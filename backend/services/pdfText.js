// Per-page text extraction from a PDF buffer (Mozilla pdf.js, no native
// deps). Used by AI link targeting so the model can pick a real page number
// and a phrase that actually occurs on it, and so the server can verify both.
//
// Results are cached in-process by a caller-supplied key (article id + a
// version stamp) because the same manual gets targeted repeatedly.

const MAX_PAGES = 2000;
const MAX_PAGE_CHARS = 20000;
const CACHE_MAX = 20;

const cache = new Map(); // key -> [{ page, text }]

let pdfjsPromise = null;
function loadPdfjs() {
  // pdfjs-dist ships ESM only; the legacy build runs in Node without DOM.
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

async function extractPages(buffer) {
  const pdfjs = await loadPdfjs();
  const data = buffer instanceof Uint8Array ? new Uint8Array(buffer) : new Uint8Array(Buffer.from(buffer));
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  try {
    const n = Math.min(doc.numPages, MAX_PAGES);
    const pages = [];
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const text = tc.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : ' ')).join('')
        .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_PAGE_CHARS);
      pages.push({ page: i, text });
      page.cleanup();
    }
    return pages;
  } finally {
    await doc.destroy();
  }
}

async function cachedPages(key, loadBuffer) {
  if (key && cache.has(key)) {
    const v = cache.get(key);
    cache.delete(key); cache.set(key, v); // LRU bump
    return v;
  }
  const pages = await extractPages(await loadBuffer());
  if (key) {
    cache.set(key, pages);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return pages;
}

module.exports = { extractPages, cachedPages };
