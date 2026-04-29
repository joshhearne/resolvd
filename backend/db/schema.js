const { pool } = require('./pool');

async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        entra_oid TEXT UNIQUE,
        display_name TEXT,
        email TEXT,
        upn TEXT,
        role TEXT NOT NULL DEFAULT 'Viewer',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_login TIMESTAMPTZ
      )
    `);

    // Multi-provider auth columns (idempotent — safe to run on existing DBs)
    await client.query(`ALTER TABLE users ALTER COLUMN entra_oid DROP NOT NULL`).catch(() => {});
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'entra'`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT UNIQUE`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_updated_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_provider TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_picture_filename TEXT`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS invite_tokens (
        id SERIAL PRIMARY KEY,
        token_hash TEXT UNIQUE NOT NULL,
        email TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'Viewer',
        invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        intended_provider TEXT NOT NULL DEFAULT 'local',
        expires_at TIMESTAMPTZ NOT NULL,
        accepted_at TIMESTAMPTZ,
        accepted_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_invite_email ON invite_tokens(email)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id SERIAL PRIMARY KEY,
        token_hash TEXT UNIQUE NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pwreset_user ON password_reset_tokens(user_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mfa_recovery_user ON mfa_recovery_codes(user_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_settings (
        id INTEGER PRIMARY KEY DEFAULT 1,
        entra_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        entra_allow_personal BOOLEAN NOT NULL DEFAULT FALSE,
        google_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        google_workspace_domain TEXT,
        google_allow_consumer BOOLEAN NOT NULL DEFAULT FALSE,
        local_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        mfa_required_roles TEXT NOT NULL DEFAULT '',
        email_backend TEXT NOT NULL DEFAULT 'graph',
        smtp_host TEXT,
        smtp_port INTEGER,
        smtp_user TEXT,
        smtp_password TEXT,
        smtp_secure BOOLEAN NOT NULL DEFAULT TRUE,
        smtp_from TEXT,
        google_mail_from TEXT,
        invite_ttl_hours INTEGER NOT NULL DEFAULT 168,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT auth_settings_single CHECK (id = 1)
      )
    `);
    await client.query(`INSERT INTO auth_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        prefix TEXT UNIQUE NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        ticket_counter INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS project_members (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role_override TEXT,
        added_by INTEGER REFERENCES users(id),
        added_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(project_id, user_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tickets (
        id SERIAL PRIMARY KEY,
        project_id INTEGER REFERENCES projects(id),
        internal_ref TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        submitted_by INTEGER REFERENCES users(id),
        assigned_to INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        impact INTEGER NOT NULL DEFAULT 2,
        urgency INTEGER NOT NULL DEFAULT 2,
        computed_priority INTEGER NOT NULL DEFAULT 3,
        priority_override INTEGER,
        effective_priority INTEGER NOT NULL DEFAULT 3,
        internal_status TEXT NOT NULL DEFAULT 'Open',
        external_status TEXT NOT NULL DEFAULT 'Unacknowledged',
        external_ticket_ref TEXT,
        external_updated_at TIMESTAMPTZ,
        blocker_type TEXT,
        blocked_by_ticket INTEGER REFERENCES tickets(id),
        internal_blocker_note TEXT,
        flagged_for_review BOOLEAN NOT NULL DEFAULT FALSE,
        review_note TEXT
      )
    `);

    // Migrate existing tickets table if project_id column missing
    await client.query(`
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS comments (
        id SERIAL PRIMARY KEY,
        ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id),
        body TEXT NOT NULL,
        is_internal BOOLEAN NOT NULL DEFAULT TRUE,
        is_system BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id),
        action TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        note TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS saved_views (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        filters JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS attachments (
        id SERIAL PRIMARY KEY,
        ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id),
        filename TEXT NOT NULL,
        original_name TEXT NOT NULL,
        mimetype TEXT,
        size INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_attachments_ticket ON attachments(ticket_id)`);
    await client.query(`ALTER TABLE attachments ADD COLUMN IF NOT EXISTS comment_id INTEGER REFERENCES comments(id) ON DELETE SET NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_attachments_comment ON attachments(comment_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS branding (
        id INTEGER PRIMARY KEY DEFAULT 1,
        site_name TEXT NOT NULL DEFAULT 'Resolvd',
        tagline TEXT NOT NULL DEFAULT 'Track every issue. Close every loop.',
        logo_filename TEXT,
        primary_color TEXT NOT NULL DEFAULT '#16a34a',
        show_powered_by BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT single_row CHECK (id = 1)
      )
    `);
    await client.query(`INSERT INTO branding (id) VALUES (1) ON CONFLICT DO NOTHING`);
    await client.query(`ALTER TABLE branding ADD COLUMN IF NOT EXISTS logo_on_dark BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE branding ADD COLUMN IF NOT EXISTS accent_override_enabled BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE branding ADD COLUMN IF NOT EXISTS logo_designed_for TEXT NOT NULL DEFAULT 'light' CHECK (logo_designed_for IN ('light','dark'))`);
    // Localization controls (admin-set, applies org-wide). UI uses these
    // to render dates/times; reports always use ISO regardless of style.
    await client.query(`ALTER TABLE branding ADD COLUMN IF NOT EXISTS date_style TEXT NOT NULL DEFAULT 'iso' CHECK (date_style IN ('iso','us','eu'))`);
    await client.query(`ALTER TABLE branding ADD COLUMN IF NOT EXISTS time_style TEXT NOT NULL DEFAULT 'iso' CHECK (time_style IN ('iso','12h'))`);
    await client.query(`ALTER TABLE branding ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC'`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS has_external_vendor BOOLEAN NOT NULL DEFAULT TRUE`);
    // Optional default assignee for new tickets in this project. Cleared
    // (SET NULL) when the user is deleted; eligibility (submitter+ role)
    // is enforced at write time, not by the FK.
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS default_assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS default_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL`);
    // Per-user QoL preferences stored as JSONB. Free-form so we can add
    // new toggles without schema migrations. Frontend reads via /auth/me.
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'::jsonb`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ticket_followers (
        id SERIAL PRIMARY KEY,
        ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(ticket_id, user_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_followers_ticket ON ticket_followers(ticket_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_followers_user ON ticket_followers(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(internal_status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets(effective_priority)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tickets_project ON tickets(project_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_ticket ON audit_log(ticket_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_comments_ticket ON comments(ticket_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_saved_views_user ON saved_views(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id)`);

    // Status configuration tables (advisory transitions, suggested mappings).
    await client.query(`
      CREATE TABLE IF NOT EXISTS statuses (
        id SERIAL PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('internal', 'external')),
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#6b7280',
        sort_order INTEGER NOT NULL DEFAULT 100,
        is_initial BOOLEAN NOT NULL DEFAULT FALSE,
        is_terminal BOOLEAN NOT NULL DEFAULT FALSE,
        is_blocker BOOLEAN NOT NULL DEFAULT FALSE,
        semantic_tag TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(kind, name)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_statuses_kind ON statuses(kind, sort_order)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS status_transitions (
        from_status_id INTEGER NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
        to_status_id INTEGER NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
        PRIMARY KEY (from_status_id, to_status_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS status_mappings (
        id SERIAL PRIMARY KEY,
        internal_status_id INTEGER NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
        external_status_id INTEGER NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'suggest' CHECK (kind IN ('suggest', 'mirror')),
        UNIQUE(internal_status_id, external_status_id)
      )
    `);

    // Seed default statuses on first run only.
    const existing = await client.query('SELECT COUNT(*) AS cnt FROM statuses');
    if (parseInt(existing.rows[0].cnt, 10) === 0) {
      const seedInternal = [
        ['Open',                 '#2563eb', 10,  true,  false, false, null],
        ['In Progress',          '#0891b2', 20,  false, false, false, 'in_progress'],
        ['Awaiting Input',       '#d97706', 30,  false, false, true,  null],
        ['Pending Review',       '#7c3aed', 40,  false, false, false, null],
        ['Closed',               '#16a34a', 50,  false, true,  false, null],
        ['Reopened',             '#dc2626', 60,  false, false, false, 'reopened'],
      ];
      const seedExternal = [
        ['Unacknowledged',       '#6b7280', 10,  true,  false, false, null],
        ['Acknowledged',         '#2563eb', 20,  false, false, false, null],
        ['In Progress',          '#0891b2', 30,  false, false, false, null],
        ['Resolved',             '#16a34a', 40,  false, true,  false, null],
        ['Rejected',             '#dc2626', 50,  false, true,  false, null],
      ];
      for (const [name, color, ord, init, term, blocker, tag] of seedInternal) {
        await client.query(
          `INSERT INTO statuses (kind, name, color, sort_order, is_initial, is_terminal, is_blocker, semantic_tag)
             VALUES ('internal', $1, $2, $3, $4, $5, $6, $7)`,
          [name, color, ord, init, term, blocker, tag]
        );
      }
      for (const [name, color, ord, init, term, blocker, tag] of seedExternal) {
        await client.query(
          `INSERT INTO statuses (kind, name, color, sort_order, is_initial, is_terminal, is_blocker, semantic_tag)
             VALUES ('external', $1, $2, $3, $4, $5, $6, $7)`,
          [name, color, ord, init, term, blocker, tag]
        );
      }
    }

    // Rename legacy status label if it exists from an older install.
    await client.query(`
      UPDATE statuses SET name = 'Awaiting Input'
      WHERE kind = 'internal' AND name = 'Awaiting MOT Input'
    `);

    // Auto-close timer column on statuses (null = never auto-close).
    // Used together with semantic_tag='resolved_pending_close' to
    // auto-promote tickets to Closed after N days in that state.
    await client.query(`ALTER TABLE statuses ADD COLUMN IF NOT EXISTS auto_close_after_days INTEGER`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ`);
    // Optional follow-up reminder set by an admin while a ticket sits in
    // a resolved_pending_close state. Cleared on status change away from
    // that state and when the reminder has fired.
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS followup_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS followup_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`);

    // Seed Resolved (semantic_tag=resolved_pending_close, default 3 days)
    // and On Hold (internal blocker distinct from Awaiting Input which
    // tracks external/vendor blocks).
    await client.query(`
      INSERT INTO statuses (kind, name, color, sort_order, is_initial, is_terminal, is_blocker, semantic_tag, auto_close_after_days)
      VALUES ('internal', 'Resolved', '#10b981', 45, FALSE, FALSE, FALSE, 'resolved_pending_close', 3)
      ON CONFLICT (kind, name) DO NOTHING
    `);
    // Tag the seeded "Pending Review" status so follow-up reminders show
    // up only on review states. Idempotent — only sets the tag if it
    // hasn't already been assigned by an admin.
    await client.query(`
      UPDATE statuses SET semantic_tag = 'pending_review'
       WHERE kind = 'internal' AND name = 'Pending Review' AND semantic_tag IS NULL
    `);
    // Tag "Awaiting Input" as the external-block companion to On Hold's
    // internal-block tag. Lets future logic differentiate vendor/customer
    // waits from internal team waits without name-matching.
    await client.query(`
      UPDATE statuses SET semantic_tag = 'awaiting_input'
       WHERE kind = 'internal' AND name = 'Awaiting Input' AND semantic_tag IS NULL
    `);
    await client.query(`
      INSERT INTO statuses (kind, name, color, sort_order, is_initial, is_terminal, is_blocker, semantic_tag)
      VALUES ('internal', 'On Hold', '#f59e0b', 33, FALSE, FALSE, TRUE, 'on_hold')
      ON CONFLICT (kind, name) DO NOTHING
    `);

    // Settings store for inbound auto-reopen gratitude phrases.
    await client.query(`
      CREATE TABLE IF NOT EXISTS auto_resolve_settings (
        id INTEGER PRIMARY KEY DEFAULT 1,
        gratitude_phrases TEXT[] NOT NULL DEFAULT ARRAY[
          'thanks', 'thank you', 'thx', 'ty', 'cheers',
          'appreciate it', 'appreciated', 'much appreciated', 'great, thanks'
        ]::TEXT[],
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT auto_resolve_single CHECK (id = 1)
      )
    `);
    await client.query(`INSERT INTO auto_resolve_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);

    // Encryption foundation (Phase 1). Default mode 'off' — no read/write
    // paths consult these columns yet. Backfill script populates *_enc
    // shadow columns once a key is configured; Phase 2 flips reads/writes.
    await client.query(`
      CREATE TABLE IF NOT EXISTS encryption_settings (
        id INTEGER PRIMARY KEY DEFAULT 1,
        mode TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off','standard','vault')),
        kms_provider TEXT NOT NULL DEFAULT 'local',
        active_kek_id TEXT NOT NULL DEFAULT 'local:v1',
        backfill_completed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT encryption_settings_single CHECK (id = 1)
      )
    `);
    await client.query(`INSERT INTO encryption_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS encryption_keys (
        kek_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL DEFAULT 'local',
        label TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        retired_at TIMESTAMPTZ
      )
    `);
    await client.query(`
      INSERT INTO encryption_keys (kek_id, provider, label)
      VALUES ('local:v1', 'local', 'initial local KEK')
      ON CONFLICT DO NOTHING
    `);

    // Generic-name rename pass (must run BEFORE the encrypted-shadow
    // ADD COLUMNs below, otherwise both old and new columns collide).
    // Legacy: mot_ref / coastal_status / coastal_updated_at /
    // mot_blocker_note(_enc) → internal_ref / external_status /
    // external_updated_at / internal_blocker_note(_enc).
    {
      const renames = [
        ['mot_ref', 'internal_ref'],
        ['coastal_status', 'external_status'],
        ['coastal_updated_at', 'external_updated_at'],
        ['mot_blocker_note', 'internal_blocker_note'],
        ['mot_blocker_note_enc', 'internal_blocker_note_enc'],
      ];
      for (const [oldName, newName] of renames) {
        const has = await client.query(`
          SELECT 1 FROM information_schema.columns
           WHERE table_name = 'tickets' AND column_name = $1
        `, [oldName]);
        if (has.rows[0]) {
          await client.query(`ALTER TABLE tickets RENAME COLUMN ${oldName} TO ${newName}`);
        }
      }
      await client.query(
        `UPDATE tickets SET blocker_type = 'internal_input' WHERE blocker_type = 'mot_input'`
      );
    }

    // Shadow ciphertext columns. Plaintext stays until Phase 2 cutover.
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS title_enc BYTEA`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS description_enc BYTEA`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS review_note_enc BYTEA`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS internal_blocker_note_enc BYTEA`);
    await client.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS body_enc BYTEA`);
    await client.query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS old_value_enc BYTEA`);
    await client.query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS new_value_enc BYTEA`);
    await client.query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS note_enc BYTEA`);
    // Attachments: encrypt original_name in DB; file content on disk handled
    // separately in Phase 2 with a sidecar blob layout.
    await client.query(`ALTER TABLE attachments ADD COLUMN IF NOT EXISTS original_name_enc BYTEA`);
    await client.query(`ALTER TABLE attachments ADD COLUMN IF NOT EXISTS encrypted_at_rest BOOLEAN NOT NULL DEFAULT FALSE`);

    // Drop NOT NULL on plaintext columns that get NULLed under standard mode.
    // App-layer validation enforces non-empty input on writes.
    await client.query(`ALTER TABLE tickets ALTER COLUMN title DROP NOT NULL`).catch(() => {});
    await client.query(`ALTER TABLE comments ALTER COLUMN body DROP NOT NULL`).catch(() => {});
    await client.query(`ALTER TABLE attachments ALTER COLUMN original_name DROP NOT NULL`).catch(() => {});

    // Blind index: HMAC-of-tokens for ticket title under encrypted mode.
    // Restores word-level search without exposing plaintext.
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS title_blind_idx TEXT[]`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tickets_title_blind ON tickets USING GIN (title_blind_idx)`);

    // Phase 3: JIT support access. Tenant admin approves time-bound access
    // grants for support users; the live `effective_status` is computed at
    // query time from columns + clock so no background job is required.
    await client.query(`
      CREATE TABLE IF NOT EXISTS support_access_grants (
        id SERIAL PRIMARY KEY,
        support_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        requested_by_email TEXT,
        reason TEXT,
        scope TEXT NOT NULL DEFAULT 'read' CHECK (scope IN ('read','read_write')),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','active','revoked','denied')),
        approved_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        approved_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        revoked_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_support_grants_status ON support_access_grants(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_support_grants_user ON support_access_grants(support_user_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS support_access_log (
        id BIGSERIAL PRIMARY KEY,
        grant_id INTEGER REFERENCES support_access_grants(id) ON DELETE SET NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        target_table TEXT,
        target_id INTEGER,
        ip TEXT,
        user_agent TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_support_log_grant ON support_access_log(grant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_support_log_created ON support_access_log(created_at DESC)`);

    // CRM: external companies and contacts attached to tickets via
    // projects with has_external_vendor=true. Names/emails/phones/notes
    // encrypt via shadow columns; contacts.email_blind_idx is a single-
    // token HMAC so the inbound webhook can resolve sender → contact
    // without needing plaintext.
    await client.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id SERIAL PRIMARY KEY,
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT,
        name_enc BYTEA,
        domain TEXT,
        notes TEXT,
        notes_enc BYTEA,
        is_archived BOOLEAN NOT NULL DEFAULT FALSE,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_companies_project ON companies(project_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies(domain)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        name TEXT,
        name_enc BYTEA,
        email TEXT,
        email_enc BYTEA,
        email_blind_idx TEXT,
        phone TEXT,
        phone_enc BYTEA,
        role_title TEXT,
        notes TEXT,
        notes_enc BYTEA,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_contacts_email_blind ON contacts(email_blind_idx)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_contacts_active ON contacts(is_active)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ticket_contacts (
        ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        added_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        added_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (ticket_id, contact_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ticket_contacts_contact ON ticket_contacts(contact_id)`);

    // Workspace-level extension to the generic-mailbox blocklist used when
    // adding vendor contacts. Comma-separated local-parts (e.g. "ops,it").
    await client.query(`ALTER TABLE auth_settings ADD COLUMN IF NOT EXISTS email_blocklist TEXT NOT NULL DEFAULT ''`);

    // Per-comment "share with vendor" toggle. Default FALSE keeps internal
    // discussion internal even when ticket has external contacts attached.
    // The template renderer (services/emailTemplate.js) filters
    // {ticket.reply} / {ticket.replies.N} on this flag, so an admin can
    // never accidentally leak internal threads through a vendor template.
    await client.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS is_external_visible BOOLEAN NOT NULL DEFAULT FALSE`);

    // Admin-editable email templates. event_type + audience is the lookup
    // key; templates carry tag placeholders rendered at send time
    // (services/emailTemplate.js). Not encrypted — no PII in the template
    // text, only structure. is_html toggles between escaped HTML and
    // plaintext rendering.
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_templates (
        id SERIAL PRIMARY KEY,
        event_type TEXT NOT NULL,
        audience TEXT NOT NULL,
        subject_template TEXT NOT NULL,
        body_template TEXT NOT NULL,
        is_html BOOLEAN NOT NULL DEFAULT FALSE,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        default_replies_count INTEGER NOT NULL DEFAULT 3,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        UNIQUE(event_type, audience)
      )
    `);

    // Per-ticket "mute the vendor" toggle. When TRUE, vendor replies
    // matched into the ticket are inserted with comments.is_muted=TRUE
    // and the UI collapses them. Admin/Manager can un-mute any single
    // muted comment they decide is relevant. Default FALSE = vendor
    // replies show normally.
    //
    // The original Phase D shipped this as `allow_inbound_email
    // (DEFAULT TRUE = accept) / FALSE = refuse`. The redesign keeps the
    // signal in-thread instead of throwing it away, so we rename the
    // column and flip the value semantics: NOT(old) = new.
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS auto_mute_vendor_replies BOOLEAN NOT NULL DEFAULT FALSE`);
    // Migrate from the old column if it exists, then drop it.
    const hasOldCol = await client.query(`
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'tickets' AND column_name = 'allow_inbound_email'
    `);
    if (hasOldCol.rows[0]) {
      await client.query(`UPDATE tickets SET auto_mute_vendor_replies = NOT allow_inbound_email`);
      await client.query(`ALTER TABLE tickets DROP COLUMN allow_inbound_email`);
    }

    // Per-comment muted flag. Set automatically when a vendor reply is
    // matched into a ticket whose auto_mute_vendor_replies=TRUE; toggled
    // manually by Admin/Manager via the mute/unmute endpoints.
    await client.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS is_muted BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_comments_muted ON comments(ticket_id, is_muted)`);
    // digested_at lets the daily muted-digest job mark which muted
    // comments have already been rolled into a digest email so a single
    // comment never appears in two days' worth of summaries.
    await client.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS digested_at TIMESTAMPTZ`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_comments_pending_digest ON comments(created_at) WHERE is_muted = TRUE AND digested_at IS NULL`);

    // Workspace-level scheduling for the muted-digest job. The scheduler
    // checks every 5 minutes and runs once the wall-clock has crossed
    // muted_digest_local_hour:minute in the configured timezone for
    // today (system_jobs records the last run).
    await client.query(`ALTER TABLE auth_settings ADD COLUMN IF NOT EXISTS muted_digest_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
    await client.query(`ALTER TABLE auth_settings ADD COLUMN IF NOT EXISTS muted_digest_local_hour INTEGER NOT NULL DEFAULT 15`);
    await client.query(`ALTER TABLE auth_settings ADD COLUMN IF NOT EXISTS muted_digest_local_minute INTEGER NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE auth_settings ADD COLUMN IF NOT EXISTS muted_digest_timezone TEXT NOT NULL DEFAULT 'UTC'`);

    // Generic system-job ledger so the in-process scheduler is idempotent
    // across restarts: if the digest already fired today, skip.
    await client.query(`
      CREATE TABLE IF NOT EXISTS system_jobs (
        name TEXT PRIMARY KEY,
        last_run_at TIMESTAMPTZ,
        last_status TEXT,
        metadata JSONB
      )
    `);
    await client.query(`
      INSERT INTO system_jobs (name) VALUES ('muted_digest')
      ON CONFLICT DO NOTHING
    `);

    // OAuth-backed email backend accounts. Each row is one connected
    // outbound mailbox: a Microsoft 365 user (Graph delegated), a Gmail
    // user (Workspace or consumer with refresh token), or a legacy SMTP
    // box. Refresh tokens / SMTP passwords encrypt under standard mode
    // via the same envelope wrapper used elsewhere; *_enc columns hold
    // the ciphertext and the plaintext column is NULLed when mode flips.
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_backend_accounts (
        id SERIAL PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('graph_user','gmail_user','smtp')),
        display_name TEXT,
        from_address TEXT NOT NULL,
        oauth_provider_user_id TEXT,
        oauth_access_token TEXT,
        oauth_access_token_enc BYTEA,
        oauth_refresh_token TEXT,
        oauth_refresh_token_enc BYTEA,
        oauth_expires_at TIMESTAMPTZ,
        oauth_scope TEXT,
        smtp_host TEXT,
        smtp_port INTEGER,
        smtp_user TEXT,
        smtp_password TEXT,
        smtp_password_enc BYTEA,
        smtp_secure BOOLEAN NOT NULL DEFAULT TRUE,
        is_active BOOLEAN NOT NULL DEFAULT FALSE,
        last_test_at TIMESTAMPTZ,
        last_test_status TEXT,
        last_test_error TEXT,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Only one row may have is_active=TRUE; partial unique index enforces it.
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_email_backend_one_active
      ON email_backend_accounts ((1)) WHERE is_active = TRUE`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_email_backend_provider ON email_backend_accounts(provider)`);

    // Inbox monitoring fields. When inbox_monitor_enabled=TRUE we keep
    // a live subscription with the provider so new mail flows into the
    // inbound queue without an external glue (Mailgun/SES/etc).
    //
    //   Graph: subscription_id is /subscriptions/{id}, expires every 3
    //          days, validated via clientState (we store as
    //          inbox_subscription_secret).
    //   Gmail: subscription_id is the Pub/Sub topic name, state holds
    //          historyId from the last watch response, expires every 7d.
    await client.query(`ALTER TABLE email_backend_accounts ADD COLUMN IF NOT EXISTS inbox_monitor_enabled BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE email_backend_accounts ADD COLUMN IF NOT EXISTS inbox_subscription_id TEXT`);
    await client.query(`ALTER TABLE email_backend_accounts ADD COLUMN IF NOT EXISTS inbox_subscription_secret TEXT`);
    await client.query(`ALTER TABLE email_backend_accounts ADD COLUMN IF NOT EXISTS inbox_subscription_state TEXT`);
    await client.query(`ALTER TABLE email_backend_accounts ADD COLUMN IF NOT EXISTS inbox_subscription_expires_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE email_backend_accounts ADD COLUMN IF NOT EXISTS inbox_last_renewed_at TIMESTAMPTZ`);

    await client.query(`
      INSERT INTO system_jobs (name) VALUES ('inbox_subscription_renewal')
      ON CONFLICT DO NOTHING
    `);

    // Inbound email queue. Webhook adapters (Graph subscription, Gmail
    // push, SMTP/Mailgun) all funnel into this table with status='unmatched'.
    // Inbound NEVER auto-creates tickets or comments — admin matches each
    // message to a ticket explicitly. Subject/body encrypt under standard
    // mode; from_addr_blind_idx is HMAC of normalised sender for fast
    // contact lookup.
    await client.query(`
      CREATE TABLE IF NOT EXISTS inbound_email_queue (
        id SERIAL PRIMARY KEY,
        source TEXT NOT NULL,
        external_message_id TEXT,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        from_addr TEXT,
        from_addr_blind_idx TEXT,
        from_name TEXT,
        to_addr TEXT,
        subject TEXT,
        subject_enc BYTEA,
        body TEXT,
        body_enc BYTEA,
        message_id TEXT,
        in_reply_to TEXT,
        ref_headers TEXT,
        candidate_ticket_ref TEXT,
        status TEXT NOT NULL DEFAULT 'unmatched'
          CHECK (status IN ('unmatched','matched','discarded','spam')),
        matched_ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
        matched_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
        matched_at TIMESTAMPTZ,
        matched_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        raw_headers JSONB
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inbound_status ON inbound_email_queue(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inbound_from_blind ON inbound_email_queue(from_addr_blind_idx)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inbound_received ON inbound_email_queue(received_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inbound_external_id ON inbound_email_queue(external_message_id) WHERE external_message_id IS NOT NULL`);
    // Why a row went unmatched / rejected — surfaces in the admin queue UI.
    await client.query(`ALTER TABLE inbound_email_queue ADD COLUMN IF NOT EXISTS reject_reason TEXT`);
    // Auto-created tickets via the #PREFIX subject route record their
    // origin queue row id so the audit trail back to the email is one
    // hop, not a join chain through comments.
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS source_inbound_email_id INTEGER REFERENCES inbound_email_queue(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS vendor_notified_at TIMESTAMPTZ`);

    // Comments authored by an external contact (matched in from the
    // inbound queue). Preserves attribution without forcing a fake user
    // row in the users table.
    await client.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS vendor_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS source_inbound_email_id INTEGER REFERENCES inbound_email_queue(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT '{}'`);

    // Seed default templates the first time the table is created.
    const tplExisting = await client.query('SELECT COUNT(*)::int AS cnt FROM email_templates');
    if (tplExisting.rows[0].cnt === 0) {
      const defaults = [
        ['new_ticket', 'vendor',
          'New ticket {ticket.ref}: {ticket.title}',
          'Hi {vendor.contact},\n\nA new ticket has been opened with {site.name}:\n\n  Ref: {ticket.ref}\n  Title: {ticket.title}\n  Priority: {ticket.priority}\n\n{ticket.description}\n\nView and reply: {ticket.url}\n\n— {actor.name}'],
        ['new_comment', 'vendor',
          'Update on {ticket.ref}: {ticket.title}',
          'Hi {vendor.contact},\n\nThere is a new update on ticket {ticket.ref}.\n\n{ticket.reply}\n\nFor context, the most recent activity:\n{ticket.replies.3}\n\nView the full thread: {ticket.url}\n\n— {actor.name}'],
        ['status_change', 'vendor',
          '{ticket.ref} status: {ticket.status}',
          'Hi {vendor.contact},\n\nTicket {ticket.ref} ("{ticket.title}") is now {ticket.status}.\n\n{ticket.url}\n\n— {actor.name}'],
        ['ticket_resolved', 'vendor',
          'Resolved: {ticket.ref} {ticket.title}',
          'Hi {vendor.contact},\n\n{ticket.ref} has been marked Resolved.\n\nLast update:\n{ticket.reply}\n\nIf this is incorrect please reply via {ticket.url}.\n\n— {actor.name}'],
        ['ticket_reopened', 'vendor',
          'Reopened: {ticket.ref} {ticket.title}',
          'Hi {vendor.contact},\n\n{ticket.ref} has been reopened and requires further attention.\n\n{ticket.url}\n\n— {actor.name}'],
        ['inbound_matched', 'submitter',
          'Vendor reply on {ticket.ref}',
          'A reply from the vendor was matched to ticket {ticket.ref} ("{ticket.title}"):\n\n{ticket.reply}\n\n{ticket.url}'],
        ['ticket_created_via_email', 'submitter',
          'Ticket created: {ticket.ref}',
          'Hi {actor.name},\n\nYour email was logged as ticket {ticket.ref}.\n\n  Title: {ticket.title}\n  Project: {site.name}\n\nView and follow up: {ticket.url}\n\nReply directly to this email or visit the link to add comments.'],
      ];
      for (const [event, audience, subj, body] of defaults) {
        await client.query(
          `INSERT INTO email_templates (event_type, audience, subject_template, body_template)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [event, audience, subj, body]
        );
      }
    }

    // Rename coastal_ticket_ref → external_ticket_ref (generic sanitization).
    const hasCoastalCol = await client.query(`
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'tickets' AND column_name = 'coastal_ticket_ref'
    `);
    if (hasCoastalCol.rows[0]) {
      await client.query(`ALTER TABLE tickets RENAME COLUMN coastal_ticket_ref TO external_ticket_ref`);
    }


    // Send-as-submitter toggle. When TRUE on a graph_user or gmail_user
    // backend, outbound vendor emails set From to the submitting user and
    // Reply-To to the monitored mailbox (if inbox monitoring is on).
    // Requires Exchange "Send on Behalf Of" (M365) or Gmail delegation
    // granted to the backend account by a tenant admin outside the app.
    await client.query(`ALTER TABLE email_backend_accounts ADD COLUMN IF NOT EXISTS send_as_submitter BOOLEAN NOT NULL DEFAULT FALSE`);

    // In-app notification tray. Surfaces actionable system events to
    // Managers and Admins — e.g. unmatched CC addresses from email intake
    // that need to be resolved as contacts. data JSONB carries
    // event-specific payload (ticket_id, email, domain, suggested_company_id).
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        data JSONB,
        read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, created_at DESC) WHERE read_at IS NULL`);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Atomic per-project ticket counter — returns "PREFIX-NNNN"
async function nextInternalRef(client, projectId) {
  const result = await client.query(
    'UPDATE projects SET ticket_counter = ticket_counter + 1 WHERE id = $1 RETURNING ticket_counter, prefix',
    [projectId]
  );
  if (!result.rows[0]) throw new Error(`Project ${projectId} not found`);
  const { ticket_counter, prefix } = result.rows[0];
  return `${prefix}-${String(ticket_counter).padStart(4, '0')}`;
}

function computePriority(impact, urgency) {
  const raw = impact + urgency - 1;
  return Math.min(Math.max(raw, 1), 5);
}

module.exports = { initSchema, nextInternalRef, computePriority };
