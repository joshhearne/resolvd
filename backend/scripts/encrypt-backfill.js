#!/usr/bin/env node
// Encrypt-backfill: populates *_enc shadow columns from existing plaintext.
// Idempotent — rows whose shadow column is already non-null are skipped.
// Under standard mode, also encrypts file bodies on disk and NULLs the
// plaintext columns so live reads stop falling back to plaintext.
//
// Usage:
//   RESOLVD_MASTER_KEY=... node backend/scripts/encrypt-backfill.js
//   (--verify to re-decrypt every row and assert plaintext matches)

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const path = require('path');
const fsp = require('fs').promises;
const { pool } = require('../db/pool');
const { encrypt, decrypt } = require('../services/crypto');
const blindIndex = require('../services/blindIndex');

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';

const VERIFY = process.argv.includes('--verify');
const BATCH = 200;

// Each entry: table, primary key column, [{ plain, enc, ctx }]
// ctx string must match what services/fields.js uses on the live read path
// (`<table>.<col>`) so backfilled rows decrypt cleanly under standard mode.
const TARGETS = [
  {
    table: 'tickets',
    pk: 'id',
    cols: [
      { plain: 'title',            enc: 'title_enc',            ctx: 'tickets.title' },
      { plain: 'description',      enc: 'description_enc',      ctx: 'tickets.description' },
      { plain: 'review_note',      enc: 'review_note_enc',      ctx: 'tickets.review_note' },
      { plain: 'internal_blocker_note', enc: 'internal_blocker_note_enc', ctx: 'tickets.internal_blocker_note' },
      { plain: 'resolution_summary', enc: 'resolution_summary_enc', ctx: 'tickets.resolution_summary' },
    ],
  },
  {
    table: 'comments',
    pk: 'id',
    cols: [
      { plain: 'body', enc: 'body_enc', ctx: 'comments.body' },
    ],
  },
  {
    table: 'audit_log',
    pk: 'id',
    cols: [
      { plain: 'old_value', enc: 'old_value_enc', ctx: 'audit_log.old_value' },
      { plain: 'new_value', enc: 'new_value_enc', ctx: 'audit_log.new_value' },
      { plain: 'note',      enc: 'note_enc',      ctx: 'audit_log.note' },
    ],
  },
  {
    table: 'attachments',
    pk: 'id',
    cols: [
      { plain: 'original_name', enc: 'original_name_enc', ctx: 'attachments.original_name' },
    ],
  },
  {
    table: 'contacts',
    pk: 'id',
    cols: [
      { plain: 'name',   enc: 'name_enc',   ctx: 'contacts.name' },
      { plain: 'email',  enc: 'email_enc',  ctx: 'contacts.email' },
      { plain: 'phone',  enc: 'phone_enc',  ctx: 'contacts.phone' },
      { plain: 'mobile', enc: 'mobile_enc', ctx: 'contacts.mobile' },
      { plain: 'notes',  enc: 'notes_enc',  ctx: 'contacts.notes' },
    ],
  },
  {
    table: 'users',
    pk: 'id',
    cols: [
      { plain: 'phone_direct', enc: 'phone_direct_enc', ctx: 'users.phone_direct' },
      { plain: 'phone_mobile', enc: 'phone_mobile_enc', ctx: 'users.phone_mobile' },
    ],
  },
  {
    table: 'software_licenses',
    pk: 'id',
    cols: [
      { plain: 'license_key', enc: 'license_key_enc', ctx: 'software_licenses.license_key' },
      { plain: 'notes',       enc: 'notes_enc',       ctx: 'software_licenses.notes' },
    ],
  },  {
    table: 'ticket_notes',
    pk: 'id',
    cols: [
      { plain: 'body', enc: 'body_enc', ctx: 'ticket_notes.body' },
    ],
  },
  {
    table: 'time_entries',
    pk: 'id',
    cols: [
      { plain: 'note', enc: 'note_enc', ctx: 'time_entries.note' },
    ],
  },
  {
    table: 'alerts',
    pk: 'id',
    cols: [
      { plain: 'title', enc: 'title_enc', ctx: 'alerts.title' },
      { plain: 'description', enc: 'description_enc', ctx: 'alerts.description' },
    ],
  },
  {
    table: 'companies',
    pk: 'id',
    cols: [
      { plain: 'name', enc: 'name_enc', ctx: 'companies.name' },
      { plain: 'notes', enc: 'notes_enc', ctx: 'companies.notes' },
    ],
  },
  {
    table: 'inbound_email_queue',
    pk: 'id',
    cols: [
      { plain: 'subject', enc: 'subject_enc', ctx: 'inbound_email_queue.subject' },
      { plain: 'body', enc: 'body_enc', ctx: 'inbound_email_queue.body' },
    ],
  },
  {
    table: 'email_backend_accounts',
    pk: 'id',
    cols: [
      { plain: 'oauth_access_token', enc: 'oauth_access_token_enc', ctx: 'email_backend_accounts.oauth_access_token' },
      { plain: 'oauth_refresh_token', enc: 'oauth_refresh_token_enc', ctx: 'email_backend_accounts.oauth_refresh_token' },
      { plain: 'smtp_password', enc: 'smtp_password_enc', ctx: 'email_backend_accounts.smtp_password' },
    ],
  },
  {
    table: 'external_alert_source',
    pk: 'id',
    cols: [
      { plain: 'api_token', enc: 'api_token_enc', ctx: 'external_alert_source.api_token' },
    ],
  },
  {
    table: 'ticket_schedules',
    pk: 'id',
    cols: [
      { plain: 'title', enc: 'title_enc', ctx: 'ticket_schedules.title' },
      { plain: 'description', enc: 'description_enc', ctx: 'ticket_schedules.description' },
    ],
  },
  {
    table: 'tasks',
    pk: 'id',
    cols: [
      { plain: 'title', enc: 'title_enc', ctx: 'tasks.title' },
      { plain: 'body', enc: 'body_enc', ctx: 'tasks.body' },
    ],
  },
];

async function backfillTable(client, target, mode) {
  const { table, pk, cols } = target;
  let totalEncrypted = 0;
  let totalSkipped = 0;
  let totalVerified = 0;

  // Build the WHERE clause: at least one plaintext column non-null AND
  // its shadow still null (so we don't re-encrypt rows we already handled).
  const conditions = cols
    .map(c => `(${c.plain} IS NOT NULL AND ${c.enc} IS NULL)`)
    .join(' OR ');
  const selectCols = [pk, ...cols.flatMap(c => [c.plain, c.enc])].join(', ');

  let lastId = 0;
  for (;;) {
    const { rows } = await client.query(
      `SELECT ${selectCols} FROM ${table}
        WHERE ${pk} > $1 AND (${conditions})
        ORDER BY ${pk} ASC
        LIMIT ${BATCH}`,
      [lastId]
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      lastId = row[pk];
      const updates = [];
      const values = [];
      let placeholderIdx = 1;

      for (const col of cols) {
        const plain = row[col.plain];
        const existingEnc = row[col.enc];
        if (plain == null || existingEnc != null) {
          if (existingEnc != null) totalSkipped++;
          continue;
        }
        const ctx = col.ctx;
        const blob = await encrypt(plain, ctx);
        updates.push(`${col.enc} = $${placeholderIdx++}`);
        values.push(blob);
        totalEncrypted++;

        if (VERIFY) {
          const back = await decrypt(blob, ctx);
          if (back !== String(plain)) {
            throw new Error(`Verify failed for ${table}.${col.plain} id=${row[pk]}`);
          }
          totalVerified++;
        }

        // Maintain the blind index for ticket titles in lockstep so search
        // keeps working after the plaintext is dropped.
        if (table === 'tickets' && col.plain === 'title' && mode === 'standard') {
          updates.push(`title_blind_idx = $${placeholderIdx++}`);
          values.push(blindIndex.buildIndex(plain));
        }

        // Contact emails are looked up by blind index (inbound mail
        // matching, contact lookup) once the plaintext is gone. Contacts
        // created through the API already have it; fill it for any row
        // that doesn't, from the same normalised value.
        if (table === 'contacts' && col.plain === 'email') {
          updates.push(`email_blind_idx = COALESCE(email_blind_idx, $${placeholderIdx++})`);
          values.push(blindIndex.hashWhole(plain));
        }

        // Under standard mode, NULL the plaintext alongside writing the
        // ciphertext so live reads stop falling back to plaintext.
        if (mode === 'standard') {
          updates.push(`${col.plain} = NULL`);
        }
      }

      if (updates.length > 0) {
        values.push(row[pk]);
        await client.query(
          `UPDATE ${table} SET ${updates.join(', ')} WHERE ${pk} = $${placeholderIdx}`,
          values
        );
      }
    }
  }

  return { table, totalEncrypted, totalSkipped, totalVerified };
}

(async () => {
  if (!process.env.RESOLVD_MASTER_KEY) {
    console.error('RESOLVD_MASTER_KEY not set. Generate one with:');
    console.error('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    const settingsRow = await client.query('SELECT mode FROM encryption_settings WHERE id = 1');
    const mode = settingsRow.rows[0]?.mode || 'off';
    console.log(`encryption_settings.mode = ${mode}`);

    const results = [];
    for (const target of TARGETS) {
      const r = await backfillTable(client, target, mode);
      console.log(`[${r.table}] encrypted=${r.totalEncrypted} skipped=${r.totalSkipped}` +
                  (VERIFY ? ` verified=${r.totalVerified}` : ''));
      results.push(r);
    }

    // Encrypt attachment file bodies on disk under standard mode.
    let fileEncrypted = 0;
    let fileSkipped = 0;
    if (mode === 'standard') {
      const { rows } = await client.query(
        `SELECT id, filename FROM attachments WHERE encrypted_at_rest = FALSE`
      );
      for (const row of rows) {
        const fp = path.join(UPLOADS_DIR, row.filename);
        try {
          const buf = await fsp.readFile(fp);
          const blob = await encrypt(buf, `attachments.file:${row.filename}`);
          await fsp.writeFile(fp, blob);
          await client.query(
            `UPDATE attachments SET encrypted_at_rest = TRUE WHERE id = $1`,
            [row.id]
          );
          fileEncrypted++;
        } catch (err) {
          console.error(`  ! attachment id=${row.id} (${row.filename}): ${err.message}`);
          fileSkipped++;
        }
      }
      console.log(`[attachments:file] encrypted=${fileEncrypted} skipped=${fileSkipped}`);
    }

    // Mark backfill complete only when nothing remained to encrypt this run.
    const totalEncrypted = results.reduce((a, r) => a + r.totalEncrypted, 0) + fileEncrypted;
    if (totalEncrypted === 0) {
      await client.query(
        `UPDATE encryption_settings SET backfill_completed_at = NOW(), updated_at = NOW() WHERE id = 1`
      );
      console.log('Backfill complete; encryption_settings.backfill_completed_at stamped.');
    } else {
      console.log(`Encrypted ${totalEncrypted} value(s) this run. Re-run until 0 to mark complete.`);
    }
  } catch (err) {
    console.error('Backfill failed:', err);
    process.exit(2);
  } finally {
    client.release();
    await pool.end();
  }
})();
