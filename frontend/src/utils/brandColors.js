// Accent-color math for per-mode branding. Each mode (light / dark) can
// carry its own accent and its own "text on the accent" color. A mode left
// without an accent gets one derived from the other mode's accent, nudged
// until it reads on that mode's background. "Auto" text picks black or
// white, whichever has the higher contrast on the accent.

export const DEFAULT_ACCENT = { light: "#16a34a", dark: "#22c55e" };

// Page backgrounds the accent has to read against (matches index.css).
const MODE_BG = { light: "#ffffff", dark: "#0f172a" };
const MIN_CONTRAST = 4.5;

export function isHex(v) {
  return /^#[0-9a-fA-F]{6}$/.test(v || "");
}

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function rgbToHex([r, g, b]) {
  return (
    "#" +
    [r, g, b]
      .map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0"))
      .join("")
  );
}

export function hexToTriplet(hex) {
  return isHex(hex) ? hexToRgb(hex).join(" ") : null;
}

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Mix toward white (amount > 0) or black (amount < 0).
function mix(hex, amount) {
  const target = amount > 0 ? 255 : 0;
  const t = Math.abs(amount);
  return rgbToHex(hexToRgb(hex).map((c) => c + (target - c) * t));
}

// Black or white, whichever reads better on the given color.
export function autoTextOn(hex) {
  return contrast(hex, "#ffffff") >= contrast(hex, "#000000") ? "#ffffff" : "#000000";
}

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

// Raise (dark mode) or lower (light mode) the lightness, keeping hue and
// saturation, until the color reaches MIN_CONTRAST on that mode's
// background.
export function readableOn(hex, mode) {
  const bg = MODE_BG[mode];
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  const step = mode === "dark" ? 0.02 : -0.02;
  let out = hex;
  for (let i = 1; i <= 50 && contrast(out, bg) < MIN_CONTRAST; i++) {
    const nl = Math.max(0, Math.min(1, l + step * i));
    out = rgbToHex(hslToRgb([h, s, nl]));
  }
  return out;
}

// Resolve the full palette for both modes from the stored branding row.
// Returns null for a mode that has no custom accent (theme defaults apply).
export function resolveAccents(branding) {
  const light =
    branding?.accent_override_enabled && isHex(branding.primary_color)
      ? branding.primary_color
      : null;
  const dark = isHex(branding?.accent_dark) ? branding.accent_dark : null;
  if (!light && !dark) return { light: null, dark: null };

  const lightAccent = light || readableOn(dark, "light");
  const darkAccent = dark || readableOn(light, "dark");
  const fgLight = isHex(branding.accent_fg_light) ? branding.accent_fg_light : autoTextOn(lightAccent);
  const fgDark = isHex(branding.accent_fg_dark) ? branding.accent_fg_dark : autoTextOn(darkAccent);

  return {
    light: {
      accent: lightAccent,
      fg: fgLight,
      bright: mix(lightAccent, -0.12),
      dim: mix(lightAccent, -0.3),
      derived: !light,
    },
    dark: {
      accent: darkAccent,
      fg: fgDark,
      bright: mix(darkAccent, 0.15),
      dim: mix(darkAccent, -0.2),
      derived: !dark,
    },
  };
}

// The light-mode accent as a hex, for exports and other always-light output.
export function lightAccentHex(branding) {
  return resolveAccents(branding).light?.accent || DEFAULT_ACCENT.light;
}

function varsBlock(p) {
  return [
    `--color-brand: ${hexToTriplet(p.accent)};`,
    `--color-brand-bright: ${hexToTriplet(p.bright)};`,
    `--color-brand-dim: ${hexToTriplet(p.dim)};`,
    `--color-brand-fg: ${hexToTriplet(p.fg)};`,
  ].join(" ");
}

// CSS that overrides the brand variables per mode. Empty string when no
// custom accent is configured, so index.css defaults apply untouched.
export function brandCss(branding) {
  const { light, dark } = resolveAccents(branding);
  if (!light || !dark) return "";
  return [
    `:root { ${varsBlock(light)} --brand-primary: ${light.accent}; }`,
    `.dark { ${varsBlock(dark)} --brand-primary: ${dark.accent}; }`,
    `@media print { :root, .dark { ${varsBlock(light)} } }`,
  ].join("\n");
}
