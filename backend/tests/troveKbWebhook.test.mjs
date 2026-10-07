// Webhook signature acceptance and the receiver route, with the settings
// loader stubbed. The route is exercised through a tiny express app with
// express.raw, exactly as server.js mounts it.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import nodeCrypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const SECRET = 'whsec_test_secret';
const sign = (body) => `sha256=${nodeCrypto.createHmac('sha256', SECRET).update(body).digest('hex')}`;

let troveKb;
beforeAll(() => {
  process.env.RESOLVD_MASTER_KEY = nodeCrypto.randomBytes(32).toString('base64');
  require('../db/pool').pool.query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  troveKb = require('../services/troveKb');
});

describe('troveKb.verifyWebhookSignature', () => {
  it('accepts the right signature and rejects everything else', () => {
    const body = '{"event":"kb.article.upserted"}';
    expect(troveKb.verifyWebhookSignature(SECRET, body, sign(body))).toBe(true);
    expect(troveKb.verifyWebhookSignature(SECRET, body, sign(body).toUpperCase())).toBe(true);
    expect(troveKb.verifyWebhookSignature(SECRET, body + ' ', sign(body))).toBe(false);
    expect(troveKb.verifyWebhookSignature('other', body, sign(body))).toBe(false);
    expect(troveKb.verifyWebhookSignature(SECRET, body, 'sha256=zz')).toBe(false);
    expect(troveKb.verifyWebhookSignature(SECRET, body, undefined)).toBe(false);
    expect(troveKb.verifyWebhookSignature(null, body, sign(body))).toBe(false);
  });
});

describe('POST /api/trove-kb/webhook', () => {
  async function app(secret) {
    vi.spyOn(troveKb, 'getSettings').mockResolvedValue({ _webhookSecret: secret });
    vi.spyOn(troveKb, 'recordWebhook').mockResolvedValue();
    const express = require('express');
    const a = express();
    a.use('/api/trove-kb/webhook', express.raw({ type: '*/*' }), require('../routes/troveKbWebhook'));
    const http = require('node:http');
    const server = http.createServer(a);
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    const post = async (body, headers = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/trove-kb/webhook`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...headers } });
      return res.status;
    };
    return { post, close: () => new Promise((r) => server.close(r)) };
  }

  it('answers 204 to a signed delivery and drops the article from cache', async () => {
    const { post, close } = await app(SECRET);
    const drop = vi.spyOn(troveKb, 'invalidateArticle');
    const body = JSON.stringify({ event: 'kb.article.upserted', data: { article_id: 'abc', collection_id: 'c', external_id: 'e', kind: 'article' } });
    expect(await post(body, { 'X-Trove-Event': 'kb.article.upserted', 'X-Trove-Signature': sign(body) })).toBe(204);
    expect(drop).toHaveBeenCalledWith('abc');
    expect(await post(body, { 'X-Trove-Signature': 'sha256=' + '0'.repeat(64) })).toBe(401);
    expect(await post(body)).toBe(401);
    expect(await post('not json', { 'X-Trove-Signature': sign('not json') })).toBe(400);
    await close();
  });

  it('answers 503 when no secret is configured', async () => {
    const { post, close } = await app(null);
    const body = '{}';
    expect(await post(body, { 'X-Trove-Signature': sign(body) })).toBe(503);
    await close();
  });
});
