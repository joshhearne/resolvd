// Raw-TCP printing to a Zebra (or ZPL-compatible) label printer.
// Opens a fresh socket per print, writes ZPL, holds open ~800ms so the
// printer has time to ack before TEAR_DOWN, then closes. nc -w3 style
// truncation killed earlier manual tests; the hold-open here mirrors
// `nc -q2 -w5` semantics.

const net = require('net');
const { pool } = require('../db/pool');

const DEFAULT_PORT = 9100;
const SEND_TIMEOUT_MS = 5000;
const POST_WRITE_HOLD_MS = 800;

async function getConfig() {
  const r = await pool.query(
    `SELECT enabled, host, port, dpi, media_w_dots, media_h_dots, top_offset_dots, property_line, updated_at
       FROM label_printer_config WHERE id = 1`
  );
  return r.rows[0] || null;
}

async function updateConfig(patch) {
  const fields = ['enabled', 'host', 'port', 'dpi', 'media_w_dots', 'media_h_dots', 'top_offset_dots', 'property_line'];
  const sets = [];
  const vals = [];
  for (const f of fields) {
    if (patch[f] !== undefined) {
      sets.push(`${f} = $${sets.length + 1}`);
      vals.push(patch[f]);
    }
  }
  if (sets.length === 0) return getConfig();
  sets.push(`updated_at = NOW()`);
  await pool.query(
    `UPDATE label_printer_config SET ${sets.join(', ')} WHERE id = 1`,
    vals
  );
  return getConfig();
}

function sendZpl(host, port, zpl) {
  return new Promise((resolve, reject) => {
    if (!host) return reject(new Error('Printer host not configured'));
    const sock = new net.Socket();
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_) {}
      if (err) reject(err); else resolve();
    };
    sock.setTimeout(SEND_TIMEOUT_MS);
    sock.once('timeout', () => finish(new Error('Printer connection timed out')));
    sock.once('error', (err) => finish(err));
    sock.connect(port || DEFAULT_PORT, host, () => {
      sock.write(zpl, () => {
        setTimeout(() => finish(null), POST_WRITE_HOLD_MS);
      });
    });
  });
}

// Print whatever the caller hands us. Pulls host/port from DB so the
// admin can flip printers without a redeploy. Throws if printer is
// disabled — callers should surface that as a 400 / toast rather than
// silently swallow.
async function print(zpl) {
  const cfg = await getConfig();
  if (!cfg || !cfg.enabled) throw new Error('Label printer disabled');
  if (!cfg.host) throw new Error('Label printer host not configured');
  await sendZpl(cfg.host, cfg.port, zpl);
  return { ok: true };
}

module.exports = {
  getConfig,
  updateConfig,
  sendZpl,
  print,
};
