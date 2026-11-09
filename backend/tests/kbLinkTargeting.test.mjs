// AI link targeting: token resolution + the full flow with the AI, Trove KB
// and PDF loading stubbed. The point under test is the safety model: the
// server, not the model, decides every URL.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pool } = require('../db/pool');
const resolution = require('../services/troveKbResolution');
const troveKb = require('../services/troveKb');
const pdfText = require('../services/pdfText');
const { targetLinks, resolveToken } = require('../services/kbLinkTargeting');

const ID = '91c78745-4707-4f28-b6c5-7d58064aab8d';
const BASE = `https://kb.gomotx.com/pub/kb/articles/${ID}/original`;
const PAGES = [
  { page: 1, text: 'Welcome to the printer guide' },
  { page: 110, text: 'Network settings: open Scan to Network and pick a folder' },
  { page: 112, text: 'Duplex printing: enable Two-Sided in Print Settings' },
];

describe('resolveToken', () => {
  const doc = { link: { pdf: true, base: BASE }, pages: PAGES };
  it('builds the URL when page + phrase check out', () => {
    const r = resolveToken(doc, ' page=110 search="Scan to Network"');
    expect(r.url).toBe(`${BASE}#page=110&search=Scan%20to%20Network&phrase=true`);
    expect(r.notes).toEqual([]);
  });
  it('moves to the page the phrase is actually on', () => {
    const r = resolveToken(doc, ' page=1 search="Two-Sided"');
    expect(r.page).toBe(112);
    expect(r.notes[0]).toMatch(/moved to page 112/);
  });
  it('drops invented phrases and missing pages', () => {
    const r = resolveToken(doc, ' page=999 search="Fax wizard"');
    expect(r.url).toBe(BASE);
    expect(r.notes).toHaveLength(2);
  });
  it('web articles: no page, phrase must be in the body', () => {
    const web = { link: { pdf: false, base: 'https://kb.x/pub/kb/articles/' + ID }, pages: null, body: 'Open Settings then Wi-Fi.' };
    expect(resolveToken(web, ' page=3 search="Open Settings"').url).toBe(`${web.link.base}#:~:text=Open%20Settings`);
  });
});

describe('targetLinks', () => {
  let aiText;
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(pool, 'query').mockResolvedValue({ rows: [{ id: 7 }] });
    vi.spyOn(troveKb, 'getArticle').mockResolvedValue({ article_id: ID, title: 'Printer manual', pdf_url: BASE, date_modified: 'x' });
    vi.spyOn(pdfText, 'cachedPages').mockResolvedValue(PAGES);
    vi.spyOn(resolution, 'aiAvailability').mockResolvedValue({
      available: true,
      eff: { provider: 'test', model: 'm', api_key: 'k', source: 'org' },
      adapter: { defaultEndpoint: 'x', complete: async ({ user }) => { expect(user).toContain('kb:D1'); expect(user).not.toContain(BASE); return { text: aiText, usage: { input_tokens: 1, output_tokens: 1 } }; } },
    });
  });

  it('rewrites into stepped, verified links and never trusts AI URLs', async () => {
    aiText = [
      '1. Open the scan menu [Printer manual](kb:D1 page=110 search="Scan to Network")',
      '2. Turn on two-sided [Printer manual](kb:D1 page=1 search="Two-Sided")',
      '3. Fax it [Printer manual](kb:D1 search="Fax wizard")',
      '4. Extra [Other](https://kb.gomotx.com/pub/kb/articles/00000000-0000-0000-0000-000000000000/original#page=2)',
    ].join('\n');
    const out = await targetLinks({
      user: { id: 1 }, ticket: { project_id: 1 },
      text: `Use the scanner and duplex. See [Printer manual](${BASE}).`,
      targets: [{ url: BASE, note: 'scanning + duplex' }],
    });
    expect(out.text).toContain(`(${BASE}#page=110&search=Scan%20to%20Network&phrase=true)`);
    expect(out.text).toContain(`(${BASE}#page=112&search=Two-Sided)`);
    expect(out.text).toContain(`3. Fax it [Printer manual](${BASE})`);
    expect(out.text).not.toContain('00000000-0000');
    expect(out.warnings.join(' ')).toMatch(/wasn't in your reply/);
    expect(out.changes).toHaveLength(3);
  });

  it('refuses when there is no KB link', async () => {
    await expect(targetLinks({ user: { id: 1 }, text: 'no links here' })).rejects.toThrow(/No KB links/);
  });
});
