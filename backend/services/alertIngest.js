// Shared ingest pipeline for alert events. Used by:
//   - routes/webhooks.js     — live fires from monitoring tools
//   - routes/alertSources.js — backfill of currently-open problems
//
// Given a normalized event (already past the preset mapper) + the source
// row, this writes the ticket/comment/audit/event-log atomically and
// updates last_seen_at. Caller handles preset selection + mapping.

const { transaction } = require('../db/pool');
const { nextInternalRef } = require('../db/schema');
const { resolvePriority } = require('./alertMappers');
const { auditLog, systemComment } = require('./ticketHelpers');
const { buildWritePatch, getMode } = require('./fields');
const blindIndex = require('./blindIndex');

async function ingestAlertEvent({ source, preset, event, rawPayload }) {
  return transaction(async (client) => {
    // Dedup
    const dup = await client.query(
      `SELECT ticket_id FROM external_alert_event
        WHERE source_id = $1 AND external_event_id = $2 AND event_type = $3`,
      [source.id, event.external_event_id, event.event_type]
    );
    if (dup.rows[0]) {
      return { ticket_id: dup.rows[0].ticket_id, deduped: true };
    }

    const externalRef = `${source.preset}:${event.external_event_id}`;
    let ticketId;
    let created = false;

    if (event.event_type === 'problem') {
      const existing = await client.query(
        `SELECT id FROM tickets
          WHERE external_ref = $1 AND internal_status != 'Closed'
          ORDER BY id DESC LIMIT 1`,
        [externalRef]
      );

      if (existing.rows[0]) {
        ticketId = existing.rows[0].id;
        await systemComment(
          client,
          ticketId,
          `**[${source.name}]** Alert refired (severity: ${event.severity})\n\n${event.description}`
        );
        await auditLog(client, {
          ticketId,
          action: 'alert_refire',
          note: `${source.preset}:${event.external_event_id}`,
        });
      } else {
        const priority = resolvePriority(preset, event.severity, source.severity_map);
        const internalRef = await nextInternalRef(client, source.default_project_id);

        // Resolve event.user_email (e.g. Zabbix INVENTORY.POC.PRIMARY.EMAIL)
        // to an active local user. Match attributes both submitted_by and
        // assigned_to so the responsible party owns the ticket immediately.
        // When the email is unknown, fall back to the source's default
        // assignee — the email itself is already in event.description.
        let resolvedUserId = null;
        if (event.user_email) {
          const u = await client.query(
            `SELECT id FROM users
              WHERE LOWER(email) = $1 AND status = 'active'
              LIMIT 1`,
            [event.user_email]
          );
          resolvedUserId = u.rows[0]?.id || null;
        }
        const submittedBy = resolvedUserId;
        const assignedTo = resolvedUserId || source.default_assignee_id || null;

        const sensitivePatch = await buildWritePatch(client, 'tickets', {
          title: event.title,
          description: event.description,
        });
        const mode = await getMode(client);
        const baseCols = [
          'project_id', 'internal_ref', 'submitted_by', 'assigned_to',
          'impact', 'urgency', 'computed_priority', 'effective_priority',
          'external_ref', 'external_source', 'external_alert_source_id',
          'external_ticket_ref', 'title_blind_idx',
        ];
        const baseValues = [
          source.default_project_id,
          internalRef,
          submittedBy,
          assignedTo,
          priority, priority, priority, priority,
          externalRef,
          source.preset,
          source.id,
          event.vendor_ref || null,
          mode === 'standard' ? blindIndex.buildIndex(event.title) : null,
        ];
        const cols = [...baseCols, ...sensitivePatch.cols];
        const values = [...baseValues, ...sensitivePatch.values];
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
        const ins = await client.query(
          `INSERT INTO tickets (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
          values
        );
        ticketId = ins.rows[0].id;
        created = true;
        await auditLog(client, {
          ticketId,
          action: 'ticket_created_from_alert',
          newValue: internalRef,
          note: `${source.preset}:${event.external_event_id}`,
        });
        // Auto-follow the attributed user so they get standard
        // notification fan-out (assignment + comments going forward).
        if (resolvedUserId) {
          await client.query(
            `INSERT INTO ticket_followers (ticket_id, user_id) VALUES ($1, $2)
               ON CONFLICT DO NOTHING`,
            [ticketId, resolvedUserId]
          );
        }
        if (event.user_email && !resolvedUserId) {
          // Capture the unmatched contact in audit so it surfaces if they
          // sign in later — easy to script a backfill of past tickets.
          await auditLog(client, {
            ticketId,
            action: 'alert_unmatched_contact',
            newValue: event.user_email,
            note: 'Zabbix inventory contact has no matching active user',
          });
        }
      }
    } else {
      // recovery
      const open = await client.query(
        `SELECT id, internal_status FROM tickets
          WHERE external_ref = $1 AND internal_status != 'Closed'
          ORDER BY id DESC LIMIT 1`,
        [externalRef]
      );
      ticketId = open.rows[0]?.id || null;

      if (ticketId) {
        await systemComment(
          client,
          ticketId,
          `**[${source.name}]** Alert recovered\n\n${event.description}`
        );
        await auditLog(client, {
          ticketId,
          action: 'alert_recovery',
          note: `${source.preset}:${event.external_event_id}`,
        });

        if (source.auto_resolve_on_recovery) {
          const resolveTo = await client.query(
            `SELECT name FROM statuses
              WHERE kind = 'internal' AND semantic_tag = 'resolved_pending_close'
              ORDER BY sort_order ASC LIMIT 1`
          );
          const target = resolveTo.rows[0]?.name;
          if (target) {
            const oldStatus = open.rows[0].internal_status;
            await client.query(
              `UPDATE tickets SET internal_status = $1, updated_at = NOW() WHERE id = $2`,
              [target, ticketId]
            );
            await auditLog(client, {
              ticketId,
              action: 'status_change',
              oldValue: oldStatus,
              newValue: target,
              note: 'auto-resolve on alert recovery',
            });
          }
        }
      }
    }

    await client.query(
      `INSERT INTO external_alert_event
         (source_id, external_event_id, ticket_id, event_type, raw_payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [source.id, event.external_event_id, ticketId, event.event_type, JSON.stringify(rawPayload)]
    );
    await client.query(
      `UPDATE external_alert_source SET last_seen_at = NOW() WHERE id = $1`,
      [source.id]
    );

    return { ticket_id: ticketId, created, recovered: event.event_type === 'recovery' };
  });
}

module.exports = { ingestAlertEvent };
