const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { handleUploadErrors, fileRejected } = require('../middleware/upload');
const { invalidateBranding } = require('../services/branding');

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function makeImageUpload(prefix) {
  const storage = multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${prefix}-${randomUUID()}${ext}`);
    },
  });
  return multer({
    storage,
    limits: { fileSize: MAX_IMAGE_BYTES },
    fileFilter: (req, file, cb) => {
      if (!file.mimetype.startsWith('image/')) {
        return cb(fileRejected('File must be an image'));
      }
      cb(null, true);
    },
  });
}


const router = express.Router();

const HEX = /^#[0-9a-fA-F]{6}$/;

function brandingPayload(row) {
  return {
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
    default_restrict_followers: row.default_restrict_followers !== false,
    default_restrict_mentions: row.default_restrict_mentions !== false,
    enable_vendor_companies: row.enable_vendor_companies !== false,
    enable_customer_companies: row.enable_customer_companies === true,
    enable_internal_companies: row.enable_internal_companies !== false,
    ai_assist_enabled: row.ai_assist_enabled !== false,
    ai_project_context_enabled: row.ai_project_context_enabled !== false,
    ai_disclosure_audience: row.ai_disclosure_audience || 'self_and_admin',
    accent_dark: row.accent_dark || null,
    accent_fg_light: row.accent_fg_light || null,
    accent_fg_dark: row.accent_fg_dark || null,
    footer_name: row.footer_name || '',
    footer_url: row.footer_url || '',
    logo_url: row.logo_filename ? '/api/branding/logo' : null,
    logo_dark_url: row.logo_dark_filename ? '/api/branding/logo-dark' : null,
    favicon_url: row.favicon_filename ? '/api/branding/favicon' : null,
    favicon_dark_url: row.favicon_dark_filename ? '/api/branding/favicon-dark' : null,
    default_project_id: row.default_project_id ?? null,
  };
}

// GET /api/branding — public
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM branding WHERE id = 1');
    const row = result.rows[0];
    if (!row) return res.json({});
    res.json(brandingPayload(row));
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
      default_restrict_followers,
      default_restrict_mentions,
      enable_vendor_companies,
      enable_customer_companies,
      enable_internal_companies,
      ai_assist_enabled,
      ai_project_context_enabled,
      ai_disclosure_audience,
      default_project_id,
      accent_dark,
      accent_fg_light,
      accent_fg_dark,
      footer_name,
      footer_url,
    } = req.body;
    const updates = {};
    // Optional per-mode colors: '' / null clears (derive / auto).
    for (const [key, val] of Object.entries({ accent_dark, accent_fg_light, accent_fg_dark })) {
      if (val === undefined) continue;
      if (val === null || val === '') updates[key] = null;
      else if (typeof val === 'string' && HEX.test(val)) updates[key] = val.toLowerCase();
      else return res.status(400).json({ error: `${key} must be a hex color like #1f6feb` });
    }
    if (footer_name !== undefined) {
      updates.footer_name = typeof footer_name === 'string' && footer_name.trim()
        ? footer_name.trim().slice(0, 120) : null;
    }
    if (footer_url !== undefined) {
      const u = typeof footer_url === 'string' ? footer_url.trim() : '';
      if (u && !/^https?:\/\/[^\s]+$/i.test(u)) {
        return res.status(400).json({ error: 'footer_url must start with http:// or https://' });
      }
      updates.footer_url = u ? u.slice(0, 500) : null;
    }
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
    if (default_restrict_followers !== undefined) {
      updates.default_restrict_followers = !!default_restrict_followers;
    }
    if (default_restrict_mentions !== undefined) {
      updates.default_restrict_mentions = !!default_restrict_mentions;
    }
    if (enable_vendor_companies !== undefined) {
      updates.enable_vendor_companies = !!enable_vendor_companies;
    }
    if (enable_customer_companies !== undefined) {
      updates.enable_customer_companies = !!enable_customer_companies;
    }
    if (enable_internal_companies !== undefined) {
      updates.enable_internal_companies = !!enable_internal_companies;
    }
    if (ai_assist_enabled !== undefined) {
      updates.ai_assist_enabled = !!ai_assist_enabled;
    }
    if (ai_project_context_enabled !== undefined) {
      updates.ai_project_context_enabled = !!ai_project_context_enabled;
    }
    if (ai_disclosure_audience !== undefined) {
      const allowed = ['self_and_admin', 'admin_only', 'all_users'];
      if (!allowed.includes(ai_disclosure_audience)) {
        return res.status(400).json({ error: 'invalid ai_disclosure_audience' });
      }
      updates.ai_disclosure_audience = ai_disclosure_audience;
    }

    if (default_project_id !== undefined) {
      if (default_project_id === null || default_project_id === '') {
        updates.default_project_id = null;
      } else {
        const pid = Number(default_project_id);
        const p = await pool.query(`SELECT id FROM projects WHERE id = $1 AND status = 'active'`, [pid]);
        if (!p.rows[0]) return res.status(400).json({ error: 'default_project_id must be an active project' });
        updates.default_project_id = pid;
      }
    }

    if (Object.keys(updates).length === 0) {
      const r = await pool.query('SELECT * FROM branding WHERE id = 1');
      return res.json(brandingPayload(r.rows[0]));
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
    res.json(brandingPayload(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Logo and tab-icon files, one pair of routes per mode:
//   /logo, /logo-dark, /favicon, /favicon-dark  (GET public; POST/DELETE Admin)
// A dark variant left empty falls back to the light one on GET, so links
// to it always resolve. The light favicon falls back to /favicon.png.
function imageRoutes({ route, column, field, prefix, fallback }) {
  const upload = makeImageUpload(prefix);

  router.get(`/${route}`, async (req, res) => {
    try {
      const result = await pool.query(`SELECT ${column} AS f FROM branding WHERE id = 1`);
      const filename = result.rows[0]?.f;
      if (filename) {
        const filePath = path.join(UPLOADS_DIR, filename);
        if (fs.existsSync(filePath)) {
          if (route.startsWith('favicon')) res.setHeader('Cache-Control', 'public, max-age=300');
          return res.sendFile(filePath);
        }
      }
      if (fallback) return res.redirect(302, fallback);
      res.status(404).end();
    } catch (err) {
      if (fallback) return res.redirect(302, fallback);
      res.status(500).end();
    }
  });

  router.post(`/${route}`, requireAuth, requireRole('Admin'), handleUploadErrors(upload.single(field), { maxBytes: MAX_IMAGE_BYTES }), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const old = await pool.query(`SELECT ${column} AS f FROM branding WHERE id = 1`);
      if (old.rows[0]?.f) {
        fs.unlink(path.join(UPLOADS_DIR, old.rows[0].f), () => {});
      }
      await pool.query(
        `UPDATE branding SET ${column} = $1, updated_at = NOW() WHERE id = 1`,
        [req.file.filename]
      );
      invalidateBranding();
      res.json({ url: `/api/branding/${route}` });
    } catch (err) {
      fs.unlink(req.file.path, () => {});
      console.error(err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  router.delete(`/${route}`, requireAuth, requireRole('Admin'), async (req, res) => {
    try {
      const result = await pool.query(`SELECT ${column} AS f FROM branding WHERE id = 1`);
      const filename = result.rows[0]?.f;
      if (filename) {
        fs.unlink(path.join(UPLOADS_DIR, filename), () => {});
      }
      await pool.query(`UPDATE branding SET ${column} = NULL, updated_at = NOW() WHERE id = 1`);
      invalidateBranding();
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database error' });
    }
  });
}

imageRoutes({ route: 'logo', column: 'logo_filename', field: 'logo', prefix: 'logo' });
imageRoutes({ route: 'logo-dark', column: 'logo_dark_filename', field: 'logo', prefix: 'logo-dark', fallback: '/api/branding/logo' });
imageRoutes({ route: 'favicon', column: 'favicon_filename', field: 'favicon', prefix: 'favicon', fallback: '/favicon.png' });
imageRoutes({ route: 'favicon-dark', column: 'favicon_dark_filename', field: 'favicon', prefix: 'favicon-dark', fallback: '/api/branding/favicon' });

// GET /api/branding/manifest — dynamic web app manifest. Drives the PWA
// install prompt on Android and is referenced by index.html. Icons point
// at /api/branding/favicon (which itself falls back when unset).
router.get('/manifest', async (req, res) => {
  try {
    const r = await pool.query('SELECT site_name, primary_color FROM branding WHERE id = 1');
    const b = r.rows[0] || {};
    const iconUrl = '/api/branding/favicon';
    res.setHeader('Content-Type', 'application/manifest+json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({
      name: b.site_name || 'Resolvd',
      short_name: (b.site_name || 'Resolvd').slice(0, 12),
      start_url: '/',
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: b.primary_color || '#16a34a',
      icons: [
        { src: iconUrl, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: iconUrl, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: iconUrl, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    });
  } catch (err) {
    res.status(500).end();
  }
});

module.exports = router;
