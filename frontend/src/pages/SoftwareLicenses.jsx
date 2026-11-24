import React, { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import { useAuth } from "../context/AuthContext";
import InventoryTabs from "../components/InventoryTabs";

// Software licenses: subscriptions, perpetual licenses and contracts the
// org owns, entered by hand. Linking a license to a title from the software
// inventory counts seats in use from installs (company-scoped licenses
// count only that company's devices).

const TYPES = [
  { value: "subscription", label: "Subscription" },
  { value: "perpetual", label: "Perpetual" },
  { value: "per_device", label: "Per device" },
  { value: "per_user", label: "Per user" },
  { value: "site", label: "Site / unlimited" },
  { value: "other", label: "Other" },
];
const TYPE_LABEL = Object.fromEntries(TYPES.map((t) => [t.value, t.label]));
const PERIOD_LABEL = { one_time: "one-time", monthly: "/ month", yearly: "/ year" };

const STATUSES = [
  { value: "active", label: "Active" },
  { value: "renewing", label: "Renewing soon" },
  { value: "expired", label: "Past renewal" },
  { value: "over", label: "Over-allocated" },
  { value: "archived", label: "Archived" },
];

const EMPTY = {
  name: "", vendor: "", software_key: "", license_type: "subscription", seats: "",
  company_id: "", purchase_date: "", renewal_date: "", auto_renew: false,
  cost: "", cost_period: "yearly", reference: "", notes: "", license_key: "",
};

// A calendar date (YYYY-MM-DD) shown as-is, never shifted by time zone.
function fmtDate(s) {
  if (!s) return "—";
  const d = new Date(`${s}T00:00:00Z`);
  return isNaN(d) ? s : d.toLocaleDateString(undefined, { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" });
}

function fmtCost(l) {
  if (l.cost == null) return "—";
  const n = Number(l.cost).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n}${l.cost_period ? ` ${PERIOD_LABEL[l.cost_period]}` : ""}`;
}

function RenewalBadge({ l, renewingDays }) {
  if (!l.renewal_date) return <span className="text-fg-dim">—</span>;
  const d = l.days_to_renewal;
  let badge = null;
  if (d < 0) badge = <span className="ml-2 rounded px-1.5 py-0.5 text-[11px] font-medium bg-red-500/15 text-red-700 dark:text-red-300">{l.auto_renew ? "renewal due" : "lapsed"}</span>;
  else if (d <= renewingDays) badge = <span className="ml-2 rounded px-1.5 py-0.5 text-[11px] font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300">in {d} day{d === 1 ? "" : "s"}</span>;
  return <span className="whitespace-nowrap">{fmtDate(l.renewal_date)}{badge}</span>;
}

function SeatsCell({ l }) {
  if (!l.software_key) return <span className="text-fg-dim" title="Not linked to software in the inventory">{l.seats == null ? "Unlimited" : `${l.seats} seats`}</span>;
  const used = l.seats_used ?? 0;
  if (l.seats == null) return <span className="tabular-nums">{used} <span className="text-fg-dim">/ unlimited</span></span>;
  const pct = l.seats ? Math.min(100, Math.round((used / l.seats) * 100)) : 100;
  return (
    <div className="min-w-[7rem]">
      <div className="flex items-baseline gap-1 tabular-nums">
        <span className={l.over_allocated ? "font-semibold text-red-600 dark:text-red-400" : ""}>{used}</span>
        <span className="text-fg-dim">/ {l.seats}</span>
        {l.over_allocated && <span className="ml-1 rounded px-1.5 py-0.5 text-[11px] font-medium bg-red-500/15 text-red-700 dark:text-red-300">over by {used - l.seats}</span>}
      </div>
      <div className="mt-1 h-1.5 rounded bg-surface-2 overflow-hidden" aria-hidden="true">
        <div className={`h-full ${l.over_allocated ? "bg-red-500" : pct >= 90 ? "bg-amber-500" : "bg-brand"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Field({ label, children, hint, className = "" }) {
  return (
    <label className={`block ${className}`}>
      <span className="block text-xs font-medium text-fg mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-fg-muted mt-1">{hint}</span>}
    </label>
  );
}

function LicenseEditor({ license, companies, canDelete, onClose, onSaved }) {
  const isNew = !license.id;
  const [form, setForm] = useState(() => isNew ? { ...EMPTY } : {
    ...EMPTY,
    ...Object.fromEntries(Object.entries(license).filter(([k]) => k in EMPTY && k !== "license_key").map(([k, v]) => [k, v ?? ""])),
    auto_renew: !!license.auto_renew,
    cost_period: license.cost_period || "",
  });
  const [titles, setTitles] = useState([]);
  const [revealed, setRevealed] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  // Suggest titles from the software inventory as the name is typed.
  useEffect(() => {
    const q = form.software_key.trim();
    if (q.length < 2) { setTitles([]); return undefined; }
    let alive = true;
    const t = setTimeout(() => {
      api.get(`/api/software?q=${encodeURIComponent(q)}&limit=15&sort=installs&dir=desc`)
        .then((r) => { if (alive) setTitles(r.items || []); }).catch(() => {});
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [form.software_key]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function reveal() {
    try { setRevealed((await api.get(`/api/software-licenses/${license.id}/key`)).license_key || ""); }
    catch (e) { toast.error(e.message); }
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    const body = { ...form };
    // The key is write-only: send it only when something was typed.
    if (!body.license_key) delete body.license_key;
    if (!body.cost) body.cost_period = null;
    try {
      const saved = isNew
        ? await api.post("/api/software-licenses", body)
        : await api.patch(`/api/software-licenses/${license.id}`, body);
      toast.success(isNew ? "License added" : "License saved");
      onSaved(saved);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function clearKey() {
    if (!window.confirm("Remove the stored license key?")) return;
    try { await api.patch(`/api/software-licenses/${license.id}`, { license_key: null }); toast.success("Key removed"); onSaved(null); }
    catch (e) { toast.error(e.message); }
  }

  async function remove() {
    if (!window.confirm(`Delete "${license.name}"? Archive it instead to keep the record.`)) return;
    try { await api.delete(`/api/software-licenses/${license.id}`); toast.success("Deleted"); onSaved(null); }
    catch (e) { toast.error(e.message); }
  }

  const input = "input";
  return (
    <div className="fixed inset-0 z-[100] flex items-start sm:items-center justify-center bg-black/50 p-4 overflow-y-auto" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form onSubmit={save} role="dialog" aria-modal="true" aria-labelledby="license-editor-title"
        className="bg-surface border border-border rounded-lg shadow-xl max-w-2xl w-full p-5 space-y-4 my-8">
        <h2 id="license-editor-title" className="text-lg font-semibold text-fg">{isNew ? "Add license" : "Edit license"}</h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Name" className="sm:col-span-2">
            <input className={input} value={form.name} onChange={set("name")} required maxLength={200} placeholder="Microsoft 365 Business Premium" autoFocus />
          </Field>
          <Field label="Software in inventory" className="sm:col-span-2"
            hint="Link it to a title from Inventory → Software to count seats in use from installs. Leave empty if it isn't discovered software.">
            <input className={input} value={form.software_key} onChange={set("software_key")} list="license-title-options" placeholder="Start typing a software name…" />
            <datalist id="license-title-options">
              {titles.map((t) => <option key={t.key} value={t.key}>{`${t.name} — ${t.installs} device${t.installs === 1 ? "" : "s"}`}</option>)}
            </datalist>
          </Field>
          <Field label="Vendor"><input className={input} value={form.vendor} onChange={set("vendor")} maxLength={200} /></Field>
          <Field label="Type">
            <select className={input} value={form.license_type} onChange={set("license_type")}>
              {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
          <Field label="Seats" hint="Blank = unlimited.">
            <input className={input} type="number" min="0" step="1" value={form.seats} onChange={set("seats")} />
          </Field>
          <Field label="For company" hint="Only that company's devices count toward seats.">
            <select className={input} value={form.company_id} onChange={set("company_id")}>
              <option value="">Whole organization</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Purchased"><input className={input} type="date" value={form.purchase_date} onChange={set("purchase_date")} /></Field>
          <Field label="Renews / expires"><input className={input} type="date" value={form.renewal_date} onChange={set("renewal_date")} /></Field>
          <label className="flex items-center gap-2 text-sm text-fg sm:col-span-2">
            <input type="checkbox" checked={form.auto_renew} onChange={set("auto_renew")} className="h-4 w-4 rounded border-border-strong" />
            Renews automatically
          </label>
          <Field label="Cost">
            <input className={input} type="number" min="0" step="0.01" value={form.cost} onChange={set("cost")} />
          </Field>
          <Field label="Billed">
            <select className={input} value={form.cost_period} onChange={set("cost_period")}>
              <option value="">—</option>
              <option value="one_time">One-time</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          </Field>
          <Field label="Reference" hint="Order, contract or agreement number." className="sm:col-span-2">
            <input className={input} value={form.reference} onChange={set("reference")} maxLength={200} />
          </Field>
          <Field label="License key" className="sm:col-span-2"
            hint={isNew ? "Stored encrypted when encryption is on. Only Admins and Managers can view it." : "Leave empty to keep the stored key. Type a new one to replace it."}>
            <input className={`${input} font-mono`} value={form.license_key} onChange={set("license_key")} autoComplete="off" spellCheck={false}
              placeholder={!isNew && license.has_key ? "•••• stored ••••" : ""} />
            {!isNew && license.has_key && (
              <span className="mt-1 flex flex-wrap items-center gap-3 text-xs">
                {revealed == null
                  ? <button type="button" onClick={reveal} className="text-brand hover:underline">Reveal stored key</button>
                  : <code className="font-mono text-fg break-all select-all">{revealed || "(empty)"}</code>}
                <button type="button" onClick={clearKey} className="text-red-600 dark:text-red-400 hover:underline">Remove key</button>
                <span className="text-fg-dim">Viewing a key is recorded in the audit log.</span>
              </span>
            )}
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <textarea className={input} rows={3} value={form.notes} onChange={set("notes")} maxLength={10000} />
          </Field>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div className="flex gap-2">
            {!isNew && (
              <button type="button" className="btn btn-secondary btn-sm"
                onClick={async () => {
                  try { await api.patch(`/api/software-licenses/${license.id}`, { archived: !license.archived }); toast.success(license.archived ? "Restored" : "Archived"); onSaved(null); }
                  catch (e) { toast.error(e.message); }
                }}>
                {license.archived ? "Restore" : "Archive"}
              </button>
            )}
            {!isNew && canDelete && <button type="button" onClick={remove} className="btn btn-danger btn-sm">Delete</button>}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="btn btn-secondary btn-sm">Cancel</button>
            <button type="submit" disabled={saving} className="btn btn-primary btn-sm">{saving ? "Saving…" : isNew ? "Add license" : "Save"}</button>
          </div>
        </div>
      </form>
    </div>
  );
}

export default function SoftwareLicenses() {
  const { user } = useAuth();
  const canEdit = ["Admin", "Manager"].includes(user?.role);
  const [params, setParams] = useSearchParams();
  const status = params.get("status") || "active";
  const softwareKey = params.get("software") || "";
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [data, setData] = useState({ items: [], renewing_days: 30 });
  const [loading, setLoading] = useState(true);
  const [companies, setCompanies] = useState([]);
  const [editing, setEditing] = useState(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    api.get("/api/companies").then((r) => setCompanies(r || [])).catch(() => setCompanies([]));
  }, []);

  const listQs = useMemo(() => {
    const p = new URLSearchParams({ status });
    if (search) p.set("q", search);
    if (companyId) p.set("company_id", companyId);
    if (softwareKey) p.set("software_key", softwareKey);
    return p.toString();
  }, [status, search, companyId, softwareKey]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get(`/api/software-licenses?${listQs}`)
      .then((r) => { if (alive) setData(r); })
      .catch((e) => { if (alive) { setData({ items: [], renewing_days: 30 }); toast.error(e.message); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [listQs, reload]);

  function setParam(k, v) {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  }

  return (
    <div className="space-y-4">
      <InventoryTabs />
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-fg mb-1">Licenses</h1>
          <p className="text-sm text-fg-muted max-w-2xl">
            Subscriptions, licenses and contracts you own. Link one to software from the inventory to see seats in use.
          </p>
        </div>
        {canEdit && <button type="button" onClick={() => setEditing({})} className="btn btn-primary btn-sm">+ Add license</button>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex flex-wrap rounded-md bg-surface-2 border border-border p-0.5" role="group" aria-label="License status">
          {STATUSES.map((s) => (
            <button key={s.value} type="button" onClick={() => setParam("status", s.value === "active" ? "" : s.value)}
              aria-pressed={status === s.value}
              className={`text-xs px-2.5 py-1 rounded transition-colors ${status === s.value ? "bg-surface text-fg shadow-sm font-medium" : "text-fg-muted hover:text-fg"}`}>
              {s.label}
            </button>
          ))}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); }} className="flex items-center gap-2">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="name, vendor, reference…" aria-label="Search licenses"
            className="bg-surface-2 text-fg placeholder:text-fg-dim text-sm rounded-md border border-border px-3 py-1.5 w-56 focus:outline-none focus:ring-2 focus:ring-brand/40" />
          <button type="submit" className="btn btn-secondary btn-sm">Search</button>
        </form>
        <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} aria-label="Filter by company"
          className="bg-surface-2 text-fg text-xs rounded-md border border-border px-2 py-1.5 max-w-[12rem]">
          <option value="">All companies</option>
          <option value="none">Whole organization</option>
          {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {softwareKey && (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-brand/10 border border-brand/30 px-2 py-1 text-xs text-fg">
            Software: <b className="font-medium">{softwareKey}</b>
            <button type="button" onClick={() => setParam("software", "")} aria-label="Clear software filter" className="text-fg-muted hover:text-fg">✕</button>
          </span>
        )}
      </div>

      <section className="bg-surface border border-border rounded-lg overflow-hidden">
        {loading && !data.items.length ? (
          <div className="p-6 text-sm text-fg-dim">Loading…</div>
        ) : !data.items.length ? (
          <div className="p-6 text-sm text-fg-dim italic">
            {status === "active" && !search && !companyId && !softwareKey
              ? (canEdit ? "No licenses yet. Add one to start tracking seats and renewals." : "No licenses yet.")
              : "No licenses match these filters."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border text-sm">
              <thead className="bg-surface-2">
                <tr className="text-fg-muted text-xs uppercase tracking-wide">
                  <th className="px-3 py-2 text-left font-medium">License</th>
                  <th className="px-3 py-2 text-left font-medium">Software</th>
                  <th className="px-3 py-2 text-left font-medium">Company</th>
                  <th className="px-3 py-2 text-left font-medium">Seats used</th>
                  <th className="px-3 py-2 text-left font-medium">Renews</th>
                  <th className="px-3 py-2 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.items.map((l) => (
                  <tr key={l.id} className="hover:bg-surface-2/40 align-top">
                    <td className="px-3 py-2">
                      {canEdit
                        ? <button type="button" onClick={() => setEditing(l)} className="font-medium text-fg hover:text-brand text-left">{l.name}</button>
                        : <span className="font-medium text-fg">{l.name}</span>}
                      <div className="text-xs text-fg-muted">
                        {[l.vendor, TYPE_LABEL[l.license_type], l.reference].filter(Boolean).join(" · ")}
                        {l.has_key && <span className="ml-1.5" title="A license key is stored">🔑</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {l.software_key
                        ? (l.title_name
                          ? <Link to={`/inventory/software?q=${encodeURIComponent(l.title_name)}`} className="text-brand hover:underline">{l.title_name}</Link>
                          : <span className="text-amber-600 dark:text-amber-400" title="No device reports this software right now">{l.software_key} (not found)</span>)
                        : <span className="text-fg-dim">—</span>}
                    </td>
                    <td className="px-3 py-2 text-fg-muted">{l.company_name || "Whole organization"}</td>
                    <td className="px-3 py-2"><SeatsCell l={l} /></td>
                    <td className="px-3 py-2"><RenewalBadge l={l} renewingDays={data.renewing_days} />{l.auto_renew && l.renewal_date && <div className="text-[11px] text-fg-dim">auto-renews</div>}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-fg-muted whitespace-nowrap">{fmtCost(l)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && (
        <LicenseEditor
          license={editing}
          companies={companies}
          canDelete={user?.role === "Admin"}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); setReload((n) => n + 1); }}
        />
      )}
    </div>
  );
}
