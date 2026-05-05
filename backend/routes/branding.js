const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { invalidateBranding } = require('../services/branding');

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `logo-${randomUUID()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Logo must be an image'));
    }
    cb(null, true);
  },
});

const router = express.Router();

// GET /api/branding — public
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM branding WHERE id = 1');
    const row = result.rows[0];
    if (!row) return res.json({});
    res.json({
      site_name: row.site_name,
      tagline: row.tagline,
      primary_color: row.primary_color,
      show_powered_by: row.show_powered_by,
      logo_on_dark: row.logo_on_dark,
      accent_override_enabled: row.accent_override_enabled,
      phonetic_readback_enabled: row.phonetic_readback_enabled,
      logo_designed_for: row.logo_designed_for,
      date_style: row.date_style,
      time_style: row.time_style,
      timezone: row.timezone,
      logo_url: row.logo_filename ? '/api/branding/logo' : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/branding — Admin only
router.patch('/', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const {
      site_name,
      tagline,
      primary_color,
      show_powered_by,
      logo_on_dark,
      accent_override_enabled,
      phonetic_readback_enabled,
      logo_designed_for,
      date_style,
      time_style,
      timezone,
    } = req.body;
    const updates = {};
    if (site_name !== undefined) updates.site_name = site_name.trim() || 'Resolvd';
    if (tagline !== undefined) updates.tagline = tagline.trim();
    if (primary_color !== undefined && /^#[0-9a-fA-F]{6}$/.test(primary_color)) {
      updates.primary_color = primary_color;
    }
    if (show_powered_by !== undefined) updates.show_powered_by = !!show_powered_by;
    if (logo_on_dark !== undefined) updates.logo_on_dark = !!logo_on_dark;
    if (accent_override_enabled !== undefined) updates.accent_override_enabled = !!accent_override_enabled;
    if (phonetic_readback_enabled !== undefined) updates.phonetic_readback_enabled = !!phonetic_readback_enabled;
    if (logo_designed_for !== undefined && ['light', 'dark'].includes(logo_designed_for)) {
      updates.logo_designed_for = logo_designed_for;
    }
    if (date_style !== undefined && ['iso', 'us', 'eu'].includes(date_style)) {
      updates.date_style = date_style;
    }
    if (time_style !== undefined && ['iso', '12h'].includes(time_style)) {
      updates.time_style = time_style;
    }
    if (timezone !== undefined && typeof timezone === 'string' && timezone.trim()) {
      updates.timezone = timezone.trim().slice(0, 64);
    }

    if (Object.keys(updates).length === 0) {
      const r = await pool.query('SELECT * FROM branding WHERE id = 1');
      return res.json(r.rows[0]);
    }

    updates.updated_at = new Date().toISOString();
    const keys = Object.keys(updates);
    const vals = Object.values(updates);
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');

    const result = await pool.query(
      `UPDATE branding SET ${setClauses} WHERE id = 1 RETURNING *`,
      vals
    );
    invalidateBranding();
    const row = result.rows[0];
    res.json({
      site_name: row.site_name,
      tagline: row.tagline,
      primary_color: row.primary_color,
      show_powered_by: row.show_powered_by,
      logo_on_dark: row.logo_on_dark,
      accent_override_enabled: row.accent_override_enabled,
      phonetic_readback_enabled: row.phonetic_readback_enabled,
      logo_designed_for: row.logo_designed_for,
      date_style: row.date_style,
      time_style: row.time_style,
      timezone: row.timezone,
      logo_url: row.logo_filename ? '/api/branding/logo' : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/branding/logo — public, serve logo file
router.get('/logo', async (req, res) => {
  try {
    const result = await pool.query('SELECT logo_filename FROM branding WHERE id = 1');
    const row = result.rows[0];
    if (!row?.logo_filename) return res.status(404).end();
    const filePath = path.join(UPLOADS_DIR, row.logo_filename);
    if (!fs.existsSync(filePath)) return res.status(404).end();
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).end();
  }
});

// POST /api/branding/logo — Admin only
router.post('/logo', requireAuth, requireRole('Admin'), upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    // Delete old logo if exists
    const old = await pool.query('SELECT logo_filename FROM branding WHERE id = 1');
    if (old.rows[0]?.logo_filename) {
      fs.unlink(path.join(UPLOADS_DIR, old.rows[0].logo_filename), () => {});
    }

    await pool.query(
      'UPDATE branding SET logo_filename = $1, updated_at = NOW() WHERE id = 1',
      [req.file.filename]
    );
    res.json({ logo_url: '/api/branding/logo' });
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/branding/logo — Admin only
router.delete('/logo', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const result = await pool.query('SELECT logo_filename FROM branding WHERE id = 1');
    const filename = result.rows[0]?.logo_filename;
    if (filename) {
      fs.unlink(path.join(UPLOADS_DIR, filename), () => {});
    }
    await pool.query('UPDATE branding SET logo_filename = NULL, updated_at = NOW() WHERE id = 1');
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
