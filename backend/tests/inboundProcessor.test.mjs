// Pure-function tests for the inbound parser. parseSubjectPrefix and
// stripSignature don't touch the database, so they're a clean unit-test
// surface. The DB-touching paths (dedup, auto-create) need integration
// tests with a real Postgres — out of scope for this scaffold.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseSubjectPrefix, stripSignature } = require('../services/inboundProcessor');

describe('parseSubjectPrefix', () => {
  it('extracts prefix and title from "#PREFIX Title"', () => {
    expect(parseSubjectPrefix('#WEB Login button crashes'))
      .toEqual({ prefix: 'WEB', title: 'Login button crashes' });
  });

  it('handles multi-character alphanumeric prefix', () => {
    expect(parseSubjectPrefix('#PROJ42 Issue with widget'))
      .toEqual({ prefix: 'PROJ42', title: 'Issue with widget' });
  });

  it('strips an optional leading colon or dash separator', () => {
    expect(parseSubjectPrefix('#WEB: Login crashes')).toEqual({ prefix: 'WEB', title: 'Login crashes' });
    expect(parseSubjectPrefix('#WEB - Login crashes')).toEqual({ prefix: 'WEB', title: 'Login crashes' });
  });

  it('returns null when prefix has no title text', () => {
    expect(parseSubjectPrefix('#WEB')).toBeNull();
    expect(parseSubjectPrefix('#WEB ')).toBeNull();
  });

  it('returns null without a leading hash', () => {
    expect(parseSubjectPrefix('WEB Login crashes')).toBeNull();
    expect(parseSubjectPrefix('Re: #WEB Login crashes')).toBeNull();
  });

  it('uppercases the matched prefix', () => {
    expect(parseSubjectPrefix('#web Login crashes').prefix).toBe('WEB');
  });
});

describe('stripSignature', () => {
  it('cuts at the RFC 3676 "-- " sig delimiter', () => {
    const body = 'real body line\n\n-- \nJoe\nVP Engineering';
    expect(stripSignature(body)).toBe('real body line');
  });

  it('cuts at "On <date> wrote:" reply preface', () => {
    const body = 'my reply here\n\nOn Mon, Apr 1 2026 someone@x.com wrote:\nold quoted text';
    expect(stripSignature(body)).toBe('my reply here');
  });

  it('cuts at Outlook quoted From: header', () => {
    const body = 'real reply\n\nFrom: someone@example.com\nSent: Mon, Apr 1\nTo: me\n\nold message body';
    expect(stripSignature(body)).toBe('real reply');
  });

  it('cuts at "Sent from my X" mobile sig', () => {
    const body = 'short note\nSent from my iPhone';
    expect(stripSignature(body)).toBe('short note');
  });

  it('cuts at "Get Outlook for X" mobile sig', () => {
    const body = 'short note\nGet Outlook for Android';
    expect(stripSignature(body)).toBe('short note');
  });

  it('strips a long run of quoted lines at the tail', () => {
    const body = 'reply line\n> old line 1\n> old line 2\n> old line 3\n> old line 4\n> old line 5\n> old line 6\n';
    expect(stripSignature(body)).toBe('reply line');
  });

  it('keeps body intact when no boundary is present', () => {
    const body = 'just a bug report.\n\nSteps:\n1. open page\n2. click button';
    expect(stripSignature(body)).toBe(body);
  });

  it('handles null / empty input', () => {
    expect(stripSignature(null)).toBe('');
    expect(stripSignature('')).toBe('');
    expect(stripSignature('   ')).toBe('');
  });

  it('cuts at the EARLIEST boundary when several are present', () => {
    const body = 'real text\n-- \nsig\n\nOn Mon someone wrote:\nold';
    expect(stripSignature(body)).toBe('real text');
  });
});
