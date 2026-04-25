import React, { useState, useRef } from "react";
import toast from "react-hot-toast";
import { useBranding } from "../context/BrandingContext";

export default function AdminBranding() {
  const { branding, setBranding } = useBranding();
  const [form, setForm] = useState({
    site_name: branding.site_name || "",
    tagline: branding.tagline || "",
    primary_color: branding.primary_color || "#16a34a",
    show_powered_by: branding.show_powered_by ?? true,
    logo_on_dark: branding.logo_on_dark ?? false,
    accent_override_enabled: branding.accent_override_enabled ?? false,
    logo_designed_for: branding.logo_designed_for || "light",
  });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef();

  async function saveSettings(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch("/api/branding", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error("Save failed");
      const data = await res.json();
      setBranding((prev) => ({ ...prev, ...data }));
      toast.success("Branding saved");
    } catch {
      toast.error("Failed to save branding");
    } finally {
      setSaving(false);
    }
  }

  async function uploadLogo(file) {
    if (!file) return;
    setUploading(true);
    const fd = new FormData();
    fd.append("logo", file);
    try {
      const res = await fetch("/api/branding/logo", {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!res.ok) throw new Error("Upload failed");
      const data = await res.json();
      setBranding((prev) => ({
        ...prev,
        logo_url: data.logo_url + "?t=" + Date.now(),
      }));
      toast.success("Logo uploaded");
    } catch {
      toast.error("Logo upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function deleteLogo() {
    if (!window.confirm("Remove logo?")) return;
    try {
      const res = await fetch("/api/branding/logo", {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error();
      setBranding((prev) => ({ ...prev, logo_url: null }));
      toast.success("Logo removed");
    } catch {
      toast.error("Failed to remove logo");
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-fg">Branding</h1>

      {/* Logo */}
      <div className="bg-surface rounded-lg border border-border p-6 space-y-4">
        <h2 className="text-base font-semibold text-fg">Logo</h2>
        <div className="flex items-center gap-4">
          {branding.logo_url ? (
            <img
              src={branding.logo_url}
              alt="Logo"
              className="h-16 w-auto object-contain rounded border border-border p-1 bg-surface-2"
            />
          ) : (
            <div className="h-16 w-16 rounded border border-dashed border-border-strong flex items-center justify-center text-fg-dim text-xs">
              No logo
            </div>
          )}
          <div className="flex flex-col gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => uploadLogo(e.target.files[0])}
            />
            <button
              onClick={() => fileRef.current.click()}
              disabled={uploading}
              className="btn-secondary btn-sm btn"
            >
              {uploading ? "Uploading…" : "Upload Logo"}
            </button>
            {branding.logo_url && (
              <button onClick={deleteLogo} className="btn-danger btn-sm btn">
                Remove
              </button>
            )}
          </div>
        </div>
        <p className="text-xs text-fg-muted">
          PNG, SVG, JPG up to 5 MB. Displayed in nav and login page.
        </p>
        <div className="space-y-2">
          <span className="block text-sm font-medium text-fg">
            My logo works best with
          </span>
          <div className="inline-flex rounded-md bg-surface-2 p-0.5 border border-border">
            {[
              { v: "light", label: "Light Mode" },
              { v: "dark", label: "Dark Mode" },
            ].map((opt) => (
              <button
                key={opt.v}
                type="button"
                onClick={() =>
                  setForm((f) => ({ ...f, logo_designed_for: opt.v }))
                }
                className={`text-xs px-3 py-1.5 rounded transition-colors ${
                  form.logo_designed_for === opt.v
                    ? "bg-surface text-fg shadow-sm"
                    : "text-fg-muted hover:text-fg"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-fg-dim">
            Logo will be smart-flipped when viewed in the opposite mode.
          </p>
        </div>
      </div>

      {/* Settings form */}
      <form
        onSubmit={saveSettings}
        className="bg-surface rounded-lg border border-border p-6 space-y-4"
      >
        <h2 className="text-base font-semibold text-fg">Settings</h2>

        <div>
          <label className="block text-sm font-medium text-fg mb-1">
            Site name
          </label>
          <input
            type="text"
            value={form.site_name}
            onChange={(e) =>
              setForm((f) => ({ ...f, site_name: e.target.value }))
            }
            className="w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-fg mb-1">
            Tagline
          </label>
          <input
            type="text"
            value={form.tagline}
            onChange={(e) =>
              setForm((f) => ({ ...f, tagline: e.target.value }))
            }
            className="w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
          />
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={form.accent_override_enabled}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  accent_override_enabled: e.target.checked,
                }))
              }
              className="h-4 w-4 rounded border-border-strong text-brand focus:ring-brand/40"
            />
            <span className="text-sm font-medium text-fg">
              Use custom accent color
            </span>
            <span className="text-xs text-fg-dim">
              (off = default theme green)
            </span>
          </label>
          <div
            className={`flex items-center gap-3 ${form.accent_override_enabled ? "" : "opacity-50 pointer-events-none"}`}
          >
            <input
              type="color"
              value={form.primary_color}
              onChange={(e) =>
                setForm((f) => ({ ...f, primary_color: e.target.value }))
              }
              className="h-9 w-12 rounded border border-border-strong cursor-pointer p-0.5"
            />
            <input
              type="text"
              value={form.primary_color}
              onChange={(e) =>
                setForm((f) => ({ ...f, primary_color: e.target.value }))
              }
              className="w-28 border border-border-strong rounded-md px-3 py-2 text-sm font-mono bg-surface text-fg focus:outline-none focus:ring-2 focus:ring-brand/40"
              placeholder="#16a34a"
            />
            <span className="text-xs text-fg-muted">
              Replaces brand color app-wide and in exports/email.
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="show_powered_by"
            checked={form.show_powered_by}
            onChange={(e) =>
              setForm((f) => ({ ...f, show_powered_by: e.target.checked }))
            }
            className="h-4 w-4 rounded border-border-strong text-brand focus:ring-brand/40"
          />
          <label htmlFor="show_powered_by" className="text-sm text-fg">
            Show "Powered by Hearne Technologies" footer
          </label>
        </div>

        <div className="pt-2">
          <button type="submit" disabled={saving} className="btn-primary btn">
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </div>
  );
}
