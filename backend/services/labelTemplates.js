// ZPL renderers for the label printer. Each function returns a string
// the labelPrinter service writes verbatim to TCP :9100. Pure functions
// — no DB access here, callers fetch and pass the data they need.
//
// Conventions:
//   - All renderers honour cfg.top_offset_dots (^LT) so the admin can
//     correct a printhead with a natural top bias without re-editing
//     every template.
//   - ^CI28 enables UTF-8.
//   - Font sizes assume 203dpi media @ 2"×0.75" (406×152 dots). Bigger
//     DPI rescales linearly via cfg.dpi when emitted; callers can pass
//     a scaled cfg from getConfig().

const APP_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

function assetDeepLink(assetId) {
  return `${APP_URL}/inventory/${assetId}`;
}

function zplEsc(s) {
  // ZPL uses ^ and ~ as command sigils. Strip both so user-supplied
  // text can't terminate the current field. Caret-FH workaround would
  // let us escape, but stripping is safer for short label content.
  return String(s == null ? '' : s).replace(/[\^~]/g, ' ').trim();
}

function scale(cfg, dots203) {
  const dpi = cfg.dpi || 203;
  return Math.round(dots203 * (dpi / 203));
}

function header(cfg) {
  return [
    '^XA',
    `^PW${cfg.media_w_dots}`,
    `^LL${cfg.media_h_dots}`,
    `^LT${cfg.top_offset_dots || 0}`,
    '^CI28',
  ].join('\n');
}

function footer() {
  return '^XZ';
}

// Test label — used by the admin "Print test" button. Confirms host
// reachability + media calibration without touching real ticket/asset
// data.
function renderTestLabel(cfg) {
  const lines = [header(cfg)];
  lines.push(`^FO20,${scale(cfg, 15)}^A0N,${scale(cfg, 30)},${scale(cfg, 30)}^FDResolvd test^FS`);
  lines.push(`^FO20,${scale(cfg, 60)}^A0N,${scale(cfg, 22)},${scale(cfg, 22)}^FD${cfg.host || 'no-host'} :${cfg.port}^FS`);
  lines.push(`^FO20,${scale(cfg, 105)}^A0N,${scale(cfg, 18)},${scale(cfg, 18)}^FD${new Date().toISOString().slice(0, 19) + 'Z'}^FS`);
  lines.push(footer());
  return lines.join('\n');
}

// Asset label layout (2"×0.75" @203dpi base, 406×152 dots):
//   Asset Tag (faux-bold)                 [QR]
//   Hostname                              [QR]
//   S/N: serial                           [QR]
//   (blank spacer)                        [QR]
//   Property of: <org>
//
// Asset tag is the operator-facing identifier (stickered/engraved
// inventory number); hostname is the OS-reported name. The tag should
// be unambiguous at a glance, so it goes top and bold. Falls back to
// hostname when no tag is set.
//
// QR is right-justified inside the die-cut radius (~10 dot margin).
// Magnification 3 keeps the code small enough to clear text at 2"
// wide. The lead line renders twice with a 1-dot horizontal offset
// for a faux-bold weight (ZPL has no native bold on the default
// scalable font).
function renderAssetLabel({ asset, qrPayload }, cfg) {
  const lines = [header(cfg)];
  const payload = qrPayload || assetDeepLink(asset.id);

  // QR — magnification 3. Anchor near the right edge with ~10 dot
  // margin so it sits inside the die-cut curve.
  const qrMargin = scale(cfg, 10);
  const qrWidth = scale(cfg, 87);
  const qrX = Math.max(0, cfg.media_w_dots - qrWidth - qrMargin);
  lines.push(`^FO${qrX},${scale(cfg, 8)}^BQN,2,3^FDLA,${zplEsc(payload)}^FS`);

  // Text column — bounded so long values don't run under the QR.
  const xText = scale(cfg, 15);
  const textBlockW = Math.max(80, qrX - xText - scale(cfg, 8));

  const tagSource = (asset.asset_tag && asset.asset_tag.trim())
    || asset.hostname
    || `Asset #${asset.id}`;
  const tag = zplEsc(tagSource);
  const tagSize = scale(cfg, 28);
  // Faux-bold via 1-dot horizontal double-strike.
  lines.push(`^FO${xText},${scale(cfg, 4)}^A0N,${tagSize},${tagSize}^FB${textBlockW},1,0,L^FD${tag}^FS`);
  lines.push(`^FO${xText + 1},${scale(cfg, 4)}^A0N,${tagSize},${tagSize}^FB${textBlockW},1,0,L^FD${tag}^FS`);

  // Hostname appears as a second line only when distinct from the tag,
  // otherwise it duplicates the lead.
  if (asset.hostname && asset.hostname.trim() && asset.hostname.trim() !== tagSource.trim()) {
    const hSize = scale(cfg, 20);
    lines.push(`^FO${xText},${scale(cfg, 40)}^A0N,${hSize},${hSize}^FB${textBlockW},1,0,L^FD${zplEsc(asset.hostname)}^FS`);
  }

  if (asset.serial) {
    const sSize = scale(cfg, 20);
    lines.push(`^FO${xText},${scale(cfg, 66)}^A0N,${sSize},${sSize}^FB${textBlockW},1,0,L^FDS/N: ${zplEsc(asset.serial)}^FS`);
  }

  if (cfg.property_line) {
    const pSize = scale(cfg, 16);
    lines.push(`^FO${xText},${scale(cfg, 128)}^A0N,${pSize},${pSize}^FB${cfg.media_w_dots - scale(cfg, 30)},1,0,L^FD${zplEsc(cfg.property_line)}^FS`);
  }

  lines.push(footer());
  return lines.join('\n');
}

// Consumable / Service Request delivery label — stub until the
// consumables catalogue lands. Layout sketched out so the wiring is
// already in place: ticket ref top-left, requestor name, optional
// location, then "<part_no> — <title>" at the bottom. Caller supplies
// whatever it has; missing fields render as blank lines.
function renderConsumableLabel({ ticket, requestor, location, consumable }, cfg) {
  const lines = [header(cfg)];
  lines.push(`^FO20,${scale(cfg, 10)}^A0N,${scale(cfg, 30)},${scale(cfg, 30)}^FD${zplEsc(ticket.internal_ref || `#${ticket.id}`)}^FS`);
  lines.push(`^FO20,${scale(cfg, 45)}^A0N,${scale(cfg, 22)},${scale(cfg, 22)}^FD${zplEsc(requestor || '')}^FS`);
  if (location) {
    lines.push(`^FO20,${scale(cfg, 72)}^A0N,${scale(cfg, 18)},${scale(cfg, 18)}^FD${zplEsc(location)}^FS`);
  }
  const partLine = consumable
    ? `${consumable.part_number || ''}${consumable.title ? ' — ' + consumable.title : ''}`
    : '';
  if (partLine) {
    lines.push(`^FO20,${scale(cfg, 100)}^A0N,${scale(cfg, 20)},${scale(cfg, 20)}^FD${zplEsc(partLine)}^FS`);
  }
  lines.push(footer());
  return lines.join('\n');
}

module.exports = {
  renderTestLabel,
  renderAssetLabel,
  renderConsumableLabel,
  zplEsc,
};
