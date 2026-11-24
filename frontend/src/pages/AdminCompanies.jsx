import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import VendorSupportAdmin from "../components/VendorSupportAdmin";
import { useBranding } from "../context/BrandingContext";
import { useAuth } from "../context/AuthContext";
import CompanyNotificationPrefs from "../components/CompanyNotificationPrefs";
import CompanyContracts from "../components/CompanyContracts";

const KIND_LABEL = {
  vendor: "Vendor",
  customer: "Customer",
  internal: "Internal",
};
const KIND_BLURB = {
  vendor: "External party you escalate to. Project-scoped.",
  customer: "External party you serve. Multi-project capable.",
  internal: "Your own org unit. Members + locations.",
};
const KIND_TONE = {
  vendor: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  customer: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
  internal: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
};

function KindBadge({ kind }) {
  return (
    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${KIND_TONE[kind] || "bg-surface-2 text-fg-muted"}`}>
      {KIND_LABEL[kind] || kind}
    </span>
  );
}

export default function AdminCompanies() {
  const { branding } = useBranding();
  const enabled = useMemo(
    () => ({
      vendor: branding?.enable_vendor_companies !== false,
      customer: branding?.enable_customer_companies === true,
      internal: branding?.enable_internal_companies !== false,
    }),
    [branding]
  );
  const enabledKinds = ["vendor", "customer", "internal"].filter((k) => enabled[k]);

  const [kindFilter, setKindFilter] = useState("all");
  const [companies, setCompanies] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  // ?company=<id>&tab=<tab> deep-links a company (e.g. from a prepaid
  // block alert notification).
  const [params] = useSearchParams();
  const [selectedId, setSelectedId] = useState(() => Number(params.get("company")) || null);
  const deepTab = params.get("tab");
  const [showCreate, setShowCreate] = useState(false);

  async function loadList() {
    setLoading(true);
    try {
      const q = kindFilter === "all" ? "" : `?kind=${kindFilter}`;
      setCompanies(await api.get(`/api/companies${q}`));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    api.get("/api/projects").then(setProjects).catch(() => setProjects([]));
  }, []);
  useEffect(() => { loadList(); }, [kindFilter]);

  // Reset filter to a still-enabled kind if branding flipped one off.
  useEffect(() => {
    if (kindFilter !== "all" && !enabled[kindFilter]) {
      setKindFilter("all");
    }
  }, [enabled, kindFilter]);

  async function handleCreated(c) {
    setShowCreate(false);
    await loadList();
    setSelectedId(c.id);
  }

  const visibleCompanies = companies.filter((c) => enabled[c.kind]);
  const selected = visibleCompanies.find((c) => c.id === selectedId);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-fg mb-1">Companies</h1>
          <p className="text-sm text-fg-muted">
            Vendors, customers, and your own internal org units.
            {enabledKinds.length === 1 && (
              <> Only {KIND_LABEL[enabledKinds[0]]} mode is enabled — toggle others in Branding.</>
            )}
          </p>
        </div>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => setShowCreate(true)}
          disabled={!enabledKinds.length}
        >
          + New company
        </button>
      </div>

      {/* Filter pills */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setKindFilter("all")}
          className={`text-xs px-2.5 py-1 rounded ${
            kindFilter === "all" ? "bg-brand text-white" : "bg-surface-2 text-fg-muted hover:text-fg"
          }`}
        >
          All ({visibleCompanies.length})
        </button>
        {enabledKinds.map((k) => {
          const count = visibleCompanies.filter((c) => c.kind === k).length;
          return (
            <button
              key={k}
              onClick={() => setKindFilter(k)}
              className={`text-xs px-2.5 py-1 rounded ${
                kindFilter === k ? "bg-brand text-white" : "bg-surface-2 text-fg-muted hover:text-fg"
              }`}
            >
              {KIND_LABEL[k]} ({count})
            </button>
          );
        })}
        <button onClick={loadList} className="ml-auto text-xs text-fg-muted hover:text-fg">
          ↻ refresh
        </button>
      </div>

      {showCreate && (
        <CreateForm
          enabledKinds={enabledKinds}
          projects={projects}
          onCancel={() => setShowCreate(false)}
          onCreated={handleCreated}
        />
      )}

      {/* Master-detail */}
      <div className="flex flex-col lg:flex-row gap-4 items-stretch">
        <aside
          className={`
            ${selectedId ? "hidden lg:block" : "block"}
            lg:w-80 lg:flex-shrink-0 bg-surface border border-border rounded-lg overflow-hidden
          `}
        >
          {loading ? (
            <div className="text-sm text-fg-dim p-4">Loading…</div>
          ) : visibleCompanies.length === 0 ? (
            <div className="text-sm text-fg-dim italic p-4">
              No companies yet. Click "New company" to add one.
            </div>
          ) : (
            <div className="divide-y divide-border max-h-[70vh] overflow-y-auto">
              {visibleCompanies.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className={`w-full text-left px-3 py-2.5 hover:bg-surface-2 transition-colors ${
                    selectedId === c.id ? "bg-brand/5 border-l-2 border-brand" : ""
                  }`}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-fg truncate">{c.name}</span>
                    <KindBadge kind={c.kind} />
                  </div>
                  <div className="text-xs text-fg-muted truncate mt-0.5">
                    {c.project_name && <>{c.project_name}</>}
                    {c.domain && <>{c.project_name ? " · " : ""}{c.domain}</>}
                  </div>
                  <div className="text-[11px] text-fg-dim mt-1">
                    {c.kind === "internal"
                      ? `${c.member_count || 0} member${c.member_count === 1 ? "" : "s"}`
                      : `${c.active_contact_count || 0} contact${c.active_contact_count === 1 ? "" : "s"}`}
                    {c.location_count > 0 && <> · {c.location_count} location{c.location_count === 1 ? "" : "s"}</>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section className={`flex-1 min-w-0 ${selectedId ? "block" : "hidden lg:block"}`}>
          {!selected ? (
            <div className="bg-surface border border-border rounded-lg p-8 text-sm text-fg-dim italic text-center">
              Select a company on the left, or create a new one.
            </div>
          ) : (
            <CompanyDetail
              initialTab={selected.id === Number(params.get("company")) ? deepTab : null}
              company={selected}
              projects={projects}
              onBack={() => setSelectedId(null)}
              onReload={loadList}
              onDeleted={() => { setSelectedId(null); loadList(); }}
            />
          )}
        </section>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Create form
// ─────────────────────────────────────────────────────────────────────
function CreateForm({ enabledKinds, projects, onCancel, onCreated }) {
  const [kind, setKind] = useState(enabledKinds[0] || "vendor");
  const [form, setForm] = useState({ name: "", domain: "", notes: "", project_id: "" });
  const [busy, setBusy] = useState(false);

  // Vendor projects must have has_external_vendor=true.
  const eligibleProjects = kind === "vendor"
    ? projects.filter((p) => p.has_external_vendor && p.status === "active")
    : projects.filter((p) => p.status === "active");

  async function submit(e) {
    e.preventDefault();
    if (!form.name.trim()) return toast.error("Name required");
    if (kind === "vendor" && !form.project_id) {
      return toast.error("Project required for vendor companies");
    }
    setBusy(true);
    try {
      const r = await api.post("/api/companies", {
        ...form,
        kind,
        project_id: form.project_id ? Number(form.project_id) : null,
      });
      onCreated(r);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="bg-surface border border-border rounded-lg p-4 space-y-3">
      <div className="text-sm font-semibold text-fg">New company</div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {enabledKinds.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={`text-left p-3 rounded-lg border transition-colors ${
              kind === k
                ? "border-brand bg-brand/5"
                : "border-border bg-surface-2 hover:bg-surface"
            }`}
          >
            <div className="flex items-center gap-2">
              <KindBadge kind={k} />
            </div>
            <div className="text-xs text-fg-muted mt-1">{KIND_BLURB[k]}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-border">
        <label className="text-xs text-fg-muted flex flex-col gap-1">
          Name
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
            placeholder={kind === "internal" ? "Internal IT" : "Acme Corp"}
            required
          />
        </label>
        <label className="text-xs text-fg-muted flex flex-col gap-1">
          Domain {kind !== "internal" && <span className="text-fg-dim">(for sender-domain matching)</span>}
          <input
            value={form.domain}
            onChange={(e) => setForm((f) => ({ ...f, domain: e.target.value }))}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
            placeholder="acme.com"
          />
        </label>
        <label className="text-xs text-fg-muted flex flex-col gap-1 sm:col-span-2">
          {kind === "vendor" ? "Project (required)" : "Initial project (optional)"}
          <select
            value={form.project_id}
            onChange={(e) => setForm((f) => ({ ...f, project_id: e.target.value }))}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
            required={kind === "vendor"}
          >
            <option value="">{kind === "vendor" ? "— pick a project —" : "— none —"}</option>
            {eligibleProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.prefix})
              </option>
            ))}
          </select>
          {kind === "vendor" && eligibleProjects.length === 0 && (
            <span className="text-xs text-amber-600 mt-1">
              No projects with "Has external vendor" enabled. Configure one in Projects first.
            </span>
          )}
        </label>
        <label className="text-xs text-fg-muted flex flex-col gap-1 sm:col-span-2">
          Notes
          <textarea
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            rows={2}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          />
        </label>
      </div>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn btn-secondary btn-sm">Cancel</button>
        <button type="submit" disabled={busy} className="btn btn-primary btn-sm">
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Detail pane
// ─────────────────────────────────────────────────────────────────────
// MSP mode lives in Branding, but the internal company is where an
// admin sets up "us" — so the switch is offered here too. It enables
// customer companies (contracts, billing) and the billing settings under
// Admin → Time tracking.
function MspModeCard() {
  const { branding, setBranding } = useBranding();
  const on = branding?.enable_customer_companies === true;
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (on && !window.confirm("Turn off MSP mode? Customer companies and billing settings will be hidden (nothing is deleted).")) return;
    setBusy(true);
    try {
      const next = await api.patch("/api/branding", { enable_customer_companies: !on });
      setBranding((b) => ({ ...b, ...next }));
      toast.success(!on ? "MSP mode on" : "MSP mode off");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`rounded-lg border p-3 flex flex-wrap items-center gap-3 ${on ? "border-purple-500/40 bg-purple-500/5" : "border-border bg-surface-2/40"}`}>
      <div className="flex-1 min-w-[14rem]">
        <div className="text-sm font-medium text-fg">
          MSP mode {on ? <span className="text-purple-700 dark:text-purple-300">— on</span> : <span className="text-fg-muted">— off</span>}
        </div>
        <div className="text-xs text-fg-muted mt-0.5">
          Serve outside customers: customer companies with contracts, rate
          cards, billable hours and billing exports. Leave off for an
          internal-only helpdesk.
        </div>
      </div>
      <button onClick={toggle} disabled={busy} className={`btn btn-sm ${on ? "btn-secondary" : "btn-primary"}`}>
        {busy ? "Saving…" : on ? "Turn off" : "Turn on MSP mode"}
      </button>
    </div>
  );
}

function CompanyDetail({ company, projects, onBack, onReload, onDeleted, initialTab }) {
  const { user } = useAuth();
  const [name, setName] = useState(company.name);
  const [domain, setDomain] = useState(company.domain || "");
  const [notes, setNotes] = useState(company.notes || "");
  const [autoDomains, setAutoDomains] = useState(
    Array.isArray(company.auto_add_domains) ? company.auto_add_domains.join(", ") : ""
  );
  const [savingCore, setSavingCore] = useState(false);
  const defaultTab = company.kind === "internal" ? "members" : "contacts";
  const [tab, setTab] = useState(initialTab || defaultTab);

  useEffect(() => {
    setName(company.name);
    setDomain(company.domain || "");
    setNotes(company.notes || "");
    setAutoDomains(
      Array.isArray(company.auto_add_domains) ? company.auto_add_domains.join(", ") : ""
    );
    setTab(initialTab || defaultTab);
  }, [company.id]);

  async function saveCore() {
    setSavingCore(true);
    try {
      const payload = {
        name: name.trim(),
        notes,
      };
      if (company.kind !== "internal") {
        payload.domain = domain.trim();
      } else {
        payload.auto_add_domains = autoDomains
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
      await api.patch(`/api/companies/${company.id}`, payload);
      await onReload();
      toast.success(
        company.kind === "internal" && payload.auto_add_domains?.length
          ? "Saved — existing users with matching domains were synced"
          : "Saved"
      );
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSavingCore(false);
    }
  }

  async function deleteCompany() {
    if (!window.confirm(`Delete "${company.name}"? Cascades contacts, members, and locations.`)) return;
    try {
      await api.delete(`/api/companies/${company.id}`);
      onDeleted();
      toast.success("Deleted");
    } catch (e) {
      toast.error(e.message);
    }
  }

  const isAdmin = user?.role === "Admin";

  // Tabs available per kind
  const tabs = (() => {
    if (company.kind === "vendor") {
      return [
        { id: "contacts", label: "Contacts" },
        { id: "support", label: "Support" },
        { id: "locations", label: "Locations" },
        { id: "notifications", label: "Notifications" },
      ];
    }
    if (company.kind === "customer") {
      return [
        { id: "contacts", label: "Contacts" },
        { id: "locations", label: "Locations" },
        { id: "projects", label: "Projects" },
        { id: "billing", label: "Billing" },
      ];
    }
    return [
      { id: "members", label: "Members" },
      { id: "locations", label: "Locations" },
    ];
  })();

  return (
    <div className="bg-surface border border-border rounded-lg p-4 space-y-4">
      <button onClick={onBack} className="lg:hidden text-xs text-fg-muted hover:text-fg">
        ← Back to list
      </button>

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-base font-semibold text-fg">{company.name}</h2>
            <KindBadge kind={company.kind} />
          </div>
          <div className="text-xs text-fg-muted mt-0.5">
            {company.project_name && <>{company.project_name}</>}
            {company.domain && <>{company.project_name ? " · " : ""}{company.domain}</>}
          </div>
        </div>
        {isAdmin && (
          <button onClick={deleteCompany} className="text-xs text-red-600 hover:underline">
            Delete
          </button>
        )}
      </div>

      {company.kind === "internal" && isAdmin && <MspModeCard />}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 border-t border-border">
        <label className="text-xs text-fg-muted flex flex-col gap-1">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          />
        </label>
        {company.kind !== "internal" && (
          <label className="text-xs text-fg-muted flex flex-col gap-1">
            Domain
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
              placeholder="acme.com"
            />
          </label>
        )}
        {company.kind === "internal" && (
          <label className="text-xs text-fg-muted flex flex-col gap-1">
            Auto-join domains
            <input
              value={autoDomains}
              onChange={(e) => setAutoDomains(e.target.value)}
              className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
              placeholder="acme.com, acme.co.uk"
            />
            <span className="text-[11px] text-fg-dim">
              Comma- or space-separated. Active users whose email matches any
              listed domain auto-join this company on SSO login or invite
              acceptance. Existing matching users are synced on save.
            </span>
          </label>
        )}
        <label className="text-xs text-fg-muted flex flex-col gap-1 sm:col-span-2">
          Notes
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          />
        </label>
      </div>
      <div className="flex justify-end">
        <button onClick={saveCore} disabled={savingCore} className="btn btn-primary btn-sm">
          {savingCore ? "Saving…" : "Save changes"}
        </button>
      </div>

      {/* Tabs */}
      <div className="border-t border-border pt-3">
        <div className="flex gap-1 mb-3">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 text-xs rounded ${
                tab === t.id ? "bg-brand/15 text-brand font-medium" : "text-fg-muted hover:text-fg"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "contacts" && <ContactsTab company={company} onChange={onReload} />}
        {tab === "locations" && <LocationsTab company={company} onChange={onReload} />}
        {tab === "members" && <MembersTab company={company} onChange={onReload} />}
        {tab === "projects" && <ProjectsTab company={company} projects={projects} />}
        {tab === "notifications" && <CompanyNotificationPrefs company={company} />}
        {tab === "support" && company.kind === "vendor" && (
          <VendorSupportAdmin company={company} projects={projects} canEdit={["Admin", "Manager"].includes(user?.role)} />
        )}
        {tab === "billing" && <CompanyContracts company={company} />}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Contacts tab — supports location-based phone-extension shortcut
// ─────────────────────────────────────────────────────────────────────
// Edit an external contact: name, title, location and phone numbers.
// Email can't be changed here (it's the contact's identity for inbound
// mail matching); deactivate and re-add to change it.
// The main line an extension at `loc` is dialled on: the site's own number
// when it uses extensions, else the site it routes extensions through,
// else null (extensions there are internal use only).
function extensionLine(loc, locations) {
  if (!loc) return null;
  if (loc.use_extensions && loc.phone) return { phone: loc.phone, name: loc.name, via: false };
  const via = loc.extension_location_id && locations.find((l) => l.id === loc.extension_location_id);
  if (via && via.use_extensions && via.phone && !via.is_archived) return { phone: via.phone, name: via.name, via: true };
  return null;
}

function extensionHint(loc, line) {
  if (!loc) return "Needs a location with a main phone line to dial.";
  if (!line) return `${loc.name} doesn't take extensions on its number, so this extension is for internal use only.`;
  return line.via
    ? `Dialled after the ${line.name} main line (${loc.name} routes extensions there).`
    : `Dialled after the ${line.name} main line.`;
}

function ContactEditor({ contact, locations, onDone, onCancel }) {
  const loc0 = locations.find((l) => l.id === contact.location_id);
  const [f, setF] = useState({
    name: contact.name || "",
    role_title: contact.role_title || "",
    location_id: contact.location_id ? String(contact.location_id) : "",
    extension: contact.extension || "",
    // Older extension-mode contacts stored the main line as their phone.
    phone: contact.phone && !(loc0?.phone && contact.phone === loc0.phone) ? contact.phone : "",
    mobile: contact.mobile || "",
  });
  const [saving, setSaving] = useState(false);
  const loc = locations.find((l) => String(l.id) === f.location_id);
  const line = extensionLine(loc, locations);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const input = "w-full bg-surface border border-border rounded px-2 py-1.5 text-sm";

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.patch(`/api/contacts/${contact.id}`, {
        name: f.name,
        role_title: f.role_title,
        location_id: f.location_id ? Number(f.location_id) : null,
        extension: f.extension,
        phone: f.phone.trim() || null,
        mobile: f.mobile.trim() || null,
      });
      toast.success("Contact updated");
      onDone();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="w-full mt-2 p-3 rounded-md bg-surface-2/60 border border-border space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-xs font-medium text-fg mb-1">Name</span>
          <input className={input} value={f.name} onChange={set("name")} maxLength={200} />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-fg mb-1">Email</span>
          <input className={`${input} opacity-60`} value={contact.email || ""} disabled />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-fg mb-1">Job title</span>
          <input className={input} value={f.role_title} onChange={set("role_title")} maxLength={120} />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-fg mb-1">Location</span>
          <select className={input} value={f.location_id} onChange={set("location_id")}>
            <option value="">— no location —</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}{l.location_code ? ` (${l.location_code})` : ""}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-fg mb-1">Extension</span>
          <input className={input} value={f.extension} onChange={set("extension")} inputMode="numeric" maxLength={10}
            placeholder={line ? `on ${line.phone}` : ""} />
          {f.extension && <span className="block text-[11px] text-fg-muted mt-1">{extensionHint(loc, line)}</span>}
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-fg mb-1">Direct line (DID)</span>
          <input className={input} type="tel" value={f.phone} onChange={set("phone")} maxLength={40} autoComplete="off" />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-fg mb-1">Mobile</span>
          <input className={input} type="tel" value={f.mobile} onChange={set("mobile")} maxLength={40} autoComplete="off" />
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn btn-secondary btn-sm">Cancel</button>
        <button type="submit" disabled={saving} className="btn btn-primary btn-sm">{saving ? "Saving…" : "Save"}</button>
      </div>
    </form>
  );
}

function ContactsTab({ company, onChange }) {
  const [contacts, setContacts] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    name: "", email: "", role_title: "", phone: "", extension: "", mobile: "", location_id: "",
  });
  const [editingId, setEditingId] = useState(null);

  async function reload() {
    setLoading(true);
    try {
      const [cs, ls] = await Promise.all([
        api.get(`/api/companies/${company.id}/contacts`),
        api.get(`/api/companies/${company.id}/locations`),
      ]);
      setContacts(cs);
      setLocations(ls.filter((l) => !l.is_archived));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); }, [company.id]);

  const selectedLocation = locations.find((l) => String(l.id) === String(form.location_id));
  // The main line an extension at the chosen location is dialled on.
  const addLine = extensionLine(selectedLocation, locations);

  async function submit(e) {
    e.preventDefault();
    if (!form.email.trim()) return toast.error("Email required");
    setAdding(true);
    try {
      // phone = the contact's own direct line (DID). The main line comes
      // from their location, dialled with the extension.
      const payload = {
        name: form.name,
        email: form.email,
        role_title: form.role_title,
        location_id: form.location_id || null,
        extension: form.extension || null,
        phone: form.phone.trim() || null,
        mobile: form.mobile.trim() || null,
      };
      await api.post(`/api/companies/${company.id}/contacts`, payload);
      setForm({ name: "", email: "", role_title: "", phone: "", extension: "", mobile: "", location_id: "" });
      await reload();
      onChange?.();
      toast.success("Contact added");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setAdding(false);
    }
  }

  async function deactivate(id) {
    if (!window.confirm("Deactivate this contact? Historical ticket links are preserved.")) return;
    try {
      await api.delete(`/api/contacts/${id}`);
      await reload();
      onChange?.();
    } catch (e) { toast.error(e.message); }
  }

  return (
    <div className="space-y-3">
      {loading ? (
        <div className="text-sm text-fg-dim">Loading…</div>
      ) : contacts.length === 0 ? (
        <div className="text-sm text-fg-dim italic">No contacts yet.</div>
      ) : (
        <ul className="divide-y divide-border border border-border rounded-md">
          {contacts.map((c) => {
            const loc = locations.find((l) => l.id === c.location_id);
            // Older extension-mode contacts stored the main line as their phone.
            const direct = c.phone && !(loc?.phone && c.phone === loc.phone) ? c.phone : null;
            const phoneDisplay = [
              c.extension && `ext ${c.extension}`,
              direct && `direct ${direct}`,
              c.mobile && `mobile ${c.mobile}`,
            ].filter(Boolean).join(" · ");
            return (
              <li key={c.id} className="px-3 py-2 flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-fg">
                    <span className="font-medium">{c.name || "(no name)"}</span>
                    <span className="text-fg-muted"> · {c.email}</span>
                  </div>
                  <div className="text-xs text-fg-muted">
                    {c.role_title && <>{c.role_title}</>}
                    {loc && <>{c.role_title ? " · " : ""}<span className="text-emerald-700 dark:text-emerald-400">{loc.name}</span></>}
                    {phoneDisplay && <>{(c.role_title || loc) ? " · " : ""}{phoneDisplay}</>}
                  </div>
                </div>
                <button onClick={() => setEditingId(editingId === c.id ? null : c.id)} className="text-xs text-brand hover:underline">
                  {editingId === c.id ? "Close" : "Edit"}
                </button>
                <button onClick={() => deactivate(c.id)} className="text-xs text-red-600 hover:underline">
                  Deactivate
                </button>
                {editingId === c.id && (
                  <ContactEditor
                    contact={c}
                    locations={locations}
                    onCancel={() => setEditingId(null)}
                    onDone={async () => { setEditingId(null); await reload(); onChange?.(); }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2 border-t border-border">
        <input
          className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          placeholder="Name"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
        <input
          className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          placeholder="Email *"
          required
          value={form.email}
          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
        />
        <input
          className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          placeholder="Role / Title"
          value={form.role_title}
          onChange={(e) => setForm((f) => ({ ...f, role_title: e.target.value }))}
        />
        <select
          value={form.location_id}
          onChange={(e) => setForm((f) => ({ ...f, location_id: e.target.value }))}
          className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
        >
          <option value="">— no location —</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}{l.location_code ? ` (${l.location_code})` : ""}
            </option>
          ))}
        </select>

        <input
          className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          placeholder={addLine ? `Extension on ${addLine.phone}` : "Extension (optional)"}
          inputMode="numeric"
          value={form.extension}
          onChange={(e) => setForm((f) => ({ ...f, extension: e.target.value }))}
        />
        <input
          className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          type="tel"
          placeholder="Direct line (DID, optional)"
          value={form.phone}
          onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
        />
        <input
          className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          type="tel"
          placeholder="Mobile (optional)"
          value={form.mobile}
          onChange={(e) => setForm((f) => ({ ...f, mobile: e.target.value }))}
        />

        <div className="sm:col-span-2 flex items-center justify-between gap-2 flex-wrap">
          <span className="text-[11px] text-fg-dim">
            {form.extension && selectedLocation
              ? `${extensionHint(selectedLocation, addLine)} Generic addresses (support@, helpdesk@…) are rejected.`
              : "Generic addresses (support@, helpdesk@, noreply@…) are rejected."}
          </span>
          <button
            type="submit"
            disabled={adding}
            className="btn btn-primary btn-sm disabled:opacity-50"
          >
            {adding ? "Adding…" : "Add contact"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Locations tab
// ─────────────────────────────────────────────────────────────────────
function LocationsTab({ company, onChange }) {
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // location row or {} for new

  async function reload() {
    setLoading(true);
    try {
      setLocations(await api.get(`/api/companies/${company.id}/locations`));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); }, [company.id]);

  async function save(form) {
    try {
      if (form.id) {
        await api.patch(`/api/companies/locations/${form.id}`, form);
        toast.success("Location updated");
      } else {
        await api.post(`/api/companies/${company.id}/locations`, form);
        toast.success("Location added");
      }
      setEditing(null);
      await reload();
      onChange?.();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function archive(id) {
    if (!window.confirm("Archive this location? Contacts pointing here keep their reference.")) return;
    try {
      await api.delete(`/api/companies/locations/${id}`);
      await reload();
      onChange?.();
    } catch (e) {
      toast.error(e.message);
    }
  }

  const active = locations.filter((l) => !l.is_archived);
  const archived = locations.filter((l) => l.is_archived);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-fg-muted">
          {active.length} active{archived.length ? ` · ${archived.length} archived` : ""}
        </span>
        <button
          onClick={() => setEditing({})}
          className="btn btn-secondary btn-sm"
        >
          + New location
        </button>
      </div>

      {editing && (
        <LocationEditor
          form={editing}
          locations={locations}
          onCancel={() => setEditing(null)}
          onSubmit={save}
        />
      )}

      {loading ? (
        <div className="text-sm text-fg-dim">Loading…</div>
      ) : active.length === 0 ? (
        <div className="text-sm text-fg-dim italic">No locations yet.</div>
      ) : (
        <ul className="divide-y divide-border border border-border rounded-md">
          {active.map((l) => (
            <li key={l.id} className="px-3 py-2 flex items-center gap-3 flex-wrap">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-fg flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{l.name}</span>
                  {l.location_code && <span className="text-fg-dim font-mono">[{l.location_code}]</span>}
                  {l.is_primary && (
                    <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-brand/15 text-brand">
                      primary
                    </span>
                  )}
                  {l.use_extensions && l.phone && (
                    <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300">
                      ext mode
                    </span>
                  )}
                  {!l.use_extensions && (() => {
                    const line = extensionLine(l, locations);
                    return line ? (
                      <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-300">
                        ext via {line.name}
                      </span>
                    ) : null;
                  })()}
                </div>
                <div className="text-xs text-fg-muted">
                  {l.address && <>{l.address}</>}
                  {l.phone && <>{l.address ? " · " : ""}{l.phone}</>}
                  {l.timezone && <>{(l.address || l.phone) ? " · " : ""}{l.timezone}</>}
                </div>
              </div>
              <button onClick={() => setEditing({ ...l })} className="text-xs text-brand hover:underline">
                Edit
              </button>
              <button onClick={() => archive(l.id)} className="text-xs text-red-600 hover:underline">
                Archive
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LocationEditor({ form, locations = [], onCancel, onSubmit }) {
  const [local, setLocal] = useState({
    id: form.id || null,
    name: form.name || "",
    location_code: form.location_code || "",
    address: form.address || "",
    timezone: form.timezone || "",
    phone: form.phone || "",
    use_extensions: !!form.use_extensions,
    is_primary: !!form.is_primary,
    extension_location_id: form.extension_location_id ? String(form.extension_location_id) : "",
  });
  // Sites whose main line can take this site's extensions instead.
  const extTargets = locations.filter((l) => l.id !== local.id && !l.is_archived && l.use_extensions && l.phone);

  function submit(e) {
    e.preventDefault();
    if (!local.name.trim()) return toast.error("Name required");
    onSubmit({
      ...local,
      extension_location_id: !local.use_extensions && local.extension_location_id ? Number(local.extension_location_id) : null,
    });
  }

  return (
    <form onSubmit={submit} className="bg-surface-2 border border-border rounded p-3 space-y-2">
      <div className="text-sm font-semibold text-fg">
        {local.id ? "Edit location" : "New location"}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input
          placeholder="Name *"
          required
          value={local.name}
          onChange={(e) => setLocal((l) => ({ ...l, name: e.target.value }))}
          className="bg-surface border border-border rounded px-2 py-1 text-sm"
        />
        <input
          placeholder="Code (HQ, EAST)"
          value={local.location_code}
          onChange={(e) => setLocal((l) => ({ ...l, location_code: e.target.value }))}
          className="bg-surface border border-border rounded px-2 py-1 text-sm"
        />
        <input
          placeholder="Address (optional)"
          value={local.address}
          onChange={(e) => setLocal((l) => ({ ...l, address: e.target.value }))}
          className="bg-surface border border-border rounded px-2 py-1 text-sm sm:col-span-2"
        />
        <input
          placeholder="Phone (optional)"
          value={local.phone}
          onChange={(e) => setLocal((l) => ({ ...l, phone: e.target.value }))}
          className="bg-surface border border-border rounded px-2 py-1 text-sm"
        />
        <input
          placeholder="Timezone (e.g. America/Chicago)"
          value={local.timezone}
          onChange={(e) => setLocal((l) => ({ ...l, timezone: e.target.value }))}
          className="bg-surface border border-border rounded px-2 py-1 text-sm"
        />
        <label className="text-xs text-fg-muted inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={local.use_extensions}
            onChange={(e) => setLocal((l) => ({ ...l, use_extensions: e.target.checked }))}
          />
          Use extensions (auto-fill phone, ask only for ext on contacts)
        </label>
        <label className="text-xs text-fg-muted inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={local.is_primary}
            onChange={(e) => setLocal((l) => ({ ...l, is_primary: e.target.checked }))}
          />
          Primary site
        </label>
        {!local.use_extensions && (
          <label className="sm:col-span-2 block text-xs text-fg-muted">
            <span className="block mb-1">
              Dial extensions here through <span className="text-fg-dim">(optional)</span>
            </span>
            <select
              value={local.extension_location_id}
              onChange={(e) => setLocal((l) => ({ ...l, extension_location_id: e.target.value }))}
              className="w-full sm:w-auto bg-surface border border-border rounded px-2 py-1 text-sm text-fg"
            >
              <option value="">No other line (extensions here are internal use only)</option>
              {extTargets.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}{l.location_code ? ` (${l.location_code})` : ""} · {l.phone}
                </option>
              ))}
            </select>
            <span className="block mt-1 text-[11px]">
              This site's number doesn't take extensions. Pick a site whose main line reaches the same extensions,
              and call buttons for people here dial that line + their extension.
              {extTargets.length === 0 && " No site has \"Use extensions\" turned on yet."}
            </span>
          </label>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn btn-secondary btn-sm">Cancel</button>
        <button type="submit" className="btn btn-primary btn-sm">{local.id ? "Save" : "Add"}</button>
      </div>
    </form>
  );
}

// Edit one member: job title + location (this company), and the person's
// phone numbers (everywhere they appear). The name is editable only for
// local-login accounts — Microsoft / Google sign-in resets it each login.
function MemberEditor({ company, member, locations, onDone, onCancel }) {
  const [f, setF] = useState({
    display_name: member.display_name || "",
    role_label: member.role_label || "",
    location_id: member.location_id ? String(member.location_id) : "",
    phone_direct: member.phone_direct || "",
    phone_extension: member.phone_extension || "",
    phone_mobile: member.phone_mobile || "",
  });
  const [saving, setSaving] = useState(false);
  const localLogin = member.auth_provider === "local";
  const loc = locations.find((l) => String(l.id) === f.location_id);
  const line = extensionLine(loc, locations);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const input = "w-full bg-surface border border-border rounded px-2 py-1.5 text-sm";

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const body = {
        role_label: f.role_label,
        location_id: f.location_id ? Number(f.location_id) : null,
        phone_direct: f.phone_direct,
        phone_extension: f.phone_extension,
        phone_mobile: f.phone_mobile,
      };
      if (localLogin) body.display_name = f.display_name;
      await api.patch(`/api/companies/${company.id}/members/${member.user_id}`, body);
      toast.success("Member updated");
      onDone();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="w-full mt-2 p-3 rounded-md bg-surface-2/60 border border-border space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-xs font-medium text-fg mb-1">Name</span>
          <input className={`${input} disabled:opacity-60`} value={f.display_name} onChange={set("display_name")}
            disabled={!localLogin} required={localLogin} maxLength={200} />
          {!localLogin && <span className="block text-[11px] text-fg-muted mt-1">Set by Microsoft / Google sign-in.</span>}
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-fg mb-1">Job title</span>
          <input className={input} value={f.role_label} onChange={set("role_label")} maxLength={120} placeholder="e.g. Service Advisor" />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-fg mb-1">Location</span>
          <select className={input} value={f.location_id} onChange={set("location_id")}>
            <option value="">— no location —</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}{l.location_code ? ` (${l.location_code})` : ""}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-fg mb-1">Extension</span>
          <input className={input} value={f.phone_extension} onChange={set("phone_extension")} inputMode="numeric"
            pattern="[0-9]{0,10}" maxLength={10} placeholder={line ? `on ${line.phone}` : "digits"} />
          <span className="block text-[11px] text-fg-muted mt-1">{extensionHint(loc, line)}</span>
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-fg mb-1">Direct line (DID)</span>
          <input className={input} type="tel" value={f.phone_direct} onChange={set("phone_direct")} maxLength={40} autoComplete="off" />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-fg mb-1">Mobile</span>
          <input className={input} type="tel" value={f.phone_mobile} onChange={set("phone_mobile")} maxLength={40} autoComplete="off" />
        </label>
      </div>
      <p className="text-[11px] text-fg-muted">Name and phone numbers apply everywhere this person appears; title and location are for {company.name}.</p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn btn-secondary btn-sm">Cancel</button>
        <button type="submit" disabled={saving} className="btn btn-primary btn-sm">{saving ? "Saving…" : "Save"}</button>
      </div>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Members tab (internal companies)
// ─────────────────────────────────────────────────────────────────────
function MembersTab({ company, onChange }) {
  const [members, setMembers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pickUser, setPickUser] = useState("");
  const [pickLocation, setPickLocation] = useState("");
  const [pickRole, setPickRole] = useState("");
  const [editingId, setEditingId] = useState(null);

  async function reload() {
    setLoading(true);
    try {
      const [m, l, u] = await Promise.all([
        api.get(`/api/companies/${company.id}/members`),
        api.get(`/api/companies/${company.id}/locations`),
        api.get(`/api/users`),
      ]);
      setMembers(m);
      setLocations(l.filter((x) => !x.is_archived));
      setAllUsers((u || []).filter((x) => x.status === "active"));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); }, [company.id]);

  const memberIds = new Set(members.map((m) => m.user_id));
  const candidates = allUsers.filter((u) => !memberIds.has(u.id));

  async function add(e) {
    e.preventDefault();
    if (!pickUser) return toast.error("Pick a user");
    try {
      await api.post(`/api/companies/${company.id}/members`, {
        user_id: Number(pickUser),
        location_id: pickLocation ? Number(pickLocation) : null,
        role_label: pickRole.trim() || null,
      });
      setPickUser(""); setPickLocation(""); setPickRole("");
      await reload();
      onChange?.();
      toast.success("Member added");
    } catch (e) { toast.error(e.message); }
  }

  async function remove(userId) {
    try {
      await api.delete(`/api/companies/${company.id}/members/${userId}`);
      await reload();
      onChange?.();
    } catch (e) { toast.error(e.message); }
  }

  async function patchLocation(userId, locationId) {
    try {
      await api.post(`/api/companies/${company.id}/members`, {
        user_id: userId,
        location_id: locationId ? Number(locationId) : null,
        role_label: members.find((m) => m.user_id === userId)?.role_label || null,
      });
      await reload();
    } catch (e) { toast.error(e.message); }
  }

  return (
    <div className="space-y-3">
      {loading ? (
        <div className="text-sm text-fg-dim">Loading…</div>
      ) : members.length === 0 ? (
        <div className="text-sm text-fg-dim italic">No members yet.</div>
      ) : (
        <ul className="divide-y divide-border border border-border rounded-md">
          {members.map((m) => (
            <li key={m.user_id} className="px-3 py-2 flex items-center gap-3 flex-wrap">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-fg">
                  <span className="font-medium">{m.display_name}</span>
                  <span className="text-fg-muted"> · {m.email}</span>
                  <span className="text-fg-dim text-xs ml-1">({m.role})</span>
                </div>
                {m.role_label && (
                  <div className="text-xs text-fg-muted">{m.role_label}</div>
                )}
                {(m.phone_direct || m.phone_mobile || m.phone_extension) && (
                  <div className="text-xs text-fg-dim">
                    {[m.phone_extension && `ext ${m.phone_extension}`, m.phone_direct && `direct ${m.phone_direct}`, m.phone_mobile && `mobile ${m.phone_mobile}`].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>
              <select
                value={m.location_id || ""}
                onChange={(e) => patchLocation(m.user_id, e.target.value)}
                className="bg-surface-2 border border-border rounded px-2 py-1 text-xs"
              >
                <option value="">— no location —</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}{l.location_code ? ` (${l.location_code})` : ""}
                  </option>
                ))}
              </select>
              <button onClick={() => setEditingId(editingId === m.user_id ? null : m.user_id)} className="text-xs text-brand hover:underline">
                {editingId === m.user_id ? "Close" : "Edit"}
              </button>
              <button onClick={() => remove(m.user_id)} className="text-xs text-red-600 hover:underline">
                Remove
              </button>
              {editingId === m.user_id && (
                <MemberEditor
                  company={company}
                  member={m}
                  locations={locations}
                  onCancel={() => setEditingId(null)}
                  onDone={async () => { setEditingId(null); await reload(); onChange?.(); }}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {candidates.length > 0 && (
        <form onSubmit={add} className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2 border-t border-border">
          <select
            value={pickUser}
            onChange={(e) => setPickUser(e.target.value)}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
            required
          >
            <option value="">— add user —</option>
            {candidates.map((u) => (
              <option key={u.id} value={u.id}>
                {u.display_name || u.email}
              </option>
            ))}
          </select>
          <select
            value={pickLocation}
            onChange={(e) => setPickLocation(e.target.value)}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          >
            <option value="">— no location —</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}{l.location_code ? ` (${l.location_code})` : ""}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <input
              placeholder="Role label (optional)"
              value={pickRole}
              onChange={(e) => setPickRole(e.target.value)}
              className="flex-1 bg-surface-2 border border-border rounded px-2 py-1 text-sm"
            />
            <button type="submit" className="btn btn-primary btn-sm">Add</button>
          </div>
        </form>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Customer ↔ Projects tab
// ─────────────────────────────────────────────────────────────────────
function ProjectsTab({ company, projects }) {
  const [linked, setLinked] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  async function reload() {
    setLoading(true);
    try {
      setLinked(await api.get(`/api/companies/${company.id}/projects`));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); }, [company.id]);

  async function toggle(projectId) {
    const ids = new Set(linked.map((l) => l.id));
    if (ids.has(projectId)) ids.delete(projectId);
    else ids.add(projectId);
    setSaving(true);
    try {
      await api.put(`/api/companies/${company.id}/projects`, {
        project_ids: Array.from(ids),
      });
      await reload();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  const active = projects.filter((p) => p.status === "active");
  const linkedIds = new Set(linked.map((l) => l.id));

  return (
    <div className="space-y-2">
      <p className="text-xs text-fg-muted">
        Tickets in any linked project are associated with this customer.
      </p>
      {loading ? (
        <div className="text-sm text-fg-dim">Loading…</div>
      ) : active.length === 0 ? (
        <div className="text-sm text-fg-dim italic">No active projects.</div>
      ) : (
        <ul className="divide-y divide-border border border-border rounded-md">
          {active.map((p) => (
            <li key={p.id} className="px-3 py-2 flex items-center gap-2">
              <input
                type="checkbox"
                checked={linkedIds.has(p.id)}
                onChange={() => toggle(p.id)}
                disabled={saving}
              />
              <span className="text-sm text-fg">{p.name}</span>
              <span className="text-xs text-fg-dim font-mono">({p.prefix})</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
