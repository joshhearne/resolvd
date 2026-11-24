// CSV import parsing (routes/imports.js): header handling, yes/no cells,
// and export cells that spreadsheet apps would otherwise run as formulas.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readCsv, yesNo, csvCell } = require('../routes/imports')._test;

describe('readCsv', () => {
  it('normalises headers, strips a BOM, skips blank rows and numbers lines from the file', () => {
    const { header, rows } = readCsv('﻿Email,Job Title,send-invite\r\na@b.co, Tech lead ,yes\r\n,,\r\nc@d.co,"Parts, East",no\r\n', 'users');
    expect([...header]).toEqual(['email', 'job_title', 'send_invite']);
    expect(rows).toEqual([
      { line: 2, data: { email: 'a@b.co', job_title: 'Tech lead', send_invite: 'yes' } },
      { line: 3, data: { email: 'c@d.co', job_title: 'Parts, East', send_invite: 'no' } },
    ]);
  });

  it('rejects unknown and missing required columns', () => {
    expect(() => readCsv('email,shoe_size\na@b.co,9\n', 'users')).toThrow(/Unknown column: shoe_size/);
    expect(() => readCsv('name,code\nHQ,HQ\n', 'locations')).toThrow(/Missing required column: company/);
    expect(() => readCsv('   ', 'users')).toThrow(/empty/);
  });

  it('caps the row count', () => {
    const big = 'email\n' + Array.from({ length: 5001 }, (_, i) => `u${i}@x.co`).join('\n');
    expect(() => readCsv(big, 'users')).toThrow(/At most 5000/);
  });
});

describe('yesNo', () => {
  it('reads common spellings and flags anything else', () => {
    for (const v of ['yes', 'Y', 'TRUE', '1', 'x']) expect(yesNo(v)).toBe(true);
    for (const v of ['', 'no', 'N', 'false', '0']) expect(yesNo(v)).toBe(false);
    expect(yesNo('maybe')).toBeUndefined();
  });
});

describe('csvCell', () => {
  it('quotes commas and quotes, and defuses formulas but not phone numbers', () => {
    expect(csvCell('Suite 101, Dallas')).toBe('"Suite 101, Dallas"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('+1 936 555 0100')).toBe('+1 936 555 0100');
    expect(csvCell(null)).toBe('');
  });
});
