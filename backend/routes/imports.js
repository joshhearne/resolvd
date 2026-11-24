// CSV import / export for company locations and users (Admin → Import).
//
//   GET  /api/imports/:kind/sample.csv   template with every column + example rows
//   GET  /api/imports/:kind/export.csv   current data in the import format
//   POST /api/imports/:kind              { csv, apply } — preview (apply false)
//                                        or apply (all-or-nothing)
//   kind = locations | users
//
// File rules (shown on the page too):
//  - The header row names the columns; order doesn't matter, and a column
//    left out of the file isn't touched on existing records. An empty
//    cell in a column that is present clears that value.
//  - Locations match an existing site of the same company by code, else
//    by name. Users match by email.
//  - New users are created as invited: Microsoft / Google users become
//    active on their first sign-in; local users set a password from the
//    invite email (send_invite = yes), or can be invited later from
//    Admin → Users.
//  - Nothing is written when any row has an error.

const express = require('express');
const { parse } = require('csv-parse/sync');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { decryptRows, buildWritePatch } = require('../services/fields');
const { getAuthSettings } = require('../services/authSettings');
const { issueInvite, inviteBaseUrl } = require('../services/invites');

const router = express.Router();
router.use(requireAuth, requireRole('Admin', 'Manager'));

const MAX_ROWS = 5000;
const ROLES = ['Admin', 'Manager', 'Tech', 'Submitter', 'Viewer', 'Support'];
const SIGN_IN = { microsoft: 'entra', entra: 'entra', google: 'google', local: 'local' };
const SIGN_IN_LABEL = { entra: 'microsoft', google: 'google', local: 'local' };

const COLUMNS = {
  locations: ['company', 'name', 'code', 'address', 'timezone', 'phone', 'use_extensions', 'primary', 'extensions_via'],
  users: ['email', 'name', 'role', 'sign_in', 'send_invite', 'company', 'location', 'job_title', 'extension', 'direct', 'mobile'],
};

const SAMPLES = {
  locations: [
    ['Acme Corp', 'Headquarters', 'HQ', '100 Main St, Springfield, TX 75000', 'America/Chicago', '(936) 555-0100', 'yes', 'yes', ''],
    ['Acme Corp', 'East Warehouse', 'EAST', '200 Dock Rd, Springfield, TX 75001', 'America/Chicago', '(936) 555-0200', 'no', 'no', 'HQ'],
    ['Acme Corp', 'Remote', 'REMOTE', '', '', '', 'no', 'no', ''],
  ],
  users: [
    ['jane.doe@acme.example', 'Jane Doe', 'Submitter', 'microsoft', 'no', 'Acme Corp', 'HQ', 'Service Advisor', '105', '(936) 555-0105', '(936) 555-0199'],
    ['sam.lee@acme.example', 'Sam Lee', 'Viewer', 'local', 'yes', 'Acme Corp', 'EAST', 'Warehouse Lead', '220', '', '936-555-0142'],
    ['pat.kim@acme.example', 'Pat Kim', 'Tech', 'local', 'no', '', '', '', '', '', ''],
  ],
};

// ── CSV helpers ─────────────────────────────────────────────────────────

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  // Keep spreadsheet apps from treating a cell as a formula.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^[+-]?[\d(]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
const csvLine = (cells) => cells.map(csvCell).join(',');

function sendCsv(res, name, header, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send([csvLine(header), ...rows.map(csvLine)].join('\r\n') + '\r\n');
}

const normKey = (h) => String(h || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
const lc = (v) => String(v || '').trim().toLowerCase();

// Returns { header: Set, rows: [{ line, data }] } or throws a user-facing Error.
function readCsv(text, kind) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('The file is empty');
  let records;
  try {
    records = parse(text, { bom: true, skip_empty_lines: true, relax_column_count: true, trim: true });
  } catch (e) {
    throw new Error(`Couldn't read the CSV: ${e.message}`);
  }
  if (!records.length) throw new Error('The file is empty');
  const header = records[0].map(normKey);
  const known = new Set(COLUMNS[kind]);
  const unknown = header.filter((h) => h && !known.has(h));
  if (unknown.length) throw new Error(`Unknown column${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Columns: ${COLUMNS[kind].join(', ')}`);
  const required = kind === 'locations' ? ['company', 'name'] : ['email'];
  const missing = required.filter((c) => !header.includes(c));
  if (missing.length) throw new Error(`Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
  const body = records.slice(1).filter((r) => r.some((c) => String(c).trim()));
  if (body.length > MAX_ROWS) throw new Error(`At most ${MAX_ROWS} rows per file`);
  return {
    header: new Set(header),
    rows: body.map((r, i) => {
      const data = {};
      header.forEach((h, j) => { if (h) data[h] = r[j] == null ? '' : String(r[j]).trim(); });
      return { line: i + 2, data };
    }),
  };
}

// yes / no cells. Returns true, false, or undefined for an unreadable value.
function yesNo(v) {
  const s = lc(v);
  if (['', 'no', 'n', 'false', '0', 'off'].includes(s)) return false;
  if (['yes', 'y', 'true', '1', 'on', 'x'].includes(s)) return true;
  return undefined;
}

const PHONE_MAX = 40;
function cleanPhone(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (s.length > PHONE_MAX || !/^[0-9+().\-\s#*,xX]+$/.test(s)) return undefined;
  return s;
}

async function loadCompanies() {
  const r = await pool.query(`SELECT id, name, name_enc, kind FROM companies WHERE is_archived = FALSE`);
  await decryptRows('companies', r.rows);
  const byName = new Map();
  for (const c of r.rows) {
    const k = lc(c.name);
    if (!k) continue;
    byName.set(k, byName.has(k) ? null : c); // null = ambiguous
  }
  return { list: r.rows, byName };
}

function findCompany(companies, name) {
  const c = companies.byName.get(lc(name));
  if (c === undefined) return [null, `Company "${name}" not found. Add it under Admin → Companies first.`];
  if (c === null) return [null, `More than one company is named "${name}"`];
  return [c];
}

// Site lookup within a company's (planned) locations: code first, then name.
function findSite(sites, ref) {
  const k = lc(ref);
  if (!k) return null;
  return sites.find((s) => lc(s.location_code) === k) || sites.find((s) => lc(s.name) === k) || null;
}

function summarize(rows) {
  const s = { create: 0, update: 0, unchanged: 0, error: 0 };
  for (const r of rows) s[r.action] = (s[r.action] || 0) + 1;
  return s;
}

// ── Samples and exports ─────────────────────────────────────────────────

router.get('/:kind/sample.csv', (req, res) => {
  const { kind } = req.params;
  if (!COLUMNS[kind]) return res.status(404).json({ error: 'not found' });
  sendCsv(res, `resolvd-${kind}-sample.csv`, COLUMNS[kind], SAMPLES[kind]);
});

router.get('/locations/export.csv', async (req, res) => {
  try {
    const companies = await loadCompanies();
    const names = new Map(companies.list.map((c) => [c.id, c.name]));
    const r = await pool.query(
      `SELECT l.*, x.location_code AS via_code, x.name AS via_name
         FROM locations l LEFT JOIN locations x ON x.id = l.extension_location_id
        WHERE l.is_archived = FALSE ORDER BY l.company_id, l.is_primary DESC, l.name`
    );
    const rows = r.rows.filter((l) => names.has(l.company_id)).map((l) => [
      names.get(l.company_id), l.name, l.location_code, l.address, l.timezone, l.phone,
      l.use_extensions ? 'yes' : 'no', l.is_primary ? 'yes' : 'no',
      l.use_extensions ? '' : (l.via_code || l.via_name || ''),
    ]);
    rows.sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { sensitivity: 'base' }));
    sendCsv(res, 'resolvd-locations.csv', COLUMNS.locations, rows);
  } catch (err) {
    console.error('locations export:', err);
    res.status(500).json({ error: 'Export failed' });
  }
});

router.get('/users/export.csv', async (req, res) => {
  try {
    const companies = await loadCompanies();
    const names = new Map(companies.list.map((c) => [c.id, c.name]));
    const r = await pool.query(
      `SELECT u.id, u.email, u.display_name, u.role, u.auth_provider,
              u.phone_direct, u.phone_direct_enc, u.phone_extension, u.phone_mobile, u.phone_mobile_enc,
              cm.company_id, cm.role_label, l.location_code, l.name AS location_name
         FROM users u
         LEFT JOIN company_members cm ON cm.user_id = u.id
         LEFT JOIN locations l ON l.id = cm.location_id
        WHERE u.status <> 'disabled' AND u.email IS NOT NULL AND u.email <> ''
        ORDER BY LOWER(u.email), cm.company_id`
    );
    await decryptRows('users', r.rows);
    const rows = r.rows.map((u) => [
      u.email, u.display_name, u.role, SIGN_IN_LABEL[u.auth_provider] || '', '',
      u.company_id ? names.get(u.company_id) || '' : '', u.company_id ? (u.location_code || u.location_name || '') : '',
      u.role_label, u.phone_extension, u.phone_direct, u.phone_mobile,
    ]);
    sendCsv(res, 'resolvd-users.csv', COLUMNS.users, rows);
  } catch (err) {
    console.error('users export:', err);
    res.status(500).json({ error: 'Export failed' });
  }
});

// ── Locations import ────────────────────────────────────────────────────

function viaChanged(res) {
  if (res.action === 'unchanged') res.action = 'update';
  (res.changes = res.changes || []).push('extensions_via');
}

async function planLocations({ header, rows }) {
  const companies = await loadCompanies();
  const existing = await pool.query(`SELECT * FROM locations WHERE is_archived = FALSE`);
  // Planned state per company: existing sites, updated / added as rows go.
  const sites = new Map();
  for (const l of existing.rows) {
    if (!sites.has(l.company_id)) sites.set(l.company_id, []);
    sites.get(l.company_id).push({ ...l, _orig: l });
  }
  const has = (c) => header.has(c);
  const out = [];
  const seen = new Map(); // company:key → line, to catch duplicates in the file

  for (const { line, data } of rows) {
    const res = { line, key: `${data.company || '?'} / ${data.name || data.code || '?'}`, action: 'error', messages: [] };
    out.push(res);
    if (!data.company) { res.error = 'company is required'; continue; }
    if (!data.name) { res.error = 'name is required'; continue; }
    const [company, cErr] = findCompany(companies, data.company);
    if (cErr) { res.error = cErr; continue; }
    if (data.name.length > 200) { res.error = 'name is too long'; continue; }
    const useExt = has('use_extensions') ? yesNo(data.use_extensions) : undefined;
    const primary = has('primary') ? yesNo(data.primary) : undefined;
    if (useExt === undefined && has('use_extensions')) { res.error = 'use_extensions must be yes or no'; continue; }
    if (primary === undefined && has('primary')) { res.error = 'primary must be yes or no'; continue; }
    let phone;
    if (has('phone')) {
      phone = cleanPhone(data.phone);
      if (phone === undefined) { res.error = `phone "${data.phone}" isn't a phone number`; continue; }
    }

    const list = sites.get(company.id) || [];
    sites.set(company.id, list);
    const matchKey = `${company.id}:${lc(data.code) || 'name:' + lc(data.name)}`;
    if (seen.has(matchKey)) { res.error = `Same location as line ${seen.get(matchKey)}`; continue; }
    seen.set(matchKey, line);
    let site = data.code ? list.find((s) => lc(s.location_code) === lc(data.code)) : null;
    if (!site) site = list.find((s) => lc(s.name) === lc(data.name) && (!data.code || !s.location_code));

    const next = {
      name: data.name,
      ...(has('code') ? { location_code: data.code || null } : {}),
      ...(has('address') ? { address: data.address || null } : {}),
      ...(has('timezone') ? { timezone: data.timezone || null } : {}),
      ...(has('phone') ? { phone } : {}),
      ...(useExt !== undefined ? { use_extensions: useExt } : {}),
      ...(primary !== undefined ? { is_primary: primary } : {}),
    };
    if (site) {
      const changed = Object.keys(next).filter((k) => (site[k] ?? null) !== (next[k] ?? null));
      Object.assign(site, next);
      res.site = site;
      res.action = changed.length ? 'update' : 'unchanged';
      res.changes = changed.map((k) => ({ location_code: 'code', is_primary: 'primary', use_extensions: 'use_extensions' }[k] || k));
    } else {
      site = { id: null, company_id: company.id, location_code: null, address: null, timezone: null, phone: null,
        use_extensions: false, is_primary: false, extension_location_id: null, ...next };
      list.push(site);
      res.site = site;
      res.action = 'create';
    }
    res.company = company;
    res.via = has('extensions_via') ? data.extensions_via : undefined;
  }

  // Second pass: primary uniqueness and extension routing, against the
  // final planned state (so a row can route through a site added below it).
  for (const res of out) {
    if (res.action === 'error') continue;
    const list = sites.get(res.company.id);
    if (res.site.is_primary) {
      const others = out.filter((o) => o !== res && o.action !== 'error' && o.company?.id === res.company.id && o.site.is_primary);
      if (others.length && others[0].line < res.line) {
        res.action = 'error'; res.error = `Only one primary location per company (line ${others[0].line} is also primary)`; continue;
      }
    }
    if (res.via === undefined) continue;
    if (!res.via) {
      res.site._via = null;
      if (res.site.extension_location_id) viaChanged(res);
      continue;
    }
    if (res.site.use_extensions) { res.messages.push('extensions_via ignored: this location uses extensions itself'); res.site._via = null; continue; }
    const target = findSite(list, res.via);
    if (!target) { res.action = 'error'; res.error = `extensions_via "${res.via}" isn't a location of ${res.company.name}`; continue; }
    if (target === res.site) { res.action = 'error'; res.error = "A location can't route extensions through itself"; continue; }
    if (!target.use_extensions || !target.phone) {
      res.action = 'error'; res.error = `extensions_via "${res.via}" needs a phone and use_extensions = yes`; continue;
    }
    res.site._via = target;
    if (res.site.id && res.site.extension_location_id !== target.id) viaChanged(res);
  }
  for (const res of out) {
    if (res.action === 'update' && res.changes?.length) res.messages.unshift(`Changes: ${res.changes.join(', ')}`);
  }
  return out;
}

async function applyLocations(plan, user) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const touched = plan.filter((p) => p.action === 'create' || p.action === 'update');
    // Demote existing primaries where a row makes another site primary.
    for (const p of touched) {
      if (p.site.is_primary) {
        await client.query(
          `UPDATE locations SET is_primary = FALSE WHERE company_id = $1 AND is_primary AND ($2::int IS NULL OR id <> $2)`,
          [p.company.id, p.site.id]
        );
      }
    }
    for (const p of touched) {
      const s = p.site;
      const vals = [s.name, s.location_code, s.address, s.timezone, s.phone, !!s.use_extensions, !!s.is_primary];
      if (s.id) {
        await client.query(
          `UPDATE locations SET name = $1, location_code = $2, address = $3, timezone = $4, phone = $5,
                  use_extensions = $6, is_primary = $7,
                  extension_location_id = CASE WHEN $6 THEN NULL ELSE extension_location_id END,
                  updated_at = NOW()
            WHERE id = $8`,
          [...vals, s.id]
        );
      } else {
        const r = await client.query(
          `INSERT INTO locations (company_id, name, location_code, address, timezone, phone, use_extensions, is_primary)
           VALUES ($8, $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [...vals, s.company_id]
        );
        s.id = r.rows[0].id;
      }
    }
    for (const p of plan) {
      if (p.action === 'error' || p.site._via === undefined || p.site.use_extensions) continue;
      await client.query(`UPDATE locations SET extension_location_id = $1 WHERE id = $2`, [p.site._via ? p.site._via.id : null, p.site.id]);
    }
    const s = summarize(plan);
    await client.query(
      `INSERT INTO audit_log (ticket_id, user_id, action, note) VALUES (NULL, $1, 'locations_imported', $2)`,
      [user.id, `Locations CSV: ${s.create} added, ${s.update} updated`]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Users import ────────────────────────────────────────────────────────

async function defaultSignIn() {
  const s = await getAuthSettings().catch(() => null);
  if (s?.entra_enabled) return 'entra';
  if (s?.google_enabled) return 'google';
  return 'local';
}

async function planUsers({ header, rows }, importer) {
  const companies = await loadCompanies();
  const locs = await pool.query(`SELECT id, company_id, name, location_code FROM locations WHERE is_archived = FALSE`);
  const sitesBy = new Map();
  for (const l of locs.rows) {
    if (!sitesBy.has(l.company_id)) sitesBy.set(l.company_id, []);
    sitesBy.get(l.company_id).push(l);
  }
  const emails = [...new Set(rows.map((r) => lc(r.data.email)).filter(Boolean))];
  const ex = emails.length
    ? await pool.query(
      `SELECT id, email, display_name, role, auth_provider, status, phone_direct, phone_direct_enc,
              phone_extension, phone_mobile, phone_mobile_enc
         FROM users WHERE LOWER(email) = ANY($1)`, [emails])
    : { rows: [] };
  await decryptRows('users', ex.rows);
  const users = new Map(ex.rows.map((u) => [lc(u.email), u]));
  const mem = ex.rows.length
    ? await pool.query(`SELECT * FROM company_members WHERE user_id = ANY($1)`, [ex.rows.map((u) => u.id)])
    : { rows: [] };
  const members = new Map(mem.rows.map((m) => [`${m.user_id}:${m.company_id}`, m]));
  const fallbackSignIn = await defaultSignIn();
  const has = (c) => header.has(c);
  const seen = new Map();
  const emailsSeen = new Set();
  const planned = new Map(); // email → planned new user (several rows can add memberships)
  const out = [];

  for (const { line, data } of rows) {
    const res = { line, key: data.email || '?', action: 'error', messages: [] };
    out.push(res);
    const email = lc(data.email);
    if (!email) { res.error = 'email is required'; continue; }
    if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email) || email.length > 254) { res.error = `"${data.email}" isn't an email address`; continue; }
    const dupKey = `${email}:${lc(data.company)}`;
    if (seen.has(dupKey)) { res.error = `Same person${data.company ? ' and company' : ''} as line ${seen.get(dupKey)}`; continue; }
    seen.set(dupKey, line);

    const user = users.get(email);
    const person = {};
    let role = null;
    let signIn = null;
    let invite = false;
    if (has('send_invite')) {
      const v = yesNo(data.send_invite);
      if (v === undefined) { res.error = 'send_invite must be yes or no'; continue; }
      invite = v;
    }
    if (has('role') && data.role) {
      role = ROLES.find((r) => r.toLowerCase() === lc(data.role));
      if (!role) { res.error = `role must be one of ${ROLES.join(', ')}`; continue; }
    }
    if (has('sign_in') && data.sign_in) {
      signIn = SIGN_IN[lc(data.sign_in)];
      if (!signIn) { res.error = 'sign_in must be microsoft, google or local'; continue; }
    }
    let bad = null;
    for (const [col, key] of [['direct', 'phone_direct'], ['mobile', 'phone_mobile']]) {
      if (!has(col)) continue;
      const v = cleanPhone(data[col]);
      if (v === undefined) { bad = `${col} "${data[col]}" isn't a phone number`; break; }
      person[key] = v;
    }
    if (bad) { res.error = bad; continue; }
    if (has('extension')) {
      if (data.extension && !/^[0-9]{1,10}$/.test(data.extension)) { res.error = 'extension must be digits'; continue; }
      person.phone_extension = data.extension || null;
    }
    // A person on several rows (one per company): later rows add
    // memberships, and their empty cells don't clear what an earlier row set.
    if (emailsSeen.has(email)) for (const k of Object.keys(person)) if (person[k] == null) delete person[k];
    emailsSeen.add(email);

    // Company membership.
    let company = null;
    let membership = null;
    if (has('company') && data.company) {
      const [c, cErr] = findCompany(companies, data.company);
      if (cErr) { res.error = cErr; continue; }
      company = c;
      membership = {};
      if (has('job_title')) membership.role_label = data.job_title.slice(0, 120) || null;
      if (has('location')) {
        if (!data.location) membership.location_id = null;
        else {
          const site = findSite(sitesBy.get(c.id) || [], data.location);
          if (!site) { res.error = `location "${data.location}" isn't a location of ${c.name}`; continue; }
          membership.location_id = site.id;
        }
      }
    } else if ((has('location') && data.location) || (has('job_title') && data.job_title)) {
      res.error = 'location and job_title need a company'; continue;
    }

    if (user || planned.has(email)) {
      const u = user || planned.get(email);
      res.user = u;
      if (user) {
        if (user.status === 'disabled') { res.error = 'This user is disabled; re-enable them under Admin → Users first'; continue; }
        if (has('name') && data.name && data.name !== (user.display_name || '')) {
          if (user.auth_provider === 'local' || user.status === 'invited') person.display_name = data.name.slice(0, 200);
          else res.messages.push('name not changed: it comes from Microsoft / Google sign-in');
        }
        if (role && role !== user.role) res.messages.push(`role not changed (stays ${user.role}); change it under Admin → Users`);
        if (signIn && signIn !== user.auth_provider && user.status !== 'invited') res.messages.push('sign_in not changed for an existing account');
        const changedPerson = Object.keys(person).filter((k) => (user[k] ?? null) !== (person[k] ?? null));
        const m = company ? members.get(`${user.id}:${company.id}`) : null;
        const changedMember = company
          ? (m ? Object.keys(membership).filter((k) => (m[k] ?? null) !== (membership[k] ?? null)) : ['membership'])
          : [];
        res.action = changedPerson.length || changedMember.length ? 'update' : 'unchanged';
        const labels = [...changedPerson, ...changedMember].map((k) => ({
          display_name: 'name', phone_direct: 'direct', phone_mobile: 'mobile', phone_extension: 'extension',
          role_label: 'job_title', location_id: 'location', membership: `added to ${company?.name}`,
        }[k] || k));
        if (labels.length) res.messages.push(`Changes: ${labels.join(', ')}`);
        if (invite) {
          if (user.status === 'invited') {
            res.invite = { role: user.role, provider: signIn || user.auth_provider || 'local' };
            res.messages.push('Sends a new invite (they haven\'t accepted one yet)');
          }
          else res.messages.push('send_invite ignored: this account is already active');
        }
      } else {
        res.action = 'update';
        res.messages.push(`Adds another company to the user created on line ${u._line}`);
      }
      res.person = person;
      res.company = company;
      res.membership = membership;
      continue;
    }

    // New user.
    const newRole = role || 'Viewer';
    if (newRole === 'Admin' && importer.role !== 'Admin') { res.error = 'Only Admins can create Admins'; continue; }
    const provider = signIn || fallbackSignIn;
    const nu = { _line: line, email, display_name: (has('name') && data.name ? data.name : '').slice(0, 200), role: newRole, auth_provider: provider };
    planned.set(email, nu);
    res.user = nu;
    res.newUser = true;
    res.action = 'create';
    res.person = person;
    res.company = company;
    res.membership = membership;
    res.messages.push(`${newRole}, signs in with ${SIGN_IN_LABEL[provider]}${provider === 'local' ? '' : ' (active on first sign-in)'}`);
    if (invite) res.invite = { role: newRole, provider };
    else if (provider === 'local') res.messages.push('No invite sent: send one later from Admin → Users to let them set a password');
  }
  return out;
}

async function applyUsers(plan, importer) {
  const client = await pool.connect();
  const invites = [];
  try {
    await client.query('BEGIN');
    for (const p of plan) {
      if (p.action === 'error' || p.action === 'unchanged') continue;
      const u = p.user;
      if (p.newUser) {
        const r = await client.query(
          `INSERT INTO users (email, display_name, role, auth_provider, status, invited_by)
           VALUES ($1, $2, $3, $4, 'invited', $5) RETURNING id`,
          [u.email, u.display_name, u.role, u.auth_provider, importer.id]
        );
        u.id = r.rows[0].id;
      }
      if (Object.keys(p.person).length) {
        const patch = await buildWritePatch(client, 'users', p.person);
        await client.query(
          `UPDATE users SET ${patch.cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${patch.cols.length + 1}`,
          [...patch.values, u.id]
        );
      }
      if (p.company) {
        const m = p.membership;
        const cols = ['company_id', 'user_id', 'added_by', ...Object.keys(m)];
        const vals = [p.company.id, u.id, importer.id, ...Object.values(m)];
        const upd = Object.keys(m).map((k) => `${k} = EXCLUDED.${k}`);
        await client.query(
          `INSERT INTO company_members (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
           ON CONFLICT (company_id, user_id) DO ${upd.length ? `UPDATE SET ${upd.join(', ')}` : 'NOTHING'}`,
          vals
        );
      }
    }
    for (const p of plan) if (p.invite && p.action !== 'error') invites.push({ email: p.user.email, ...p.invite });
    const s = summarize(plan);
    await client.query(
      `INSERT INTO audit_log (ticket_id, user_id, action, note) VALUES (NULL, $1, 'users_imported', $2)`,
      [importer.id, `Users CSV: ${s.create} added, ${s.update} updated, ${invites.length} invite(s)`]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return invites;
}

// ── Preview / apply ─────────────────────────────────────────────────────

router.post('/:kind', async (req, res) => {
  const { kind } = req.params;
  if (!COLUMNS[kind]) return res.status(404).json({ error: 'not found' });
  let parsed;
  try {
    parsed = readCsv(req.body?.csv, kind);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  try {
    const plan = kind === 'locations' ? await planLocations(parsed) : await planUsers(parsed, req.session.user);
    const summary = summarize(plan);
    const rows = plan.map((p) => ({ line: p.line, key: p.key, action: p.action, error: p.error || null, messages: p.messages,
      invite: p.invite && p.action !== 'error' ? true : undefined }));
    if (!req.body.apply) return res.json({ applied: false, summary, rows });
    if (summary.error) return res.status(400).json({ error: 'Fix the rows with errors, then import again', summary, rows });
    let invitesSent = 0;
    let inviteFailures = [];
    if (kind === 'locations') await applyLocations(plan, req.session.user);
    else {
      const invites = await applyUsers(plan, req.session.user);
      for (const inv of invites) {
        try {
          await issueInvite({
            email: inv.email, role: inv.role, provider: inv.provider,
            invitedById: req.session.user.id, invitedByName: req.session.user.displayName,
            baseUrl: inviteBaseUrl(req),
          });
          invitesSent++;
        } catch (e) {
          console.error('import invite failed:', inv.email, e.message);
          inviteFailures.push(inv.email);
        }
      }
    }
    res.json({ applied: true, summary, rows, invites_sent: invitesSent, invite_failures: inviteFailures });
  } catch (err) {
    console.error(`${kind} import:`, err);
    res.status(500).json({ error: 'Import failed; nothing was changed' });
  }
});

module.exports = router;
module.exports._test = { readCsv, yesNo, csvCell };
