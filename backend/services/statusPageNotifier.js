// Status page email subscriptions.
//
//   - Up/down alerts: every TICK_MS, read new rows from
//     alert_item_state_changes (written by both the poller and the
//     webhook path), keep transitions into or out of 'down', map them to
//     the pages that show the item (directly or as a service component)
//     and email each subscriber one message per page per tick. An item
//     that went down and came back inside one tick is reported as a
//     brief outage. Changes during a maintenance window are skipped.
//   - Page changes: routes/statusPages.js calls notifyPageChanged()
//     after a curator adds services to a page.
//
// The cursor advances in a transaction before sending, so a send
// failure (mail backend / M365 down) never replays a storm later; it's
// logged and that batch is dropped. Private pages only mail staff.

const { pool } = require('../db/pool');
const { sendMail, baseHtml } = require('./email');
const { rollupServiceState } = require('./monitoredItems');
const access = require('./statusPageAccess');

const TICK_MS = 60 * 1000;
const BATCH = 1000;
const APP_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtDuration(ms) {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return h < 48 ? `${h}h ${mins % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

const fmtTime = (d) => new Date(d).toLocaleString('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

// Pure: collapse one item's ordered transitions in a batch into a
// single event. Returns null when nothing worth mailing happened.
//   transitions: [{ from_state, to_state, changed_at }] (asc)
function summarizeItem(transitions) {
  const relevant = transitions.filter((c) => c.to_state === 'down' || c.from_state === 'down');
  if (!relevant.length) return null;
  const first = relevant[0];
  const last = relevant[relevant.length - 1];
  const wentDown = relevant.find((c) => c.to_state === 'down');
  if (last.to_state === 'down') {
    return { kind: 'down', at: last.changed_at };
  }
  if (wentDown && first.to_state === 'down') {
    // Down and back within the batch.
    return { kind: 'blip', at: wentDown.changed_at, until: last.changed_at };
  }
  return { kind: 'up', at: last.changed_at, to: last.to_state };
}

async function loadSubscribers(pageIds, flag) {
  const r = await pool.query(
    `SELECT s.page_id, u.id AS user_id, u.email, u.display_name, u.role,
            COALESCE(ARRAY(SELECT project_id FROM project_members WHERE user_id = u.id), '{}') AS member_project_ids
       FROM status_page_subscriptions s
       JOIN users u ON u.id = s.user_id
      WHERE s.page_id = ANY($1::int[]) AND s.${flag} = TRUE
        AND u.status = 'active' AND u.email IS NOT NULL AND u.email <> ''`,
    [pageIds]
  );
  return r.rows;
}

function canSee(page, sub) {
  // Same rule as the page itself (staff-only + project restriction).
  return access.canViewPage({ role: sub.role, memberProjectIds: sub.member_project_ids }, page);
}

async function sendToSubscribers(page, subs, subject, bodyHtml) {
  const html = await baseHtml(subject, bodyHtml + manageFooter(page));
  let sent = 0;
  for (const sub of subs) {
    if (!canSee(page, sub)) continue;
    try {
      await sendMail({ to: sub.email, subject, html });
      sent += 1;
    } catch (err) {
      console.error(`status notifier: send to ${sub.email} failed:`, err.message);
    }
  }
  return sent;
}

function manageFooter(page) {
  const url = `${APP_URL}/status/${encodeURIComponent(page.slug)}`;
  return `
    <p style="margin:16px 0 0"><a href="${url}" style="display:inline-block;background:#1e40af;color:#fff;text-decoration:none;padding:8px 14px;border-radius:6px;font-size:13px;font-weight:600">Open status page</a></p>
    <p style="color:#9ca3af;font-size:12px;margin:12px 0 0">You're subscribed to <strong>${esc(page.name)}</strong>. Use the Subscribe menu on the page to change or stop these emails.</p>`;
}

const STATE_WORD = { down: 'Down', partial: 'Partial outage', up: 'Operational', pending: 'Degraded', maintenance: 'Maintenance', unknown: 'Unknown' };
const STATE_COLOR = { down: '#dc2626', partial: '#ea580c', up: '#059669', pending: '#d97706', maintenance: '#0284c7', unknown: '#6b7280' };

function eventLine(ev) {
  const where = ev.isService ? `<strong>${esc(ev.serviceName)}</strong>`
    : `<strong>${esc(ev.serviceName)}</strong> › ${esc(ev.itemLabel)}`;
  let what;
  if (ev.kind === 'down') what = `<span style="color:#dc2626;font-weight:600">went down</span> at ${esc(fmtTime(ev.at))}`;
  else if (ev.kind === 'up') what = `<span style="color:#059669;font-weight:600">recovered</span> at ${esc(fmtTime(ev.at))}`;
  else what = `<span style="color:#ea580c;font-weight:600">brief outage</span> (${fmtDuration(new Date(ev.until) - new Date(ev.at))}) at ${esc(fmtTime(ev.at))}`;
  const svc = !ev.isService && ev.serviceState
    ? ` <span style="color:#6b7280">— service now <span style="color:${STATE_COLOR[ev.serviceState] || '#6b7280'}">${STATE_WORD[ev.serviceState] || ev.serviceState}</span></span>`
    : '';
  return `<li style="margin:0 0 6px">${where} ${what}${svc}</li>`;
}

function subjectFor(page, events) {
  if (events.length === 1) {
    const ev = events[0];
    const name = ev.isService ? ev.serviceName : `${ev.serviceName} › ${ev.itemLabel}`;
    const word = ev.kind === 'down' ? 'DOWN' : ev.kind === 'up' ? 'recovered' : 'brief outage';
    return `[${page.name}] ${name} ${word}`;
  }
  const down = events.filter((e) => e.kind === 'down').length;
  return `[${page.name}] ${events.length} status updates${down ? ` (${down} down)` : ''}`;
}

// One tick. Safe to call manually (tests). Returns a summary.
async function tickOnce() {
  const client = await pool.connect();
  let changes;
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO status_page_notifier_state (id) VALUES (1) ON CONFLICT DO NOTHING`);
    const st = await client.query(`SELECT last_change_id FROM status_page_notifier_state WHERE id = 1 FOR UPDATE`);
    const cursor = st.rows[0].last_change_id;
    if (cursor == null) {
      const max = await client.query(`SELECT COALESCE(MAX(id), 0) AS m FROM alert_item_state_changes`);
      await client.query(`UPDATE status_page_notifier_state SET last_change_id = $1, last_run_at = NOW() WHERE id = 1`, [max.rows[0].m]);
      await client.query('COMMIT');
      return { started: true, events: 0, emails: 0 };
    }
    const r = await client.query(
      `SELECT id, item_id, from_state, to_state, changed_at
         FROM alert_item_state_changes WHERE id > $1 ORDER BY id ASC LIMIT ${BATCH}`,
      [cursor]
    );
    changes = r.rows;
    const next = changes.length ? changes[changes.length - 1].id : cursor;
    await client.query(`UPDATE status_page_notifier_state SET last_change_id = $1, last_run_at = NOW() WHERE id = 1`, [next]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (!changes.length) return { events: 0, emails: 0 };

  // Group transitions by item, then summarize.
  const byItem = new Map();
  for (const c of changes) {
    if (!byItem.has(c.item_id)) byItem.set(c.item_id, []);
    byItem.get(c.item_id).push(c);
  }
  const summaries = new Map();
  for (const [itemId, list] of byItem) {
    const s = summarizeItem(list);
    if (s) summaries.set(itemId, s);
  }
  if (!summaries.size) return { events: 0, emails: 0 };
  const itemIds = [...summaries.keys()];

  // Skip transitions inside a maintenance window on the item or its parent.
  const mw = await pool.query(
    `SELECT DISTINCT i.id, w.starts_at, w.ends_at
       FROM alert_monitored_items i
       JOIN maintenance_window_items mi ON mi.item_id = i.id OR mi.item_id = i.parent_item_id
       JOIN maintenance_windows w ON w.id = mi.window_id
      WHERE i.id = ANY($1::int[]) AND w.ends_at > NOW() - INTERVAL '1 day'`,
    [itemIds]
  );
  const inMaint = (itemId, at) => mw.rows.some((w) => w.id === itemId
    && new Date(at) >= new Date(w.starts_at) && new Date(at) < new Date(w.ends_at));

  // Pages that show each item (as a service or a component of one).
  const placements = await pool.query(
    `SELECT p.id AS page_id, p.name AS page_name, p.slug, p.is_public,
            spi.item_id AS service_id, COALESCE(spi.display_name, svc.label) AS service_name,
            ci.id AS item_id, ci.label AS item_label
       FROM alert_monitored_items ci
       JOIN status_page_items spi ON spi.item_id = ci.id OR spi.item_id = ci.parent_item_id
       JOIN alert_monitored_items svc ON svc.id = spi.item_id
       JOIN status_pages p ON p.id = spi.page_id
      WHERE ci.id = ANY($1::int[])`,
    [itemIds]
  );
  if (!placements.rows.length) return { events: 0, emails: 0 };

  // Current rolled-up state of affected services, for context lines.
  const serviceIds = [...new Set(placements.rows.map((p) => p.service_id))];
  const comps = await pool.query(
    `SELECT parent_item_id, COALESCE(last_state, 'unknown') AS state, is_primary
       FROM alert_monitored_items WHERE parent_item_id = ANY($1::int[]) AND active`,
    [serviceIds]
  );
  const serviceState = new Map();
  for (const sid of serviceIds) {
    const mine = comps.rows.filter((c) => c.parent_item_id === sid);
    if (mine.length) serviceState.set(sid, rollupServiceState(mine, 'unknown'));
  }

  const pages = new Map();
  for (const pl of placements.rows) {
    const s = summaries.get(pl.item_id);
    if (!s || inMaint(pl.item_id, s.at)) continue;
    if (!pages.has(pl.page_id)) {
      pages.set(pl.page_id, { page: { id: pl.page_id, name: pl.page_name, slug: pl.slug, is_public: pl.is_public }, events: [] });
    }
    pages.get(pl.page_id).events.push({
      ...s,
      isService: pl.item_id === pl.service_id,
      serviceName: pl.service_name,
      itemLabel: pl.item_label,
      serviceState: serviceState.get(pl.service_id) || null,
    });
  }
  if (!pages.size) return { events: 0, emails: 0 };
  const limits = await access.pageProjectIds([...pages.keys()]);
  for (const [pid, entry] of pages) entry.page.project_ids = limits.get(pid) || [];

  const subs = await loadSubscribers([...pages.keys()], 'notify_state');
  let emails = 0;
  let events = 0;
  for (const { page, events: evs } of pages.values()) {
    const mine = subs.filter((s) => s.page_id === page.id);
    events += evs.length;
    if (!mine.length) continue;
    evs.sort((a, b) => new Date(a.at) - new Date(b.at));
    const body = `
      <p style="color:#374151;font-size:14px;margin:0 0 10px">Status update for <strong>${esc(page.name)}</strong>:</p>
      <ul style="color:#374151;font-size:14px;padding-left:18px;margin:0">${evs.map(eventLine).join('')}</ul>`;
    emails += await sendToSubscribers(page, mine, subjectFor(page, evs), body);
  }
  return { events, emails };
}

// Called after a curator adds services to a page.
async function notifyPageChanged(pageId, addedItemIds) {
  if (!addedItemIds.length) return { emails: 0 };
  const p = await pool.query(`SELECT id, name, slug, is_public FROM status_pages WHERE id = $1`, [pageId]);
  const page = p.rows[0];
  if (!page) return { emails: 0 };
  page.project_ids = (await access.pageProjectIds([page.id])).get(page.id) || [];
  const items = await pool.query(
    `SELECT COALESCE(spi.display_name, i.label) AS name, spi.section
       FROM status_page_items spi JOIN alert_monitored_items i ON i.id = spi.item_id
      WHERE spi.page_id = $1 AND spi.item_id = ANY($2::int[])
      ORDER BY spi.sort_order`,
    [pageId, addedItemIds]
  );
  if (!items.rows.length) return { emails: 0 };
  const subs = await loadSubscribers([pageId], 'notify_changes');
  if (!subs.length) return { emails: 0 };
  const n = items.rows.length;
  const subject = `[${page.name}] ${n === 1 ? `New service: ${items.rows[0].name}` : `${n} services added`}`;
  const body = `
    <p style="color:#374151;font-size:14px;margin:0 0 10px">${n === 1 ? 'A service was' : `${n} services were`} added to <strong>${esc(page.name)}</strong>:</p>
    <ul style="color:#374151;font-size:14px;padding-left:18px;margin:0">
      ${items.rows.map((i) => `<li>${esc(i.name)}${i.section ? ` <span style="color:#6b7280">(${esc(i.section)})</span>` : ''}</li>`).join('')}
    </ul>`;
  return { emails: await sendToSubscribers(page, subs, subject, body) };
}

let timer = null;
function startScheduler() {
  if (timer) return;
  const run = () => tickOnce().catch((err) => console.error('status notifier tick:', err.message));
  timer = setInterval(run, TICK_MS);
  if (timer.unref) timer.unref();
  setTimeout(run, 15 * 1000).unref?.();
}

module.exports = { tickOnce, notifyPageChanged, startScheduler, summarizeItem, TICK_MS };
