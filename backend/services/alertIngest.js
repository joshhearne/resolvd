// Shared ingest pipeline for alert events. Used by:
//   - routes/webhooks.js     — live fires from monitoring tools
//   - routes/alertSources.js — backfill of currently-open problems
//   - services/action1Poll.js — scheduled polls
//
// Decoupled from ticket creation: every inbound event lands in the
// `alerts` table first (deduped per source+external_event_id). Rules
// in `alert_rules` then decide whether to promote a firing alert to a
// ticket — immediately, with a delay, or not at all.
//
// Recoveries route to handleExternalRecovery() which marks any linked
// ticket as externally resolved (canonical resolution_summary +
// resolved_pending_close status) so the existing 3-day grace nudge
// takes over.

const { pool, transaction } = require('../db/pool');
const { nextInternalRef } = require('../db/schema');
const { resolvePriority } = require('./alertMappers');
const { auditLog, systemComment } = require('./ticketHelpers');
const { buildWritePatch, getMode } = require('./fields');
const { pickRule, severityRank } = require('./alertEvaluator');
const blindIndex = require('./blindIndex');
const sla = require('./sla');
const assignmentPolicies = require('./assignmentPolicies');
const { notifyManagersAndAdmins } = require('./notifications');
const { fanoutNewTicket } = require('./notificationFanout');

// Zabbix templates frequently ship URLs containing the user macro
// `{$ZABBIX.URL}` which Zabbix itself doesn't expand for outbound
// webhooks. Substitute with the source's api_url base so "View in
// Zabbix" links land somewhere usable. Strip the JSON-RPC suffix
// because operators paste the *API* URL into the integration config
// but the Zabbix web UI lives at the host root.
function resolveZabbixMacros(source, event) {
  if (!event) return event;
  if (source?.preset !== 'zabbix') return event;
  const apiUrl = String(source.api_url || '').trim();
  if (!apiUrl) return event;
  const base = apiUrl
    .replace(/\/api_jsonrpc\.php\b.*$/i, '')
    .replace(/\/+$/, '');
  if (!base) return event;
  const sub = (s) => (typeof s === 'string' ? s.replace(/\{\$ZABBIX\.URL\}/g, base) : s);
  event.description = sub(event.description);
  event.title = sub(event.title);
  if (event.vendor_ref) event.vendor_ref = sub(event.vendor_ref);
  return event;
}

async function ingestAlertEvent({ source, preset, event, rawPayload }) {
  resolveZabbixMacros(source, event);
  return transaction(async (client) => {
    // Dedup the immutable event log first — re-firing recoveries from
    // a flaky webhook shouldn't duplicate audit rows. We still always
    // upsert the alerts row regardless, so refire_count tracks reality.
    const dup = await client.query(
      `SELECT id FROM external_alert_event
        WHERE source_id = $1 AND external_event_id = $2 AND event_type = $3`,
      [source.id, event.external_event_id, event.event_type]
    );
    const isDupEvent = !!dup.rows[0];

    const externalRef = `${source.preset}:${event.external_event_id}`;

    if (event.event_type === 'problem') {
      const alertRow = await upsertFiringAlert(client, source, event, externalRef, rawPayload);
      let result = { alert_id: alertRow.id, deduped: isDupEvent };
      if (!alertRow.ticket_id) {
        const decision = await evaluateAndAct(client, source, alertRow);
        result = { ...result, ...decision };
      } else {
        result.ticket_id = alertRow.ticket_id;
        // Existing ticket — keep the alert refire system-comment so the
        // ticket timeline mirrors the alert activity.
        await systemComment(
          client,
          alertRow.ticket_id,
          `**[${source.name}]** Alert refired (severity: ${event.severity})\n\n${event.description}`
        );
        await auditLog(client, {
          ticketId: alertRow.ticket_id,
          action: 'alert_refire',
          note: externalRef,
        });
      }
      await logEvent(client, source, event, rawPayload, alertRow.ticket_id || null);
      return result;
    }

    // recovery
    const recovered = await markRecovered(client, source, event, externalRef);
    if (recovered?.ticket_id) {
      await handleExternalRecovery(client, source, event, recovered);
    }
    await logEvent(client, source, event, rawPayload, recovered?.ticket_id || null);
    return {
      alert_id: recovered?.id || null,
      ticket_id: recovered?.ticket_id || null,
      recovered: true,
    };
  });
}

async function upsertFiringAlert(client, source, event, externalRef, rawPayload) {
  const sev = event.severity || null;
  const sevRank = severityRank(sev);
  const mode = await getMode(client);
  const patch = await buildWritePatch(client, 'alerts', {
    title: event.title || null,
    description: event.description || null,
  });
  // INSERT ON CONFLICT — manual column list because patch.cols already
  // carries title/description (and their _enc shadows).
  const baseCols = [
    'source_id', 'external_event_id', 'external_ref', 'state',
    'severity', 'severity_rank', 'user_email', 'vendor_ref', 'raw_payload',
  ];
  // rawPayload is the unparsed body the vendor posted (forwarded via
  // ingestAlertEvent). Older callers (or replay paths) sometimes pass
  // the parsed event.raw instead — keep that as a fallback so we never
  // store an empty {} when *some* shape was available.
  const rawForStore = rawPayload ?? event.raw ?? {};
  const baseVals = [
    source.id, event.external_event_id, externalRef, 'firing',
    sev, sevRank, event.user_email || null, event.vendor_ref || null,
    JSON.stringify(rawForStore),
  ];
  const cols = [...baseCols, ...patch.cols];
  const vals = [...baseVals, ...patch.values];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  // We must rebuild the UPDATE clause to avoid clobbering ticket_id /
  // promoted_at if the row already exists from a prior firing.
  const updates = [
    `state = 'firing'`,
    `last_seen_at = NOW()`,
    `refire_count = alerts.refire_count + 1`,
    `severity = EXCLUDED.severity`,
    `severity_rank = EXCLUDED.severity_rank`,
    `user_email = COALESCE(EXCLUDED.user_email, alerts.user_email)`,
    `vendor_ref = COALESCE(EXCLUDED.vendor_ref, alerts.vendor_ref)`,
    `raw_payload = EXCLUDED.raw_payload`,
  ];
  // Title/desc updates only when new values are non-null (avoid blanking).
  if (patch.cols.includes('title') || patch.cols.includes('title_enc')) {
    updates.push(`title = EXCLUDED.title`);
    updates.push(`title_enc = EXCLUDED.title_enc`);
  }
  if (patch.cols.includes('description') || patch.cols.includes('description_enc')) {
    updates.push(`description = EXCLUDED.description`);
    updates.push(`description_enc = EXCLUDED.description_enc`);
  }
  const r = await client.query(
    `INSERT INTO alerts (${cols.join(', ')}) VALUES (${placeholders})
       ON CONFLICT (source_id, external_event_id)
       DO UPDATE SET ${updates.join(', ')}
     RETURNING id, ticket_id, severity_rank, state`,
    vals
  );
  const row = r.rows[0];
  // Re-fetch title/description in plaintext for the rule evaluator.
  // We have them in `event` already; pass through.
  return {
    id: row.id,
    ticket_id: row.ticket_id,
    severity_rank: row.severity_rank,
    state: row.state,
    title: event.title,
    description: event.description,
    user_email: event.user_email,
    external_ref: externalRef,
    severity: sev,
    event,
  };
}

async function markRecovered(client, source, event, externalRef) {
  const r = await client.query(
    `UPDATE alerts
        SET state = 'recovered',
            recovered_at = NOW(),
            last_seen_at = NOW()
      WHERE source_id = $1 AND external_event_id = $2
      RETURNING id, ticket_id, external_ref`,
    [source.id, event.external_event_id]
  );
  if (r.rows[0]) return r.rows[0];
  // Recovery for an alert we never saw fire — insert a placeholder row
  // so the Alerts page still surfaces it.
  const ins = await client.query(
    `INSERT INTO alerts (source_id, external_event_id, external_ref, state,
                          first_seen_at, last_seen_at, recovered_at, raw_payload)
       VALUES ($1, $2, $3, 'recovered', NOW(), NOW(), NOW(), $4::jsonb)
       ON CONFLICT (source_id, external_event_id) DO NOTHING
       RETURNING id, ticket_id, external_ref`,
    [source.id, event.external_event_id, externalRef, JSON.stringify(event.raw || {})]
  );
  return ins.rows[0] || null;
}

async function evaluateAndAct(client, source, alertRow) {
  const rules = await client.query(
    `SELECT * FROM alert_rules
      WHERE integration_id = $1 AND enabled = TRUE
      ORDER BY priority ASC, id ASC`,
    [source.id]
  );
  const rule = pickRule(rules.rows, alertRow);
  await client.query(`UPDATE alerts SET evaluated_at = NOW() WHERE id = $1`, [alertRow.id]);

  if (!rule) {
    return { decision: 'no_rule_match' };
  }
  if (rule.action === 'suppress' || rule.action === 'ignore') {
    await client.query(
      `UPDATE alerts SET state = 'suppressed', suppression_reason = $1 WHERE id = $2`,
      [`rule:${rule.id} (${rule.name})`, alertRow.id]
    );
    return { decision: rule.action, rule_id: rule.id };
  }
  // create_ticket
  if (rule.delay_minutes && rule.delay_minutes > 0) {
    await client.query(
      `UPDATE alerts
          SET next_evaluation_at = NOW() + ($1::int * INTERVAL '1 minute')
        WHERE id = $2`,
      [rule.delay_minutes, alertRow.id]
    );
    return { decision: 'delayed', rule_id: rule.id, delay_minutes: rule.delay_minutes };
  }
  const ticketId = await promoteAlertToTicket(client, source, alertRow, rule, null);
  return { decision: 'created_ticket', rule_id: rule.id, ticket_id: ticketId };
}

// Extracted from the previous monolithic ingest. Called by:
//   - auto-promote from evaluateAndAct
//   - scheduler when a delayed alert clears its window
//   - manual /api/alerts/:id/promote
async function promoteAlertToTicket(client, source, alertRow, rule, actingUserId) {
  // Idempotent: if alert already linked, just return.
  const existing = await client.query(
    `SELECT ticket_id FROM alerts WHERE id = $1`,
    [alertRow.id]
  );
  if (existing.rows[0]?.ticket_id) return existing.rows[0].ticket_id;

  const overrides = rule?.ticket_overrides || {};
  const event = alertRow.event || {};
  const preset = require('./alertMappers').getPreset(source.preset);
  const priority = overrides.priority
    ? Math.max(1, Math.min(5, Number(overrides.priority)))
    : resolvePriority(preset, alertRow.severity, source.severity_map);
  const projectId = overrides.project_id || source.default_project_id;
  const internalRef = await nextInternalRef(client, projectId);

  let resolvedUserId = null;
  let autoProvisionedUserId = null;
  if (alertRow.user_email) {
    const u = await client.query(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND status = 'active' LIMIT 1`,
      [alertRow.user_email]
    );
    resolvedUserId = u.rows[0]?.id || null;
    if (!resolvedUserId) {
      // Email tied to alert payload but no matching user — auto-provision
      // a default Submitter so the ticket has an owner. Source label
      // includes the preset (zabbix/action1/etc) so admins can trace it.
      const exists = await client.query(
        `SELECT 1 FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
        [alertRow.user_email]
      );
      if (exists.rows.length === 0) {
        try {
          const { autoProvisionSubmitter } = require('./userAutoProvision');
          const provisioned = await autoProvisionSubmitter(
            { email: alertRow.user_email, source: `alert:${source.preset}` },
            client
          );
          if (provisioned) {
            resolvedUserId = provisioned.id;
            autoProvisionedUserId = provisioned.id;
          }
        } catch (e) {
          console.error('alert auto-provision failed:', e.message);
        }
      }
    }
  }
  const assignedTo = overrides.assignee_id
    || resolvedUserId
    || source.default_assignee_id
    || null;

  const mode = await getMode(client);
  const sensitivePatch = await buildWritePatch(client, 'tickets', {
    title: alertRow.title,
    description: alertRow.description,
  });
  const baseCols = [
    'project_id', 'internal_ref', 'submitted_by', 'assigned_to',
    'impact', 'urgency', 'computed_priority', 'effective_priority',
    'external_ref', 'external_source', 'external_alert_source_id',
    'external_ticket_ref', 'title_blind_idx',
  ];
  const baseVals = [
    projectId, internalRef, resolvedUserId, assignedTo,
    priority, priority, priority, priority,
    alertRow.external_ref, source.preset, source.id,
    event.vendor_ref || alertRow.vendor_ref || null,
    mode === 'standard' ? blindIndex.buildIndex(alertRow.title || '') : null,
  ];
  const cols = [...baseCols, ...sensitivePatch.cols];
  const vals = [...baseVals, ...sensitivePatch.values];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const ins = await client.query(
    `INSERT INTO tickets (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id, created_at`,
    vals
  );
  const ticketId = ins.rows[0].id;
  const ticketCreatedAt = ins.rows[0].created_at;

  // Stamp SLA due/warn timestamps with business-hours math. Mirrors the
  // REST and inbound create paths. Without this the timestamps stay
  // NULL and the schema-init backfill stamps them wall-clock, ignoring
  // business_hours_id and firing breach notifications overnight.
  await sla.applyPolicyOnCreate(client, {
    ticketId,
    priority,
    projectId,
    createdAt: ticketCreatedAt,
  });

  // Auto-assignment fallback. Alert path already considered override →
  // resolved-from-email → source.default_assignee_id; if all three were
  // empty, fall through to the org/project assignment policy so admins
  // get a deterministic owner instead of a NULL assignee.
  if (!assignedTo) {
    const policyPick = await assignmentPolicies.applyOnCreate(client, {
      priority,
      projectId,
    });
    if (policyPick) {
      await client.query(
        `UPDATE tickets SET assigned_to = $1 WHERE id = $2`,
        [policyPick, ticketId]
      );
    }
  }

  await client.query(
    `UPDATE alerts
        SET ticket_id = $1,
            promoted_at = NOW(),
            promoted_by_rule_id = $2,
            promoted_by_user_id = $3,
            next_evaluation_at = NULL
      WHERE id = $4`,
    [ticketId, rule?.id || null, actingUserId, alertRow.id]
  );

  await auditLog(client, {
    ticketId,
    userId: actingUserId,
    action: 'ticket_created_from_alert',
    newValue: internalRef,
    note: rule
      ? `${alertRow.external_ref} (rule: ${rule.name})`
      : `${alertRow.external_ref} (manual)`,
  });
  if (resolvedUserId) {
    await client.query(
      `INSERT INTO ticket_followers (ticket_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
      [ticketId, resolvedUserId]
    );
  }
  if (alertRow.user_email && !resolvedUserId) {
    await auditLog(client, {
      ticketId,
      action: 'alert_unmatched_contact',
      newValue: alertRow.user_email,
      note: 'Contact has no matching active user',
    });
  }
  if (autoProvisionedUserId) {
    await auditLog(client, {
      ticketId,
      action: 'submitter_auto_provisioned',
      newValue: alertRow.user_email,
      note: `Created Submitter user #${autoProvisionedUserId} from alert payload`,
    });
  }

  // Pull the alert's raw_payload once so both the dedup note and the
  // consumable-flag block below see the part.number tag. upsertFiringAlert
  // doesn't ship raw_payload on the in-memory alertRow, so re-fetch.
  let alertPayload = null;
  try {
    const pr = await client.query(
      `SELECT raw_payload FROM alerts WHERE id = $1`,
      [alertRow.id]
    );
    alertPayload = pr.rows[0]?.raw_payload || null;
  } catch { /* best-effort */ }
  const partTag = extractPartNumberFromAlertPayload(alertPayload);

  // Dedup note. Best-effort, post-commit-equivalent (still in the same
  // client tx — same-tx tickets are visible to the query). Looks for
  // recent tickets that could be the same physical problem:
  //   - same project + same submitter, within decay_days
  //   - consumable_movements on those tickets for the same part (when
  //     the alert's payload carries a part.number tag — common on
  //     Zabbix Low-cartridge triggers)
  // Flags those as potential duplicates via a system comment so the
  // tech can decide whether to merge / dismiss without scrolling
  // their history.
  if (source.dedup_alert_enabled !== false
      && Number(source.dedup_alert_decay_days || 0) > 0
      && resolvedUserId) {
    try {
      const decayDays = Math.max(1, Math.min(365, Number(source.dedup_alert_decay_days)));
      const candidates = await client.query(
        `SELECT t.id, t.internal_ref, t.created_at, t.internal_status,
                EXISTS (
                  SELECT 1 FROM consumable_movements cm
                   JOIN consumables c ON c.id = cm.consumable_id
                   WHERE cm.ticket_id = t.id
                     AND cm.delta < 0
                     AND ($3::text IS NULL OR c.part_no ILIKE $3 OR c.vendor_part_no ILIKE $3)
                ) AS same_consumable_dispatched
           FROM tickets t
          WHERE t.project_id = $1
            AND t.submitted_by = $2
            AND t.id <> $4
            AND t.created_at >= NOW() - ($5::int * INTERVAL '1 day')
          ORDER BY t.created_at DESC
          LIMIT 10`,
        [projectId, resolvedUserId, partTag, ticketId, decayDays]
      );
      if (candidates.rows.length) {
        // Rank: same-consumable hits first, then plain recency.
        const sorted = [...candidates.rows].sort((a, b) =>
          (b.same_consumable_dispatched - a.same_consumable_dispatched)
          || (new Date(b.created_at) - new Date(a.created_at))
        );
        const lines = sorted.map((r) => {
          const flag = r.same_consumable_dispatched ? ' · 📦 consumable already dispatched' : '';
          return `- **${r.internal_ref}** (${r.internal_status})${flag} · ${new Date(r.created_at).toISOString().slice(0, 10)}`;
        });
        const hot = sorted.some((r) => r.same_consumable_dispatched);
        await systemComment(
          client, ticketId,
          (hot
            ? `⚠ **Possible duplicate / recent fulfilment.** Same requestor had this consumable dispatched within the last ${decayDays} day(s):\n\n`
            : `🔍 **Possible duplicate.** Same requestor opened these tickets in the last ${decayDays} day(s):\n\n`
          ) + lines.join('\n') + `\n\nIf this is the same physical issue, link or close the duplicate.`
        );
      }
    } catch (err) {
      console.warn('alert dedup note failed:', err.message);
    }
  }

  // Consumable match at ingest. When the alert carries a part.number tag
  // (Zabbix Low-cartridge templates, etc.), resolve the matching
  // consumable now so techs see stock state on ticket open instead of
  // discovering OOS / missing data only when they try to print a label.
  if (partTag) {
    try {
      const cm = await client.query(
        `SELECT id, part_no, title, current_stock, low_stock_threshold,
                reorder_qty, purchase_url, vendor_part_no, is_metered,
                vendor_company_id
           FROM consumables
          WHERE is_archived = FALSE
            AND (part_no ILIKE $1 OR vendor_part_no ILIKE $1)
          ORDER BY (CASE WHEN part_no ILIKE $1 THEN 0 ELSE 1 END), id ASC
          LIMIT 1`,
        [partTag]
      );
      const cons = cm.rows[0];
      if (!cons) {
        await systemComment(
          client, ticketId,
          `⚠ **Unmatched part:** alert tag \`part.number:${partTag}\` does not match any active consumable on file. Add it under Admin → Consumables so future alerts auto-link.`
        );
        await notifyManagersAndAdmins(client, {
          type: 'consumable_unmatched',
          title: `Unmatched part ${partTag}`,
          body: `Alert on ${alertRow.external_ref} tagged ${partTag} but no consumable matches.`,
          data: {
            ticket_id: ticketId,
            part_no: partTag,
            alert_external_ref: alertRow.external_ref,
          },
        });
      } else {
        const stock = Number(cons.current_stock || 0);
        const thr = Number(cons.low_stock_threshold || 0);
        const isOOS = stock <= 0;
        const isLow = !isOOS && thr > 0 && stock <= thr;
        // Missing-data warnings — same checks the print-label flow uses,
        // surfaced up front so admins can fix the consumable row before
        // anyone tries to use it.
        const gaps = [];
        if (!cons.vendor_part_no) gaps.push('vendor P/N');
        if (!cons.reorder_qty) gaps.push('restock qty');
        if (!cons.is_metered && !cons.purchase_url) gaps.push('purchase URL');
        if (!cons.vendor_company_id) gaps.push('vendor company');
        const gapLine = gaps.length
          ? `\n\n📝 **Missing data on the consumable record:** ${gaps.join(', ')}. Fix under Admin → Consumables → ${cons.part_no}.`
          : '';
        const restockCta = cons.is_metered
          ? `Use canned response "Consumable restock — metered / leased printer" to dispatch via service agreement.`
          : (cons.purchase_url
              ? `**Restock URL:** ${cons.purchase_url}\n**Vendor P/N:** ${cons.vendor_part_no || cons.part_no}\nUse canned response "Consumable restock — self-serve RFQ".`
              : `No purchase URL on file. Use canned response "Consumable restock — self-serve RFQ" or add a URL.`);

        if (isOOS) {
          await systemComment(
            client, ticketId,
            `⚠ **${cons.part_no} (${cons.title || ''}) is out of stock.** Auto-matched from alert tag \`part.number:${partTag}\`.\n\n${restockCta}${gapLine}`
          );
          await notifyManagersAndAdmins(client, {
            type: 'consumable_out_of_stock',
            title: `Out of stock: ${cons.part_no}`,
            body: `Alert on ${alertRow.external_ref} matched ${cons.part_no} but stock is 0.`,
            data: {
              ticket_id: ticketId,
              consumable_id: cons.id,
              part_no: cons.part_no,
              is_metered: cons.is_metered,
              purchase_url: cons.purchase_url,
              vendor_part_no: cons.vendor_part_no,
              reorder_qty: cons.reorder_qty,
              missing: gaps,
            },
          });
        } else if (isLow) {
          await systemComment(
            client, ticketId,
            `🟡 **Low stock:** ${cons.part_no} at ${stock}/${thr}. Auto-matched from alert tag \`part.number:${partTag}\`.\n\n${restockCta}${gapLine}`
          );
          await notifyManagersAndAdmins(client, {
            type: 'consumable_low_stock',
            title: `Low stock: ${cons.part_no} at ${stock}/${thr}`,
            body: `Alert on ${alertRow.external_ref} matched ${cons.part_no} (low).`,
            data: {
              ticket_id: ticketId,
              consumable_id: cons.id,
              part_no: cons.part_no,
              current_stock: stock,
              low_stock_threshold: thr,
              is_metered: cons.is_metered,
              purchase_url: cons.purchase_url,
              vendor_part_no: cons.vendor_part_no,
              reorder_qty: cons.reorder_qty,
              missing: gaps,
            },
          });
        } else if (gaps.length) {
          // Stock fine but the record's incomplete — still worth
          // flagging once at ticket-open so admins fix it now.
          await systemComment(
            client, ticketId,
            `📝 **${cons.part_no}** auto-matched from alert. Stock OK (${stock}), but the consumable record is missing: ${gaps.join(', ')}. Fix under Admin → Consumables → ${cons.part_no}.`
          );
        }
      }
    } catch (err) {
      console.warn('alert consumable-match flag failed:', err.message);
    }
  }

  // Broadcast new-ticket to opted-in Admins/Managers. Fire-and-forget;
  // the fanout query runs on its own pool connection so it doesn't
  // depend on the ingest tx committing first — defer via setImmediate
  // so the caller's transaction commits before the recipients see it.
  setImmediate(() => {
    pool.query(
      `SELECT id, internal_ref, title, assigned_to, submitted_by,
              effective_priority, project_id, external_source
         FROM tickets WHERE id = $1`,
      [ticketId]
    ).then(async (r) => {
      const ticket = r.rows[0];
      if (!ticket) return;
      await fanoutNewTicket(null, {
        ticket,
        actorId: actingUserId || null,
        actorName: source?.name || 'Alert',
        submitterId: ticket.submitted_by,
      });
    }).catch((err) => console.error('fanoutNewTicket (alert) failed:', err.message));
  });

  return ticketId;
}

// Pull a "part.number:<value>" tag out of an alert payload. Mirrors
// the helper in routes/tickets.js so the dedup query can match the
// same consumable the print modal would auto-select.
function extractPartNumberFromAlertPayload(payload) {
  if (!payload) return null;
  const tagsRaw = payload.event_tags;
  if (typeof tagsRaw === 'string' && tagsRaw) {
    for (const part of tagsRaw.split(',')) {
      const m = /^\s*part\.number\s*:\s*(.+?)\s*$/i.exec(part);
      if (m && m[1]) return m[1];
    }
  }
  if (Array.isArray(payload.tags)) {
    for (const t of payload.tags) {
      if (t && /^part\.number$/i.test(String(t.tag || '').trim()) && t.value) {
        return String(t.value).trim();
      }
    }
  }
  return null;
}

// Recovery → mark linked ticket externally resolved. Sets canonical
// resolution_summary and flips status to resolved_pending_close so the
// 3-day grace nudge picks it up. Tech still has to acknowledge.
async function handleExternalRecovery(client, source, event, alertRow) {
  const ticketId = alertRow.ticket_id;
  const ticket = await client.query(
    `SELECT id, internal_status, resolution_summary FROM tickets WHERE id = $1`,
    [ticketId]
  );
  if (!ticket.rows[0]) return;
  await systemComment(
    client,
    ticketId,
    `**[${source.name}]** Alert recovered\n\n${event.description || ''}`
  );
  await auditLog(client, {
    ticketId,
    action: 'alert_recovery',
    note: alertRow.external_ref,
  });

  // If ticket is already terminal/resolved, leave it alone.
  const term = await client.query(
    `SELECT is_terminal, semantic_tag FROM statuses
      WHERE kind = 'internal' AND name = $1`,
    [ticket.rows[0].internal_status]
  );
  if (term.rows[0]?.is_terminal) return;
  if (term.rows[0]?.semantic_tag === 'resolved_pending_close') return;

  // Pick the resolved_pending_close status (e.g. "Resolved").
  const resolveTo = await client.query(
    `SELECT name FROM statuses
      WHERE kind = 'internal' AND semantic_tag = 'resolved_pending_close'
      ORDER BY sort_order ASC LIMIT 1`
  );
  const target = resolveTo.rows[0]?.name;
  if (!target) return;
  const oldStatus = ticket.rows[0].internal_status;

  const canonicalSummary = ticket.rows[0].resolution_summary
    || `Resolved externally by ${source.name} (alert recovered). Verify before closing.`;

  // Wrap resolution_summary in the encryption envelope.
  const resPatch = await buildWritePatch(client, 'tickets', {
    resolution_summary: canonicalSummary,
  });
  const sets = [
    `internal_status = $1`,
    `resolved_at = NOW()`,
    `updated_at = NOW()`,
    ...resPatch.cols.map((c, i) => `${c} = $${i + 2}`),
  ];
  await client.query(
    `UPDATE tickets SET ${sets.join(', ')} WHERE id = $${resPatch.cols.length + 2}`,
    [target, ...resPatch.values, ticketId]
  );
  await auditLog(client, {
    ticketId,
    action: 'status_change',
    oldValue: oldStatus,
    newValue: target,
    note: 'auto-resolve on alert recovery',
  });
}

async function logEvent(client, source, event, rawPayload, ticketId) {
  await client.query(
    `INSERT INTO external_alert_event
       (source_id, external_event_id, ticket_id, event_type, raw_payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT DO NOTHING`,
    [source.id, event.external_event_id, ticketId, event.event_type, JSON.stringify(rawPayload)]
  );
  await client.query(
    `UPDATE external_alert_source SET last_seen_at = NOW() WHERE id = $1`,
    [source.id]
  );
}

module.exports = { ingestAlertEvent, promoteAlertToTicket };
