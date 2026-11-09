// pdf.js page-text extraction against a tiny hand-built 3-page fixture.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { extractPages, cachedPages } = require('../services/pdfText');
const buf = readFileSync(new URL('./fixtures/sample-3page.pdf', import.meta.url));

describe('pdfText', () => {
  it('extracts text per page, 1-based', async () => {
    const pages = await extractPages(buf);
    expect(pages.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(pages[1].text).toContain('Scan to Network');
  });
  it('caches by key', async () => {
    let loads = 0;
    const load = async () => { loads++; return buf; };
    await cachedPages('k1', load);
    await cachedPages('k1', load);
    expect(loads).toBe(1);
  });
});
