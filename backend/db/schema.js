const { pool } = require('./pool');

async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        entra_oid TEXT UNIQUE NOT NULL,
        display_name TEXT,
        email TEXT,
        upn TEXT,
        role TEXT NOT NULL DEFAULT 'Viewer',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_login TIMESTAMPTZ
      )
    `);

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
        site_name TEXT NOT NULL DEFAULT 'MOT Operations',
        tagline TEXT NOT NULL DEFAULT 'Internal project & issue tracking',
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
