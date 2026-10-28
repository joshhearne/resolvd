import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import { behaviorLabel } from "./BillingAdmin";

// Customer company → Billing tab. A contract puts the customer on a bill
// type (how their time is priced) and a rate card, for a term. The
// contract in force on the day time is logged prices that time. The
// external reference (a Xero contact / QuickBooks customer id, a contract
// number…) rides along on exports for an accounting system.

const EMPTY = {
  name: "", billing_type_id: "", rate_card_id: "", starts_on: new Date().toISOString().slice(0, 10),
  ends_on: "", block_hours: "", block_period: "term", external_ref: "", notes: "", active: true,
};

function fmtHours(minutes) {
  return `${(Math.round(((Number(minutes) || 0) / 60) * 100) / 100).toString()} h`;
}

function ContractForm({ initial, types, cards, onSave, onCancel }) {
  const [f, setF] = useState(initial);
  const type = types.find((t) => String(t.id) === String(f.billing_type_id));
  const block = type?.behavior === "prepaid_block";
  const set = (patch) => setF((x) => ({ ...x, ...patch }));

  function submit(e) {
    e.preventDefault();
    onSave({
      ...f,
      billing_type_id: f.billing_type_id ? Number(f.billing_type_id) : null,
      rate_card_id: f.rate_card_id ? Number(f.rate_card_id) : null,
      ends_on: f.ends_on || null,
      block_hours: block ? f.block_hours : null,
    });
  }

  return (
    <form onSubmit={submit} className="border border-border rounded p-3 space-y-3 bg-surface-2/40">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Name
          <input value={f.name} onChange={(e) => set({ name: e.target.value })} className="input py-1 text-sm" placeholder="e.g. 2026 managed services" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Bill type
          <select value={f.billing_type_id} onChange={(e) => set({ billing_type_id: e.target.value })} className="input py-1 text-sm">
            <option value="">Choose…</option>
            {types.filter((t) => t.active || String(t.id) === String(initial.billing_type_id)).map((t) => (
              <option key={t.id} value={t.id}>{t.name} — {behaviorLabel(t.behavior)}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Rate card
          <select value={f.rate_card_id ?? ""} onChange={(e) => set({ rate_card_id: e.target.value })} className="input py-1 text-sm">
            <option value="">Default card</option>
            {cards.filter((c) => c.active || String(c.id) === String(initial.rate_card_id)).map((c) => (
              <option key={c.id} value={c.id}>{c.name} ({Number(c.hourly_rate).toFixed(2)}/h)</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          External reference
          <input value={f.external_ref || ""} onChange={(e) => set({ external_ref: e.target.value })} className="input py-1 text-sm font-mono" placeholder="Accounting contact / contract id" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Starts
          <input type="date" value={f.starts_on} onChange={(e) => set({ starts_on: e.target.value })} className="input py-1 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Ends <span className="text-fg-dim">(blank = open-ended)</span>
          <input type="date" value={f.ends_on || ""} onChange={(e) => set({ ends_on: e.target.value })} className="input py-1 text-sm" />
        </label>
        {block && (
          <>
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              Block hours
              <input type="number" min="0" step="0.25" value={f.block_hours ?? ""} onChange={(e) => set({ block_hours: e.target.value })} className="input py-1 text-sm" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              Block resets
              <select value={f.block_period} onChange={(e) => set({ block_period: e.target.value })} className="input py-1 text-sm">
                <option value="term">Never — one block for the whole term</option>
                <option value="monthly">Every month</option>
              </select>
            </label>
          </>
        )}
        <label className="flex flex-col gap-1 text-xs text-fg-muted sm:col-span-2">
          Notes
          <textarea value={f.notes || ""} onChange={(e) => set({ notes: e.target.value })} rows={2} className="input py-1 text-sm" />
        </label>
      </div>
      <div className="flex items-center justify-between gap-2">
        <label className="inline-flex items-center gap-1 text-xs">
          <input type="checkbox" checked={f.active} onChange={(e) => set({ active: e.target.checked })} />
          active
        </label>
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} className="btn btn-sm btn-secondary">Cancel</button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={!f.name.trim() || !f.billing_type_id}>Save contract</button>
        </div>
      </div>
    </form>
  );
}

export default function CompanyContracts({ company }) {
  const [contracts, setContracts] = useState(null);
  const [types, setTypes] = useState([]);
  const [cards, setCards] = useState([]);
  const [editing, setEditing] = useState(null); // 'new' | contract id

  const load = () =>
    api.get(`/api/billing/companies/${company.id}/contracts`).then(setContracts).catch((e) => toast.error(e.message));
  useEffect(() => {
    load();
    api.get("/api/billing/types").then(setTypes).catch(() => {});
    api.get("/api/billing/rate-cards").then(setCards).catch(() => {});
  }, [company.id]);

  async function save(body) {
    try {
      if (editing === "new") await api.post(`/api/billing/companies/${company.id}/contracts`, body);
      else await api.patch(`/api/billing/companies/${company.id}/contracts/${editing}`, body);
      setEditing(null);
      load();
      toast.success("Contract saved");
    } catch (e) { toast.error(e.message); }
  }
  async function remove(c) {
    if (!window.confirm(`Delete contract "${c.name}"? Time already logged re-prices under whatever contract is left.`)) return;
    try { await api.delete(`/api/billing/companies/${company.id}/contracts/${c.id}`); load(); }
    catch (e) { toast.error(e.message); }
  }

  const today = new Date().toISOString().slice(0, 10);
  const inForce = (contracts || []).find((c) => c.active && c.starts_on.slice(0, 10) <= today && (!c.ends_on || c.ends_on.slice(0, 10) >= today));

  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-muted">
        How this customer's time is billed. Tickets bill to this customer
        when their project is linked to it (Projects tab), or when a ticket
        is pointed here directly. Time without a contract bills hourly at the
        default rate card.
      </p>
      {types.length === 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          No bill types yet — add them under Admin → Time tracking → Bill types.
        </p>
      )}
      {contracts === null ? (
        <p className="text-sm text-fg-muted">Loading…</p>
      ) : (
        <ul className="space-y-2">
          {contracts.length === 0 && <li className="text-sm text-fg-dim">No contracts yet.</li>}
          {contracts.map((c) => editing === c.id ? (
            <li key={c.id}>
              <ContractForm
                initial={{
                  ...EMPTY, ...c,
                  starts_on: c.starts_on.slice(0, 10), ends_on: c.ends_on ? c.ends_on.slice(0, 10) : "",
                  rate_card_id: c.rate_card_id ?? "", block_hours: c.block_hours ?? "",
                }}
                types={types} cards={cards} onSave={save} onCancel={() => setEditing(null)}
              />
            </li>
          ) : (
            <li key={c.id} className={`border border-border rounded p-3 text-sm ${c.active ? "" : "opacity-60"}`}>
              <div className="flex flex-wrap items-center gap-2">
                <b className="text-fg">{c.name}</b>
                {inForce?.id === c.id && <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">In force</span>}
                <span className="text-xs text-fg-muted">
                  {c.billing_type_name === behaviorLabel(c.behavior)
                    ? c.billing_type_name
                    : `${c.billing_type_name} · ${behaviorLabel(c.behavior)}`}
                </span>
                <span className="ml-auto flex gap-3 text-xs">
                  <button onClick={() => setEditing(c.id)} className="text-brand hover:underline">edit</button>
                  <button onClick={() => remove(c)} className="text-fg-muted hover:text-red-600">delete</button>
                </span>
              </div>
              <div className="text-xs text-fg-muted mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                <span>{c.starts_on.slice(0, 10)} → {c.ends_on ? c.ends_on.slice(0, 10) : "open-ended"}</span>
                <span>Rate card: {c.rate_card_name || "default"}</span>
                {c.external_code && <span>Code: <span className="font-mono">{c.external_code}</span></span>}
                {c.external_ref && <span>Ref: <span className="font-mono">{c.external_ref}</span></span>}
              </div>
              {c.block_usage && (
                <div className="mt-2">
                  <div className="flex justify-between text-xs text-fg-muted">
                    <span>
                      Block {c.block_period === "monthly" ? `this month (${c.block_usage.period})` : "for the term"}
                    </span>
                    <span className="tabular-nums">
                      {c.block_usage.level === "exhausted" && <b className="text-red-600 dark:text-red-400 mr-1">Used up ·</b>}
                      {c.block_usage.level === "threshold" && <b className="text-amber-600 dark:text-amber-400 mr-1">Nearly used ·</b>}
                      {fmtHours(c.block_usage.used_minutes)} of {fmtHours(c.block_usage.block_minutes)} used
                    </span>
                  </div>
                  <div className="h-1.5 rounded bg-surface-2 mt-1 overflow-hidden">
                    <div
                      className={`h-full ${
                        c.block_usage.level === "exhausted" ? "bg-red-500" : c.block_usage.level === "threshold" ? "bg-amber-500" : "bg-brand"
                      }`}
                      style={{ width: `${Math.min(100, (c.block_usage.used_minutes / Math.max(1, c.block_usage.block_minutes)) * 100)}%` }}
                    />
                  </div>
                </div>
              )}
              {c.notes && <p className="text-xs text-fg-muted mt-1 whitespace-pre-wrap">{c.notes}</p>}
            </li>
          ))}
        </ul>
      )}
      {editing === "new" ? (
        <ContractForm initial={EMPTY} types={types} cards={cards} onSave={save} onCancel={() => setEditing(null)} />
      ) : (
        <button onClick={() => setEditing("new")} className="btn btn-sm btn-secondary">+ New contract</button>
      )}
    </div>
  );
}
