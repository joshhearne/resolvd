// Track recently opened tickets in localStorage so the TicketList's
// left rail can surface a per-user navigation history. The list is
// capped + deduped by id, sorted most-recent-first.
const KEY = "resolvd.recentTickets.v1";
const CAP = 20;

export function pushRecentTicket({ id, ref, title }) {
  if (!id) return;
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    const filtered = arr.filter((t) => t.id !== id);
    filtered.unshift({ id, ref: ref || `#${id}`, title: title || "", ts: Date.now() });
    localStorage.setItem(KEY, JSON.stringify(filtered.slice(0, CAP)));
    window.dispatchEvent(new CustomEvent("resolvd:recent-tickets-changed"));
  } catch {
    /* quota / private mode */
  }
}

export function getRecentTickets() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function clearRecentTickets() {
  try {
    localStorage.removeItem(KEY);
    window.dispatchEvent(new CustomEvent("resolvd:recent-tickets-changed"));
  } catch {
    /* ignore */
  }
}
