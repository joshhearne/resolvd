// Web Push fan-out. Loads VAPID config lazily so missing env vars
// don't crash the server — push just no-ops until configured.
//
// Subscriptions live in push_subscriptions (one row per browser/device).
// On send failure with 404/410 we prune the dead row; other errors get
// logged and swallowed so a bad endpoint can't fail the parent request.

const { pool } = require('../db/pool');

let webpush = null;
let vapidConfigured = false;

function getWebPush() {
  if (webpush) return webpush;
  try {
    webpush = require('web-push');
  } catch (err) {
    console.warn('[push] web-push not installed; push disabled');
    return null;
  }
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  if (!pub || !priv) {
    console.warn('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY missing; push disabled');
    return null;
  }
  webpush.setVapidDetails(subject, pub, priv);
  vapidConfigured = true;
  return webpush;
}

function isConfigured() {
  getWebPush();
  return vapidConfigured;
}

function getPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

async function sendToSubscription(sub, payload) {
  const wp = getWebPush();
  if (!wp || !vapidConfigured) return { ok: false, gone: false };
  try {
    await wp.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
    return { ok: true, gone: false };
  } catch (err) {
    const status = err && err.statusCode;
    if (status === 404 || status === 410) return { ok: false, gone: true };
    console.error('[push] send failed:', status || err.message);
    return { ok: false, gone: false };
  }
}

// Send a payload to every active subscription for a user. Prunes
// expired endpoints. Payload shape consumed by sw.js:
//   { title, body, url, tag }
async function sendPushToUser(userId, payload) {
  if (!isConfigured()) return;
  const r = await pool.query(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
    [userId]
  );
  if (!r.rows.length) return;
  const stale = [];
  for (const sub of r.rows) {
    const res = await sendToSubscription(sub, payload);
    if (res.gone) stale.push(sub.id);
    else if (res.ok) {
      pool.query(`UPDATE push_subscriptions SET last_used_at = NOW() WHERE id = $1`, [sub.id])
        .catch(() => {});
    }
  }
  if (stale.length) {
    pool.query(`DELETE FROM push_subscriptions WHERE id = ANY($1::int[])`, [stale])
      .catch(err => console.error('[push] prune failed:', err.message));
  }
}

module.exports = { sendPushToUser, isConfigured, getPublicKey };
