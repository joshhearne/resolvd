import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import HybridTime from "../components/HybridTime";

const SOURCE_LABELS = {
  action1: "Action1",
};

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

export default function Inventory() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);

  async function load(searchQ = q) {
    setLoading(true);
    try {
      const r = await api.get(
        `/api/assets${searchQ ? `?q=${encodeURIComponent(searchQ)}` : ""}`
      );
      setItems(r.items || []);
      setTotal(r.total || 0);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(""); }, []);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    api.get(`/api/assets/${selected}`)
      .then(setDetail)
      .catch((e) => toast.error(e.message));
  }, [selected]);

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
        </form>
      </div>

      <div className="flex flex-col lg:flex-row gap-4 items-stretch">
        <section
          className={`${selected ? "hidden lg:block lg:w-2/3" : "block w-full"} bg-surface border border-border rounded-lg overflow-hidden`}
        >
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
                    <th className="px-3 py-2 text-left font-medium">Serial</th>
                    <th className="px-3 py-2 text-left font-medium">Org</th>
                    <th className="px-3 py-2 text-left font-medium">Source</th>
                    <th className="px-3 py-2 text-left font-medium">Last seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.map((a) => (
                    <tr
                      key={a.id}
                      onClick={() => setSelected(a.id)}
                      className={`cursor-pointer hover:bg-surface-2 ${selected === a.id ? "bg-brand/5" : ""}`}
                    >
                      <td className="px-3 py-2 font-medium text-fg">
                        {a.hostname || <span className="text-fg-dim italic">unnamed</span>}
                      </td>
                      <td className="px-3 py-2 text-fg-muted">
                        {a.os || "—"}{a.os_version ? ` ${a.os_version}` : ""}
                      </td>
                      <td className="px-3 py-2 text-fg-muted">{a.model || "—"}</td>
                      <td className="px-3 py-2 text-fg-muted font-mono text-xs">{a.serial || "—"}</td>
                      <td className="px-3 py-2 text-fg-muted">{a.organization || "—"}</td>
                      <td className="px-3 py-2 text-fg-muted">
                        {SOURCE_LABELS[a.source_system] || a.source_system}
                      </td>
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

        {selected && (
          <section className="flex-1 min-w-0 lg:max-w-md">
            <AssetDetail
              detail={detail}
              onBack={() => setSelected(null)}
            />
          </section>
        )}
      </div>
    </div>
  );
}

function AssetDetail({ detail, onBack }) {
  if (!detail) {
    return (
      <div className="bg-surface border border-border rounded-lg p-6 text-sm text-fg-dim">
        Loading…
      </div>
    );
  }
  const rows = [
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
    <div className="bg-surface border border-border rounded-lg p-4 space-y-3 sticky top-20">
      <button
        onClick={onBack}
        className="lg:hidden text-xs text-fg-muted hover:text-fg"
      >
        ← Back to list
      </button>
      <div>
        <h2 className="text-base font-semibold text-fg">
          {detail.hostname || <span className="text-fg-dim italic">unnamed</span>}
        </h2>
        <div className="text-xs text-fg-muted mt-0.5">
          Last seen{" "}
          {detail.last_seen_at ? <HybridTime value={detail.last_seen_at} /> : <span className="italic">never</span>}
        </div>
      </div>
      <dl className="grid grid-cols-[7rem_1fr] gap-y-1 text-xs">
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt className="text-fg-muted">{k}</dt>
            <dd className="text-fg font-mono break-all">{v || <span className="text-fg-dim">—</span>}</dd>
          </React.Fragment>
        ))}
      </dl>
      <CustomFieldsPanel assetId={detail.id} />
      {Array.isArray(detail.tickets) && detail.tickets.length > 0 && (
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
      <details className="text-xs">
        <summary className="cursor-pointer text-fg-muted hover:text-fg">Raw payload</summary>
        <pre className="mt-2 bg-surface-2 border border-border rounded p-2 overflow-x-auto text-[10px] font-mono max-h-80 overflow-y-auto">
          {JSON.stringify(detail.raw_data, null, 2)}
        </pre>
      </details>
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
