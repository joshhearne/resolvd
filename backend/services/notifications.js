const { pool } = require('../db/pool');

async function createNotification(client, { userId, type, title, body = null, data = null }) {
  const result = await (client || pool).query(
    `INSERT INTO notifications (user_id, type, title, body, data)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [userId, type, title, body, data ? JSON.stringify(data) : null]
  );
  return result.rows[0].id;
}

// Broadcast to all Managers and Admins in the system.
async function notifyManagersAndAdmins(client, { type, title, body = null, data = null }) {
  const db = client || pool;
  const users = await db.query(
    `SELECT id FROM users WHERE role IN ('Admin','Manager') AND status = 'active'`
  );
  for (const u of users.rows) {
    await db.query(
      `INSERT INTO notifications (user_id, type, title, body, data)
       VALUES ($1, $2, $3, $4, $5)`,
      [u.id, type, title, body, data ? JSON.stringify(data) : null]
    );
  }
}

async function listForUser(userId) {
  const result = await pool.query(
    `SELECT id, type, title, body, data, read_at, created_at
     FROM notifications
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [userId]
  );
  return result.rows;
}

async function unreadCount(userId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [userId]
  );
  return result.rows[0].count;
}

async function markRead(id, userId) {
  await pool.query(
    `UPDATE notifications SET read_at = NOW() WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
    [id, userId]
  );
}

async function markAllRead(userId) {
  await pool.query(
    `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`,
    [userId]
  );
}

module.exports = { createNotification, notifyManagersAndAdmins, listForUser, unreadCount, markRead, markAllRead };
