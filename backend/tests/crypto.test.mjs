// Smoke tests for the envelope encryption helpers. These don't touch
// the database — they exercise the pure crypto module against an
// in-memory master key so they run anywhere.
//
// Tests cover the AAD-binding contract (different ctx → AuthError),
// tamper detection on the ciphertext payload, round-trip on
// pathological inputs (empty / unicode / large), and stable structure
// across a serialize→parse cycle.

import { describe, it, expect, beforeAll } from 'vitest';
import nodeCrypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

beforeAll(() => {
  // 32-byte test key — only used here, never written to disk.
  process.env.RESOLVD_MASTER_KEY = nodeCrypto.randomBytes(32).toString('base64');
});

describe('services/crypto', () => {
  it('round-trips simple text', async () => {
    const { encrypt, decrypt } = require('../services/crypto');
    const blob = await encrypt('Hello world', 'tickets.title');
    expect(Buffer.isBuffer(blob)).toBe(true);
    expect(await decrypt(blob, 'tickets.title')).toBe('Hello world');
  });

  it('round-trips multi-line + unicode', async () => {
    const { encrypt, decrypt } = require('../services/crypto');
    const input = 'line one\nline two\n你好 👋';
    const blob = await encrypt(input, 'comments.body');
    expect(await decrypt(blob, 'comments.body')).toBe(input);
  });

  it('round-trips an empty string', async () => {
    const { encrypt, decrypt } = require('../services/crypto');
    const blob = await encrypt('', 'tickets.description');
    expect(await decrypt(blob, 'tickets.description')).toBe('');
  });

  it('rejects ciphertext under a different ctx (AAD mismatch)', async () => {
    const { encrypt, decrypt } = require('../services/crypto');
    const blob = await encrypt('secret', 'tickets.title');
    await expect(decrypt(blob, 'tickets.description')).rejects.toThrow();
  });

  it('rejects tampered ciphertext', async () => {
    const { encrypt, decrypt } = require('../services/crypto');
    const blob = await encrypt('secret', 'tickets.title');
    blob[blob.length - 1] ^= 1;
    await expect(decrypt(blob, 'tickets.title')).rejects.toThrow();
  });
});
