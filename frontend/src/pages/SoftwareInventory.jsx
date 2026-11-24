import React, { Fragment, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import HybridTime from "../components/HybridTime";
import InventoryTabs from "../components/InventoryTabs";

// Software inventory: every title installed across the fleet, from the
// software the RMM integrations pull per asset. One row per title (grouped
// by the canonical name from Admin → Software aliases); expand a row for
// the devices it's on.

const PAGE = 100;

function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== "" && v != null) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

function SortHeader({ label, col, sort, dir, onSort, className = "" }) {
  const active = sort === col;
  return (
    <th className={`px-3 py-2 font-medium ${className}`} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => onSort(col)} className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-fg">
        {label}
        <span aria-hidden="true" className={active ? "text-fg" : "text-fg-dim/50"}>{active && dir === "desc" ? "▼" : "▲"}</span>
      </button>
    </th>
  );
}

function Installs({ titleKey, filters }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get(`/api/software/installs${qs({ key: titleKey, ...filters })}`)
      .then((r) => { if (alive) setRows(r.items || []); })
      .catch((e) => { if (alive) { setRows([]); toast.error(e.message); } });
    return () => { alive = false; };
  }, [titleKey, filters.company_id, filters.source]); // eslint-disable-line react-hooks/exhaustive-deps

  if (rows == null) return <div className="px-4 py-3 text-xs text-fg-dim">Loading devices…</div>;
  if (!rows.length) return <div className="px-4 py-3 text-xs text-fg-dim italic">No devices.</div>;
  return (
    <table className="min-w-full text-xs">
      <thead className="text-fg-muted">
        <tr>
          <th className="px-4 py-1.5 text-left font-medium">Device</th>
          <th className="px-3 py-1.5 text-left font-medium">Company</th>
          <th className="px-3 py-1.5 text-left font-medium">Version</th>
          <th className="px-3 py-1.5 text-left font-medium">Reported as</th>
          <th className="px-3 py-1.5 text-left font-medium">Installed</th>
          <th className="px-3 py-1.5 text-left font-medium">Device last seen</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((r) => (
          <tr key={`${r.asset_id}-${r.raw_name}-${r.version}`}>
            <td className="px-4 py-1.5">
              <Link to={`/inventory/${r.asset_id}`} className="text-brand hover:underline">{r.hostname || r.serial || `Asset #${r.asset_id}`}</Link>
              {r.source_system === "manual" && <span className="ml-1.5 text-fg-dim">manual</span>}
            </td>
            <td className="px-3 py-1.5 text-fg-muted">{r.company_name || "—"}</td>
            <td className="px-3 py-1.5 font-mono">{r.version || "—"}</td>
            <td className="px-3 py-1.5 text-fg-muted">{r.raw_name}</td>
            <td className="px-3 py-1.5 text-fg-muted">{r.install_date ? <HybridTime value={r.install_date} /> : "—"}</td>
            <td className="px-3 py-1.5 text-fg-muted">{r.last_seen_at ? <HybridTime value={r.last_seen_at} /> : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Seats licensed for a title vs devices it's on, linking to its licenses.
function Licensed({ t }) {
  if (!t.license_count) return <span className="text-fg-dim">—</span>;
  const over = !t.unlimited && t.licensed_seats != null && t.installs > t.licensed_seats;
  const label = t.unlimited ? "Unlimited" : `${t.licensed_seats ?? 0} seat${t.licensed_seats === 1 ? "" : "s"}`;
  return (
    <Link to={`/inventory/licenses?software=${encodeURIComponent(t.key)}`}
      className={`whitespace-nowrap hover:underline ${over ? "text-red-600 dark:text-red-400 font-medium" : "text-brand"}`}
      title={`${t.license_count} license${t.license_count === 1 ? "" : "s"}${over ? ` — ${t.installs - t.licensed_seats} more devices than seats` : ""}`}>
      {label}{over ? ` · over by ${t.installs - t.licensed_seats}` : ""}
    </Link>
  );
}

export default function SoftwareInventory() {
  // ?q= pre-fills the search (links from Licenses land on their title).
  const [params] = useSearchParams();
  const [q, setQ] = useState(() => params.get("q") || "");
  const [search, setSearch] = useState(() => params.get("q") || "");
  const [companyId, setCompanyId] = useState("");
  const [source, setSource] = useState("");
  const [sort, setSort] = useState("name");
  const [dir, setDir] = useState("asc");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [companies, setCompanies] = useState([]);
  const [open, setOpen] = useState(() => new Set());

  useEffect(() => {
    api.get("/api/companies").then((r) => setCompanies(r || [])).catch(() => setCompanies([]));
  }, []);

  const filters = { company_id: companyId, source };
  const listQs = qs({ q: search, ...filters, sort, dir });

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get(`/api/software${listQs}${listQs ? "&" : "?"}limit=${PAGE}&offset=${offset}`)
      .then((r) => { if (alive) setData(r); })
      .catch((e) => { if (alive) { setData({ items: [], total: 0 }); toast.error(e.message); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [listQs, offset]);

  // A new query starts from the top with everything collapsed.
  useEffect(() => { setOffset(0); setOpen(new Set()); }, [search, companyId, source, sort, dir]);

  function onSort(col) {
    if (sort === col) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSort(col); setDir(col === "name" ? "asc" : "desc"); }
  }
  function toggle(key) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const from = data.total ? offset + 1 : 0;
  const to = Math.min(offset + PAGE, data.total);

  return (
    <div className="space-y-4">
      <InventoryTabs />
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-fg mb-1">Software</h1>
          <p className="text-sm text-fg-muted max-w-2xl">
            Every title installed across your devices, from the software your RMM integrations pull.
            Names are grouped using <Link to="/admin/software-aliases" className="text-brand hover:underline">software aliases</Link>.
          </p>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); }} className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="name or vendor…"
            aria-label="Search software"
            className="bg-surface-2 text-fg placeholder:text-fg-dim text-sm rounded-md border border-border px-3 py-1.5 w-56 focus:outline-none focus:ring-2 focus:ring-brand/40"
          />
          <button type="submit" className="btn btn-secondary btn-sm">Search</button>
          <select
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
            aria-label="Filter by company"
            className="bg-surface-2 text-fg text-xs rounded-md border border-border px-2 py-1.5 max-w-[12rem]"
          >
            <option value="">All companies</option>
            <option value="none">No company</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            aria-label="Filter by source"
            className="bg-surface-2 text-fg text-xs rounded-md border border-border px-2 py-1.5"
          >
            <option value="">All devices</option>
            <option value="synced">Synced devices</option>
            <option value="manual">Manual devices</option>
          </select>
          <a href={`/api/software/export.csv${listQs}`} className="btn btn-secondary btn-sm" title="Download this view as CSV">
            Export CSV
          </a>
        </form>
      </div>

      <section className="bg-surface border border-border rounded-lg overflow-hidden">
        {loading && !data.items.length ? (
          <div className="p-6 text-sm text-fg-dim">Loading…</div>
        ) : !data.items.length ? (
          <div className="p-6 text-sm text-fg-dim italic">
            {search || companyId || source
              ? "No software matches these filters."
              : "No software yet. Software is pulled per device by RMM integrations with the Software feature on (Admin → Integrations)."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border text-sm">
              <thead className="bg-surface-2">
                <tr className="text-fg-muted text-xs">
                  <SortHeader label="Software" col="name" sort={sort} dir={dir} onSort={onSort} className="text-left" />
                  <th className="px-3 py-2 text-left font-medium uppercase tracking-wide">Vendor</th>
                  <SortHeader label="Devices" col="installs" sort={sort} dir={dir} onSort={onSort} className="text-right" />
                  <SortHeader label="Versions" col="versions" sort={sort} dir={dir} onSort={onSort} className="text-left" />
                  <th className="px-3 py-2 text-right font-medium uppercase tracking-wide">Companies</th>
                  <th className="px-3 py-2 text-left font-medium uppercase tracking-wide">Licensed</th>
                  <th className="px-3 py-2 text-left font-medium uppercase tracking-wide">Last reported</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.items.map((t) => {
                  const isOpen = open.has(t.key);
                  const versions = t.versions || [];
                  return (
                    <Fragment key={t.key}>
                      <tr className={isOpen ? "bg-surface-2/50" : "hover:bg-surface-2/40"}>
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            onClick={() => toggle(t.key)}
                            aria-expanded={isOpen}
                            className="inline-flex items-center gap-2 text-left text-fg hover:text-brand"
                          >
                            <span aria-hidden="true" className={`text-fg-dim text-xs transition-transform ${isOpen ? "rotate-90" : ""}`}>▶</span>
                            <span className="font-medium">{t.name}</span>
                          </button>
                        </td>
                        <td className="px-3 py-2 text-fg-muted">{t.vendor || "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{t.installs}</td>
                        <td className="px-3 py-2 text-fg-muted">
                          <span className="tabular-nums">{t.version_count}</span>
                          {versions.length > 0 && (
                            <span className="ml-2 font-mono text-xs text-fg-dim" title={versions.join(", ")}>
                              {versions.slice(0, 3).join(", ")}{versions.length > 3 ? ", …" : ""}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-fg-muted">{t.company_count}</td>
                        <td className="px-3 py-2"><Licensed t={t} /></td>
                        <td className="px-3 py-2 text-fg-muted">{t.last_seen_at ? <HybridTime value={t.last_seen_at} /> : "—"}</td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={7} className="bg-surface-2/30 p-0">
                            <Installs titleKey={t.key} filters={filters} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {data.total > 0 && (
          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-fg-muted">
            <span>{from}–{to} of {data.total} titles</span>
            <div className="flex gap-2">
              <button type="button" className="btn btn-secondary btn-sm" disabled={offset === 0 || loading} onClick={() => setOffset((o) => Math.max(0, o - PAGE))}>Previous</button>
              <button type="button" className="btn btn-secondary btn-sm" disabled={to >= data.total || loading} onClick={() => setOffset((o) => o + PAGE)}>Next</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
