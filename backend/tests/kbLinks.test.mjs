// Pure-function tests for KB link building / parsing.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildKbUrl, markdownLink, parseKbLink, findKbLinks, phraseInText, cleanPage } = require('../services/kbLinks');

const ORIG = 'https://kb.gomotx.com/pub/kb/articles/91c78745-4707-4f28-b6c5-7d58064aab8d/original';

describe('buildKbUrl', () => {
  it('matches the reference PDF link (page + multi-word phrase)', () => {
    expect(buildKbUrl(ORIG, { pdf: true, page: 110, search: 'Scan to Network' }))
      .toBe(`${ORIG}#page=110&search=Scan%20to%20Network&phrase=true`);
  });
  it('omits phrase for a single word, and either part may be absent', () => {
    expect(buildKbUrl(ORIG, { pdf: true, search: 'duplex' })).toBe(`${ORIG}#search=duplex`);
    expect(buildKbUrl(ORIG, { pdf: true, page: '7' })).toBe(`${ORIG}#page=7`);
    expect(buildKbUrl(ORIG, { pdf: true })).toBe(ORIG);
  });
  it('rejects non-numeric / out-of-range pages', () => {
    expect(buildKbUrl(ORIG, { pdf: true, page: '1e3' })).toBe(ORIG);
    expect(buildKbUrl(ORIG, { pdf: true, page: 0 })).toBe(ORIG);
    expect(cleanPage('12a')).toBe(null);
  });
  it('replaces an existing fragment instead of stacking', () => {
    expect(buildKbUrl(`${ORIG}#page=3`, { pdf: true, page: 4 })).toBe(`${ORIG}#page=4`);
  });
  it('uses a text fragment for non-PDF articles and ignores page', () => {
    const art = 'https://kb.example.com/pub/kb/articles/91c78745-4707-4f28-b6c5-7d58064aab8d';
    expect(buildKbUrl(art, { page: 5, search: 'Wi-Fi, 5 GHz' })).toBe(`${art}#:~:text=Wi%2DFi%2C%205%20GHz`);
  });
  it('encodes parentheses so markdown links stay intact', () => {
    const u = buildKbUrl(ORIG, { pdf: true, search: 'Settings (Advanced)' });
    expect(u).not.toMatch(/[()]/);
    expect(markdownLink('Guide [v2]', u)).toBe(`[Guide \\[v2\\]](${u})`);
  });
});

describe('parseKbLink', () => {
  it('round-trips a targeted Trove PDF link', () => {
    const p = parseKbLink(`${ORIG}#page=110&search=Scan%20to%20Network&phrase=true`);
    expect(p).toMatchObject({ source: 'trove', pdf: true, id: '91c78745-4707-4f28-b6c5-7d58064aab8d', base: ORIG, page: 110, search: 'Scan to Network' });
  });
  it('recognises Trove articles, local PDFs and local articles', () => {
    expect(parseKbLink(ORIG.replace('/original', ''))).toMatchObject({ source: 'trove', pdf: false });
    expect(parseKbLink('https://help.acme.io/api/kb/articles/42/pdf#page=2')).toMatchObject({ source: 'local', pdf: true, id: 42, page: 2 });
    expect(parseKbLink('https://help.acme.io/kb/3/reset-vpn#:~:text=Click%20Save')).toMatchObject({ source: 'local', pdf: false, projectId: 3, slug: 'reset-vpn', search: 'Click Save' });
  });
  it('ignores other links', () => {
    expect(parseKbLink('https://example.com/page')).toBe(null);
    expect(parseKbLink('javascript:alert(1)')).toBe(null);
  });
});

describe('findKbLinks', () => {
  it('finds markdown and bare KB links with their line', () => {
    const text = `Step 1: open settings [Guide](${ORIG})\nOther https://example.com\nSee ${ORIG}#page=2`;
    const found = findKbLinks(text);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ title: 'Guide', line: `Step 1: open settings [Guide](${ORIG})` });
    expect(found[1]).toMatchObject({ title: null, page: 2 });
  });
});

describe('phraseInText', () => {
  it('matches case/whitespace-insensitively', () => {
    expect(phraseInText('scan  to network', 'Press Scan to\nNetwork now')).toBe(true);
    expect(phraseInText('fax', 'Press Scan')).toBe(false);
  });
});
