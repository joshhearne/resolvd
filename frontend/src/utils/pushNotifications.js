// Web Push subscription manager. Wraps the SW registration and the
// PushManager subscribe/unsubscribe dance, plus the backend round-trips.
// All callers should treat push as best-effort — anything can fail (no
// permission, denied, no SW support, no VAPID configured server-side).

const SW_PATH = '/sw.js';

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export function isPushSupported() {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

export function getNotificationPermission() {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission;
}

async function registerSW() {
  return navigator.serviceWorker.register(SW_PATH);
}

async function getVapidPublicKey() {
  const r = await fetch('/api/push/vapid-public-key', { credentials: 'include' });
  if (!r.ok) throw new Error('Push not configured on server');
  const data = await r.json();
  if (!data.key) throw new Error('No VAPID key returned');
  return data.key;
}

// Returns the active PushSubscription, or null if not subscribed yet.
export async function getCurrentSubscription() {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration(SW_PATH)
    || await registerSW();
  return reg.pushManager.getSubscription();
}

// Asks for permission (if needed), creates a subscription, registers it
// with the backend. Throws on denied/unsupported.
export async function subscribePush() {
  if (!isPushSupported()) throw new Error('Push not supported in this browser');
  const perm = Notification.permission === 'default'
    ? await Notification.requestPermission()
    : Notification.permission;
  if (perm !== 'granted') throw new Error('Notification permission denied');

  const reg = await registerSW();
  // Wait for SW to be active before subscribing; otherwise pushManager
  // can race on first install.
  if (reg.installing) {
    await new Promise((resolve) => {
      reg.installing.addEventListener('statechange', (e) => {
        if (e.target.state === 'activated') resolve();
      });
    });
  }

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const key = await getVapidPublicKey();
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }

  const json = sub.toJSON();
  const body = { endpoint: json.endpoint, keys: json.keys };
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Failed to register subscription');
  return sub;
}

// Unsubscribes locally and tells the backend to drop the row.
export async function unsubscribePush() {
  if (!isPushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  await fetch('/api/push/subscribe', {
    method: 'DELETE',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  }).catch(() => {});
}
