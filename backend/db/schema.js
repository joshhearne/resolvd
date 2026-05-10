const { pool } = require('./pool');
const { DEFAULT_NOTIFICATION_PREFS, DEFAULT_EMAIL_DIGEST } = require('../services/notificationPrefs');

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
    await client.query(`ALTER TABLE branding ADD COLUMN IF NOT EXISTS phonetic_readback_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
    await client.query(`ALTER TABLE branding ADD COLUMN IF NOT EXISTS logo_designed_for TEXT NOT NULL DEFAULT 'light' CHECK (logo_designed_for IN ('light','dark'))`);
    // Custom favicon doubles as the PWA / iOS home-screen icon. Stored as
    // a filename in UPLOADS_DIR; served at /api/branding/favicon.
    await client.query(`ALTER TABLE branding ADD COLUMN IF NOT EXISTS favicon_filename TEXT`);
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
    // Per-project mention/follower scope overrides. NULL means "inherit
    // the org-wide default from branding". TRUE/FALSE explicitly overrides
    // it for this project. Admins (global role) bypass the gate either way.
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS restrict_followers_to_members BOOLEAN`);
    await client.query(`ALTER TABLE projects ALTER COLUMN restrict_followers_to_members DROP NOT NULL`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS restrict_mentions_to_members BOOLEAN`);
    // When TRUE, every newly-activated user (SSO first login or invite
    // acceptance) is automatically added as a project member. Useful for
    // org-wide queues like the helpdesk / incident project where every
    // employee should be able to file or follow.
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_add_new_users BOOLEAN NOT NULL DEFAULT FALSE`);

    // BYO-AI project context: admin-authored markdown that gets prepended
    // to the AI rewrite system prompt for tickets in this project. Lets
    // the model speak the project's lingo (sites, integrations, glossary)
    // without the user having to rewrite every reference. Per-project
    // toggle so admins can disable it on noisy projects without losing
    // the authored content.
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS ai_context_md TEXT`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS ai_context_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
    // Global defaults (admin panel). Apply when a project hasn't set its
    // own value. Defaults TRUE so a fresh install is locked down.
    await client.query(`ALTER TABLE branding ADD COLUMN IF NOT EXISTS default_restrict_followers BOOLEAN NOT NULL DEFAULT TRUE`);
    await client.query(`ALTER TABLE branding ADD COLUMN IF NOT EXISTS default_restrict_mentions BOOLEAN NOT NULL DEFAULT TRUE`);
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

    // Companies are now multi-modal:
    //   vendor   — external party we escalate to (existing default).
    //              project_id stays mandatory at the app layer for vendors
    //              to keep the existing per-project escalation flow intact.
    //   customer — external party we *serve* (MSP mode). project_id may be
    //              NULL; multi-project linkage rides on company_projects.
    //   internal — your own org's units (Internal IT, DevOps, dept). No
    //              external contacts; members are real users; tracks
    //              physical locations.
    await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'vendor'`);
    await client.query(`ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_kind_check`);
    await client.query(`ALTER TABLE companies ADD CONSTRAINT companies_kind_check CHECK (kind IN ('vendor','customer','internal'))`);
    await client.query(`ALTER TABLE companies ALTER COLUMN project_id DROP NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_companies_kind ON companies(kind)`);

    // Locations — physical sites, primarily for internal companies but
    // available on customers too (MSPs track multi-site customers).
    // location_code is optional shorthand (e.g. "HQ", "EAST"). use_extensions
    // flips the contact-create UX: pre-fill phone from location, ask only
    // for ext. is_primary drives default selection in pickers.
    await client.query(`
      CREATE TABLE IF NOT EXISTS locations (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        location_code TEXT,
        address TEXT,
        timezone TEXT,
        phone TEXT,
        use_extensions BOOLEAN NOT NULL DEFAULT FALSE,
        is_primary BOOLEAN NOT NULL DEFAULT FALSE,
        is_archived BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_locations_company ON locations(company_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_one_primary
      ON locations(company_id) WHERE is_primary = TRUE AND is_archived = FALSE`);

    // Internal/customer companies can attribute Resolvd users to themselves.
    // role kept as a free-text label for now; bare list w/ optional location.
    await client.query(`
      CREATE TABLE IF NOT EXISTS company_members (
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
        role_label TEXT,
        added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (company_id, user_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_company_members_user ON company_members(user_id)`);

    // Customer-kind multi-project mapping. One customer org might span
    // their helpdesk, infra, and security projects. Vendors stick with
    // companies.project_id for now.
    await client.query(`
      CREATE TABLE IF NOT EXISTS company_projects (
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        PRIMARY KEY (company_id, project_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_company_projects_project ON company_projects(project_id)`);

    // Contacts can attach to a specific location for routing + extension
    // pre-fill. extension lives alongside phone for compactness.
    await client.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS extension TEXT`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_contacts_location ON contacts(location_id)`);

    // Admin-controlled feature flags for which company modes are active.
    // Internal stays on by default since users always live somewhere.
    // Customer (MSP mode) defaults OFF since most installs run helpdesk
    // for their own org and exposing customer-facing visibility is a
    // policy decision.
    await client.query(`ALTER TABLE branding ADD COLUMN IF NOT EXISTS enable_vendor_companies BOOLEAN NOT NULL DEFAULT TRUE`);
    await client.query(`ALTER TABLE branding ADD COLUMN IF NOT EXISTS enable_customer_companies BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE branding ADD COLUMN IF NOT EXISTS enable_internal_companies BOOLEAN NOT NULL DEFAULT TRUE`);

    // Domain-based auto-membership for internal companies. Comma-stored as
    // a TEXT[] of lowercased apex domains ("acme.com", "acme.co.uk"). On
    // user activation we match user.email's domain against any internal
    // company's array and insert company_members rows. NULL or empty =
    // auto-join disabled for that company. Only meaningful for kind='internal'.
    await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS auto_add_domains TEXT[]`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_companies_auto_add_domains ON companies USING GIN(auto_add_domains)`);

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
    await client.query(`
      INSERT INTO system_jobs (name) VALUES ('auto_close')
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

    // Per-account regex patterns applied to inbound mail bodies before
    // ingestion. Lets admins strip recipient banners injected by mail
    // security gateways (Inky, Mimecast, Proofpoint, Avanan) when they
    // can't suppress the banner upstream. Patterns are POSIX-style and
    // applied with case-insensitive multi-line flags. Empty array =
    // no per-account stripping.
    await client.query(`ALTER TABLE email_backend_accounts ADD COLUMN IF NOT EXISTS inbound_banner_strip_patterns TEXT[] NOT NULL DEFAULT '{}'`);

    // Many-to-many scope between email accounts and projects. An account
    // can serve N projects; a project can be served by N accounts.
    // send_enabled / recv_enabled toggle the direction independently.
    // approved_by/approved_at gate dedicated single-project scopes —
    // when an account ends up scoped to exactly one project, an Admin
    // must approve before inbound auto-creates land in that project
    // (prevents Manager from making a covert "all mail to my project"
    // mailbox without oversight). Multi-project scopes don't require
    // approval since they fall through to existing #PREFIX routing.
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_account_project_scopes (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES email_backend_accounts(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        send_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        recv_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        approved_at TIMESTAMPTZ,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(account_id, project_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_email_scopes_project ON email_account_project_scopes(project_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_email_scopes_account ON email_account_project_scopes(account_id)`);

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

    // Web Push subscriptions. One row per (user, browser/device) — endpoint
    // is unique. p256dh + auth are the encryption keys the browser hands
    // back when subscribing; web-push needs both to encrypt payloads.
    await client.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        user_agent TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id)`);

    // External alert ingestion (Zabbix, Alertmanager, generic webhook, etc.).
    // One row per configured monitoring source. Token is hashed (sha256) at
    // rest; raw token is shown to the admin once on create/rotate. Severity
    // map is preset-specific (e.g. Zabbix Disaster→1 ... Info→5) and merges
    // over the preset's built-in defaults at receive time.
    await client.query(`
      CREATE TABLE IF NOT EXISTS external_alert_source (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        preset TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        default_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        default_assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        severity_map JSONB NOT NULL DEFAULT '{}'::jsonb,
        auto_resolve_on_recovery BOOLEAN NOT NULL DEFAULT FALSE,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        last_seen_at TIMESTAMPTZ,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_alert_source_token ON external_alert_source(token_hash)`);
    // Optional outbound API connection back to the monitoring tool. Lets
    // Resolvd pull (backfill open problems, ack-on-close future). Token
    // encrypts under standard mode via the standard envelope wrapper.
    await client.query(`ALTER TABLE external_alert_source ADD COLUMN IF NOT EXISTS api_url TEXT`);
    await client.query(`ALTER TABLE external_alert_source ADD COLUMN IF NOT EXISTS api_token TEXT`);
    await client.query(`ALTER TABLE external_alert_source ADD COLUMN IF NOT EXISTS api_token_enc BYTEA`);
    await client.query(`ALTER TABLE external_alert_source ADD COLUMN IF NOT EXISTS api_last_ok_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE external_alert_source ADD COLUMN IF NOT EXISTS api_last_error TEXT`);

    // Audit + dedup log. UNIQUE(source_id, external_event_id) blocks Zabbix
    // resends from spawning duplicate tickets even if the mapper logic
    // changes. raw_payload kept for debugging when a mapper misbehaves.
    await client.query(`
      CREATE TABLE IF NOT EXISTS external_alert_event (
        id SERIAL PRIMARY KEY,
        source_id INTEGER NOT NULL REFERENCES external_alert_source(id) ON DELETE CASCADE,
        external_event_id TEXT NOT NULL,
        ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        raw_payload JSONB NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(source_id, external_event_id, event_type)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_alert_event_source ON external_alert_event(source_id, received_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_alert_event_ticket ON external_alert_event(ticket_id)`);

    // Tickets carry a back-pointer to the originating monitoring event so
    // recoveries / repeat-firings can find the open ticket. Format:
    //   external_ref = '<preset>:<external_event_id>'  e.g. 'zabbix:1842937'
    // Partial unique index prevents two open tickets sharing a ref while
    // still allowing the column to be NULL for human-filed tickets.
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS external_ref TEXT`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS external_source TEXT`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS external_alert_source_id INTEGER REFERENCES external_alert_source(id) ON DELETE SET NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tickets_external_ref ON tickets(external_ref) WHERE external_ref IS NOT NULL`);

    // Canned responses — reusable comment text. scope='global' rows are
    // visible to everyone; scope='user' rows belong to user_id only.
    // category is free-form for grouping in the picker UI ("Printer",
    // "Vendor", etc.). use_count + last_used_at drive a "frequent" sort.
    await client.query(`
      CREATE TABLE IF NOT EXISTS canned_responses (
        id SERIAL PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'user')),
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        category TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        use_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TIMESTAMPTZ,
        CONSTRAINT canned_user_scope_consistency CHECK (
          (scope = 'global' AND user_id IS NULL) OR
          (scope = 'user' AND user_id IS NOT NULL)
        )
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_canned_user ON canned_responses(user_id) WHERE user_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_canned_scope ON canned_responses(scope, category)`);
    // Optional per-project scope. NULL or empty array = applies to all
    // projects. When set, the response only surfaces for tickets in one
    // of the listed projects.
    await client.query(`ALTER TABLE canned_responses ADD COLUMN IF NOT EXISTS project_ids INTEGER[]`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_canned_projects ON canned_responses USING GIN(project_ids)`);

    // ── Notifications matrix refactor ────────────────────────────────────
    // Buffered email rows when a user has email_digest != 'instant'.
    // Each row carries enough payload snapshot to render the digest
    // without re-querying the source ticket. Indexed for the flusher's
    // "ripe & unsent" lookup.
    await client.query(`
      CREATE TABLE IF NOT EXISTS notification_outbox (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        scheduled_flush_at TIMESTAMPTZ NOT NULL,
        sent_at TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_notif_outbox_pending ON notification_outbox (user_id, scheduled_flush_at) WHERE sent_at IS NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_notif_outbox_ticket ON notification_outbox (ticket_id) WHERE sent_at IS NULL`);
    await client.query(`INSERT INTO system_jobs (name) VALUES ('notification_outbox') ON CONFLICT DO NOTHING`);

    // Backfill notification_prefs + email_digest into every existing
    // users.preferences blob. Only writes the keys when missing — safe
    // to re-run.
    await client.query(`
      UPDATE users
         SET preferences = preferences
           || CASE WHEN preferences ? 'notification_prefs' THEN '{}'::jsonb
                   ELSE jsonb_build_object('notification_prefs', $1::jsonb) END
           || CASE WHEN preferences ? 'email_digest' THEN '{}'::jsonb
                   ELSE jsonb_build_object('email_digest', $2::text) END
    `, [JSON.stringify(DEFAULT_NOTIFICATION_PREFS), DEFAULT_EMAIL_DIGEST]);

    // One-time legacy-key sweep. The five deprecated flags are no longer
    // read; strip them so users.preferences stays clean. Idempotent —
    // re-running is a no-op once the keys are gone.
    await client.query(`
      UPDATE users
         SET preferences = preferences
           - 'email_on_comment'
           - 'email_on_status_change'
           - 'email_on_assignment'
           - 'push_on_assignment'
           - 'push_on_mention'
       WHERE preferences ?| ARRAY[
         'email_on_comment','email_on_status_change',
         'email_on_assignment','push_on_assignment','push_on_mention'
       ]
    `);

    // ── SLA tracker ──────────────────────────────────────────────────────
    // One row per (priority, project_id) pair. project_id IS NULL = org
    // default. Project-specific row overrides the default for that
    // (project, priority). Targets in minutes; sla.js converts to/from
    // due-at timestamps when applying to tickets.
    await client.query(`
      CREATE TABLE IF NOT EXISTS sla_policies (
        id SERIAL PRIMARY KEY,
        priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 5),
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        response_target_minutes INTEGER NOT NULL CHECK (response_target_minutes > 0),
        resolve_target_minutes INTEGER NOT NULL CHECK (resolve_target_minutes > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Cannot enforce UNIQUE(priority, project_id) directly because NULL
    // is not equal to NULL — use a partial unique index pair.
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sla_policies_org_default
      ON sla_policies(priority) WHERE project_id IS NULL`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sla_policies_project
      ON sla_policies(priority, project_id) WHERE project_id IS NOT NULL`);

    // Per-ticket SLA timer columns. Set on create from policyForTicket().
    // first_response_at populates when the first qualifying comment
    // posts (non-system, not by submitter). paused_at + paused_seconds
    // implement pause-on-blocker semantics so vendor/customer wait time
    // doesn't count against us.
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_first_response_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_response_due_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_resolve_due_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_paused_seconds INTEGER NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_paused_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_response_breached BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_resolve_breached BOOLEAN NOT NULL DEFAULT FALSE`);
    // When the breach flag was first flipped — drives MTD breach
    // counts on the dashboard. Stays NULL for unbreached tickets.
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_response_breached_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_resolve_breached_at TIMESTAMPTZ`);
    // Backfill timestamps for any tickets that were already flagged
    // breached before this column existed. Use the due_at as the best
    // proxy. Only updates rows missing the timestamp — idempotent.
    await client.query(`
      UPDATE tickets SET sla_response_breached_at = sla_response_due_at
       WHERE sla_response_breached = TRUE
         AND sla_response_breached_at IS NULL
         AND sla_response_due_at IS NOT NULL
    `);
    await client.query(`
      UPDATE tickets SET sla_resolve_breached_at = sla_resolve_due_at
       WHERE sla_resolve_breached = TRUE
         AND sla_resolve_breached_at IS NULL
         AND sla_resolve_due_at IS NOT NULL
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tickets_sla_response_breached_at
      ON tickets(sla_response_breached_at) WHERE sla_response_breached_at IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tickets_sla_resolve_breached_at
      ON tickets(sla_resolve_breached_at) WHERE sla_resolve_breached_at IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tickets_sla_response_due
      ON tickets(sla_response_due_at) WHERE sla_response_due_at IS NOT NULL AND sla_first_response_at IS NULL AND sla_response_breached = FALSE`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tickets_sla_resolve_due
      ON tickets(sla_resolve_due_at) WHERE sla_resolve_due_at IS NOT NULL AND resolved_at IS NULL AND sla_resolve_breached = FALSE`);

    await client.query(`INSERT INTO system_jobs (name) VALUES ('sla_breach_check') ON CONFLICT DO NOTHING`);

    // Sensible org-default targets per priority. Idempotent: only inserts
    // when the row doesn't already exist. Customers tune these in the
    // admin UI; these are starting values.
    //   P1: respond within 30 min, resolve within 4 hrs   (critical)
    //   P2: respond within 1 hr,    resolve within 8 hrs   (high)
    //   P3: respond within 4 hrs,   resolve within 24 hrs  (normal)
    //   P4: respond within 8 hrs,   resolve within 72 hrs  (low)
    //   P5: respond within 1 day,   resolve within 7 days  (cosmetic / planning)
    await client.query(`
      INSERT INTO sla_policies (priority, project_id, response_target_minutes, resolve_target_minutes)
      VALUES
        (1, NULL,   30,    240),
        (2, NULL,   60,    480),
        (3, NULL,  240,   1440),
        (4, NULL,  480,   4320),
        (5, NULL, 1440,  10080)
      ON CONFLICT DO NOTHING
    `);

    // One-time backfill: any pre-existing ticket without sla_*_due_at
    // gets timers stamped from its created_at + the matching policy
    // target. Tickets already past due will be flagged on the next
    // breach tick. Updates only rows where the column is currently null
    // — re-running the migration is a no-op once stamped.
    await client.query(`
      UPDATE tickets t
         SET sla_response_due_at = t.created_at + (sp.response_target_minutes || ' minutes')::interval,
             sla_resolve_due_at  = t.created_at + (sp.resolve_target_minutes  || ' minutes')::interval
        FROM sla_policies sp
       WHERE sp.project_id IS NULL
         AND sp.priority = COALESCE(t.effective_priority, 3)
         AND t.sla_response_due_at IS NULL
         AND t.sla_resolve_due_at IS NULL
    `);
    // ── BYO-AI text rewrite ──────────────────────────────────────────────
    // Per-user encrypted API key for the user's chosen AI provider.
    // Non-secret config (provider id, endpoint, model, default tone /
    // verbosity, enabled flag) lives under users.preferences.ai_assist
    // JSONB — no schema needed. The api key is always encrypted at rest
    // via the standard envelope wrapper.
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_api_key_enc BYTEA`);

    // Org-level kill switch. Admin can disable BYO-AI for the entire org
    // (compliance / data-handling override). Default ON — feature is
    // opt-in per user; org-level just gates whether per-user opt-in is
    // possible at all.
    await client.query(`ALTER TABLE branding ADD COLUMN IF NOT EXISTS ai_assist_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
    // Org-wide toggle for the project AI context feature. When OFF, no
    // project's ai_context_md is ever included in the rewrite prompt
    // regardless of per-project / per-user settings. Default ON.
    await client.query(`ALTER TABLE branding ADD COLUMN IF NOT EXISTS ai_project_context_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
    // Org-wide visibility tier for the AI usage badge on comments +
    // tickets. 'self_and_admin' (default) = author + Admins see; 'admin_only'
    // = Admins only; 'all_users' = every internal user sees (vendors never).
    // A per-comment ai_publish_consent (snapshotted from the author's user
    // pref at apply time) can override admin_only/self_and_admin upward to
    // org-wide visibility for that single comment.
    await client.query(`ALTER TABLE branding ADD COLUMN IF NOT EXISTS ai_disclosure_audience TEXT NOT NULL DEFAULT 'self_and_admin' CHECK (ai_disclosure_audience IN ('self_and_admin','admin_only','all_users'))`);

    // Per-rewrite log. Every successful /api/ai/rewrite call writes a
    // row. When the user clicks 'Apply' in the modal, the consuming
    // endpoint (comment POST / ticket description PATCH) takes the
    // log_id, validates ownership + un-applied state, copies the
    // provider/model/tokens onto the saved row, and marks the log as
    // applied. Logs are kept long-term for usage reporting; one-shot
    // 'applied' flag prevents replay.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_rewrite_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        surface TEXT NOT NULL,
        project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        tone TEXT,
        verbosity TEXT,
        eli5 BOOLEAN NOT NULL DEFAULT FALSE,
        applied_to_table TEXT,
        applied_to_id INTEGER,
        applied_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ai_rewrite_logs_user_created ON ai_rewrite_logs(user_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ai_rewrite_logs_unapplied ON ai_rewrite_logs(user_id) WHERE applied_at IS NULL`);
    // Track whether the project AI context was actually injected on this
    // call. Surfaces in the badge popover as an extra disclosure line.
    await client.query(`ALTER TABLE ai_rewrite_logs ADD COLUMN IF NOT EXISTS project_context_used BOOLEAN NOT NULL DEFAULT FALSE`);

    // Per-comment AI usage metadata. Set when an AI rewrite was applied
    // before posting. ai_publish_consent snapshots the author's
    // 'publish my AI usage' pref at apply time so future pref changes
    // don't retroactively widen visibility.
    await client.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS ai_provider TEXT`);
    await client.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS ai_model TEXT`);
    await client.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS ai_input_tokens INTEGER`);
    await client.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS ai_output_tokens INTEGER`);
    await client.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS ai_tone TEXT`);
    await client.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS ai_verbosity TEXT`);
    await client.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS ai_eli5 BOOLEAN`);
    await client.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS ai_publish_consent BOOLEAN`);
    await client.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS ai_project_context_used BOOLEAN`);

    // Same metadata for tickets (description / title rewrites).
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ai_provider TEXT`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ai_model TEXT`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ai_input_tokens INTEGER`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ai_output_tokens INTEGER`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ai_tone TEXT`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ai_verbosity TEXT`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ai_eli5 BOOLEAN`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ai_publish_consent BOOLEAN`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ai_project_context_used BOOLEAN`);

    // ── Login security — attempt audit + IP-based blocking ──────────────
    // Logs every /auth/local/login + bootstrap attempt for forensics and
    // to feed the IP rate limiter. Indexed by ip + email for fast
    // lookback windows. Rows are small; long retention OK.
    await client.query(`
      CREATE TABLE IF NOT EXISTS login_attempts (
        id BIGSERIAL PRIMARY KEY,
        email_attempted TEXT,
        ip TEXT,
        user_agent TEXT,
        success BOOLEAN NOT NULL,
        reason TEXT,
        honeypot_filled BOOLEAN NOT NULL DEFAULT FALSE,
        form_dwell_ms INTEGER,
        attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts(ip, attempted_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_login_attempts_email_time ON login_attempts(email_attempted, attempted_at DESC) WHERE email_attempted IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_login_attempts_failures ON login_attempts(ip, attempted_at DESC) WHERE success = FALSE`);

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
