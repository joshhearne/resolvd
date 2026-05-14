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

    // Ticket-asset linking. Off by default — admins opt in per project.
    // asset_company_ids = empty array means "any asset", non-empty
    // restricts pickable assets to those companies (MSP isolation).
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS allow_asset_linking BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS asset_company_ids INTEGER[] NOT NULL DEFAULT '{}'::int[]`);
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
    // is_agent marks a member as eligible for ticket assignment within
    // this project. Replaces the previous role-based filter (which
    // assumed Admin/Manager/Tech == assignable everywhere). A user can
    // be an agent on one project but not another. Org-default policies
    // (project_id IS NULL) treat anyone who is an agent on ANY project
    // as a candidate.
    await client.query(`ALTER TABLE project_members ADD COLUMN IF NOT EXISTS is_agent BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_project_members_agent ON project_members(project_id) WHERE is_agent = TRUE`);

    // Per-user starred projects. Used by Projects + KB index pages to
    // float favored projects to the top and (eventually) by anywhere
    // else that lists projects. Composite PK + cascade keeps the table
    // self-cleaning: deleting the user or project removes the row.
    // Membership is NOT enforced here — admins can star projects they
    // aren't members of (they see all projects); per-page list queries
    // already filter to accessible projects so unreachable stars become
    // dead rows harmlessly until the user re-stars somewhere visible.
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_starred_projects (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, project_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_starred_user ON user_starred_projects(user_id)`);

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
    // Resolved vendor-outbound actor for this comment. Stamped at comment
    // create time when the client signals attachments are coming
    // (defer_vendor_email=true), so the attachment-upload handler can
    // fire sendVendorEmail with the original send_as identity once files
    // are linked — avoids the race where vendor email leaves before the
    // attachments land. NULL when the comment fired vendor email inline.
    await client.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS vendor_actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL`);
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
    // api_client_id holds the OAuth2 client identifier for presets that use
    // client_credentials (Action1). Not secret — pairs with api_token (which
    // holds the client_secret under encryption).
    await client.query(`ALTER TABLE external_alert_source ADD COLUMN IF NOT EXISTS api_client_id TEXT`);
    await client.query(`ALTER TABLE external_alert_source ADD COLUMN IF NOT EXISTS api_last_ok_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE external_alert_source ADD COLUMN IF NOT EXISTS api_last_error TEXT`);
    // Periodic poll (Action1: no webhook channel, so the scheduler pulls
    // policy results on this cadence). 0 = disabled, else minutes between
    // ticks. last_poll_at marks the most recent attempt (success or fail).
    await client.query(`ALTER TABLE external_alert_source ADD COLUMN IF NOT EXISTS poll_interval_minutes INTEGER NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE external_alert_source ADD COLUMN IF NOT EXISTS last_poll_at TIMESTAMPTZ`);
    // When enabled, the source also feeds the inventory module. Multiple
    // sources can feed inventory simultaneously; phase 2 adds a priority
    // list for dedup. For now the latest write wins per (source_system,
    // source_external_id).
    await client.query(`ALTER TABLE external_alert_source ADD COLUMN IF NOT EXISTS affect_inventory BOOLEAN NOT NULL DEFAULT FALSE`);
    // Per-source attribute mapping. Format:
    //   { "<source attribute name>": {
    //       type:   'asset_column' | 'custom_field',
    //       target: <asset column name> | <custom_field_defs.id> }
    //   }
    // Action1 returns a custom[] array of {name, value}; each entry can
    // be routed via this map to either a built-in asset column or a
    // custom field def. Empty {} = no mapping (current behavior). The
    // asset_column whitelist lives in services/action1Poll.js to prevent
    // writing arbitrary columns through user input.
    await client.query(`ALTER TABLE external_alert_source ADD COLUMN IF NOT EXISTS attribute_map JSONB NOT NULL DEFAULT '{}'::jsonb`);
    // Inventory company override — pins every asset from this source to
    // one Resolvd company. Useful for per-customer sources (Zabbix
    // instance dedicated to customer A's network). Multi-tenant sources
    // (Action1 with multiple orgs) leave this NULL and let the org-name
    // matcher in services/upnMatch.js resolve per-asset.
    await client.query(`ALTER TABLE external_alert_source ADD COLUMN IF NOT EXISTS inventory_company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL`);
    // Hudu-style explicit org→company mapping for multi-tenant sources
    // where the integration ships customer org names that don't match
    // Resolvd company names exactly. Format:
    //   { "<source org name>": <resolvd_company_id>, ... }
    // Resolution at sync time prefers inventory_company_id over this,
    // and this over the per-asset name matcher. Lets an admin route
    // "Motorhomes of Texas — Site 1" + "Motorhomes of Texas HQ" +
    // "Internal IT Infrastructure" all to one MOT company.
    await client.query(`ALTER TABLE external_alert_source ADD COLUMN IF NOT EXISTS company_map JSONB NOT NULL DEFAULT '{}'::jsonb`);

    // Phase 0 of the multi-vendor integrations refactor. New columns
    // layered onto external_alert_source so it can model any RMM /
    // monitor / webhook-only vendor, not just Action1 + Zabbix. The
    // table will be renamed to `integrations` in a future release; for
    // now we add an aliasing VIEW so new code can read by the better
    // name without breaking existing routes.
    //   vendor       — e.g. 'action1', 'ninjaone', 'datto', 'zabbix'.
    //                  Backfilled from preset (1:1 for current installs).
    //                  Adapter registry keys off this column.
    //   kind         — coarse category for the admin UI: rmm /
    //                  monitor / webhook_only. Drives default form
    //                  rendering when an adapter doesn't fully declare
    //                  its credentials schema yet.
    //   capabilities — declared by the adapter. Drives which sections
    //                  of the admin UI render (alerts tuning, inventory
    //                  company override, software sync, etc.).
    //   field_map    — generic JSON-path → resolvd-field tabular map.
    //                  Supersedes attribute_map for new vendors; old
    //                  rows continue using attribute_map until migrated.
    await client.query(`ALTER TABLE external_alert_source ADD COLUMN IF NOT EXISTS vendor TEXT`);
    await client.query(`ALTER TABLE external_alert_source ADD COLUMN IF NOT EXISTS kind TEXT`);
    await client.query(`ALTER TABLE external_alert_source ADD COLUMN IF NOT EXISTS capabilities TEXT[] NOT NULL DEFAULT '{}'::text[]`);
    await client.query(`ALTER TABLE external_alert_source ADD COLUMN IF NOT EXISTS field_map JSONB NOT NULL DEFAULT '{}'::jsonb`);

    // Backfill vendor + kind + capabilities from the legacy preset
    // column. Idempotent — only writes when the new columns are still
    // empty / NULL so the admin's later edits aren't clobbered. After
    // every install runs this once, the adapter registry takes over.
    await client.query(`
      UPDATE external_alert_source
         SET vendor = COALESCE(vendor, preset),
             kind = COALESCE(kind,
               CASE preset
                 WHEN 'action1' THEN 'rmm'
                 WHEN 'zabbix'  THEN 'monitor'
                 ELSE 'webhook_only'
               END),
             capabilities = CASE
               WHEN array_length(capabilities, 1) IS NULL THEN
                 CASE preset
                   WHEN 'action1' THEN ARRAY['alerts','inventory','software','vulnerabilities','companies']::text[]
                   WHEN 'zabbix'  THEN ARRAY['alerts']::text[]
                   ELSE ARRAY['alerts']::text[]
                 END
               ELSE capabilities
             END
       WHERE vendor IS NULL OR kind IS NULL OR array_length(capabilities, 1) IS NULL
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_alert_source_vendor ON external_alert_source(vendor) WHERE vendor IS NOT NULL`);

    // Forward-readers should use `integrations`. Old `external_alert_source`
    // remains the writable table this release; next release renames the
    // base table and drops the view in favor of the real name.
    await client.query(`CREATE OR REPLACE VIEW integrations AS SELECT * FROM external_alert_source`);

    // Raw inbound payload store. Every webhook hit lands here verbatim
    // before mapping runs, so:
    //   * the admin can debug a failed mapping by inspecting the actual
    //     payload (no need to re-trigger the upstream tool);
    //   * a "Test against last payload" button on the field-map editor
    //     can replay an event without touching the live vendor;
    //   * we can reprocess events after tweaking field_map.
    // status: 'pending' (just landed) | 'processed' (mapping ran ok) |
    //   'error' (mapping or ingest threw — see error_message).
    // ticket_id back-points to the ticket created/updated by ingest
    // when successful; NULL on errors or pure-event-no-side-effects.
    await client.query(`
      CREATE TABLE IF NOT EXISTS integration_inbound_events (
        id BIGSERIAL PRIMARY KEY,
        integration_id INTEGER REFERENCES external_alert_source(id) ON DELETE CASCADE,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','error')),
        error_message TEXT,
        payload JSONB NOT NULL,
        ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inbound_events_integration ON integration_inbound_events(integration_id, received_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inbound_events_status ON integration_inbound_events(status) WHERE status <> 'processed'`);
    // Retention: 30 days of payloads is plenty for debugging and
    // replay. Run cheap on every schema init so the table stays
    // bounded without a separate cron job — deletes are FK-cascaded
    // through ticket_id (SET NULL) so old debug rows stay viewable
    // after tickets are pruned upstream.
    await client.query(`DELETE FROM integration_inbound_events WHERE received_at < NOW() - INTERVAL '30 days'`);

    // Phase 4 — Software-name normalization across vendors.
    //
    // Different RMMs ship the same product under different strings
    // ("Adobe Acrobat DC" vs "Adobe Acrobat Pro DC 64-bit"). Reports
    // that count installs need the canonical name to roll up correctly.
    //
    // software_aliases is admin-curated: each row maps a pattern
    // (LIKE, or full regex when is_regex=TRUE) to a canonical
    // {name, vendor} pair. The software-pull adapters consult this
    // table at insert time and stamp the canonical columns on
    // asset_software so dashboards / reports / dedup queries can group
    // by canonical instead of raw vendor strings.
    //
    // Raw name + vendor stay on asset_software so admins can see what
    // the upstream actually sent, and the alias list can grow / change
    // without rewriting historical rows (canonical is recomputed on
    // next sync).
    await client.query(`
      CREATE TABLE IF NOT EXISTS software_aliases (
        id SERIAL PRIMARY KEY,
        pattern TEXT NOT NULL,
        is_regex BOOLEAN NOT NULL DEFAULT FALSE,
        canonical_name TEXT NOT NULL,
        canonical_vendor TEXT,
        priority INTEGER NOT NULL DEFAULT 100,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_software_aliases_priority ON software_aliases(priority, id)`);

    // asset_software gains canonical_name + canonical_vendor. Nullable
    // by design — when no alias matches, the raw name IS the canonical
    // (the UI handles the fallback). last_alias_id back-references the
    // row that won the match so the admin can audit and a deleted /
    // edited alias can trigger a resync.
    await client.query(`ALTER TABLE asset_software ADD COLUMN IF NOT EXISTS canonical_name TEXT`);
    await client.query(`ALTER TABLE asset_software ADD COLUMN IF NOT EXISTS canonical_vendor TEXT`);
    await client.query(`ALTER TABLE asset_software ADD COLUMN IF NOT EXISTS last_alias_id INTEGER REFERENCES software_aliases(id) ON DELETE SET NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_asset_software_canonical ON asset_software(LOWER(canonical_name)) WHERE canonical_name IS NOT NULL`);

    // pg_trgm is needed for the "near-duplicates" suggestion endpoint
    // (similarity() function). Enabling it is cheap and idempotent.
    // If the extension isn't available on the install (rare — it ships
    // with stock Postgres), the route degrades to "no suggestions"
    // rather than erroring.
    await client.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`).catch(() => {
      console.warn('pg_trgm extension unavailable — software-alias near-dupe suggestions will be empty');
    });

    // Inventory module — one row per managed machine, scoped per source
    // system. source_external_id is the RMM's stable id for the device
    // (Action1 endpoint id, ConnectWise asset id, etc.). raw_data holds
    // the upstream payload verbatim for fields we don't surface yet.
    await client.query(`
      CREATE TABLE IF NOT EXISTS assets (
        id SERIAL PRIMARY KEY,
        source_system TEXT NOT NULL,
        source_external_id TEXT NOT NULL,
        source_alert_source_id INTEGER REFERENCES external_alert_source(id) ON DELETE SET NULL,
        hostname TEXT,
        serial TEXT,
        mac TEXT,
        manufacturer TEXT,
        model TEXT,
        os TEXT,
        os_version TEXT,
        cpu TEXT,
        ram_bytes BIGINT,
        storage_bytes BIGINT,
        ip_address TEXT,
        organization TEXT,
        last_seen_at TIMESTAMPTZ,
        raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(source_system, source_external_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_assets_hostname ON assets(hostname)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_assets_serial ON assets(serial) WHERE serial IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_assets_last_seen ON assets(last_seen_at DESC NULLS LAST)`);
    // Cross-references — asset → user (auto-resolved from RMM's reported
    // username via the UPN matcher) and asset → company (auto-resolved
    // from the source system's organization label when names match).
    // Both nullable; matcher leaves them NULL when ambiguous so the
    // admin can correct manually later.
    await client.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS linked_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_assets_linked_user ON assets(linked_user_id) WHERE linked_user_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_assets_company ON assets(company_id) WHERE company_id IS NOT NULL`);

    // Asset types — drives which fields apply per asset. Seeded with a
    // handful of common kinds (workstation, server, printer, monitor,
    // voip phone, etc.). is_system marks the shipped defaults so the
    // UI can prevent accidental deletion. Admin can add custom types
    // for anything else (door reader, sensor, signage display, etc.).
    await client.query(`
      CREATE TABLE IF NOT EXISTS asset_types (
        id SERIAL PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        icon TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_system BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Per-type field list. Each row says "this builtin column on
    // assets applies to this type". Required + sort_order control
    // form rendering + validation. Phase 1B-2 keeps this to builtin
    // columns only; custom-field-defs continue to apply globally
    // (per asset entity, not per type). Per-type custom slots can
    // come later if real usage demands.
    await client.query(`
      CREATE TABLE IF NOT EXISTS asset_type_fields (
        id SERIAL PRIMARY KEY,
        type_id INTEGER NOT NULL REFERENCES asset_types(id) ON DELETE CASCADE,
        builtin_key TEXT NOT NULL,
        required BOOLEAN NOT NULL DEFAULT FALSE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        UNIQUE(type_id, builtin_key)
      )
    `);

    await client.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS asset_type_id INTEGER REFERENCES asset_types(id) ON DELETE SET NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(asset_type_id) WHERE asset_type_id IS NOT NULL`);

    // Security posture — pulled from RMM payloads each sync. Critical
    // counts get their own column so the list view can render a red
    // badge cheaply without parsing raw_data. status fields hold the
    // RMM's own classification ('SUCCESS' / 'WARNING' / 'ERROR' for
    // Action1) for display + sort.
    await client.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS missing_updates_critical INTEGER`);
    await client.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS missing_updates_other INTEGER`);
    await client.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS vulnerabilities_critical INTEGER`);
    await client.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS vulnerabilities_other INTEGER`);
    await client.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS update_status TEXT`);
    await client.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS vulnerability_status TEXT`);
    await client.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS reboot_required BOOLEAN`);

    // Installed software per asset. Sourced from the RMM's software
    // inventory endpoint (Action1 today; others when they're wired).
    // last_software_sync_at on the parent asset lets the UI show how
    // fresh the list is + drives the on-demand "Sync now" button.
    await client.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS last_software_sync_at TIMESTAMPTZ`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS asset_software (
        id SERIAL PRIMARY KEY,
        asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        version TEXT,
        vendor TEXT,
        install_date TIMESTAMPTZ,
        size_bytes BIGINT,
        raw JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(asset_id, name, version)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_asset_software_asset ON asset_software(asset_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_asset_software_name ON asset_software(LOWER(name))`);
    // One-time backfill from raw_data for existing Action1 rows. Cheap
    // — single UPDATE, only touches rows where the columns are still
    // null. Subsequent syncs keep these fresh.
    await client.query(`
      UPDATE assets
         SET missing_updates_critical = COALESCE(missing_updates_critical, NULLIF((raw_data->'missing_updates'->>'critical')::int, NULL)),
             missing_updates_other = COALESCE(missing_updates_other, NULLIF((raw_data->'missing_updates'->>'other')::int, NULL)),
             vulnerabilities_critical = COALESCE(vulnerabilities_critical, NULLIF((raw_data->'vulnerabilities'->>'critical')::int, NULL)),
             vulnerabilities_other = COALESCE(vulnerabilities_other, NULLIF((raw_data->'vulnerabilities'->>'other')::int, NULL)),
             update_status = COALESCE(update_status, raw_data->>'update_status'),
             vulnerability_status = COALESCE(vulnerability_status, raw_data->>'vulnerability_status'),
             reboot_required = COALESCE(reboot_required,
               CASE LOWER(COALESCE(raw_data->>'reboot_required', ''))
                 WHEN 'yes' THEN TRUE
                 WHEN 'no' THEN FALSE
                 ELSE NULL END)
       WHERE source_system = 'action1'
         AND (missing_updates_critical IS NULL
              OR missing_updates_other IS NULL
              OR vulnerabilities_critical IS NULL
              OR vulnerabilities_other IS NULL)
    `);

    // Seed default types (idempotent via slug UNIQUE). Order matches
    // sort_order so the picker has a sensible default ordering.
    // Each type's field list is seeded right after.
    const DEFAULT_TYPES = [
      { slug: 'workstation', label: 'Workstation', sort: 10, fields: [
        ['hostname', true], ['serial', false], ['mac', false], ['ip_address', false],
        ['manufacturer', false], ['model', false], ['os', false], ['os_version', false],
        ['cpu', false], ['ram_bytes', false], ['storage_bytes', false],
      ]},
      { slug: 'laptop', label: 'Laptop', sort: 20, fields: [
        ['hostname', true], ['serial', false], ['mac', false], ['ip_address', false],
        ['manufacturer', false], ['model', false], ['os', false], ['os_version', false],
        ['cpu', false], ['ram_bytes', false], ['storage_bytes', false],
      ]},
      { slug: 'server', label: 'Server', sort: 30, fields: [
        ['hostname', true], ['serial', false], ['mac', false], ['ip_address', false],
        ['manufacturer', false], ['model', false], ['os', false], ['os_version', false],
        ['cpu', false], ['ram_bytes', false], ['storage_bytes', false],
      ]},
      { slug: 'printer', label: 'Printer', sort: 40, fields: [
        ['hostname', false], ['serial', false], ['manufacturer', false],
        ['model', false], ['ip_address', false], ['mac', false],
      ]},
      { slug: 'monitor', label: 'Monitor', sort: 50, fields: [
        ['serial', false], ['manufacturer', false], ['model', false],
      ]},
      { slug: 'voip_phone', label: 'VoIP phone', sort: 60, fields: [
        ['hostname', false], ['serial', false], ['manufacturer', false],
        ['model', false], ['ip_address', false], ['mac', false],
      ]},
      { slug: 'network_switch', label: 'Network switch', sort: 70, fields: [
        ['hostname', false], ['serial', false], ['manufacturer', false],
        ['model', false], ['ip_address', false], ['mac', false],
      ]},
      { slug: 'wireless_ap', label: 'Wireless AP', sort: 80, fields: [
        ['hostname', false], ['serial', false], ['manufacturer', false],
        ['model', false], ['ip_address', false], ['mac', false],
      ]},
      { slug: 'mobile', label: 'Mobile device', sort: 90, fields: [
        ['serial', false], ['manufacturer', false], ['model', false],
      ]},
      { slug: 'ups', label: 'UPS', sort: 100, fields: [
        ['hostname', false], ['serial', false], ['manufacturer', false],
        ['model', false], ['ip_address', false], ['mac', false],
      ]},
      { slug: 'nvr_dvr', label: 'NVR / DVR', sort: 110, fields: [
        ['hostname', false], ['serial', false], ['manufacturer', false],
        ['model', false], ['ip_address', false], ['mac', false],
      ]},
      { slug: 'other', label: 'Other', sort: 999, fields: [
        ['hostname', false], ['serial', false], ['mac', false], ['ip_address', false],
        ['manufacturer', false], ['model', false], ['os', false], ['os_version', false],
        ['cpu', false], ['ram_bytes', false], ['storage_bytes', false],
      ]},
    ];
    for (const t of DEFAULT_TYPES) {
      const ins = await client.query(
        `INSERT INTO asset_types (slug, label, sort_order, is_system)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (slug) DO NOTHING
         RETURNING id`,
        [t.slug, t.label, t.sort]
      );
      let typeId = ins.rows[0]?.id;
      if (!typeId) {
        const r = await client.query(`SELECT id FROM asset_types WHERE slug = $1`, [t.slug]);
        typeId = r.rows[0]?.id;
      }
      if (!typeId) continue;
      for (let i = 0; i < t.fields.length; i++) {
        const [key, required] = t.fields[i];
        await client.query(
          `INSERT INTO asset_type_fields (type_id, builtin_key, required, sort_order)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (type_id, builtin_key) DO NOTHING`,
          [typeId, key, required, i]
        );
      }
    }
    // Stamp existing Action1-sourced assets with the Workstation type
    // so the inventory list shows a sane default. New Action1 syncs
    // pick it up via the resolver in services/action1Poll.js.
    await client.query(`
      UPDATE assets SET asset_type_id = (SELECT id FROM asset_types WHERE slug = 'workstation')
       WHERE asset_type_id IS NULL AND source_system = 'action1'
    `);

    // Custom field definitions. entity_type lets one table cover assets,
    // tickets, companies, etc. as the system grows. slug is a stable
    // machine-readable handle (lowercase, no spaces); label is the
    // display name. type drives the validator + which value_* column
    // holds the actual data. options is type='select' specific: a JSON
    // array of {value, label}. sort_order controls UI display order
    // within an entity_type. UNIQUE on (entity_type, slug) prevents
    // duplicate slugs per scope.
    await client.query(`
      CREATE TABLE IF NOT EXISTS custom_field_defs (
        id SERIAL PRIMARY KEY,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('asset', 'ticket')),
        slug TEXT NOT NULL,
        label TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('text', 'number', 'date', 'bool', 'select')),
        options JSONB NOT NULL DEFAULT '[]'::jsonb,
        required BOOLEAN NOT NULL DEFAULT FALSE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        help_text TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(entity_type, slug)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_custom_field_defs_entity
      ON custom_field_defs(entity_type, sort_order, id)`);

    // Custom field values. One row per (def_id, asset_id). Only one
    // value_* column is populated per row based on the def's type;
    // others stay NULL. ON DELETE CASCADE both directions keeps the
    // join clean. Asset-only for now; ticket support adds a parallel
    // ticket_id column when we wire that entity.
    await client.query(`
      CREATE TABLE IF NOT EXISTS custom_field_values (
        id SERIAL PRIMARY KEY,
        def_id INTEGER NOT NULL REFERENCES custom_field_defs(id) ON DELETE CASCADE,
        asset_id INTEGER REFERENCES assets(id) ON DELETE CASCADE,
        value_text TEXT,
        value_number NUMERIC,
        value_date TIMESTAMPTZ,
        value_bool BOOLEAN,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(def_id, asset_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_custom_field_values_asset
      ON custom_field_values(asset_id) WHERE asset_id IS NOT NULL`);

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
    // Ticket → asset link. Optional; gated per-project by
    // projects.allow_asset_linking. SET NULL on asset deletion keeps
    // ticket history intact when an asset is decommissioned.
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tickets_asset ON tickets(asset_id) WHERE asset_id IS NOT NULL`);
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
    // Pre-breach warnings. warn_at fires before due_at — driven by the
    // policy's warning_threshold_percent (default 80). Same pause/resume
    // semantics as due_at. Notification fanout uses fanoutSlaWarning;
    // separate from breach so users can opt out of one without losing
    // the other.
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_response_warn_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_resolve_warn_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_response_warned BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_resolve_warned BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_response_warned_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_resolve_warned_at TIMESTAMPTZ`);
    // D1 breakdown: split sla_paused_seconds by pause kind so the
    // dashboard can show "vendor wait" vs "internal hold" separately.
    // sla_pause_kind tracks the in-progress pause's kind so resume can
    // route to the right counter; semantic_tag 'awaiting_input' = vendor,
    // 'on_hold' = internal (default mapping in services/sla.js).
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_vendor_wait_seconds INTEGER NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_internal_hold_seconds INTEGER NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_pause_kind TEXT CHECK (sla_pause_kind IN ('vendor', 'internal'))`);
    // One-time backfill: legacy sla_paused_seconds gets attributed to
    // vendor wait (the more common case). Idempotent — only updates
    // rows where the new counters are still zero and there's something
    // to attribute. Loss is acceptable: this is approximate history.
    await client.query(`
      UPDATE tickets
         SET sla_vendor_wait_seconds = sla_paused_seconds
       WHERE sla_paused_seconds > 0
         AND sla_vendor_wait_seconds = 0
         AND sla_internal_hold_seconds = 0
    `);
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
    // Warn-at partial indexes mirror the due-at ones so the scheduler
    // sweep stays cheap as the ticket table grows.
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tickets_sla_response_warn
      ON tickets(sla_response_warn_at) WHERE sla_response_warn_at IS NOT NULL AND sla_first_response_at IS NULL AND sla_response_warned = FALSE`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tickets_sla_resolve_warn
      ON tickets(sla_resolve_warn_at) WHERE sla_resolve_warn_at IS NOT NULL AND resolved_at IS NULL AND sla_resolve_warned = FALSE`);

    // Per-policy warning threshold (% of total window elapsed before
    // the warning fires). 80 = warn at 80% of the window. 0 disables.
    await client.query(`ALTER TABLE sla_policies ADD COLUMN IF NOT EXISTS warning_threshold_percent INTEGER NOT NULL DEFAULT 80 CHECK (warning_threshold_percent BETWEEN 0 AND 99)`);

    // Business hours — used by SLA clock math so a Friday-5pm ticket
    // doesn't burn through the weekend. One row per scope: project_id
    // NULL = org default. tz is an IANA name; days is a 0–6 array
    // (0=Sun..6=Sat). start/end are local clock times in tz.
    await client.query(`
      CREATE TABLE IF NOT EXISTS business_hours_policies (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        tz TEXT NOT NULL DEFAULT 'America/Chicago',
        days INTEGER[] NOT NULL DEFAULT ARRAY[1,2,3,4,5],
        start_time TIME NOT NULL DEFAULT '09:00',
        end_time TIME NOT NULL DEFAULT '17:00',
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_business_hours_org_default
      ON business_hours_policies((project_id IS NULL)) WHERE project_id IS NULL`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_business_hours_project
      ON business_hours_policies(project_id) WHERE project_id IS NOT NULL`);
    // SLA policy can pin a business-hours policy. NULL = clock runs
    // 24/7 (existing behavior pre-A3). Stays compatible with old rows.
    await client.query(`ALTER TABLE sla_policies ADD COLUMN IF NOT EXISTS business_hours_id INTEGER REFERENCES business_hours_policies(id) ON DELETE SET NULL`);

    // Seed an org default Mon-Fri 9-5 Central. Customers can edit or
    // disable. Idempotent.
    await client.query(`
      INSERT INTO business_hours_policies (name, project_id, tz, days, start_time, end_time, enabled)
      SELECT 'Org default — Mon–Fri 9–5 CT', NULL, 'America/Chicago', ARRAY[1,2,3,4,5], '09:00', '17:00', TRUE
      WHERE NOT EXISTS (SELECT 1 FROM business_hours_policies WHERE project_id IS NULL)
    `);

    // Backfill warn_at on existing tickets: warn_at = created_at +
    // ((due_at - created_at) * threshold / 100). Idempotent — only
    // updates rows missing the warn_at column.
    await client.query(`
      UPDATE tickets t
         SET sla_response_warn_at = t.created_at + ((t.sla_response_due_at - t.created_at) * COALESCE(sp.warning_threshold_percent, 80) / 100.0),
             sla_resolve_warn_at  = t.created_at + ((t.sla_resolve_due_at  - t.created_at) * COALESCE(sp.warning_threshold_percent, 80) / 100.0)
        FROM sla_policies sp
       WHERE sp.project_id IS NULL
         AND sp.priority = COALESCE(t.effective_priority, 3)
         AND t.sla_response_warn_at IS NULL
         AND t.sla_resolve_warn_at IS NULL
         AND t.sla_response_due_at IS NOT NULL
         AND t.sla_resolve_due_at IS NOT NULL
    `);

    await client.query(`INSERT INTO system_jobs (name) VALUES ('sla_breach_check') ON CONFLICT DO NOTHING`);

    // Auto-assignment policies. Same (priority, project_id) scoping as
    // sla_policies — project-specific row beats org default. Strategy
    // controls how an agent is picked from agent_pool:
    //   round_robin  — cycle through agent_pool by index; cursor stored
    //                  on the row, incremented atomically per pick.
    //   case_load    — pick the agent with the fewest currently open
    //                  tickets (resolved_at IS NULL + status not closed).
    //   specific_user — return specific_user_id (pool ignored).
    // enabled=FALSE leaves tickets falling through to project default.
    await client.query(`
      CREATE TABLE IF NOT EXISTS assignment_policies (
        id SERIAL PRIMARY KEY,
        priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 5),
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        strategy TEXT NOT NULL DEFAULT 'specific_user'
          CHECK (strategy IN ('round_robin', 'case_load', 'specific_user')),
        agent_pool INTEGER[] NOT NULL DEFAULT '{}'::int[],
        specific_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        round_robin_cursor INTEGER NOT NULL DEFAULT 0,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // priority_op lets one policy cover a priority range. With operators,
    // multiple rows can match the same ticket priority — resolution
    // picks the most specific (project-scoped beats org-default, '='
    // beats range operators, newest beats older). The old unique
    // indexes are dropped (idempotent: only drops if present).
    await client.query(`ALTER TABLE assignment_policies ADD COLUMN IF NOT EXISTS priority_op TEXT NOT NULL DEFAULT '=' CHECK (priority_op IN ('=', '<', '>', '<=', '>='))`);
    await client.query(`DROP INDEX IF EXISTS idx_assignment_policies_org_default`);
    await client.query(`DROP INDEX IF EXISTS idx_assignment_policies_project`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_assignment_policies_lookup
      ON assignment_policies(project_id, priority, priority_op) WHERE enabled = TRUE`);

    // Escalation chains. One row = one step. Steps grouped by
    // (priority, project_id, trigger); step_order drives execution.
    // Trigger names mirror the four SLA milestones surfaced by
    // tickWarnings + tickBreaches. delay_minutes = grace period after
    // the trigger before this step fires (0 = immediately). Actions:
    //   notify_user / notify_role  — fan out to user or all users in role
    //   reassign_user / reassign_role — UPDATE assigned_to (role pick
    //     uses the first active user with that role on the project;
    //     refine in a later PR if round-robin among managers is needed)
    // Tickets track which steps have fired via tickets.escalation_steps_fired
    // so a single trigger doesn't re-fire a step on every scheduler tick.
    await client.query(`
      CREATE TABLE IF NOT EXISTS escalation_chain_steps (
        id SERIAL PRIMARY KEY,
        priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 5),
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL CHECK (trigger IN (
          'warning_response', 'warning_resolve',
          'breach_response',  'breach_resolve'
        )),
        step_order INTEGER NOT NULL DEFAULT 1,
        delay_minutes INTEGER NOT NULL DEFAULT 0 CHECK (delay_minutes >= 0),
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE escalation_chain_steps ADD COLUMN IF NOT EXISTS priority_op TEXT NOT NULL DEFAULT '=' CHECK (priority_op IN ('=', '<', '>', '<=', '>='))`);
    await client.query(`DROP INDEX IF EXISTS idx_escalation_lookup`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_escalation_lookup
      ON escalation_chain_steps(priority, priority_op, project_id, trigger, enabled)`);

    // Multi-action support: one step can fan out to multiple actions
    // on the same (trigger, delay) without duplicating rows. Each entry
    // is { kind, target_user_id?, target_role? } — kind ∈ notify_user /
    // notify_role / notify_assignee / reassign_user / reassign_role.
    // 'notify_assignee' targets the ticket's current assignee directly,
    // avoiding the ambiguity of notify_role when many users share a role.
    await client.query(`ALTER TABLE escalation_chain_steps ADD COLUMN IF NOT EXISTS actions JSONB NOT NULL DEFAULT '[]'::jsonb`);
    // Backfill from legacy single-action columns into the actions array
    // only when those columns still exist (first run after upgrade).
    // Subsequent boots skip the UPDATE because the cols have been dropped.
    await client.query(`
      DO $do$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_name='escalation_chain_steps' AND column_name='action'
        ) THEN
          UPDATE escalation_chain_steps
             SET actions = jsonb_build_array(
                   jsonb_strip_nulls(jsonb_build_object(
                     'kind', action,
                     'target_user_id', target_user_id,
                     'target_role', target_role
                   ))
                 )
           WHERE jsonb_array_length(actions) = 0
             AND action IS NOT NULL;
        END IF;
      END
      $do$;
    `);
    // Drop legacy single-action columns + their CHECK constraint. New
    // code reads/writes only the actions[] array. Safe because the
    // module shipped in the current (held) v0.7.0 work — no prior
    // release depended on this shape.
    await client.query(`ALTER TABLE escalation_chain_steps DROP COLUMN IF EXISTS action`);
    await client.query(`ALTER TABLE escalation_chain_steps DROP COLUMN IF EXISTS target_user_id`);
    await client.query(`ALTER TABLE escalation_chain_steps DROP COLUMN IF EXISTS target_role`);

    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalation_steps_fired INTEGER[] NOT NULL DEFAULT '{}'::int[]`);
    // Snapshot of the priority the chain first matched against on this
    // ticket. Written the first time a `bump_priority` action fires.
    // After that, the chain matcher uses this column instead of
    // effective_priority so bumping doesn't re-enter the chain at the
    // newly elevated tier (would cascade indefinitely). NULL = never
    // bumped; matcher falls back to effective_priority. Reset only on
    // ticket delete; admin re-priority does NOT clear it (intentional —
    // an admin overriding priority on a previously-escalated ticket
    // shouldn't re-arm the chain at a different tier).
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalation_priority_snapshot INTEGER CHECK (escalation_priority_snapshot BETWEEN 1 AND 5)`);

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
    // Source of credentials — 'user' (BYOK) or 'org' (admin-managed).
    // Lets usage reports attribute cost to the right party.
    await client.query(`ALTER TABLE ai_rewrite_logs ADD COLUMN IF NOT EXISTS config_source TEXT`);

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

    // ── AI Settings — dedicated singleton table ──────────────────────────
    // Centralizes BYO-AI / org-managed-AI configuration that previously
    // lived under branding.ai_*. Three admin-facing layers:
    //   1. Integration  — org provider / endpoint / model + encrypted key
    //   2. Permissions  — enabled, disclosure audience, BYOK policy
    //   3. Project ctx  — feature toggle lives here, content edited inline
    //
    // When org_locked=TRUE, users cannot override the org config — every
    // rewrite uses the org credentials. When allow_user_byok=TRUE and
    // org_locked=FALSE, users may set their own provider/model/key.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_settings (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        org_provider TEXT,
        org_endpoint TEXT,
        org_model TEXT,
        org_api_key_enc BYTEA,
        org_locked BOOLEAN NOT NULL DEFAULT FALSE,
        allow_user_byok BOOLEAN NOT NULL DEFAULT TRUE,
        project_context_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        disclosure_audience TEXT NOT NULL DEFAULT 'self_and_admin'
          CHECK (disclosure_audience IN ('self_and_admin','admin_only','all_users')),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Backfill from existing branding.ai_* on first run. Idempotent —
    // only inserts when the singleton row is missing.
    await client.query(`
      INSERT INTO ai_settings (id, enabled, project_context_enabled, disclosure_audience)
      SELECT 1,
             COALESCE((SELECT ai_assist_enabled FROM branding WHERE id = 1), TRUE),
             COALESCE((SELECT ai_project_context_enabled FROM branding WHERE id = 1), TRUE),
             COALESCE((SELECT ai_disclosure_audience FROM branding WHERE id = 1), 'self_and_admin')
      ON CONFLICT DO NOTHING
    `);

    // ── Knowledge Base — per-project articles with version history ───────
    // BlockNote editor stores rich content as JSON; content_text is the
    // plain-text extraction kept in sync for FTS + summaries. Slug is
    // unique per project so different projects can use the same slug.
    // Soft delete via status='archived'.
    await client.query(`
      CREATE TABLE IF NOT EXISTS kb_articles (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        content_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        content_text TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft','published','archived')),
        author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        last_edited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        published_at TIMESTAMPTZ,
        view_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(project_id, slug)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_kb_articles_project ON kb_articles(project_id, status, updated_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_kb_articles_fts ON kb_articles USING GIN (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content_text,'')))`);

    // Version snapshots — written on every save. Lets editors revert
    // and shows a change history surface. version_no monotonic per
    // article (computed at insert time).
    await client.query(`
      CREATE TABLE IF NOT EXISTS kb_article_versions (
        id SERIAL PRIMARY KEY,
        article_id INTEGER NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
        version_no INTEGER NOT NULL,
        title TEXT NOT NULL,
        content_json JSONB NOT NULL,
        content_text TEXT NOT NULL,
        author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        change_summary TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(article_id, version_no)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_kb_versions_article ON kb_article_versions(article_id, version_no DESC)`);

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
