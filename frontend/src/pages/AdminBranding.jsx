import React, { useState, useEffect } from "react";
import toast from "react-hot-toast";
import { useBranding } from "../context/BrandingContext";
import SaveBar, { useSavedBaseline } from "../components/SaveBar";
import BrandingThemeEditor from "../components/BrandingThemeEditor";
import { isHex } from "../utils/brandColors";

export default function AdminBranding() {
  const { branding, setBranding } = useBranding();
  const [form, setForm] = useState({
    site_name: branding.site_name || "",
    tagline: branding.tagline || "",
    // Light accent: '' = theme default (accent_override_enabled off).
    accent_light: branding.accent_override_enabled ? branding.primary_color || "" : "",
    accent_dark: branding.accent_dark || "",
    accent_fg_light: branding.accent_fg_light || "",
    accent_fg_dark: branding.accent_fg_dark || "",
    show_powered_by: branding.show_powered_by ?? true,
    footer_name: branding.footer_name || "",
    footer_url: branding.footer_url || "",
    phonetic_readback_enabled: branding.phonetic_readback_enabled ?? true,
    logo_designed_for: branding.logo_designed_for || "light",
    date_style: branding.date_style || "iso",
    time_style: branding.time_style || "iso",
    timezone: branding.timezone || "UTC",
    default_restrict_followers: branding.default_restrict_followers ?? true,
    default_restrict_mentions: branding.default_restrict_mentions ?? true,
    enable_vendor_companies: branding.enable_vendor_companies ?? true,
    enable_customer_companies: branding.enable_customer_companies ?? false,
    enable_internal_companies: branding.enable_internal_companies ?? true,
    ai_assist_enabled: branding.ai_assist_enabled ?? true,
    ai_project_context_enabled: branding.ai_project_context_enabled ?? true,
    ai_disclosure_audience: branding.ai_disclosure_audience || 'self_and_admin',
    default_project_id: branding.default_project_id ?? "",
  });
  const [projects, setProjects] = useState([]);
  useEffect(() => {
    fetch("/api/projects", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((all) => setProjects((all || []).filter((p) => p.status === "active")))
      .catch(() => setProjects([]));
  }, []);
  const [saving, setSaving] = useState(false);
  const { dirty, markSaved, savedValue } = useSavedBaseline(form);
  // Baseline = the form as first shown.
  useEffect(() => { markSaved(form); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function saveSettings(e) {
    e?.preventDefault();
    const colorKeys = ["accent_light", "accent_dark", "accent_fg_light", "accent_fg_dark"];
    if (colorKeys.some((k) => form[k] && !isHex(form[k]))) {
      toast.error("Colors must be 6-digit hex values like #1f6feb");
      return;
    }
    setSaving(true);
    try {
      const { accent_light, ...rest } = form;
      const res = await fetch("/api/branding", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...rest,
          accent_override_enabled: !!accent_light,
          ...(accent_light ? { primary_color: accent_light } : {}),
          default_project_id: form.default_project_id ? Number(form.default_project_id) : null,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to save branding");
      }
      const data = await res.json();
      setBranding((prev) => ({ ...prev, ...data }));
      markSaved(form);
      toast.success("Branding saved");
    } catch (err) {
      toast.error(err.message || "Failed to save branding");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-5xl space-y-6">
      <h1 className="text-2xl font-bold text-fg">Branding</h1>

      <BrandingThemeEditor
        branding={branding}
        setBranding={setBranding}
        form={form}
        setForm={setForm}
      />

      {/* Settings form */}
      <form
        onSubmit={saveSettings}
        className="bg-surface rounded-lg border border-border p-6 space-y-4 max-w-2xl"
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

        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="phonetic_readback_enabled"
            checked={form.phonetic_readback_enabled}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                phonetic_readback_enabled: e.target.checked,
              }))
            }
            className="mt-0.5 h-4 w-4 rounded border-border-strong text-brand focus:ring-brand/40"
          />
          <label
            htmlFor="phonetic_readback_enabled"
            className="text-sm text-fg"
          >
            Phonetic readback on ticket refs
            <span className="block text-xs text-fg-muted mt-0.5">
              Hover a ticket ref (e.g. WEB-0079) to see "Whiskey Echo Bravo - 0
              0 7 9" for verbal readback. Users can opt out individually.
            </span>
          </label>
        </div>

        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="ai_assist_enabled"
            checked={form.ai_assist_enabled}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                ai_assist_enabled: e.target.checked,
              }))
            }
            className="mt-0.5 h-4 w-4 rounded border-border-strong text-brand focus:ring-brand/40"
          />
          <label htmlFor="ai_assist_enabled" className="text-sm text-fg">
            AI Assist available org-wide (BYO-AI)
            <span className="block text-xs text-fg-muted mt-0.5">
              When OFF, the AI rewrite button is hidden everywhere and the
              per-user AI Assist card is locked. Use this if your org wants
              zero AI traffic — even with each user using their own provider
              and key.
            </span>
          </label>
        </div>

        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="ai_project_context_enabled"
            checked={form.ai_project_context_enabled}
            disabled={!form.ai_assist_enabled}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                ai_project_context_enabled: e.target.checked,
              }))
            }
            className="mt-0.5 h-4 w-4 rounded border-border-strong text-brand focus:ring-brand/40 disabled:opacity-40"
          />
          <label htmlFor="ai_project_context_enabled" className="text-sm text-fg">
            Allow project AI context
            <span className="block text-xs text-fg-muted mt-0.5">
              When ON, admins can author a per-project glossary (sites,
              integrations, lingo) that gets prepended to AI rewrites for
              tickets in that project. Adds input tokens per call. Per-user
              opt-out lives in Account → Preferences → AI Assist.
            </span>
          </label>
        </div>

        <div>
          <label htmlFor="ai_disclosure_audience" className="block text-sm font-medium text-fg mb-1">
            AI usage disclosure
          </label>
          <p className="text-xs text-fg-muted mb-2">
            Who sees the "✨ AI · provider · model · tokens" badge on
            comments + tickets. Comment author + Admin/Manager always see.
            Vendors never see (badge is stripped from any content sent
            externally). Per-user opt-in to publish own usage org-wide
            overrides this for their own posts only.
          </p>
          <select
            id="ai_disclosure_audience"
            value={form.ai_disclosure_audience}
            disabled={!form.ai_assist_enabled}
            onChange={(e) =>
              setForm((f) => ({ ...f, ai_disclosure_audience: e.target.value }))
            }
            className="border border-border-strong rounded-md px-2 py-1 text-sm disabled:opacity-40"
          >
            <option value="self_and_admin">Author + Admins/Managers (default)</option>
            <option value="admin_only">Admins/Managers only</option>
            <option value="all_users">Every internal user</option>
          </select>
        </div>

        <div className="border-t border-border pt-4">
          <h2 className="text-sm font-semibold text-fg mb-1">Cross-project visibility</h2>
          <p className="text-xs text-fg-muted mb-3">
            Org-wide defaults for who can be mentioned or added as a follower.
            Each project may override these for its own tickets. Admins (global
            role) bypass these gates either way.
          </p>
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                id="default_restrict_mentions"
                checked={form.default_restrict_mentions}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    default_restrict_mentions: e.target.checked,
                  }))
                }
                className="mt-0.5 h-4 w-4 rounded border-border-strong text-brand focus:ring-brand/40"
              />
              <label htmlFor="default_restrict_mentions" className="text-sm text-fg">
                Restrict @mentions to project members by default
                <span className="block text-xs text-fg-muted mt-0.5">
                  When on, the comment autocomplete and mention notifications
                  only resolve users who are members of the ticket's project.
                </span>
              </label>
            </div>
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                id="default_restrict_followers"
                checked={form.default_restrict_followers}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    default_restrict_followers: e.target.checked,
                  }))
                }
                className="mt-0.5 h-4 w-4 rounded border-border-strong text-brand focus:ring-brand/40"
              />
              <label htmlFor="default_restrict_followers" className="text-sm text-fg">
                Restrict follower picker to project members by default
                <span className="block text-xs text-fg-muted mt-0.5">
                  When on, "add follower" on a ticket only lists users who
                  belong to that project.
                </span>
              </label>
            </div>
          </div>
        </div>

        <div className="border-t border-border pt-4">
          <h2 className="text-sm font-semibold text-fg mb-1">Company modes</h2>
          <p className="text-xs text-fg-muted mb-3">
            Which kinds of companies are managed in this install. Disabled
            modes are hidden from the Companies admin and from filters
            elsewhere; existing rows of those kinds stay in the database
            untouched.
          </p>
          <div className="space-y-2">
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                id="enable_vendor_companies"
                checked={form.enable_vendor_companies}
                onChange={(e) =>
                  setForm((f) => ({ ...f, enable_vendor_companies: e.target.checked }))
                }
                className="mt-0.5 h-4 w-4 rounded border-border-strong text-brand focus:ring-brand/40"
              />
              <label htmlFor="enable_vendor_companies" className="text-sm text-fg">
                Vendor companies
                <span className="block text-xs text-fg-muted mt-0.5">
                  External parties you escalate to (printer vendor, ISP,
                  software support). Project-scoped; drives the existing
                  vendor outbound + inbound mail flows.
                </span>
              </label>
            </div>
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                id="enable_customer_companies"
                checked={form.enable_customer_companies}
                onChange={(e) =>
                  setForm((f) => ({ ...f, enable_customer_companies: e.target.checked }))
                }
                className="mt-0.5 h-4 w-4 rounded border-border-strong text-brand focus:ring-brand/40"
              />
              <label htmlFor="enable_customer_companies" className="text-sm text-fg">
                Customer companies (MSP mode)
                <span className="block text-xs text-fg-muted mt-0.5">
                  External parties you serve. One customer can map to
                  multiple projects (helpdesk + infra + security). Off by
                  default — leave off for pure internal helpdesk installs.
                </span>
              </label>
            </div>
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                id="enable_internal_companies"
                checked={form.enable_internal_companies}
                onChange={(e) =>
                  setForm((f) => ({ ...f, enable_internal_companies: e.target.checked }))
                }
                className="mt-0.5 h-4 w-4 rounded border-border-strong text-brand focus:ring-brand/40"
              />
              <label htmlFor="enable_internal_companies" className="text-sm text-fg">
                Internal companies / departments
                <span className="block text-xs text-fg-muted mt-0.5">
                  Your own org units (Internal IT, DevOps, departments).
                  Members are real Resolvd users, optionally pinned to a
                  Location for routing and reporting.
                </span>
              </label>
            </div>
          </div>
        </div>

        <div className="border-t border-border pt-4">
          <h2 className="text-sm font-semibold text-fg mb-1">Default project</h2>
          <p className="text-xs text-fg-muted mb-3">
            Preselected on New Ticket for everyone who hasn't picked their own
            default (Account → Preferences). Users who can't access this project
            fall back to their usual choice.
          </p>
          <label className="block max-w-sm">
            <span className="block text-xs text-fg-muted mb-1">Organization default project</span>
            <select
              value={form.default_project_id}
              onChange={(e) => setForm((f) => ({ ...f, default_project_id: e.target.value }))}
              className="w-full border border-border-strong rounded-md px-2 py-1.5 text-sm bg-surface"
            >
              <option value="">None</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.prefix ? `${p.prefix} — ${p.name}` : p.name}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="border-t border-border pt-4">
          <h2 className="text-sm font-semibold text-fg mb-1">Localization</h2>
          <p className="text-xs text-fg-muted mb-3">
            How dates and times render across the app. Reports always render
            absolute timestamps using these styles regardless of recency.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="block">
              <span className="block text-xs text-fg-muted mb-1">Date style</span>
              <select
                value={form.date_style}
                onChange={(e) =>
                  setForm((f) => ({ ...f, date_style: e.target.value }))
                }
                className="w-full border border-border-strong rounded-md px-2 py-1.5 text-sm"
              >
                <option value="iso">ISO (2026-04-28)</option>
                <option value="us">US (Apr 28, 2026)</option>
                <option value="eu">EU (28 Apr 2026)</option>
              </select>
            </label>
            <label className="block">
              <span className="block text-xs text-fg-muted mb-1">Time style</span>
              <select
                value={form.time_style}
                onChange={(e) =>
                  setForm((f) => ({ ...f, time_style: e.target.value }))
                }
                className="w-full border border-border-strong rounded-md px-2 py-1.5 text-sm"
              >
                <option value="iso">24-hour (14:32)</option>
                <option value="12h">12-hour (2:32 PM)</option>
              </select>
            </label>
            <label className="block">
              <span className="block text-xs text-fg-muted mb-1">Time zone</span>
              <input
                type="text"
                list="branding-timezone-list"
                value={form.timezone}
                onChange={(e) =>
                  setForm((f) => ({ ...f, timezone: e.target.value }))
                }
                placeholder="UTC"
                className="w-full border border-border-strong rounded-md px-2 py-1.5 text-sm"
              />
              <datalist id="branding-timezone-list">
                {(typeof Intl?.supportedValuesOf === "function"
                  ? Intl.supportedValuesOf("timeZone")
                  : [
                      "UTC",
                      "America/New_York",
                      "America/Chicago",
                      "America/Denver",
                      "America/Los_Angeles",
                      "America/Anchorage",
                      "America/Phoenix",
                      "America/Toronto",
                      "America/Vancouver",
                      "America/Mexico_City",
                      "America/Sao_Paulo",
                      "Europe/London",
                      "Europe/Dublin",
                      "Europe/Paris",
                      "Europe/Berlin",
                      "Europe/Amsterdam",
                      "Europe/Madrid",
                      "Europe/Rome",
                      "Europe/Stockholm",
                      "Europe/Moscow",
                      "Asia/Dubai",
                      "Asia/Karachi",
                      "Asia/Kolkata",
                      "Asia/Shanghai",
                      "Asia/Hong_Kong",
                      "Asia/Singapore",
                      "Asia/Tokyo",
                      "Asia/Seoul",
                      "Australia/Sydney",
                      "Australia/Melbourne",
                      "Pacific/Auckland",
                      "Pacific/Honolulu",
                    ]
                ).map((tz) => (
                  <option key={tz} value={tz} />
                ))}
              </datalist>
              <span className="block text-[11px] text-fg-muted mt-1">
                Start typing a city or region — e.g. <code>America/Chicago</code>, <code>Europe/London</code>.{" "}
                <a
                  href="https://en.wikipedia.org/wiki/List_of_tz_database_time_zones"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand hover:underline"
                >
                  Full IANA list
                </a>
                .
              </span>
            </label>
          </div>
        </div>

      </form>

      <SaveBar
        dirty={dirty}
        saving={saving}
        onSave={() => saveSettings()}
        onDiscard={() => setForm(savedValue)}
        savedHint="logos and tab icons save on upload"
      />
    </div>
  );
}
