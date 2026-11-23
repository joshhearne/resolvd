const { pool } = require('../db/pool');

let _cache = null;
let _cacheAt = 0;
const TTL_MS = 60 * 1000;

async function getBranding() {
  if (_cache && Date.now() - _cacheAt < TTL_MS) return _cache;
  const result = await pool.query('SELECT * FROM branding WHERE id = 1');
  _cache = result.rows[0] || null;
  _cacheAt = Date.now();
  return _cache;
}

function invalidateBranding() {
  _cache = null;
  _cacheAt = 0;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function luminance(hex) {
  const v = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Black or white, whichever reads better on `hex`.
function autoTextOn(hex) {
  const l = luminance(hex);
  return (1.05 / (l + 0.05)) >= ((l + 0.05) / 0.05) ? '#ffffff' : '#000000';
}

// Light-mode accent + text color for always-light output (email). Mirrors
// frontend/src/utils/brandColors.js; a dark-only accent is used as-is here.
function lightAccent(b) {
  let accent = '#16a34a';
  if (b?.accent_override_enabled && HEX.test(b?.primary_color || '')) accent = b.primary_color;
  else if (HEX.test(b?.accent_dark || '')) accent = b.accent_dark;
  else return { accent, fg: '#ffffff' };
  const fg = HEX.test(b?.accent_fg_light || '') ? b.accent_fg_light : autoTextOn(accent);
  return { accent, fg };
}

module.exports = { getBranding, invalidateBranding, lightAccent, autoTextOn };
