// On-call rotations for SLA escalations.
//
// A rotation cycles through member_ids in order, one shift_hours-long
// shift each, anchored at handoff_at (the moment member_ids[0]'s shift
// starts). Shifts repeat forever in both directions, so who is on call
// at any instant is pure arithmetic — no per-shift rows to maintain.
// Overrides (swaps, cover for leave) put a specific user on call for a
// window and beat the rotation; the newest override wins on overlap.
//
// Scope mirrors SLA policies: a project's enabled rotations beat the
// org-wide ones (project_id IS NULL) — "who's on call for this ticket".
// A project can run several rotations (primary + secondary); notify_oncall
// pages each one's current person, reassign_oncall takes the first.
//
// onCallAt / upcomingShifts are pure; the rest load from the database.

const { pool } = require('../db/pool');

const HOUR_MS = 3_600_000;

function toMs(t) {
  return t instanceof Date ? t.getTime() : new Date(t).getTime();
}

// Index of the base-rotation shift containing `at` (may be negative
// before handoff_at).
function shiftIndex(rotation, atMs) {
  const len = Number(rotation.shift_hours) * HOUR_MS;
  return Math.floor((atMs - toMs(rotation.handoff_at)) / len);
}

function memberForShift(members, idx) {
  const n = members.length;
  return members[((idx % n) + n) % n];
}

function activeOverride(overrides, atMs) {
  let hit = null;
  for (const o of overrides || []) {
    if (toMs(o.starts_at) <= atMs && atMs < toMs(o.ends_at)) {
      if (!hit || toMs(o.created_at || 0) >= toMs(hit.created_at || 0)) hit = o;
    }
  }
  return hit;
}

// { user_id, source: 'override'|'rotation', until } | null
function onCallAt(rotation, overrides, at = new Date()) {
  if (!rotation || rotation.enabled === false) return null;
  const members = (rotation.member_ids || []).map(Number).filter(Boolean);
  const shiftHours = Number(rotation.shift_hours);
  if (!(shiftHours > 0) || !rotation.handoff_at) return null;
  const atMs = toMs(at);
  const o = activeOverride(overrides, atMs);
  if (o) return { user_id: Number(o.user_id), source: 'override', until: new Date(toMs(o.ends_at)) };
  if (!members.length) return null;
  const idx = shiftIndex(rotation, atMs);
  const until = new Date(toMs(rotation.handoff_at) + (idx + 1) * shiftHours * HOUR_MS);
  return { user_id: memberForShift(members, idx), source: 'rotation', until };
}

// Next `count` base-rotation shifts starting with the one in progress.
// Overrides are listed separately in the UI, not folded in here.
function upcomingShifts(rotation, from = new Date(), count = 4) {
  const members = (rotation?.member_ids || []).map(Number).filter(Boolean);
  const shiftHours = Number(rotation?.shift_hours);
  if (!members.length || !(shiftHours > 0) || !rotation.handoff_at) return [];
  const len = shiftHours * HOUR_MS;
  const base = toMs(rotation.handoff_at);
  const first = shiftIndex(rotation, toMs(from));
  const out = [];
  for (let i = first; i < first + count; i++) {
    out.push({
      user_id: memberForShift(members, i),
      starts_at: new Date(base + i * len),
      ends_at: new Date(base + (i + 1) * len),
    });
  }
  return out;
}

async function loadOverrides(db, rotationIds) {
  if (!rotationIds.length) return new Map();
  const r = await db.query(
    `SELECT * FROM oncall_overrides
      WHERE rotation_id = ANY($1::int[]) AND ends_at > NOW() - INTERVAL '1 day'`,
    [rotationIds]
  );
  const byRotation = new Map();
  for (const o of r.rows) {
    if (!byRotation.has(o.rotation_id)) byRotation.set(o.rotation_id, []);
    byRotation.get(o.rotation_id).push(o);
  }
  return byRotation;
}

// Rotations that answer for a ticket: an explicit rotation id, else the
// project's enabled rotations, else the org-wide ones.
async function rotationsFor(db, { projectId, rotationId }) {
  if (rotationId) {
    const r = await db.query(
      `SELECT * FROM oncall_rotations WHERE id = $1 AND enabled = TRUE`,
      [rotationId]
    );
    return r.rows;
  }
  if (projectId) {
    const r = await db.query(
      `SELECT * FROM oncall_rotations WHERE project_id = $1 AND enabled = TRUE ORDER BY id`,
      [projectId]
    );
    if (r.rows.length) return r.rows;
  }
  const r = await db.query(
    `SELECT * FROM oncall_rotations WHERE project_id IS NULL AND enabled = TRUE ORDER BY id`
  );
  return r.rows;
}

// [{ rotation, user_id }] for everyone currently on call for a ticket.
// Users who are no longer active are skipped.
async function currentOnCall(client, { projectId, rotationId, at = new Date() } = {}) {
  const db = client || pool;
  const rotations = await rotationsFor(db, { projectId, rotationId });
  if (!rotations.length) return [];
  const overrides = await loadOverrides(db, rotations.map((r) => r.id));
  const picks = [];
  for (const rotation of rotations) {
    const who = onCallAt(rotation, overrides.get(rotation.id) || [], at);
    if (who) picks.push({ rotation, user_id: who.user_id });
  }
  if (!picks.length) return [];
  const active = await db.query(
    `SELECT id FROM users WHERE id = ANY($1::int[]) AND status = 'active'`,
    [picks.map((p) => p.user_id)]
  );
  const ok = new Set(active.rows.map((r) => r.id));
  return picks.filter((p) => ok.has(p.user_id));
}

module.exports = { onCallAt, upcomingShifts, currentOnCall, loadOverrides };
