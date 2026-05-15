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

const { transaction } = require('../db/pool');
const { nextInternalRef } = require('../db/schema');
const { resolvePriority } = require('./alertMappers');
const { auditLog, systemComment } = require('./ticketHelpers');
const { buildWritePatch, getMode } = require('./fields');
const { pickRule, severityRank } = require('./alertEvaluator');
const blindIndex = require('./blindIndex');

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
      const alertRow = await upsertFiringAlert(client, source, event, externalRef);
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

async function upsertFiringAlert(client, source, event, externalRef) {
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
  const baseVals = [
    source.id, event.external_event_id, externalRef, 'firing',
    sev, sevRank, event.user_email || null, event.vendor_ref || null,
    JSON.stringify(event.raw || {}),
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
  if (alertRow.user_email) {
    const u = await client.query(
      `SELECT id FROM users WHERE LOWER(email) = $1 AND status = 'active' LIMIT 1`,
      [alertRow.user_email]
    );
    resolvedUserId = u.rows[0]?.id || null;
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
    `INSERT INTO tickets (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
    vals
  );
  const ticketId = ins.rows[0].id;

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
  return ticketId;
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
