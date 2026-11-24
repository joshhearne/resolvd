// Calling-app link templates are admin-entered and end up as href values,
// so the server refuses anything that could run script or break out of
// the attribute (routes/callingApps.js templateError).

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { templateError } = require('../routes/callingApps');

describe('calling app templates', () => {
  it('accepts app schemes, https links and bare prefixes', () => {
    for (const t of ['tel:{number}', 'webextel://{number}', 'webextel://', 'zoomphonecall://{digits}',
      'https://teams.microsoft.com/l/call/0/0?users=4:{number}', 'rcmobile://call?number={number}']) {
      expect(templateError(t)).toBe(null);
    }
  });

  it('refuses script-capable schemes, missing schemes and attribute breakouts', () => {
    expect(templateError('javascript:alert(1)')).toMatch(/aren't allowed/);
    expect(templateError('JavaScript:alert(1)')).toMatch(/aren't allowed/);
    expect(templateError('data:text/html,hi')).toMatch(/aren't allowed/);
    expect(templateError('vbscript:x')).toMatch(/aren't allowed/);
    expect(templateError('//evil.example/{number}')).toMatch(/scheme/);
    expect(templateError('webextel://{number}" onclick="x')).toMatch(/spaces, quotes/);
    expect(templateError('')).toMatch(/required/);
  });

  it('requires {ext} in an extension link', () => {
    expect(templateError('tel:{number}', { needsExt: true })).toMatch(/\{ext\}/);
    expect(templateError('tel:{number},{ext}', { needsExt: true })).toBe(null);
  });
});
