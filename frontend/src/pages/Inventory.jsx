import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../utils/api";
import HybridTime from "../components/HybridTime";

const SOURCE_LABELS = {
  action1: "Action1",
};

const OFFLINE_DAYS = 14;

function isOffline(lastSeenAt) {
  if (!lastSeenAt) return true;
  const ageMs = Date.now() - new Date(lastSeenAt).getTime();
  return ageMs > OFFLINE_DAYS * 86400_000;
}

function PrintLabelButton({ assetId }) {
  const [busy, setBusy] = useState(false);
  async function print() {
    setBusy(true);
    try {
      await api.post(`/api/assets/${assetId}/print-label`);
      toast.success("Label sent to printer");
    } catch (e) {
      toast.error(e.message || "Print failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      onClick={print}
      disabled={busy}
      className="btn btn-secondary btn-sm disabled:opacity-50"
      title="Print an asset label on the configured Zebra"
    >
      {busy ? "Printing…" : "Print label"}
    </button>
  );
}

function PatchBadge({ crit, other }) {
  const c = Number(crit) || 0;
  const o = Number(other) || 0;
  if (c === 0 && o === 0 && crit == null && other == null) {
    return <span className="text-fg-dim text-xs">—</span>;
  }
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span
        className={`px-1.5 py-0.5 rounded font-mono ${
          c > 0
            ? "bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300"
            : "bg-surface-2 text-fg-muted"
        }`}
        title="Critical"
      >
        {c}
      </span>
      <span className="px-1.5 py-0.5 rounded font-mono bg-surface-2 text-fg-muted" title="Other">
        {o}
      </span>
    </div>
  );
}

function formatBytes(n) {
  if (n == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

// Two-mode component. /inventory => list. /inventory/:id => full-page
// detail. The two modes share asset-type loading and the search query
// but render disjoint shells — the side-panel layout is gone.
export default function Inventory() {
  const params = useParams();
  const navigate = useNavigate();
  const detailId = params.id ? Number(params.id) : null;

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [types, setTypes] = useState([]);
  const [offlineOnly, setOfflineOnly] = useState(false);

  useEffect(() => {
    api.get("/api/asset-types").then(setTypes).catch(() => setTypes([]));
  }, []);
  // List-mode data loaders. Declared above the detail-mode early
  // return so the hook count stays stable when the user toggles
  // between /inventory and /inventory/:id (Rules of Hooks).
  // Effects no-op in detail mode so we don't burn an extra API call.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (!detailId) load("", false); }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (!detailId) load(q, offlineOnly); }, [offlineOnly]);

  if (detailId) {
    return <AssetDetailPage id={detailId} types={types} onBack={() => navigate("/inventory")} />;
  }

  function buildQs(searchQ = q, offline = offlineOnly) {
    const parts = [];
    if (searchQ) parts.push(`q=${encodeURIComponent(searchQ)}`);
    if (offline) parts.push(`offline_days=${OFFLINE_DAYS}`);
    return parts.length ? `?${parts.join("&")}` : "";
  }

  async function load(searchQ = q, offline = offlineOnly) {
    setLoading(true);
    try {
      const r = await api.get(`/api/assets${buildQs(searchQ, offline)}`);
      setItems(r.items || []);
      setTotal(r.total || 0);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }

  function handleSearch(e) {
    e.preventDefault();
    load(q.trim());
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-fg mb-1">Inventory</h1>
          <p className="text-sm text-fg-muted">
            Managed machines aggregated from RMM integrations. Toggle{" "}
            <b>Feed inventory module</b> on a source in Admin → Alert sources
            to populate.
          </p>
        </div>
        <form onSubmit={handleSearch} className="flex items-center gap-2">
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="hostname, serial, model…"
            className="bg-surface-2 text-fg placeholder:text-fg-dim text-sm rounded-md border border-border px-3 py-1.5 w-64 focus:outline-none focus:ring-2 focus:ring-brand/40"
          />
          <button type="submit" className="btn btn-secondary btn-sm">Search</button>
          <label className="inline-flex items-center gap-1.5 text-xs text-fg-muted ml-2">
            <input
              type="checkbox"
              checked={offlineOnly}
              onChange={(e) => setOfflineOnly(e.target.checked)}
            />
            Offline only ({OFFLINE_DAYS}d+)
          </label>
          <a
            href={`/api/assets/export.csv${buildQs(q, offlineOnly)}`}
            className="btn btn-secondary btn-sm"
            title="Download current view as CSV"
          >
            Export CSV
          </a>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="btn btn-primary btn-sm"
          >
            + New asset
          </button>
        </form>
      </div>
      {creating && (
        <NewAssetForm
          types={types}
          onCancel={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            navigate(`/inventory/${id}`);
          }}
        />
      )}

      <div className="flex flex-col gap-4 items-stretch">
        <section className="bg-surface border border-border rounded-lg overflow-hidden">
          {loading ? (
            <div className="p-6 text-sm text-fg-dim">Loading…</div>
          ) : items.length === 0 ? (
            <div className="p-6 text-sm text-fg-dim italic">
              No assets yet. Enable inventory sync on an alert source.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-border text-sm">
                <thead className="bg-surface-2">
                  <tr className="text-fg-muted text-xs uppercase tracking-wide">
                    <th className="px-3 py-2 text-left font-medium">Hostname</th>
                    <th className="px-3 py-2 text-left font-medium">OS</th>
                    <th className="px-3 py-2 text-left font-medium">Model</th>
                    <th className="px-3 py-2 text-left font-medium">Org</th>
                    <th className="px-3 py-2 text-left font-medium" title="Missing updates (critical / other)">Patches</th>
                    <th className="px-3 py-2 text-left font-medium" title="Vulnerabilities (critical / other)">Vulns</th>
                    <th className="px-3 py-2 text-left font-medium">Last seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.map((a) => (
                    <tr
                      key={a.id}
                      onClick={() => navigate(`/inventory/${a.id}`)}
                      className="cursor-pointer hover:bg-surface-2"
                    >
                      <td className="px-3 py-2 font-medium text-fg">
                        <div className="flex items-center gap-1.5">
                          <Link
                            to={`/inventory/${a.id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="text-brand hover:underline"
                          >
                            {a.hostname || <span className="text-fg-dim italic">unnamed</span>}
                          </Link>
                          {isOffline(a.last_seen_at) && (
                            <span
                              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300"
                              title={`Last seen > ${OFFLINE_DAYS} days ago`}
                            >
                              offline
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-fg-muted">
                        {a.os || "—"}{a.os_version ? ` ${a.os_version}` : ""}
                      </td>
                      <td className="px-3 py-2 text-fg-muted">{a.model || "—"}</td>
                      <td className="px-3 py-2 text-fg-muted">{a.organization || "—"}</td>
                      <td className="px-3 py-2"><PatchBadge crit={a.missing_updates_critical} other={a.missing_updates_other} /></td>
                      <td className="px-3 py-2"><PatchBadge crit={a.vulnerabilities_critical} other={a.vulnerabilities_other} /></td>
                      <td className="px-3 py-2 text-fg-muted whitespace-nowrap">
                        {a.last_seen_at ? <HybridTime value={a.last_seen_at} /> : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="px-3 py-2 text-xs text-fg-dim border-t border-border">
            {items.length} of {total} shown
          </div>
        </section>
      </div>
    </div>
  );
}

// Full-page detail. Mounted at /inventory/:id. Replaces the old side
// panel — gives the security posture, software, tickets, vulnerabilities
// and raw payload room to breathe in a two-column layout.
function AssetDetailPage({ id, types, onBack }) {
  const [detail, setDetail] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [vulns, setVulns] = useState(null);

  async function loadDetail() {
    try {
      const d = await api.get(`/api/assets/${id}`);
      setDetail(d);
    } catch (e) {
      toast.error(e.message);
    }
  }
  async function loadSidebars() {
    try { setTickets(await api.get(`/api/assets/${id}/tickets`)); } catch { setTickets([]); }
    try { setVulns(await api.get(`/api/assets/${id}/vulnerabilities`)); } catch { setVulns(null); }
  }

  useEffect(() => {
    setDetail(null); setTickets([]); setVulns(null);
    loadDetail();
    loadSidebars();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!detail) {
    return (
      <div className="space-y-4">
        <button onClick={onBack} className="text-xs text-fg-muted hover:text-fg">← Back to inventory</button>
        <div className="bg-surface border border-border rounded-lg p-6 text-sm text-fg-dim">Loading…</div>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <button onClick={onBack} className="text-xs text-fg-muted hover:text-fg">← Back to inventory</button>
        <div className="flex items-center gap-3">
          <PrintLabelButton assetId={detail.id} />
          <div className="text-xs text-fg-dim">
            {detail.last_seen_at ? <>Last seen <HybridTime value={detail.last_seen_at} /></> : "Never seen"}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        <div className="lg:col-span-1 space-y-4">
          <AssetDetail
            detail={detail}
            types={types}
            onBack={onBack}
            onReload={async () => { await loadDetail(); await loadSidebars(); }}
            hideTicketsList   /* tickets get their own large panel on the right */
            hideRawPayload    /* raw payload also moves to the right column */
          />
        </div>
        <div className="lg:col-span-2 space-y-4">
          <TicketsPanel tickets={tickets} />
          <VulnerabilitiesPanel vulns={vulns} />
          <RawPayloadPanel raw={detail.raw_data} />
        </div>
      </div>
    </div>
  );
}

// Tickets across all projects this asset has appeared on. Admin /
// Manager see every row; everyone else only their project_members
// scope (server enforces).
function TicketsPanel({ tickets }) {
  return (
    <div className="bg-surface border border-border rounded-lg p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg">Linked tickets</h2>
        <span className="text-xs text-fg-muted">{tickets.length}</span>
      </div>
      {tickets.length === 0 ? (
        <div className="text-xs text-fg-dim italic">No tickets reference this asset yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-border text-xs">
            <thead className="bg-surface-2 text-fg-dim">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">Ref</th>
                <th className="px-3 py-1.5 text-left font-medium">Title</th>
                <th className="px-3 py-1.5 text-left font-medium">Project</th>
                <th className="px-3 py-1.5 text-left font-medium">Status</th>
                <th className="px-3 py-1.5 text-left font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {tickets.map((t) => (
                <tr key={t.id} className={t.resolved_at ? "opacity-60" : ""}>
                  <td className="px-3 py-1.5 font-mono">
                    <Link to={`/tickets/${t.id}`} className="text-brand hover:underline">{t.internal_ref}</Link>
                  </td>
                  <td className="px-3 py-1.5">{t.title || <span className="text-fg-dim italic">(no title)</span>}</td>
                  <td className="px-3 py-1.5 text-fg-muted">
                    {t.project_prefix ? <span className="font-mono">{t.project_prefix}</span> : "—"}
                    {t.project_name && <span className="ml-1 text-fg-dim">{t.project_name}</span>}
                  </td>
                  <td className="px-3 py-1.5 text-fg-muted">{t.internal_status}</td>
                  <td className="px-3 py-1.5 text-fg-muted whitespace-nowrap">
                    <HybridTime value={t.updated_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Vulnerabilities panel. Per-CVE items land here once Phase 5 ships
// asset_vulnerabilities; for now we render the summary counters the
// asset table already carries.
function VulnerabilitiesPanel({ vulns }) {
  if (!vulns) {
    return (
      <div className="bg-surface border border-border rounded-lg p-4 text-xs text-fg-dim">Vulnerabilities loading…</div>
    );
  }
  const s = vulns.summary || {};
  return (
    <div className="bg-surface border border-border rounded-lg p-4 space-y-2">
      <h2 className="text-sm font-semibold text-fg">Vulnerabilities</h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div className="bg-surface-2 rounded p-2">
          <div className="text-fg-muted">Vuln (critical)</div>
          <div className="text-lg font-semibold text-fg">{s.vulnerabilities_critical ?? "—"}</div>
        </div>
        <div className="bg-surface-2 rounded p-2">
          <div className="text-fg-muted">Vuln (other)</div>
          <div className="text-lg font-semibold text-fg">{s.vulnerabilities_other ?? "—"}</div>
        </div>
        <div className="bg-surface-2 rounded p-2">
          <div className="text-fg-muted">Patches (critical)</div>
          <div className="text-lg font-semibold text-fg">{s.missing_updates_critical ?? "—"}</div>
        </div>
        <div className="bg-surface-2 rounded p-2">
          <div className="text-fg-muted">Patches (other)</div>
          <div className="text-lg font-semibold text-fg">{s.missing_updates_other ?? "—"}</div>
        </div>
      </div>
      {vulns.items.length === 0 ? (
        <p className="text-xs text-fg-dim italic">
          Per-CVE details land here when an integration ships them
          (Phase 5). Today only counts + vendor-reported status are
          available.
        </p>
      ) : (
        <table className="min-w-full divide-y divide-border text-xs">
          <thead className="bg-surface-2 text-fg-dim">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">CVE</th>
              <th className="px-3 py-1.5 text-left font-medium">Severity</th>
              <th className="px-3 py-1.5 text-left font-medium">Title</th>
              <th className="px-3 py-1.5 text-left font-medium">First seen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {vulns.items.map((v) => (
              <tr key={v.id}>
                <td className="px-3 py-1.5 font-mono">{v.cve_id}</td>
                <td className="px-3 py-1.5">{v.severity}</td>
                <td className="px-3 py-1.5">{v.title}</td>
                <td className="px-3 py-1.5 text-fg-muted whitespace-nowrap">
                  <HybridTime value={v.first_seen_at} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RawPayloadPanel({ raw }) {
  return (
    <details className="bg-surface border border-border rounded-lg">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-fg hover:bg-surface-2">
        Raw payload
      </summary>
      <pre className="text-[11px] font-mono bg-surface-2 border-t border-border p-3 overflow-x-auto max-h-[60vh] overflow-y-auto whitespace-pre-wrap">
{JSON.stringify(raw, null, 2)}
      </pre>
    </details>
  );
}

function AssetDetail({ detail, types, onBack, onReload, hideTicketsList, hideRawPayload }) {
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEditing(false);
    setEdits({});
  }, [detail?.id]);

  const isManual = detail?.source_system === "manual";

  function setField(k, v) {
    setEdits((prev) => ({ ...prev, [k]: v }));
  }

  async function save() {
    setSaving(true);
    try {
      const payload = {};
      for (const [k, v] of Object.entries(edits)) {
        payload[k] = v === "" ? null : v;
      }
      await api.patch(`/api/assets/${detail.id}`, payload);
      toast.success("Saved");
      setEditing(false);
      setEdits({});
      if (onReload) await onReload();
    } catch (e) {
      toast.error(e.message || "Failed");
    } finally {
      setSaving(false);
    }
  }

  async function del() {
    if (!confirm("Delete this manual asset? Linked tickets will keep their history (asset reference cleared).")) return;
    try {
      await api.delete(`/api/assets/${detail.id}`);
      toast.success("Deleted");
      if (onReload) await onReload();
    } catch (e) {
      toast.error(e.message || "Failed");
    }
  }

  if (!detail) {
    return (
      <div className="bg-surface border border-border rounded-lg p-6 text-sm text-fg-dim">
        Loading…
      </div>
    );
  }
  const rows = [
    ["Type", detail.asset_type_label || null],
    ["Hostname", detail.hostname],
    ["Serial", detail.serial],
    ["MAC", detail.mac],
    ["IP", detail.ip_address],
    ["Manufacturer", detail.manufacturer],
    ["Model", detail.model],
    ["OS", `${detail.os || ""}${detail.os_version ? ` ${detail.os_version}` : ""}`.trim() || null],
    ["CPU", detail.cpu],
    ["RAM", detail.ram_bytes ? formatBytes(detail.ram_bytes) : null],
    ["Storage", detail.storage_bytes ? formatBytes(detail.storage_bytes) : null],
    ["Organization", detail.organization],
    ["Company", detail.company_name || null],
    ["Linked user", detail.linked_user_name ? `${detail.linked_user_name} (${detail.linked_user_email})` : null],
    ["Source", `${SOURCE_LABELS[detail.source_system] || detail.source_system} (${detail.source_external_id})`],
  ];
  return (
    <div className="bg-surface border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-fg">
            {detail.hostname || <span className="text-fg-dim italic">unnamed</span>}
          </h2>
          <div className="text-xs text-fg-muted mt-0.5">
            Last seen{" "}
            {detail.last_seen_at ? <HybridTime value={detail.last_seen_at} /> : <span className="italic">never</span>}
          </div>
        </div>
        <div className="flex gap-2">
          {!editing && (
            <button onClick={() => setEditing(true)} className="text-xs px-2 py-1 border border-border rounded hover:bg-surface-2">
              Edit
            </button>
          )}
          {editing && (
            <>
              <button onClick={save} disabled={saving} className="text-xs px-2 py-1 bg-brand text-white rounded disabled:opacity-50">
                {saving ? "Saving…" : "Save"}
              </button>
              <button onClick={() => { setEditing(false); setEdits({}); }} className="text-xs px-2 py-1 text-fg-muted hover:text-fg">
                Cancel
              </button>
            </>
          )}
          {isManual && !editing && (
            <button onClick={del} className="text-xs px-2 py-1 text-red-600 hover:underline">Delete</button>
          )}
        </div>
      </div>
      {editing ? (
        <AssetEditForm detail={detail} edits={edits} setField={setField} isManual={isManual} types={types} />
      ) : (
        <dl className="grid grid-cols-[7rem_1fr] gap-y-1 text-xs">
          {rows.map(([k, v]) => (
            <React.Fragment key={k}>
              <dt className="text-fg-muted">{k}</dt>
              <dd className="text-fg font-mono break-all">{v || <span className="text-fg-dim">—</span>}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      <SecurityPostureSection detail={detail} />
      <SoftwareSection detail={detail} onReload={onReload} />
      <CustomFieldsPanel assetId={detail.id} />
      {!hideTicketsList && Array.isArray(detail.tickets) && detail.tickets.length > 0 && (
        <div className="border-t border-border pt-3 space-y-2">
          <div className="text-xs font-semibold text-fg-muted uppercase tracking-wider">
            Tickets ({detail.tickets.length})
          </div>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {detail.tickets.map((t) => (
              <a key={t.id} href={`/tickets/${t.id}`}
                className="block text-xs hover:bg-surface-2 rounded px-2 py-1 -mx-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-fg-muted">{t.internal_ref}</span>
                  <span className="text-fg truncate">{t.title || "(no title)"}</span>
                </div>
                <div className="text-fg-dim text-[11px]">
                  {t.internal_status}{" · "}
                  <HybridTime value={t.updated_at} />
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
      {!hideRawPayload && (
        <details className="text-xs">
          <summary className="cursor-pointer text-fg-muted hover:text-fg">Raw payload</summary>
          <pre className="mt-2 bg-surface-2 border border-border rounded p-2 overflow-x-auto text-[10px] font-mono max-h-80 overflow-y-auto">
            {JSON.stringify(detail.raw_data, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

function CustomFieldsPanel({ assetId }) {
  const [rows, setRows] = useState(null);
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const r = await api.get(`/api/custom-field-defs/values/asset/${assetId}`);
      setRows(r);
      setEdits({});
    } catch (e) {
      setRows([]);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [assetId]);

  if (rows == null) return null;
  if (rows.length === 0) return null;

  function currentValue(d) {
    if (Object.prototype.hasOwnProperty.call(edits, d.id)) return edits[d.id];
    switch (d.type) {
      case 'number': return d.value_number != null ? String(d.value_number) : '';
      case 'date': return d.value_date ? String(d.value_date).slice(0, 10) : '';
      case 'bool': return !!d.value_bool;
      case 'select':
      case 'text':
      default: return d.value_text || '';
    }
  }

  function setEdit(id, val) {
    setEdits((prev) => ({ ...prev, [id]: val }));
  }

  const dirty = Object.keys(edits).length > 0;

  async function save() {
    setSaving(true);
    try {
      const items = Object.entries(edits).map(([id, value]) => ({ def_id: Number(id), value }));
      await api.put(`/api/custom-field-defs/values/asset/${assetId}`, items);
      toast.success("Saved");
      await load();
    } catch (e) {
      toast.error(e.message || "Failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-t border-border pt-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-fg-muted uppercase tracking-wider">Custom fields</div>
        {dirty && (
          <button onClick={save} disabled={saving}
            className="text-xs px-2 py-0.5 bg-brand text-white rounded disabled:opacity-50">
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </div>
      <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5 text-xs items-center">
        {rows.map((d) => {
          const v = currentValue(d);
          let input;
          if (d.type === "bool") {
            input = (
              <input type="checkbox" checked={!!v} onChange={(e) => setEdit(d.id, e.target.checked)} />
            );
          } else if (d.type === "select") {
            input = (
              <select value={v} onChange={(e) => setEdit(d.id, e.target.value)}
                className="border border-border-strong rounded px-2 py-1 text-xs w-full">
                <option value="">—</option>
                {(d.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            );
          } else if (d.type === "date") {
            input = (
              <input type="date" value={v} onChange={(e) => setEdit(d.id, e.target.value)}
                className="border border-border-strong rounded px-2 py-1 text-xs font-mono" />
            );
          } else if (d.type === "number") {
            input = (
              <input type="number" value={v} onChange={(e) => setEdit(d.id, e.target.value)}
                className="border border-border-strong rounded px-2 py-1 text-xs font-mono w-full" />
            );
          } else {
            input = (
              <input value={v} onChange={(e) => setEdit(d.id, e.target.value)}
                className="border border-border-strong rounded px-2 py-1 text-xs w-full" />
            );
          }
          return (
            <React.Fragment key={d.id}>
              <dt className="text-fg-muted" title={d.help_text || ""}>
                {d.label}{d.required ? <span className="text-red-500 ml-0.5">*</span> : null}
              </dt>
              <dd>{input}</dd>
            </React.Fragment>
          );
        })}
      </dl>
    </div>
  );
}

const FIELD_LABELS = {
  hostname: "Hostname",
  serial: "Serial",
  mac: "MAC",
  ip_address: "IP",
  manufacturer: "Manufacturer",
  model: "Model",
  os: "OS",
  os_version: "OS version",
  cpu: "CPU",
  ram_bytes: "RAM (bytes)",
  storage_bytes: "Storage (bytes)",
  organization: "Organization",
};

function AssetEditForm({ detail, edits, setField, isManual, types }) {
  const cur = (k) => (Object.prototype.hasOwnProperty.call(edits, k) ? edits[k] : (detail[k] ?? ""));
  const typeId = Object.prototype.hasOwnProperty.call(edits, "asset_type_id")
    ? edits.asset_type_id
    : detail.asset_type_id;
  const activeType = types.find((t) => t.id === Number(typeId));
  const fieldList = activeType?.fields || [];

  // Type picker is always editable, even on RMM-managed assets — admin
  // owns classification regardless of source.
  const typePicker = (
    <>
      <dt className="text-fg-muted">Type</dt>
      <dd>
        <select
          value={typeId || ""}
          onChange={(e) => setField("asset_type_id", e.target.value ? Number(e.target.value) : null)}
          className="w-full border border-border-strong rounded px-2 py-1 text-xs"
        >
          <option value="">— pick type —</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
      </dd>
    </>
  );

  if (!isManual) {
    return (
      <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5 text-xs items-center">
        {typePicker}
        <dt className="text-fg-muted">Note</dt>
        <dd className="text-fg-muted italic text-[11px]">
          Structural fields on RMM-managed assets sync from the source on
          every pull — only type, linked user, and company are mutable here.
          Edit hostname / serial / etc. in the source system or change the
          source's mapping under Admin → Alert sources.
        </dd>
      </dl>
    );
  }

  return (
    <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5 text-xs items-center">
      {typePicker}
      {fieldList.map((f) => (
        <React.Fragment key={f.builtin_key}>
          <dt className="text-fg-muted">
            {FIELD_LABELS[f.builtin_key] || f.builtin_key}
            {f.required ? <span className="text-red-500 ml-0.5">*</span> : null}
          </dt>
          <dd>
            <input
              value={cur(f.builtin_key) || ""}
              onChange={(e) => setField(f.builtin_key, e.target.value)}
              className="w-full border border-border-strong rounded px-2 py-1 text-xs"
            />
          </dd>
        </React.Fragment>
      ))}
      {fieldList.length === 0 && (
        <>
          <dt className="text-fg-muted italic">No fields</dt>
          <dd className="text-fg-muted italic text-[11px]">Pick a type to see fields.</dd>
        </>
      )}
    </dl>
  );
}

function NewAssetForm({ onCancel, onCreated, types }) {
  const [form, setForm] = useState({});
  const [typeId, setTypeId] = useState("");
  const [saving, setSaving] = useState(false);

  const activeType = types.find((t) => t.id === Number(typeId));
  const fieldList = activeType?.fields || [];

  async function submit(e) {
    e.preventDefault();
    // Floor: at least one identifying field (server enforces too).
    if (![form.hostname, form.serial, form.mac].some((v) => typeof v === "string" && v.trim())) {
      toast.error("At least one of hostname, serial, MAC required");
      return;
    }
    if (!typeId) {
      toast.error("Pick an asset type");
      return;
    }
    setSaving(true);
    try {
      const r = await api.post("/api/assets", { ...form, asset_type_id: Number(typeId) });
      toast.success("Asset created");
      onCreated(r.id);
    } catch (err) {
      toast.error(err.message || "Failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="bg-surface border border-border rounded-lg p-4 space-y-3"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg">New manual asset</h2>
        <button type="button" onClick={onCancel}
          className="text-xs text-fg-muted hover:text-fg">Cancel</button>
      </div>
      <p className="text-xs text-fg-muted">
        For assets not in any RMM (printer, deskphone, modem, NVR, etc.).
        Pick the type first — the form below adapts to the fields that
        type uses. At least one of hostname / serial / MAC is required
        (use whichever identifier makes sense for the device).
      </p>
      <label className="text-xs text-fg-muted flex flex-col gap-1 max-w-sm">
        Asset type <span className="text-red-500">*</span>
        <select
          value={typeId}
          onChange={(e) => setTypeId(e.target.value)}
          className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          required
        >
          <option value="">— pick type —</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
      </label>
      {fieldList.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {fieldList.map((f) => (
            <label key={f.builtin_key} className="text-xs text-fg-muted flex flex-col gap-1">
              {FIELD_LABELS[f.builtin_key] || f.builtin_key}
              {f.required ? <span className="text-red-500 ml-0.5">*</span> : null}
              <input
                value={form[f.builtin_key] || ""}
                onChange={(e) => setForm((fm) => ({ ...fm, [f.builtin_key]: e.target.value }))}
                className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
                required={f.required}
              />
            </label>
          ))}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel}
          className="btn btn-secondary btn-sm">Cancel</button>
        <button type="submit" disabled={saving || !typeId}
          className="btn btn-primary btn-sm disabled:opacity-50">
          {saving ? "Creating…" : "Create asset"}
        </button>
      </div>
    </form>
  );
}

function SecurityPostureSection({ detail }) {
  const muc = detail.missing_updates_critical;
  const muo = detail.missing_updates_other;
  const vc = detail.vulnerabilities_critical;
  const vo = detail.vulnerabilities_other;
  const has =
    muc != null || muo != null || vc != null || vo != null ||
    detail.update_status || detail.vulnerability_status ||
    detail.reboot_required != null;
  if (!has) return null;

  function StatusPill({ value }) {
    if (!value) return <span className="text-fg-dim">—</span>;
    const v = String(value).toUpperCase();
    const cls = v === 'SUCCESS'
      ? 'bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
      : v === 'WARNING'
        ? 'bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300'
        : v === 'ERROR' || v === 'CRITICAL'
          ? 'bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300'
          : 'bg-surface-2 text-fg-muted';
    return <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium tracking-wide ${cls}`}>{v}</span>;
  }

  return (
    <div className="border-t border-border pt-3 space-y-2">
      <div className="text-xs font-semibold text-fg-muted uppercase tracking-wider">
        Security posture
      </div>
      <dl className="grid grid-cols-[7rem_1fr] gap-y-1 text-xs items-center">
        <dt className="text-fg-muted">Updates</dt>
        <dd className="flex items-center gap-2">
          <PatchBadge crit={muc} other={muo} />
          <StatusPill value={detail.update_status} />
        </dd>
        <dt className="text-fg-muted">Vulns</dt>
        <dd className="flex items-center gap-2">
          <PatchBadge crit={vc} other={vo} />
          <StatusPill value={detail.vulnerability_status} />
        </dd>
        <dt className="text-fg-muted">Reboot</dt>
        <dd>
          {detail.reboot_required == null ? (
            <span className="text-fg-dim">—</span>
          ) : detail.reboot_required ? (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium tracking-wide bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300">REQUIRED</span>
          ) : (
            <span className="text-fg-muted">Not required</span>
          )}
        </dd>
      </dl>
    </div>
  );
}

const SOFTWARE_TYPES = new Set(['workstation', 'server', 'laptop']);

function SoftwareSection({ detail, onReload }) {
  const [items, setItems] = useState(null);
  const [q, setQ] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const eligible = SOFTWARE_TYPES.has(detail.asset_type_slug)
    && detail.source_alert_source_id != null;

  async function load(query = q) {
    try {
      const r = await api.get(
        `/api/assets/${detail.id}/software${query ? `?q=${encodeURIComponent(query)}` : ""}`
      );
      setItems(r.items || []);
    } catch (e) {
      setItems([]);
    }
  }

  useEffect(() => {
    if (expanded && items == null) load("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  async function sync() {
    setSyncing(true);
    try {
      const r = await api.post(`/api/assets/${detail.id}/sync-software`, {});
      toast.success(`${r.upserted} packages synced`);
      await load("");
      if (onReload) await onReload();
    } catch (e) {
      toast.error(e.message || "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  if (!eligible) return null;

  return (
    <div className="border-t border-border pt-3 space-y-2">
      <div className="flex items-center justify-between">
        <button
          onClick={() => setExpanded((x) => !x)}
          className="text-xs font-semibold text-fg-muted uppercase tracking-wider hover:text-fg flex items-center gap-1"
        >
          {expanded ? "▾" : "▸"} Software
          {detail.last_software_sync_at && (
            <span className="text-fg-dim normal-case tracking-normal font-normal ml-1">
              · synced <HybridTime value={detail.last_software_sync_at} />
            </span>
          )}
        </button>
        <button
          onClick={sync}
          disabled={syncing}
          className="text-xs px-2 py-1 border border-border rounded hover:bg-surface-2 disabled:opacity-50"
        >
          {syncing ? "Syncing…" : detail.last_software_sync_at ? "Re-sync" : "Sync now"}
        </button>
      </div>
      {expanded && (
        <>
          <input
            type="text"
            value={q}
            onChange={(e) => { setQ(e.target.value); load(e.target.value); }}
            placeholder="filter by name / vendor…"
            className="w-full bg-surface-2 border border-border rounded px-2 py-1 text-xs"
          />
          {items == null ? (
            <div className="text-xs text-fg-dim">Loading…</div>
          ) : items.length === 0 ? (
            <div className="text-xs text-fg-dim italic">
              {detail.last_software_sync_at ? "No matches." : "No software synced yet — click Sync now."}
            </div>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto border border-border rounded">
              <table className="w-full text-xs">
                <thead className="bg-surface-2 sticky top-0 text-fg-muted">
                  <tr>
                    <th className="text-left px-2 py-1 font-medium">Name</th>
                    <th className="text-left px-2 py-1 font-medium">Version</th>
                    <th className="text-left px-2 py-1 font-medium">Vendor</th>
                    <th className="text-left px-2 py-1 font-medium"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.map((s) => <SoftwareRow key={s.id} s={s} />)}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// One row per installed package. Surfaces canonical name above raw
// name when an alias matched (so reports tie back to a known
// product), and exposes the raw JSON payload via an inline toggle so
// admins can inspect what the upstream actually sent.
function SoftwareRow({ s }) {
  const [open, setOpen] = useState(false);
  const display = s.canonical_name || s.name;
  const aliased = !!s.canonical_name && s.canonical_name !== s.name;
  return (
    <>
      <tr>
        <td className="px-2 py-1 text-fg break-all">
          <div className="font-medium">{display}</div>
          {aliased && (
            <div className="text-[10px] text-fg-dim font-mono">
              was: {s.name}
              {s.alias_pattern && (
                <span className="ml-1 text-brand">[{s.alias_pattern}]</span>
              )}
            </div>
          )}
        </td>
        <td className="px-2 py-1 text-fg-muted font-mono">{s.version || "—"}</td>
        <td className="px-2 py-1 text-fg-muted">{s.canonical_vendor || s.vendor || "—"}</td>
        <td className="px-2 py-1 text-right">
          <button
            type="button"
            onClick={() => setOpen((x) => !x)}
            className="text-[10px] text-fg-dim hover:text-fg"
          >
            {open ? "hide raw" : "raw"}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4} className="px-2 py-1 bg-surface-2/40">
            <pre className="text-[10px] font-mono whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto">
{JSON.stringify(s.raw || {}, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
