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

const BLOCKED = /^(javascript|data|vbscript|file|about|blob|filesystem):/i;
const PHONE_APP = { key: "phone", name: "Phone app", url_template: "tel:{number}", ext_template: "tel:{number},{ext}" };

// Link for `raw` (and an optional extension) in a calling app. Returns
// { href, extToDial } — extToDial is set when the app's link can't carry
// the extension, so the UI can show it to key in after connecting.
// {number} = +E.164 where known, {digits} = without '+'; a template with
// neither is a prefix and gets the number appended. Values are
// URL-encoded inside http(s) links (a raw '+' would become a space).
export function appHref(app, raw, ext) {
  const a = app && app.url_template && !BLOCKED.test(app.url_template.trim()) ? app : PHONE_APP;
  const number = digitsForDial(raw);
  if (!number) return null;
  const e = ext ? String(ext).replace(/\D/g, "") : "";
  const useExt = !!(e && a.ext_template && !BLOCKED.test(a.ext_template.trim()));
  const tpl = (useExt ? a.ext_template : a.url_template).trim();
  const isHttp = /^https?:/i.test(tpl);
  const enc = (v) => (isHttp ? encodeURIComponent(v) : v);
  const vals = { number: enc(number), digits: enc(number.replace(/^\+/, "")), ext: enc(e) };
  let href = tpl.replace(/\{(number|digits|ext)\}/g, (_, k) => vals[k]);
  if (!/\{(number|digits)\}/.test(tpl)) href += vals.number;
  return { href, extToDial: e && !useExt ? e : null };
}

export const isPhoneApp = (app) => !app || /^tel:/i.test((app.url_template || "").trim());

// Can this app dial a main line and then an extension in one link?
// The phone app can (tel:…,ext); most VoIP apps' links can't.
const dialsExtAfterMain = (app) => isPhoneApp(app) || !!(app && app.ext_template);

// Link that dials an internal extension on its own (e.g. webextel://105),
// for apps the admin has marked ext_direct.
function extOnlyHref(app, ext) {
  const e = String(ext || "").replace(/\D/g, "");
  if (!e || !app?.url_template || BLOCKED.test(app.url_template.trim())) return null;
  const tpl = app.url_template.trim();
  const v = /^https?:/i.test(tpl) ? encodeURIComponent(e) : e;
  let href = tpl.replace(/\{(number|digits)\}/g, v).replace(/\{ext\}/g, v);
  if (!/\{(number|digits)\}/.test(tpl)) href += v;
  return href;
}

// The numbers to offer for one person, skipping any not on file. Each
// option carries the link for the chosen calling app and, when that isn't
// the phone app, a plain tel: link as a fallback (a browser can't tell
// whether an app is installed, and an app link with nothing to open it
// does nothing).
//  - Phone app (or an app with an extension link): main line + extension,
//    direct line, mobile.
//  - Other apps can't dial an extension after the main line, so they lead
//    with direct line and mobile; for internal users with an extension,
//    apps marked "dial internal extensions directly" add the extension on
//    its own; main line + extension stays available through the phone app.
export function callOptions(p, app) {
  const out = [];
  const add = (key, label, display, raw, ext) => {
    const main = appHref(app, raw, ext);
    if (!main) return;
    const phone = isPhoneApp(app) ? null : telHref(raw, ext);
    out.push({ key, label, display, href: main.href, extToDial: main.extToDial, phoneHref: phone });
  };
  const hasMainExt = !!(p.location_phone && p.extension);
  // Older extension-mode contacts stored the main line as their direct
  // number; don't offer the same line twice.
  const sameAsMain = p.direct && p.location_phone && digitsForDial(p.direct) === digitsForDial(p.location_phone);
  const direct = p.direct && !sameAsMain;

  if (dialsExtAfterMain(app)) {
    if (hasMainExt) add("main", "Main + ext", `${formatPhone(p.location_phone)} ext ${p.extension}`, p.location_phone, p.extension);
    if (direct) add("direct", "Direct", formatPhone(p.direct), p.direct);
    if (p.mobile) add("mobile", "Mobile", formatPhone(p.mobile), p.mobile);
    return out;
  }

  if (direct) add("direct", "Direct", formatPhone(p.direct), p.direct);
  if (p.mobile) add("mobile", "Mobile", formatPhone(p.mobile), p.mobile);
  if (app?.ext_direct && p.internal && p.extension) {
    const href = extOnlyHref(app, p.extension);
    if (href) out.push({ key: "ext", label: "Extension", display: `Ext ${String(p.extension).replace(/\D/g, "")}`, href, extToDial: null, phoneHref: null });
  }
  if (hasMainExt) {
    const href = telHref(p.location_phone, p.extension);
    if (href) {
      out.push({ key: "main", label: "Main + ext", display: `${formatPhone(p.location_phone)} ext ${p.extension}`,
        href, extToDial: null, phoneHref: null, viaPhone: true });
    }
  }
  return out;
}
