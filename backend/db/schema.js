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
        mot_ref TEXT UNIQUE NOT NULL,
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
        coastal_status TEXT NOT NULL DEFAULT 'Unacknowledged',
        coastal_ticket_ref TEXT,
        coastal_updated_at TIMESTAMPTZ,
        blocker_type TEXT,
        blocked_by_ticket INTEGER REFERENCES tickets(id),
        mot_blocker_note TEXT,
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

    await client.query(`
      CREATE TABLE IF NOT EXISTS branding (
        id INTEGER PRIMARY KEY DEFAULT 1,
        site_name TEXT NOT NULL DEFAULT 'Punchlist',
        tagline TEXT NOT NULL DEFAULT 'Track every issue. Close every loop.',
        logo_filename TEXT,
        primary_color TEXT NOT NULL DEFAULT '#1e40af',
        show_powered_by BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT single_row CHECK (id = 1)
      )
    `);
    await client.query(`INSERT INTO branding (id) VALUES (1) ON CONFLICT DO NOTHING`);
    await client.query(`ALTER TABLE branding ADD COLUMN IF NOT EXISTS logo_on_dark BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS has_external_vendor BOOLEAN NOT NULL DEFAULT TRUE`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS default_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL`);

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
        ['Awaiting MOT Input',   '#d97706', 30,  false, false, true,  null],
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

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Atomic per-project ticket counter — returns "PREFIX-NNNN"
async function nextMotRef(client, projectId) {
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

module.exports = { initSchema, nextMotRef, computePriority };
