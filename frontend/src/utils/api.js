const BASE = '';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });

  if (res.status === 401) {
    // Send users to the login page (multi-provider chooser) instead of jumping
    // straight into one provider's flow. Skip when already on /login or /accept-invite.
    const here = window.location.pathname;
    if (!here.startsWith('/login') && !here.startsWith('/accept-invite') &&
        !here.startsWith('/reset-password') && !here.startsWith('/forgot-password') &&
        !here.startsWith('/mfa-challenge')) {
      window.location.href = '/login';
    }
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Unauthenticated');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: (path, body) => request(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: (path) => request(path, { method: 'DELETE' }),
};

export async function uploadCsv(file) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch('/api/admin/import/csv', {
    method: 'POST',
    credentials: 'include',
    body: formData,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
