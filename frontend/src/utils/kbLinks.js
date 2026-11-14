// Mirror of backend/services/kbLinks.js buildKbUrl/markdownLink (keep in
// sync; the backend copy has the unit tests).
//   PDF      #page=N&search=term&phrase=true (phrase only for multi-word)
//   Article  #:~:text=term (browser text fragment; page not applicable)

const MAX_PAGE = 100000;
const MAX_TERM = 200;

export function cleanPage(page) {
  if (page == null || page === "") return null;
  const s = String(page).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= MAX_PAGE ? n : null;
}

function cleanTerm(term) {
  const s = String(term ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, MAX_TERM) : null;
}

function enc(s) {
  return encodeURIComponent(s).replace(/[()'!*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function stripFragment(url) {
  const s = String(url || "");
  const i = s.indexOf("#");
  return i === -1 ? s : s.slice(0, i);
}

export function buildKbUrl(base, { pdf = false, page = null, search = null } = {}) {
  const b = stripFragment(base);
  if (!b) return "";
  const p = cleanPage(page);
  const t = cleanTerm(search);
  if (pdf) {
    const parts = [];
    if (p) parts.push(`page=${p}`);
    if (t) {
      parts.push(`search=${enc(t)}`);
      if (/\s/.test(t)) parts.push("phrase=true");
    }
    return parts.length ? `${b}#${parts.join("&")}` : b;
  }
  return t ? `${b}#:~:text=${enc(t).replace(/-/g, "%2D").replace(/,/g, "%2C")}` : b;
}

export function markdownLink(title, url) {
  const t = String(title || "").replace(/([\\[\]])/g, "\\$1").replace(/\s+/g, " ").trim();
  return `[${t || "Documentation"}](${url})`;
}

// True when the text contains a link the server can target (Trove public
// article / PDF, or a local KB article / PDF).
const KB_LINK_RE = /\/pub\/kb\/articles\/[0-9a-f-]{36}|\/api\/kb\/articles\/\d+\/pdf|\/kb\/\d+\/[a-z0-9][a-z0-9-]*/i;
export function hasKbLink(text) {
  return KB_LINK_RE.test(String(text || ""));
}

// KB links in a text, one entry per distinct document (base URL), with the
// line each first appears on (context for the "Target links" dialog).
export function listKbLinks(text) {
  const s = String(text || "");
  const out = [];
  const seen = new Set();
  const re = /\[([^\]]*)\]\(((?:https?:\/\/|\/)[^\s)]+)\)|https?:\/\/[^\s)<>\]]+/g;
  let m;
  while ((m = re.exec(s))) {
    const url = m[2] || m[0];
    if (!KB_LINK_RE.test(url)) continue;
    const base = stripFragment(url);
    if (seen.has(base)) continue;
    seen.add(base);
    const start = s.lastIndexOf("\n", m.index - 1) + 1;
    const end = s.indexOf("\n", m.index);
    out.push({ url, base, title: m[1] || null, line: s.slice(start, end === -1 ? s.length : end).trim() });
  }
  return out;
}
