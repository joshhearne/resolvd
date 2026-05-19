import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../utils/api";
import HybridTime from "../components/HybridTime";

export default function Consumables() {
  const { id } = useParams();
  if (id) return <ConsumableDetailPage id={Number(id)} />;
  return <ConsumablesList />;
}

function ConsumablesList() {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [companies, setCompanies] = useState([]);

  async function load() {
    try {
      const qs = new URLSearchParams();
      if (q.trim()) qs.set("q", q.trim());
      if (showArchived) qs.set("include_archived", "1");
      setRows(await api.get(`/api/consumables${qs.toString() ? `?${qs}` : ""}`));
    } catch (e) {
      toast.error(e.message || "Failed");
      setRows([]);
    }
  }
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [q, showArchived]);

  useEffect(() => {
    api.get("/api/companies").then((r) => setCompanies(r || [])).catch(() => setCompanies([]));
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-fg">Consumables</h1>
          <p className="text-sm text-fg-muted">
            Supply inventory — toner, drums, batteries, anything that gets used up. Stock changes via the movement ledger so usage is auditable.
          </p>
        </div>
        <button onClick={() => setCreating((s) => !s)} className="btn btn-primary btn-sm">
          {creating ? "Cancel" : "+ New consumable"}
        </button>
      </div>

      {creating && (
        <NewConsumableForm
          companies={companies}
          onCreated={async (newId) => {
            setCreating(false);
            await load();
            if (newId) navigate(`/consumables/${newId}`);
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search part #, title, or category…"
          className="border border-border-strong rounded px-2 py-1 text-sm flex-1 min-w-[14rem]"
        />
        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Include archived
        </label>
      </div>

      {rows == null ? (
        <div className="text-sm text-fg-dim">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-fg-dim italic">No consumables match.</div>
      ) : (
        <div className="bg-surface border border-border rounded-lg overflow-x-auto">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="bg-surface-2 text-fg-dim text-xs">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Part #</th>
                <th className="px-3 py-2 text-left font-medium">Title</th>
                <th className="px-3 py-2 text-left font-medium">Category</th>
                <th className="px-3 py-2 text-left font-medium">Vendor</th>
                <th className="px-3 py-2 text-right font-medium">Stock</th>
                <th className="px-3 py-2 text-right font-medium">Low at</th>
                <th className="px-3 py-2 text-left font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => {
                const low = r.low_stock_threshold > 0 && r.current_stock <= r.low_stock_threshold;
                return (
                  <tr key={r.id} className={r.is_archived ? "opacity-60" : ""}>
                    <td className="px-3 py-1.5 font-mono">
                      <Link to={`/consumables/${r.id}`} className="text-brand hover:underline">
                        {r.part_no}
                      </Link>
                    </td>
                    <td className="px-3 py-1.5">{r.title || <span className="text-fg-dim">—</span>}</td>
                    <td className="px-3 py-1.5">{r.category || <span className="text-fg-dim">—</span>}</td>
                    <td className="px-3 py-1.5">{r.vendor_company_name || <span className="text-fg-dim">—</span>}</td>
                    <td className={`px-3 py-1.5 text-right font-mono ${low ? "text-red-600 font-semibold" : ""}`}>
                      {r.current_stock}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-fg-muted">
                      {r.low_stock_threshold || <span className="text-fg-dim">—</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {r.is_archived && <span className="text-[10px] uppercase tracking-wider text-fg-dim">archived</span>}
                      {low && !r.is_archived && <span className="text-[10px] uppercase tracking-wider text-red-600">low</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function NewConsumableForm({ companies, onCreated, onCancel }) {
  const [form, setForm] = useState({
    part_no: "",
    title: "",
    category: "",
    vendor_company_id: "",
    current_stock: 0,
    low_stock_threshold: 0,
    notes: "",
  });
  const [saving, setSaving] = useState(false);
  async function submit(e) {
    e.preventDefault();
    if (!form.part_no.trim()) { toast.error("Part # required"); return; }
    setSaving(true);
    try {
      const r = await api.post("/api/consumables", {
        ...form,
        vendor_company_id: form.vendor_company_id ? Number(form.vendor_company_id) : null,
        current_stock: Number(form.current_stock) || 0,
        low_stock_threshold: Number(form.low_stock_threshold) || 0,
      });
      toast.success("Created");
      onCreated?.(r.id);
    } catch (e) {
      toast.error(e.message || "Failed");
    } finally {
      setSaving(false);
    }
  }
  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }
  return (
    <form onSubmit={submit} className="bg-surface border border-border rounded-lg p-4 space-y-3">
      <div className="text-sm font-semibold text-fg">New consumable</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-fg-muted">
        <label className="flex flex-col gap-1">
          Part # *
          <input value={form.part_no} onChange={(e) => set("part_no", e.target.value)}
            className="bg-surface-2 border border-border rounded px-2 py-1" placeholder="106R03524" required />
        </label>
        <label className="flex flex-col gap-1">
          Title
          <input value={form.title} onChange={(e) => set("title", e.target.value)}
            className="bg-surface-2 border border-border rounded px-2 py-1" placeholder="Black toner, Xerox VL C605" />
        </label>
        <label className="flex flex-col gap-1">
          Category
          <input value={form.category} onChange={(e) => set("category", e.target.value)}
            className="bg-surface-2 border border-border rounded px-2 py-1" placeholder="Toner / Drum / Battery" />
        </label>
        <label className="flex flex-col gap-1">
          Vendor
          <select value={form.vendor_company_id} onChange={(e) => set("vendor_company_id", e.target.value)}
            className="bg-surface-2 border border-border rounded px-2 py-1">
            <option value="">— none —</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Starting stock
          <input type="number" min="0" value={form.current_stock}
            onChange={(e) => set("current_stock", e.target.value)}
            className="bg-surface-2 border border-border rounded px-2 py-1" />
        </label>
        <label className="flex flex-col gap-1">
          Low-stock threshold
          <input type="number" min="0" value={form.low_stock_threshold}
            onChange={(e) => set("low_stock_threshold", e.target.value)}
            className="bg-surface-2 border border-border rounded px-2 py-1" />
        </label>
      </div>
      <label className="text-xs text-fg-muted flex flex-col gap-1">
        Notes
        <textarea value={form.notes} onChange={(e) => set("notes", e.target.value)}
          rows={2} className="bg-surface-2 border border-border rounded px-2 py-1" />
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn btn-secondary btn-sm">Cancel</button>
        <button type="submit" disabled={saving} className="btn btn-primary btn-sm disabled:opacity-50">
          {saving ? "Saving…" : "Create"}
        </button>
      </div>
    </form>
  );
}

function ConsumableDetailPage({ id }) {
  const navigate = useNavigate();
  const [detail, setDetail] = useState(null);
  const [movements, setMovements] = useState([]);
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState({});
  const [companies, setCompanies] = useState([]);
  const [moveForm, setMoveForm] = useState({ delta: "", reason: "manual", note: "", ticket_id: "" });
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [d, m] = await Promise.all([
        api.get(`/api/consumables/${id}`),
        api.get(`/api/consumables/${id}/movements`),
      ]);
      setDetail(d);
      setMovements(m);
    } catch (e) {
      toast.error(e.message || "Failed");
      setDetail(null);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  useEffect(() => {
    api.get("/api/companies").then((r) => setCompanies(r || [])).catch(() => setCompanies([]));
  }, []);

  async function save() {
    setBusy(true);
    try {
      const payload = {};
      for (const [k, v] of Object.entries(edits)) {
        payload[k] = v === "" ? null : v;
      }
      await api.patch(`/api/consumables/${id}`, payload);
      toast.success("Saved");
      setEditing(false);
      setEdits({});
      await load();
    } catch (e) {
      toast.error(e.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function move(sign) {
    const d = Number(moveForm.delta);
    if (!Number.isInteger(d) || d <= 0) { toast.error("Quantity must be a positive integer"); return; }
    setBusy(true);
    try {
      await api.post(`/api/consumables/${id}/move`, {
        delta: sign * d,
        reason: moveForm.reason || null,
        note: moveForm.note || null,
        ticket_id: moveForm.ticket_id ? Number(moveForm.ticket_id) : null,
      });
      toast.success(sign > 0 ? "Stock in" : "Stock out");
      setMoveForm({ delta: "", reason: moveForm.reason, note: "", ticket_id: "" });
      await load();
    } catch (e) {
      toast.error(e.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function printLabel() {
    setBusy(true);
    try {
      await api.post(`/api/consumables/${id}/print-label`, {});
      toast.success("Label sent to printer");
    } catch (e) {
      toast.error(e.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  if (!detail) return <div className="text-sm text-fg-dim">Loading…</div>;

  const low = detail.low_stock_threshold > 0 && detail.current_stock <= detail.low_stock_threshold;
  const cur = (k) => (Object.prototype.hasOwnProperty.call(edits, k) ? edits[k] : (detail[k] ?? ""));
  function setField(k, v) { setEdits((p) => ({ ...p, [k]: v })); }

  return (
    <div className="space-y-4">
      <button onClick={() => navigate("/consumables")} className="text-xs text-fg-muted hover:text-fg">← Back to consumables</button>

      <div className="bg-surface border border-border rounded-lg p-4 space-y-3">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold text-fg">
              <span className="font-mono">{detail.part_no}</span>
              {detail.title && <span className="text-fg-muted font-normal"> — {detail.title}</span>}
            </h1>
            <div className="text-xs text-fg-dim mt-0.5">
              {detail.category && <>Category: {detail.category} · </>}
              {detail.vendor_company_name && <>Vendor: {detail.vendor_company_name} · </>}
              Updated <HybridTime value={detail.updated_at} />
              {detail.is_archived && <span className="ml-2 text-[10px] uppercase tracking-wider text-fg-dim">archived</span>}
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={printLabel} disabled={busy} className="btn btn-secondary btn-sm disabled:opacity-50">Print label</button>
            <button onClick={() => { setEditing((s) => !s); setEdits({}); }} className="btn btn-secondary btn-sm">
              {editing ? "Cancel" : "Edit"}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-surface-2 rounded border border-border p-3">
            <div className="text-[11px] uppercase tracking-wider text-fg-dim">On hand</div>
            <div className={`text-2xl font-semibold ${low ? "text-red-600" : "text-fg"}`}>{detail.current_stock}</div>
          </div>
          <div className="bg-surface-2 rounded border border-border p-3">
            <div className="text-[11px] uppercase tracking-wider text-fg-dim">Low at</div>
            <div className="text-2xl font-semibold text-fg-muted">{detail.low_stock_threshold || "—"}</div>
          </div>
        </div>

        {editing && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-fg-muted pt-2 border-t border-border">
            <label className="flex flex-col gap-1">Part #
              <input value={cur("part_no") || ""} onChange={(e) => setField("part_no", e.target.value)}
                className="bg-surface-2 border border-border rounded px-2 py-1" />
            </label>
            <label className="flex flex-col gap-1">Title
              <input value={cur("title") || ""} onChange={(e) => setField("title", e.target.value)}
                className="bg-surface-2 border border-border rounded px-2 py-1" />
            </label>
            <label className="flex flex-col gap-1">Category
              <input value={cur("category") || ""} onChange={(e) => setField("category", e.target.value)}
                className="bg-surface-2 border border-border rounded px-2 py-1" />
            </label>
            <label className="flex flex-col gap-1">Vendor
              <select value={cur("vendor_company_id") || ""} onChange={(e) => setField("vendor_company_id", e.target.value ? Number(e.target.value) : null)}
                className="bg-surface-2 border border-border rounded px-2 py-1">
                <option value="">— none —</option>
                {companies.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
              </select>
            </label>
            <label className="flex flex-col gap-1">Low-stock threshold
              <input type="number" min="0" value={cur("low_stock_threshold") || 0} onChange={(e) => setField("low_stock_threshold", Number(e.target.value))}
                className="bg-surface-2 border border-border rounded px-2 py-1" />
            </label>
            <label className="flex flex-col gap-1">Archived?
              <select value={cur("is_archived") ? "1" : "0"} onChange={(e) => setField("is_archived", e.target.value === "1")}
                className="bg-surface-2 border border-border rounded px-2 py-1">
                <option value="0">No</option><option value="1">Yes</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">Notes
              <textarea value={cur("notes") || ""} onChange={(e) => setField("notes", e.target.value)}
                rows={2} className="bg-surface-2 border border-border rounded px-2 py-1" />
            </label>
            <div className="sm:col-span-2 flex justify-end gap-2">
              <button onClick={() => { setEditing(false); setEdits({}); }} className="btn btn-secondary btn-sm">Cancel</button>
              <button onClick={save} disabled={busy || Object.keys(edits).length === 0} className="btn btn-primary btn-sm disabled:opacity-50">
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        )}

        {!editing && detail.notes && (
          <div className="text-xs text-fg-muted whitespace-pre-wrap border-t border-border pt-2">
            {detail.notes}
          </div>
        )}
      </div>

      <div className="bg-surface border border-border rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-semibold text-fg">Adjust stock</h2>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 text-xs text-fg-muted">
          <label className="flex flex-col gap-1">Quantity
            <input type="number" min="1" value={moveForm.delta}
              onChange={(e) => setMoveForm((p) => ({ ...p, delta: e.target.value }))}
              className="bg-surface-2 border border-border rounded px-2 py-1" />
          </label>
          <label className="flex flex-col gap-1">Reason
            <select value={moveForm.reason}
              onChange={(e) => setMoveForm((p) => ({ ...p, reason: e.target.value }))}
              className="bg-surface-2 border border-border rounded px-2 py-1">
              <option value="manual">manual adjust</option>
              <option value="received">received</option>
              <option value="delivered">delivered</option>
              <option value="returned">returned</option>
              <option value="damaged">damaged</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">Ticket id (optional)
            <input value={moveForm.ticket_id}
              onChange={(e) => setMoveForm((p) => ({ ...p, ticket_id: e.target.value }))}
              className="bg-surface-2 border border-border rounded px-2 py-1" />
          </label>
          <label className="flex flex-col gap-1">Note
            <input value={moveForm.note}
              onChange={(e) => setMoveForm((p) => ({ ...p, note: e.target.value }))}
              className="bg-surface-2 border border-border rounded px-2 py-1" />
          </label>
        </div>
        <div className="flex gap-2">
          <button onClick={() => move(1)} disabled={busy} className="btn btn-primary btn-sm disabled:opacity-50">+ Stock in</button>
          <button onClick={() => move(-1)} disabled={busy} className="btn btn-secondary btn-sm disabled:opacity-50">- Stock out</button>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-lg p-4 space-y-2">
        <h2 className="text-sm font-semibold text-fg">Ledger</h2>
        {movements.length === 0 ? (
          <div className="text-xs text-fg-dim italic">No movements yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border text-xs">
              <thead className="bg-surface-2 text-fg-dim">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">When</th>
                  <th className="px-3 py-1.5 text-right font-medium">Δ</th>
                  <th className="px-3 py-1.5 text-left font-medium">Reason</th>
                  <th className="px-3 py-1.5 text-left font-medium">By</th>
                  <th className="px-3 py-1.5 text-left font-medium">Ticket</th>
                  <th className="px-3 py-1.5 text-left font-medium">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {movements.map((m) => (
                  <tr key={m.id}>
                    <td className="px-3 py-1.5 whitespace-nowrap"><HybridTime value={m.at} /></td>
                    <td className={`px-3 py-1.5 text-right font-mono ${m.delta > 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}>
                      {m.delta > 0 ? `+${m.delta}` : m.delta}
                    </td>
                    <td className="px-3 py-1.5">{m.reason || <span className="text-fg-dim">—</span>}</td>
                    <td className="px-3 py-1.5 text-fg-muted">{m.by_user_name || "?"}</td>
                    <td className="px-3 py-1.5">
                      {m.ticket_ref ? (
                        <Link to={`/tickets/${m.ticket_id}`} className="text-brand hover:underline font-mono">
                          {m.ticket_ref}
                        </Link>
                      ) : <span className="text-fg-dim">—</span>}
                    </td>
                    <td className="px-3 py-1.5 text-fg-muted">{m.note || <span className="text-fg-dim">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
