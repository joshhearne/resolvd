import React, { useRef, useState } from "react";
import toast from "react-hot-toast";
import { brandingLogo } from "../utils/helpers";
import { DEFAULT_ACCENT, autoTextOn, isHex, resolveAccents } from "../utils/brandColors";
import PoweredByFooter from "./PoweredByFooter";

// Theme defaults shown when no custom accent is set (mirror index.css).
const THEME_DEFAULT = {
  light: { accent: DEFAULT_ACCENT.light, fg: "#ffffff" },
  dark: { accent: DEFAULT_ACCENT.dark, fg: "#062814" },
};

// Preview surfaces (mirror index.css surface / fg per mode).
const SURFACE = {
  light: { bg: "#ffffff", fg: "#0f172a", muted: "#475569", border: "#e2e8f0" },
  dark: { bg: "#0f172a", fg: "#e2e8f0", muted: "#94a3b8", border: "#1e293b" },
};

// Build the branding object the form would produce, for live previews.
export function draftBranding(branding, form) {
  const light = (form.accent_light || "").trim();
  return {
    ...branding,
    accent_override_enabled: isHex(light),
    primary_color: isHex(light) ? light : branding.primary_color,
    accent_dark: isHex(form.accent_dark) ? form.accent_dark : null,
    accent_fg_light: isHex(form.accent_fg_light) ? form.accent_fg_light : null,
    accent_fg_dark: isHex(form.accent_fg_dark) ? form.accent_fg_dark : null,
    logo_designed_for: form.logo_designed_for,
    show_powered_by: form.show_powered_by,
    footer_name: form.footer_name,
    footer_url: form.footer_url,
  };
}

function useUpload(setBranding) {
  const [busy, setBusy] = useState(null);
  async function upload(route, field, key, file) {
    if (!file) return;
    setBusy(route);
    const fd = new FormData();
    fd.append(field, file);
    try {
      const res = await fetch(`/api/branding/${route}`, { method: "POST", credentials: "include", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setBranding((prev) => ({ ...prev, [key]: `${data.url}?t=${Date.now()}` }));
      toast.success("Uploaded");
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  }
  async function remove(route, key, label) {
    if (!window.confirm(`Remove ${label}?`)) return;
    try {
      const res = await fetch(`/api/branding/${route}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error();
      setBranding((prev) => ({ ...prev, [key]: null }));
      toast.success("Removed");
    } catch {
      toast.error(`Failed to remove ${label}`);
    }
  }
  return { busy, upload, remove };
}

function ColorField({ id, label, value, placeholder, swatch, onChange, resetLabel, help }) {
  const invalid = value && !isHex(value);
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-fg mb-1">{label}</label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value.trim())}
          className={`input font-mono flex-1 min-w-0 ${invalid ? "border-red-500 focus:ring-red-500/40" : ""}`}
          spellCheck={false}
          aria-invalid={invalid || undefined}
        />
        <input
          type="color"
          aria-label={`${label} picker`}
          value={isHex(value) ? value : swatch}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-10 shrink-0 rounded border border-border-strong cursor-pointer p-0.5 bg-surface"
        />
        <button type="button" onClick={() => onChange("")} disabled={!value} className="btn btn-sm btn-secondary shrink-0">
          {resetLabel}
        </button>
      </div>
      <p className={`text-xs mt-1 ${invalid ? "text-red-600 dark:text-red-400" : "text-fg-muted"}`}>
        {invalid ? "Use a 6-digit hex color like #1f6feb." : help}
      </p>
    </div>
  );
}

function ImageField({ label, help, src, bg, imgClass, onPick, onRemove, busy, uploadLabel, empty }) {
  const ref = useRef();
  return (
    <div>
      <span className="block text-sm font-medium text-fg mb-1">{label}</span>
      <div
        className="rounded-lg border flex items-center justify-center p-3 min-h-[72px]"
        style={{ background: bg.bg, borderColor: bg.border, color: bg.muted }}
      >
        {src ? <img src={src.src} alt="" className={imgClass} style={src.filter ? { filter: src.filter } : undefined} /> : <span className="text-xs">{empty}</span>}
      </div>
      <p className="text-xs text-fg-muted mt-1">{help}</p>
      <div className="flex gap-2 mt-2">
        <input ref={ref} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden" onChange={(e) => { onPick(e.target.files[0]); e.target.value = ""; }} />
        <button type="button" onClick={() => ref.current.click()} disabled={busy} className="btn btn-sm btn-secondary">
          {busy ? "Uploading…" : uploadLabel}
        </button>
        {onRemove && (
          <button type="button" onClick={onRemove} className="btn btn-sm btn-danger">Remove</button>
        )}
      </div>
    </div>
  );
}

function ModePreview({ mode, branding, palette }) {
  const s = SURFACE[mode];
  const logo = brandingLogo(branding, mode);
  const icon = mode === "dark" && branding.favicon_dark_url ? branding.favicon_dark_url : branding.favicon_url || "/favicon.png";
  return (
    <div className="rounded-xl border p-4" style={{ background: s.bg, borderColor: s.border, color: s.fg }}>
      <div className="text-[11px] uppercase tracking-wider mb-3" style={{ color: s.muted }}>
        {mode === "light" ? "Light mode" : "Dark mode"}
        {palette.derived && " · accent derived"}
      </div>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <img src={logo.src || "/icon.svg"} alt="" className="h-7 w-auto object-contain" style={logo.filter ? { filter: logo.filter } : undefined} />
          <span className="font-bold truncate">{branding.site_name || "Resolvd"}</span>
        </div>
        <span
          className="inline-flex items-center rounded-lg px-4 py-2 text-sm font-medium"
          style={{ background: palette.accent, color: palette.fg }}
        >
          A button in your color
        </span>
      </div>
      <div className="flex items-center gap-3 mt-3 text-xs" style={{ color: s.muted }}>
        <span className="inline-flex items-center gap-1.5">
          <img src={icon} alt="" className="h-4 w-4 object-contain" /> Tab icon
        </span>
        <span>
          Link in <span style={{ color: palette.accent }} className="font-medium underline">your accent</span>
        </span>
      </div>
    </div>
  );
}

export default function BrandingThemeEditor({ branding, setBranding, form, setForm }) {
  const { busy, upload, remove } = useUpload(setBranding);
  const draft = draftBranding(branding, form);
  const accents = resolveAccents(draft);
  const palette = {
    light: accents.light || { ...THEME_DEFAULT.light, derived: false },
    dark: accents.dark || { ...THEME_DEFAULT.dark, derived: false },
  };
  const set = (key) => (v) => setForm((f) => ({ ...f, [key]: v }));

  const modes = [
    {
      mode: "light",
      accentKey: "accent_light",
      fgKey: "accent_fg_light",
      accentHelp: "Used exactly as given in light mode. Clear it to use the default theme color (or one derived from your dark accent).",
      logo: branding.logo_url ? { src: branding.logo_url, filter: null } : null,
      logoRoute: "logo",
      logoKey: "logo_url",
      logoHelp: "PNG, JPEG, WebP or SVG, up to 5 MB. Shown in the top bar and on the sign-in page.",
      iconRoute: "favicon",
      iconKey: "favicon_url",
      iconHelp: "Square PNG, 512 × 512 recommended (min 192). Also the iOS / Android home-screen icon.",
    },
    {
      mode: "dark",
      accentKey: "accent_dark",
      fgKey: "accent_fg_dark",
      accentHelp: "Optional. Left empty, one is derived from your light accent so it stays readable on dark backgrounds.",
      logo: branding.logo_dark_url ? { src: branding.logo_dark_url, filter: null } : null,
      logoRoute: "logo-dark",
      logoKey: "logo_dark_url",
      logoHelp: "Optional. Left empty, the light logo is shown (smart-flipped if set below).",
      iconRoute: "favicon-dark",
      iconKey: "favicon_dark_url",
      iconHelp: "Optional. Used when the browser is in dark mode. Left empty, the light icon is used.",
    },
  ];

  return (
    <div className="bg-surface rounded-lg border border-border p-6 space-y-6">
      <div>
        <h2 className="text-base font-semibold text-fg">Theme</h2>
        <p className="text-sm text-fg-muted mt-1">
          Each mode has its own accent, its own text-on-accent color, its own logo and tab icon. A mode
          left without an accent gets one derived from the other, kept readable on its background.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {modes.map((m) => {
          const p = palette[m.mode];
          const autoFg = autoTextOn(p.accent);
          return (
            <div key={m.mode} className="space-y-4 min-w-0">
              <ModePreview mode={m.mode} branding={draft} palette={p} />

              <ColorField
                id={`${m.accentKey}-input`}
                label={`Accent color for ${m.mode} mode`}
                value={form[m.accentKey]}
                placeholder={p.accent}
                swatch={p.accent}
                onChange={set(m.accentKey)}
                resetLabel="Clear"
                help={m.accentHelp}
              />

              <ColorField
                id={`${m.fgKey}-input`}
                label={`Text on the accent for ${m.mode} mode`}
                value={form[m.fgKey]}
                placeholder={`Auto (${autoFg})`}
                swatch={autoFg}
                onChange={set(m.fgKey)}
                resetLabel="Auto"
                help="The color of a button's label and other text on the accent. Auto picks black or white, whichever reads."
              />

              <ImageField
                label={`Logo for ${m.mode} mode`}
                help={m.logoHelp}
                src={m.logo}
                bg={SURFACE[m.mode]}
                imgClass="h-12 w-auto object-contain"
                empty="No logo of its own"
                busy={busy === m.logoRoute}
                uploadLabel={m.logo ? "Replace logo" : "Upload logo"}
                onPick={(file) => upload(m.logoRoute, "logo", m.logoKey, file)}
                onRemove={m.logo ? () => remove(m.logoRoute, m.logoKey, "logo") : null}
              />

              {m.mode === "light" && (
                <div className="space-y-1">
                  <span className="block text-sm font-medium text-fg">The light logo is drawn for</span>
                  <div className="inline-flex rounded-md bg-surface-2 p-0.5 border border-border">
                    {[
                      { v: "light", label: "Light backgrounds" },
                      { v: "dark", label: "Dark backgrounds" },
                    ].map((opt) => (
                      <button
                        key={opt.v}
                        type="button"
                        onClick={() => setForm((f) => ({ ...f, logo_designed_for: opt.v }))}
                        className={`text-xs px-3 py-1.5 rounded transition-colors ${
                          form.logo_designed_for === opt.v ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-fg-dim">
                    Where it's shown on the other background (no dark logo uploaded), it's smart-flipped to stay visible.
                  </p>
                </div>
              )}

              <ImageField
                label={`Tab icon for ${m.mode} mode`}
                help={m.iconHelp}
                src={branding[m.iconKey] ? { src: branding[m.iconKey], filter: null } : null}
                bg={SURFACE[m.mode]}
                imgClass="h-10 w-10 object-contain"
                empty={m.mode === "light" ? "Default Resolvd icon" : "Uses the light icon"}
                busy={busy === m.iconRoute}
                uploadLabel={branding[m.iconKey] ? "Replace icon" : "Upload icon"}
                onPick={(file) => upload(m.iconRoute, "favicon", m.iconKey, file)}
                onRemove={branding[m.iconKey] ? () => remove(m.iconRoute, m.iconKey, "icon") : null}
              />
            </div>
          );
        })}
      </div>

      <div className="border-t border-border pt-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-fg">Footer</h3>
          <p className="text-xs text-fg-muted mt-0.5">The line at the foot of every page, the sign-in page and exports.</p>
        </div>
        <label className="flex items-start gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={form.show_powered_by}
            onChange={(e) => setForm((f) => ({ ...f, show_powered_by: e.target.checked }))}
            className="mt-0.5 h-4 w-4 rounded border-border-strong text-brand focus:ring-brand/40"
          />
          <span className="text-sm text-fg">
            Show the "Powered by Hearne Technologies" credit
          </span>
        </label>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="block">
            <span className="block text-sm font-medium text-fg mb-1">Your name in the footer</span>
            <input
              type="text"
              value={form.footer_name}
              maxLength={120}
              placeholder="Your company name"
              onChange={(e) => setForm((f) => ({ ...f, footer_name: e.target.value }))}
              className="input"
            />
          </label>
          <label className="block">
            <span className="block text-sm font-medium text-fg mb-1">Link for your name</span>
            <input
              type="url"
              value={form.footer_url}
              placeholder="https://example.com"
              onChange={(e) => setForm((f) => ({ ...f, footer_url: e.target.value }))}
              className="input"
            />
          </label>
        </div>
        <p className="text-xs text-fg-muted">
          Optional. With both the credit off and no name, the footer is hidden.
        </p>
        <div className="rounded-lg border border-dashed border-border-strong py-3 px-4">
          {form.show_powered_by || form.footer_name.trim() ? (
            <PoweredByFooter branding={draft} />
          ) : (
            <p className="text-xs text-fg-dim text-center">No footer</p>
          )}
        </div>
      </div>
    </div>
  );
}
