// Admin endpoints for the label printer: get/set config + send test
// print. Per-row print endpoints (asset label, consumable label) live
// on the resource routes (assets.js, etc.) so callers hit the natural
// REST path.

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const labelPrinter = require('../services/labelPrinter');
const labelTemplates = require('../services/labelTemplates');

const router = express.Router();

router.get('/', requireAuth, requireRole('Admin', 'Manager', 'Tech'), async (_req, res) => {
  try {
    const cfg = await labelPrinter.getConfig();
    res.json(cfg);
  } catch (err) {
    console.error('label printer get:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.patch('/', requireAuth, requireRole('Admin', 'Manager'), async (req, res) => {
  try {
    const body = req.body || {};
    const patch = {};
    if (body.enabled !== undefined) patch.enabled = !!body.enabled;
    if (body.host !== undefined) patch.host = body.host ? String(body.host).trim() : null;
    if (body.port !== undefined) {
      const p = Number(body.port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        return res.status(400).json({ error: 'port must be 1-65535' });
      }
      patch.port = p;
    }
    if (body.property_line !== undefined) {
      patch.property_line = body.property_line ? String(body.property_line).trim() : null;
    }
    for (const f of ['dpi', 'media_w_dots', 'media_h_dots', 'top_offset_dots']) {
      if (body[f] !== undefined) {
        const n = Number(body[f]);
        if (!Number.isFinite(n) || n < 0) {
          return res.status(400).json({ error: `${f} must be a non-negative number` });
        }
        patch[f] = Math.round(n);
      }
    }
    const cfg = await labelPrinter.updateConfig(patch);
    res.json(cfg);
  } catch (err) {
    console.error('label printer patch:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/test', requireAuth, requireRole('Admin', 'Manager', 'Tech'), async (_req, res) => {
  try {
    const cfg = await labelPrinter.getConfig();
    if (!cfg || !cfg.enabled) {
      return res.status(400).json({ error: 'Label printer disabled' });
    }
    if (!cfg.host) {
      return res.status(400).json({ error: 'Label printer host not configured' });
    }
    const zpl = labelTemplates.renderTestLabel(cfg);
    await labelPrinter.print(zpl);
    res.json({ ok: true });
  } catch (err) {
    console.error('label printer test:', err);
    res.status(500).json({ error: err.message || 'Print failed' });
  }
});

module.exports = router;
