// handleUploadErrors: multer rejections come back as JSON 4xx instead of
// Express's default HTML 500. Exercised through a real Express server and
// real multer so the error objects are the genuine article.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const multer = require('multer');
const { handleUploadErrors, fileRejected } = require('../middleware/upload');

const MAX = 1024 * 1024; // 1 MB
let server;
let base;

beforeAll(async () => {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX },
    fileFilter: (req, file, cb) => {
      if (!file.mimetype.startsWith('image/')) return cb(fileRejected('File must be an image'));
      cb(null, true);
    },
  });
  const broken = multer({
    storage: {
      _handleFile: (req, file, cb) => cb(new Error('disk full')),
      _removeFile: (req, file, cb) => cb(null),
    },
  });
  const app = express();
  app.post('/one', handleUploadErrors(upload.single('file'), { maxBytes: MAX }), (req, res) => res.json({ size: req.file.size }));
  app.post('/many', handleUploadErrors(upload.array('files', 2), { maxBytes: MAX }), (req, res) => res.json({ n: req.files.length }));
  app.post('/broken', handleUploadErrors(broken.single('file'), { maxBytes: MAX }), (req, res) => res.json({}));
  app.use((err, req, res, next) => res.status(500).json({ reached: 'error handler', error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

const send = (path, files) => {
  const fd = new FormData();
  for (const [field, bytes, type] of files) fd.append(field, new Blob([new Uint8Array(bytes)], { type }), 'f');
  return fetch(base + path, { method: 'POST', body: fd });
};

describe('handleUploadErrors', () => {
  it('passes uploads within the limit through', async () => {
    const r = await send('/one', [['file', 100, 'image/png']]);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ size: 100 });
  });

  it('returns 413 JSON naming the cap for an oversized file', async () => {
    const r = await send('/one', [['file', MAX + 1, 'image/png']]);
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: 'File too large (max 1 MB)' });
  });

  it('returns 400 JSON for a fileFilter rejection', async () => {
    const r = await send('/one', [['file', 10, 'text/plain']]);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'File must be an image' });
  });

  it('returns 400 JSON for other multer limits (too many files)', async () => {
    const r = await send('/many', [['files', 1, 'image/png'], ['files', 1, 'image/png'], ['files', 1, 'image/png']]);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('Unexpected file field');
  });

  it('leaves server-side failures to the error handler', async () => {
    const r = await send('/broken', [['file', 10, 'image/png']]);
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ reached: 'error handler', error: 'disk full' });
  });
});
