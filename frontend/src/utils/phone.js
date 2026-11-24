// Click-to-call helpers (#153). Builds tel: links that phones dial
// directly and desktop VoIP apps pick up:
//   tel:+19363055454,123   main line, pause, extension
//   tel:+19365551234       direct line (DID) or mobile
// Numbers are stored as typed; these normalise them for dialling and
// for display. Ten-digit numbers are treated as North American.

export function digitsForDial(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // Drop an inline extension ("x123", "ext 123", "#123") from the number part.
  const main = s.split(/\s*(?:x|ext\.?|extension|#)\s*\d+\s*$/i)[0];
  const plus = main.trim().startsWith("+");
  const digits = main.replace(/\D/g, "");
  if (!digits) return null;
  if (plus) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits;
}

export function telHref(raw, ext) {
  const n = digitsForDial(raw);
  if (!n) return null;
  const e = ext ? String(ext).replace(/\D/g, "") : "";
  return e ? `tel:${n},${e}` : `tel:${n}`;
}

export function formatPhone(raw) {
  const n = digitsForDial(raw);
  if (!n) return "";
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(n);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(raw).trim();
}

// The numbers to offer for one person, in order, skipping any not on file:
// main line + extension, direct line, mobile.
export function callOptions(p) {
  const out = [];
  if (p.location_phone && p.extension) {
    const href = telHref(p.location_phone, p.extension);
    if (href) out.push({ key: "main", label: "Main + ext", display: `${formatPhone(p.location_phone)} ext ${p.extension}`, href });
  }
  // Older extension-mode contacts stored the main line as their direct
  // number; don't offer the same line twice.
  const sameAsMain = p.direct && p.location_phone && digitsForDial(p.direct) === digitsForDial(p.location_phone);
  const direct = sameAsMain ? null : telHref(p.direct);
  if (direct) out.push({ key: "direct", label: "Direct", display: formatPhone(p.direct), href: direct });
  const mobile = telHref(p.mobile);
  if (mobile) out.push({ key: "mobile", label: "Mobile", display: formatPhone(p.mobile), href: mobile });
  return out;
}
