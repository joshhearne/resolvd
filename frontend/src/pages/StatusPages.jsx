import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import { useAuth } from "../context/AuthContext";
import MarkdownContent from "../components/MarkdownContent";
import MonitoredItemPicker from "../components/MonitoredItemPicker";
import StatusPageLayoutEditor, { toSections, fromSections, layoutProblem } from "../components/StatusPageLayoutEditor";
import { StateDot, stateInfo, fmtUptime, fmtDateTime, fmtDuration } from "../utils/itemState";

const REFRESH_MS = 60 * 1000;

// Status pages: curated views over monitored items (Uptime Kuma
// monitors etc.) with live state, alert-driven incidents and
// maintenance windows. Readable by every logged-in user; Admin /
// Manager build and edit pages here.
export default function StatusPages() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canCurate = ["Admin", "Manager"].includes(user?.role);
  const [pages, setPages] = useState(null);
  const [creating, setCreating] = useState(false);

  const loadPages = useCallback(async () => {
    try {
      const r = await api.get("/api/status-pages");
      setPages(Array.isArray(r) ? r : []);
    } catch (e) {
      toast.error(e.message);
      setPages([]);
    }
  }, []);

  useEffect(() => {
    loadPages();
    const t = setInterval(loadPages, REFRESH_MS);
    return () => clearInterval(t);
  }, [loadPages]);

  useEffect(() => {
    if (!slug && pages && pages.length) navigate(`/status/${pages[0].slug}`, { replace: true });
  }, [slug, pages, navigate]);

  async function createPage(name) {
    try {
      const p = await api.post("/api/status-pages", { name });
      setCreating(false);
      await loadPages();
      navigate(`/status/${p.slug}?edit=1`);
    } catch (e) { toast.error(e.message); }
  }

  const pageState = (p) => (p.down_count > 0 ? "down" : p.partial_count > 0 ? "partial"
    : p.maintenance_count > 0 ? "maintenance" : p.item_count ? "up" : "unknown");
  const railLink = (active) => `flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors ${active
    ? "bg-brand/10 text-brand font-medium"
    : "text-fg-muted hover:bg-surface-2 hover:text-fg"}`;

  return (
    <div className="flex h-full min-h-0">
      {/* Secondary rail (md+), same pattern as Admin's sub-nav. */}
      <aside className="hidden md:flex md:flex-col w-56 shrink-0 border-r border-border min-h-0">
        <div className="px-4 pt-6 pb-3 flex items-center justify-between gap-2">
          <h1 className="text-[11px] uppercase tracking-wider font-semibold text-fg-dim">Status pages</h1>
          {canCurate && (
            <button onClick={() => setCreating(true)} className="text-xs text-brand hover:underline">+ New</button>
          )}
        </div>
        <nav className="flex-1 min-h-0 overflow-y-auto px-2 pb-4 space-y-0.5" aria-label="Status pages">
          {creating && <RailNewPage onCancel={() => setCreating(false)} onCreate={createPage} />}
          {pages === null && <div className="px-3 text-sm text-fg-dim italic">Loading…</div>}
          {pages?.map((p) => (
            <Link key={p.id} to={`/status/${p.slug}`} className={railLink(p.slug === slug)}
              aria-current={p.slug === slug ? "page" : undefined}>
              <StateDot state={pageState(p)} />
              <span className="flex-1 min-w-0 truncate">{p.name}</span>
              {p.down_count > 0 && (
                <span className="text-[11px] font-semibold text-red-700 dark:text-red-300 shrink-0">{p.down_count}</span>
              )}
            </Link>
          ))}
        </nav>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {/* Phones / small tablets: a page picker in place of the rail. */}
        <div className="md:hidden sticky top-0 z-10 bg-bg border-b border-border px-4 pt-4 pb-3 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-xl font-semibold text-fg">Status</h1>
            {canCurate && (
              <button onClick={() => setCreating(true)} className="btn btn-secondary btn-sm">+ New page</button>
            )}
          </div>
          {pages && pages.length > 0 && (
            <select
              value={slug || ""}
              onChange={(e) => navigate(`/status/${e.target.value}`)}
              aria-label="Status page"
              className="w-full bg-surface border border-border rounded-md px-2 py-2 text-sm"
            >
              {pages.map((p) => (
                <option key={p.id} value={p.slug}>
                  {p.name}{p.down_count > 0 ? ` (${p.down_count} down)` : p.partial_count > 0 ? " (partial)" : ""}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-4 md:py-6">
          {/* Phones only; md+ adds the new page at the top of the rail. */}
          {creating && (
            <div className="md:hidden max-w-5xl mx-auto mb-4">
              <NewPageForm onCancel={() => setCreating(false)} onCreate={createPage} />
            </div>
          )}
          {pages === null ? (
            <div className="text-sm text-fg-dim italic md:hidden">Loading…</div>
          ) : pages.length === 0 ? (
            <div className="card p-6 text-sm text-fg-muted max-w-xl">
              No status pages yet.
              {canCurate
                ? " Create one with “New page”, then add monitored items from your integrations (Admin → Integrations)."
                : " An admin or manager can create one."}
            </div>
          ) : slug ? (
            <PageView key={slug} slug={slug} canCurate={canCurate} onChanged={loadPages} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

// New-page row at the top of the rail: the existing pages shift down
// beneath it, and saving opens the new page in the editor.
function RailNewPage({ onCancel, onCreate }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit(e) {
    e.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    try { await onCreate(name.trim()); } finally { setSaving(false); }
  }
  return (
    <form onSubmit={submit} className="px-1 pb-2 mb-1 border-b border-border space-y-1.5">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
        placeholder="New page name"
        aria-label="New status page name"
        className="w-full bg-surface-2 border border-brand/60 rounded-md px-2 py-1.5 text-sm"
      />
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm">Cancel</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!name.trim() || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function NewPageForm({ onCancel, onCreate }) {
  const [name, setName] = useState("");
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (name.trim()) onCreate(name.trim()); }}
      className="flex items-center gap-2 flex-wrap"
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Page name, e.g. External services"
        className="flex-1 min-w-[220px] bg-surface-2 border border-border rounded px-2 py-1.5 text-sm"
      />
      <button type="submit" className="btn btn-primary btn-sm" disabled={!name.trim()}>Create</button>
      <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm">Cancel</button>
    </form>
  );
}

function PageView({ slug, canCurate, onChanged }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(() => new URLSearchParams(window.location.search).get("edit") === "1");

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/api/status-pages/${encodeURIComponent(slug)}`));
      setError(null);
    } catch (e) { setError(e.message); }
  }, [slug]);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <div className="card p-4 text-sm text-red-600">{error}</div>;
  if (!data) return <div className="text-sm text-fg-dim italic">Loading…</div>;

  if (editing) {
    return (
      <PageEditor
        data={data}
        onDone={async (newSlug) => {
          setEditing(false);
          await onChanged();
          if (newSlug && newSlug !== slug) navigate(`/status/${newSlug}`, { replace: true });
          else { navigate(`/status/${slug}`, { replace: true }); load(); }
        }}
        onDeleted={async () => { await onChanged(); navigate("/status", { replace: true }); }}
      />
    );
  }

  return <PageBody data={data} canCurate={canCurate} onEdit={() => setEditing(true)} />;
}

function PageBody({ data, canCurate, onEdit }) {
  const { page, items, incidents, maintenance, history_days: historyDays } = data;
  // Component incidents read "Service › component".
  const nameById = useMemo(() => {
    const m = {};
    for (const i of items) {
      const name = i.display_name || i.label;
      m[i.item_id] = name;
      for (const c of i.components || []) m[c.item_id] = `${name} › ${c.label}`;
    }
    return m;
  }, [items]);
  const sections = useMemo(() => {
    const m = new Map();
    for (const it of items) {
      const key = it.section || "";
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(it);
    }
    return [...m.entries()];
  }, [items]);

  const down = items.filter((i) => i.state === "down").length;
  const partial = items.filter((i) => i.state === "partial").length;
  const degraded = items.filter((i) => i.state === "pending").length;
  const inMaint = items.filter((i) => i.state === "maintenance").length;
  const now = Date.now();
  const activeIncidents = incidents.filter((i) => i.state === "firing" || i.state === "acknowledged");
  const pastIncidents = incidents.filter((i) => i.state === "recovered");
  const activeMaint = maintenance.filter((w) => new Date(w.starts_at) <= now && new Date(w.ends_at) > now);
  const upcomingMaint = maintenance.filter((w) => new Date(w.starts_at) > now)
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  const pastMaint = maintenance.filter((w) => new Date(w.ends_at) <= now);

  let banner;
  if (!items.length) banner = { state: "unknown", text: "No items on this page yet" };
  else if (down) banner = { state: "down", text: `${down} ${down === 1 ? "service is" : "services are"} down` };
  else if (partial) banner = { state: "partial", text: `Partial outage on ${partial} ${partial === 1 ? "service" : "services"}` };
  else if (degraded) banner = { state: "pending", text: `${degraded} ${degraded === 1 ? "service is" : "services are"} degraded` };
  else if (inMaint) banner = { state: "maintenance", text: `All other systems operational · ${inMaint} in maintenance` };
  else banner = { state: "up", text: "All systems operational" };

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-fg">{page.name}</h2>
          {page.description && <p className="text-sm text-fg-muted mt-0.5">{page.description}</p>}
        </div>
        {canCurate && <button onClick={onEdit} className="btn btn-secondary btn-sm">Edit page</button>}
      </div>

      <div className={`card p-4 flex items-center gap-3 ${banner.state === "down" ? "border-red-400 dark:border-red-800" : ""}`}>
        <StateDot state={banner.state} className="w-3.5 h-3.5" />
        <span className={`font-medium ${stateInfo(banner.state).text}`}>{banner.text}</span>
      </div>

      {activeMaint.map((w) => <MaintenanceCard key={w.id} w={w} nameById={nameById} tone="active" />)}

      {activeIncidents.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-fg">Active incidents</h3>
          {activeIncidents.map((inc) => <IncidentRow key={inc.id} inc={inc} nameById={nameById} />)}
        </section>
      )}

      {sections.map(([section, rows]) => (
        <section key={section || "_"} className="card overflow-hidden">
          {section && (
            <div className="px-4 py-2 border-b border-border text-sm font-semibold text-fg bg-surface-2/60">{section}</div>
          )}
          <ul className="divide-y divide-border">
            {rows.map((it) => <ItemRow key={it.page_item_id} it={it} />)}
          </ul>
        </section>
      ))}

      {upcomingMaint.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-fg">Scheduled maintenance</h3>
          {upcomingMaint.map((w) => <MaintenanceCard key={w.id} w={w} nameById={nameById} tone="upcoming" />)}
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-fg">Past {historyDays} days</h3>
        {pastIncidents.length === 0 && pastMaint.length === 0 ? (
          <div className="text-sm text-fg-muted">No incidents or maintenance.</div>
        ) : (
          <>
            {pastIncidents.map((inc) => <IncidentRow key={inc.id} inc={inc} nameById={nameById} />)}
            {pastMaint.map((w) => <MaintenanceCard key={w.id} w={w} nameById={nameById} tone="past" />)}
          </>
        )}
      </section>
    </div>
  );
}

function ItemRow({ it }) {
  const [open, setOpen] = useState(false);
  const comps = it.components || [];
  const info = stateInfo(it.active ? it.state : "unknown");
  const since = it.state && it.state !== "up" && it.state_since && !comps.length ? ` · ${fmtDuration(it.state_since)}` : "";
  const troubled = comps.filter((c) => c.state === "down" || c.state === "pending");
  return (
    <li>
      <div className="px-4 py-3 flex items-center gap-3 flex-wrap sm:flex-nowrap">
        <StateDot state={it.active ? it.state : "unknown"} />
        <div className="min-w-0 flex-1">
          {comps.length ? (
            <button type="button" onClick={() => setOpen(!open)} className="text-sm text-fg text-left hover:underline">
              {open ? "▾" : "▸"} {it.display_name || it.label}
              <span className="text-xs text-fg-dim ml-1.5">{comps.length} components</span>
            </button>
          ) : (
            <div className="text-sm text-fg truncate">{it.display_name || it.label}</div>
          )}
          {troubled.length > 0 && !open && (
            <div className="text-xs text-red-700 dark:text-red-300 truncate">
              {troubled.map((c) => `${c.label} ${stateInfo(c.state).label.toLowerCase()}`).join(" · ")}
            </div>
          )}
          {!comps.length && it.detail && <div className="text-xs text-fg-dim font-mono truncate">{it.detail}</div>}
        </div>
        <div className="flex items-center gap-4 text-xs text-fg-muted w-full sm:w-auto pl-5 sm:pl-0">
          {it.response_ms != null && <span title="Last response time">{it.response_ms} ms</span>}
          {it.cert_days != null && (
            <span title="TLS certificate expires in" className={it.cert_days < 14 ? "text-amber-700 dark:text-amber-300" : ""}>
              cert {it.cert_days}d
            </span>
          )}
          <span title="Uptime, last 24 hours">24h {fmtUptime(it.uptime_1d)}</span>
          <span title="Uptime, last 30 days" className="hidden md:inline">30d {fmtUptime(it.uptime_30d)}</span>
          <span className={`font-medium whitespace-nowrap ${info.text}`}>{it.active ? info.label : "Not reported"}{since}</span>
        </div>
      </div>
      {open && comps.length > 0 && (
        <ul className="pb-2">
          {comps.map((c) => {
            const ci = stateInfo(c.state);
            return (
              <li key={c.item_id} className="pl-10 pr-4 py-1.5 flex items-center gap-3 text-sm">
                <StateDot state={c.state} className="w-2 h-2" />
                <span className="flex-1 min-w-0 truncate text-fg-muted">
                  {c.label}
                  {c.is_primary && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-fg-dim">primary</span>}
                </span>
                <span className="text-xs text-fg-muted hidden sm:inline">24h {fmtUptime(c.uptime_1d)}</span>
                <span className={`text-xs font-medium whitespace-nowrap ${ci.text}`}>
                  {ci.label}{c.state !== "up" && c.state_since ? ` · ${fmtDuration(c.state_since)}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

function IncidentRow({ inc, nameById }) {
  const active = inc.state !== "recovered";
  const inMaintenance = inc.suppression_reason?.startsWith("maintenance:");
  return (
    <div className={`card p-3 flex items-start gap-3 ${active ? "border-red-300 dark:border-red-900" : ""}`}>
      <StateDot state={active ? "down" : "up"} className="mt-1.5" />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-fg">{nameById[inc.item_id] || inc.title || "Incident"}</div>
        <div className="text-xs text-fg-muted mt-0.5">
          {active
            ? <>Started {fmtDateTime(inc.first_seen_at)} · ongoing {fmtDuration(inc.first_seen_at)}</>
            : <>{fmtDateTime(inc.first_seen_at)} → {fmtDateTime(inc.recovered_at)} · {fmtDuration(inc.first_seen_at, inc.recovered_at)}</>}
          {inMaintenance && <> · during maintenance, no ticket</>}
        </div>
      </div>
      {inc.ticket_ref ? (
        <Link to={`/tickets/${inc.ticket_id}`} className="text-xs text-brand hover:underline whitespace-nowrap">
          {inc.ticket_ref} · {inc.ticket_status}
        </Link>
      ) : active ? (
        <span className="text-xs text-fg-dim whitespace-nowrap">No ticket yet</span>
      ) : null}
    </div>
  );
}

function MaintenanceCard({ w, nameById, tone }) {
  const [open, setOpen] = useState(tone !== "past");
  const names = (w.item_ids || []).map((id) => nameById[id]).filter(Boolean);
  const toneCls = tone === "active"
    ? "border-sky-400 dark:border-sky-800 bg-sky-50/60 dark:bg-sky-950/20"
    : "";
  return (
    <div className={`card p-3 space-y-2 ${toneCls}`}>
      <button type="button" onClick={() => setOpen(!open)} className="w-full flex items-start gap-3 text-left">
        <StateDot state="maintenance" className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className="text-sm text-fg font-medium">
            {tone === "active" && <span className="text-sky-700 dark:text-sky-300">In progress · </span>}
            {w.title}
          </div>
          <div className="text-xs text-fg-muted mt-0.5">
            {fmtDateTime(w.starts_at)} → {fmtDateTime(w.ends_at)}
            {names.length > 0 && <> · {names.join(", ")}</>}
          </div>
        </div>
        {w.ticket_ref && <span className="text-xs text-fg-muted whitespace-nowrap">{w.ticket_ref}</span>}
      </button>
      {open && (w.description || w.work_notes) && (
        <div className="pl-5 space-y-2 text-sm">
          {w.description && <MarkdownContent>{w.description}</MarkdownContent>}
          {w.work_notes && (
            <div>
              <div className="text-xs font-semibold text-fg-muted uppercase tracking-wide mb-1">What was done</div>
              <MarkdownContent>{w.work_notes}</MarkdownContent>
            </div>
          )}
          <div className="text-xs text-fg-dim">
            Logged by {w.created_by_name || "unknown"} · <Link to="/maintenance" className="hover:underline">Maintenance log</Link>
          </div>
        </div>
      )}
    </div>
  );
}

function PageEditor({ data, onDone, onDeleted }) {
  const { page } = data;
  const [name, setName] = useState(page.name);
  const [description, setDescription] = useState(page.description || "");
  const [slug, setSlug] = useState(page.slug);
  const [all, setAll] = useState([]);
  const [sections, setSections] = useState(() => toSections(data.items.map((i) => ({
    item_id: i.item_id, label: i.label, section: i.section || "", display_name: i.display_name || "",
  }))));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get("/api/status-pages/_meta/items").then(setAll).catch((e) => toast.error(e.message));
  }, []);

  const selected = useMemo(() => new Set(sections.flatMap((s) => s.items.map((r) => r.item_id))), [sections]);
  const problem = layoutProblem(sections);

  // Newly ticked items land at the end of the last section.
  function toggle(id, checked) {
    if (checked) {
      const it = all.find((a) => a.id === id);
      const row = { item_id: id, label: it?.label, display_name: "" };
      setSections((prev) => prev.map((s, i) => (i === prev.length - 1 ? { ...s, items: [...s.items, row] } : s)));
    } else {
      setSections((prev) => prev.map((s) => ({ ...s, items: s.items.filter((r) => r.item_id !== id) })));
    }
  }

  async function save() {
    if (problem) { toast.error(problem); return; }
    setSaving(true);
    try {
      const p = await api.patch(`/api/status-pages/${page.id}`, {
        name, description, ...(slug !== page.slug ? { slug } : {}),
      });
      await api.put(`/api/status-pages/${page.id}/items`, {
        items: fromSections(sections),
      });
      toast.success("Status page saved");
      onDone(p.slug);
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  }

  async function remove() {
    if (!window.confirm(`Delete status page "${page.name}"? Items and history are kept.`)) return;
    try {
      await api.delete(`/api/status-pages/${page.id}`);
      toast.success("Status page deleted");
      onDeleted();
    } catch (e) { toast.error(e.message); }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="card p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="text-xs text-fg-muted flex flex-col gap-1">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)}
              className="bg-surface-2 border border-border rounded px-2 py-1.5 text-sm" />
          </label>
          <label className="text-xs text-fg-muted flex flex-col gap-1">
            URL slug
            <input value={slug} onChange={(e) => setSlug(e.target.value)}
              className="bg-surface-2 border border-border rounded px-2 py-1.5 text-sm font-mono" />
          </label>
        </div>
        <label className="text-xs text-fg-muted flex flex-col gap-1">
          Description (optional)
          <input value={description} onChange={(e) => setDescription(e.target.value)}
            className="bg-surface-2 border border-border rounded px-2 py-1.5 text-sm" />
        </label>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card p-4 space-y-2">
          <div className="text-sm font-medium text-fg">Add items</div>
          <MonitoredItemPicker items={all} selected={selected} onToggle={toggle} maxHeight="28rem" />
        </div>
        <div className="card p-4 space-y-2">
          <div className="text-sm font-medium text-fg">On this page</div>
          <p className="text-xs text-fg-muted">
            Drag the grips to reorder sections and items, or to move an item into another section.
            Display name overrides the monitor name.
          </p>
          <StatusPageLayoutEditor
            sections={sections}
            setSections={setSections}
            all={all}
            onRemoveItem={(id) => toggle(id, false)}
          />
          {problem && <div className="text-xs text-red-500">{problem}</div>}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <button onClick={remove} className="btn btn-ghost btn-sm text-red-600">Delete page</button>
        <div className="flex gap-2">
          <button onClick={() => onDone()} className="btn btn-ghost btn-sm">Cancel</button>
          <button onClick={save} disabled={saving || !name.trim() || !!problem} className="btn btn-primary btn-sm">
            {saving ? "Saving…" : "Save page"}
          </button>
        </div>
      </div>
    </div>
  );
}
