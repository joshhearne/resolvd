// KB link building + parsing, shared by the link inserter, knowledge briefs
// and AI link targeting. Pure functions (no I/O) so they're unit-testable;
// frontend/src/utils/kbLinks.js mirrors buildKbUrl/markdownLink.
//
// Two document kinds:
//   PDF      browser PDF viewers read `#page=N&search=term&phrase=true`
//            (phrase=true keeps a multi-word term together). Trove KB serves
//            an imported PDF at <public article url>/original; a local KB
//            article's attached PDF lives at /api/kb/articles/<id>/pdf.
//   Article  HTML pages get no page anchor; a search term becomes a
//            text fragment (`#:~:text=…`) that browsers scroll to + highlight.

const MAX_PAGE = 100000;
const MAX_TERM = 200;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TROVE_ORIGINAL_RE = new RegExp(`/pub/kb/articles/(${UUID})/original/?$`, 'i');
const TROVE_ARTICLE_RE = new RegExp(`/pub/kb/articles/(${UUID})/?$`, 'i');
const LOCAL_PDF_RE = /\/api\/kb\/articles\/(\d+)\/pdf\/?$/;
const LOCAL_ARTICLE_RE = /\/kb\/(\d+)\/([a-z0-9][a-z0-9-]*)\/?$/i;

function cleanPage(page) {
  if (page == null || page === '') return null;
  const s = String(page).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= MAX_PAGE ? n : null;
}

function cleanTerm(term) {
  const s = String(term ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, MAX_TERM) : null;
}

// encodeURIComponent leaves ( ) ' ! * alone; parentheses would end a
// markdown link early, so encode them too.
function enc(s) {
  return encodeURIComponent(s).replace(/[()'!*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// Text-fragment syntax reserves - , & as delimiters.
function encFragmentText(s) {
  return enc(s).replace(/-/g, '%2D').replace(/,/g, '%2C');
}

function stripFragment(url) {
  const s = String(url || '');
  const i = s.indexOf('#');
  return i === -1 ? s : s.slice(0, i);
}

// Build the targeted URL. `pdf` decides page/search vs text-fragment.
function buildKbUrl(base, { pdf = false, page = null, search = null } = {}) {
  const b = stripFragment(base);
  if (!b) return '';
  const p = cleanPage(page);
  const t = cleanTerm(search);
  if (pdf) {
    const parts = [];
    if (p) parts.push(`page=${p}`);
    if (t) {
      parts.push(`search=${enc(t)}`);
      if (/\s/.test(t)) parts.push('phrase=true');
    }
    return parts.length ? `${b}#${parts.join('&')}` : b;
  }
  return t ? `${b}#:~:text=${encFragmentText(t)}` : b;
}

function escapeMdText(s) {
  return String(s || '').replace(/([\\[\]])/g, '\\$1').replace(/\s+/g, ' ').trim();
}

function markdownLink(title, url) {
  return `[${escapeMdText(title) || 'Documentation'}](${url})`;
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// Parse the fragment of a KB URL back into { page, search }.
function parseFragment(url) {
  const s = String(url || '');
  const i = s.indexOf('#');
  if (i === -1) return { page: null, search: null };
  const frag = s.slice(i + 1);
  if (frag.startsWith(':~:text=')) {
    return { page: null, search: cleanTerm(safeDecode(frag.slice(8).split('&')[0])) };
  }
  let page = null;
  let search = null;
  for (const kv of frag.split('&')) {
    const [k, v = ''] = kv.split('=');
    if (k === 'page') page = cleanPage(v);
    else if (k === 'search') search = cleanTerm(safeDecode(v.replace(/\+/g, ' ')));
  }
  return { page, search };
}

// Identify a KB link. Returns null for anything that isn't one.
// { source: 'trove'|'local', pdf, base, id?, projectId?, slug?, page, search }
function parseKbLink(url) {
  const raw = String(url || '').trim();
  if (!/^https?:\/\//i.test(raw) && !raw.startsWith('/')) return null;
  const base = stripFragment(raw).replace(/\?.*$/, '');
  const frag = parseFragment(raw);
  let m;
  if ((m = base.match(TROVE_ORIGINAL_RE))) return { source: 'trove', pdf: true, id: m[1].toLowerCase(), base: stripFragment(raw), ...frag };
  if ((m = base.match(TROVE_ARTICLE_RE))) return { source: 'trove', pdf: false, id: m[1].toLowerCase(), base: stripFragment(raw), ...frag };
  if ((m = base.match(LOCAL_PDF_RE))) return { source: 'local', pdf: true, id: Number(m[1]), base: stripFragment(raw), ...frag };
  if ((m = base.match(LOCAL_ARTICLE_RE))) return { source: 'local', pdf: false, projectId: Number(m[1]), slug: m[2], base: stripFragment(raw), ...frag };
  return null;
}

// Every markdown link + bare URL in a text, with its offset and the line it
// sits on (context for the AI and the UI). KB links only.
function findKbLinks(text) {
  const s = String(text || '');
  const out = [];
  const seen = new Set();
  const lineAt = (idx) => {
    const start = s.lastIndexOf('\n', idx - 1) + 1;
    const end = s.indexOf('\n', idx);
    return s.slice(start, end === -1 ? s.length : end).trim();
  };
  const md = /\[([^\]]*)\]\((https?:\/\/[^\s)]+|\/[^\s)]+)\)/g;
  let m;
  while ((m = md.exec(s))) {
    const parsed = parseKbLink(m[2]);
    if (!parsed) continue;
    seen.add(m.index + m[0].indexOf(m[2]));
    out.push({ index: m.index, match: m[0], title: m[1], url: m[2], line: lineAt(m.index), ...parsed });
  }
  const bare = /https?:\/\/[^\s)<>\]]+/g;
  while ((m = bare.exec(s))) {
    if (seen.has(m.index)) continue;
    const parsed = parseKbLink(m[0]);
    if (!parsed) continue;
    out.push({ index: m.index, match: m[0], title: null, url: m[0], line: lineAt(m.index), ...parsed });
  }
  return out.sort((a, b) => a.index - b.index);
}

// Case/whitespace-insensitive "does this phrase occur in the document text".
function normalizeForMatch(s) {
  return String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
}
function phraseInText(phrase, text) {
  const p = normalizeForMatch(phrase);
  return !!p && normalizeForMatch(text).includes(p);
}

module.exports = {
  buildKbUrl, markdownLink, parseKbLink, parseFragment, findKbLinks,
  stripFragment, cleanPage, cleanTerm, phraseInText, escapeMdText,
  MAX_TERM,
};
