import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// MSP billing setup cards for Admin → Time tracking: rate cards, bill
// types, and the utilisation report. Rendered only in MSP mode.

export function formatMoney(cents, currency = "USD") {
  const n = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

function fmtMinutes(m) {
  const t = Math.max(0, Math.round(Number(m) || 0));
  const h = Math.floor(t / 60);
  const r = t % 60;
  if (!h) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

export const BEHAVIORS = [
  { value: "hourly", label: "Hourly (time & materials)", help: "Billable time × the rate card." },
  { value: "prepaid_block", label: "Prepaid block", help: "Draws down a block of hours per contract term or month; the rest bills as overage." },
  { value: "covered", label: "Covered (managed / flat fee)", help: "Time is tracked and counted but bills at $0 — it's covered by the agreement." },
  { value: "non_billable", label: "Non-billable", help: "Nothing on this contract is billable." },
];
export const behaviorLabel = (v) => BEHAVIORS.find((b) => b.value === v)?.label || v;

export function MspOffNote() {
  return (
    <div className="bg-surface border border-dashed border-border rounded-lg p-4">
      <h3 className="text-sm font-semibold text-fg mb-1">Billing</h3>
      <p className="text-xs text-fg-muted">
        Billable hours, rate cards, bill types and contracts appear when MSP
        mode is on — turn it on from Admin → Companies (your internal company)
        or Admin → Branding.
      </p>
    </div>
  );
}

// --- Rate cards ---------------------------------------------------------

function RateRow({ card, rate, onChanged }) {
  async function remove() {
    try { await api.delete(`/api/billing/rate-cards/${card.id}/rates/${rate.id}`); onChanged(); }
    catch (e) { toast.error(e.message); }
  }
  const who = [rate.work_type_name, rate.user_name || rate.user_email].filter(Boolean).join(" · ");
  return (
    <li className="flex items-center gap-3 text-sm py-1">
      <span className="flex-1 text-fg">{who}</span>
      <span className="tabular-nums">{Number(rate.hourly_rate).toFixed(2)}/h</span>
      <button onClick={remove} className="text-xs text-fg-muted hover:text-red-600">remove</button>
    </li>
  );
}

function RateCardEditor({ card, workTypes, techs, onChanged }) {
  const [f, setF] = useState({
    name: card.name,
    hourly_rate: card.hourly_rate,
    after_hours_multiplier: card.after_hours_multiplier,
    weekend_multiplier: card.weekend_multiplier,
  });
  const [ov, setOv] = useState({ work_type_id: "", user_id: "", hourly_rate: "" });
  const dirty = ["name", "hourly_rate", "after_hours_multiplier", "weekend_multiplier"].some((k) => String(f[k]) !== String(card[k]));

  async function save() {
    try { await api.patch(`/api/billing/rate-cards/${card.id}`, f); toast.success("Saved"); onChanged(); }
    catch (e) { toast.error(e.message); }
  }
  async function patch(body) {
    try { await api.patch(`/api/billing/rate-cards/${card.id}`, body); onChanged(); }
    catch (e) { toast.error(e.message); }
  }
  async function remove() {
    if (!window.confirm(`Remove rate card "${card.name}"?`)) return;
    try {
      const r = await api.delete(`/api/billing/rate-cards/${card.id}`);
      if (r.retired) toast("A contract uses it, so it was retired instead of deleted.");
      onChanged();
    } catch (e) { toast.error(e.message); }
  }
  async function addOverride(e) {
    e.preventDefault();
    try {
      await api.put(`/api/billing/rate-cards/${card.id}/rates`, ov);
      setOv({ work_type_id: "", user_id: "", hourly_rate: "" });
      onChanged();
    } catch (err) { toast.error(err.message); }
  }

  return (
    <div className={`border border-border rounded p-3 space-y-3 ${card.active ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Name
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className="input py-1 w-44 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Base rate / hour
          <input type="number" min="0" step="0.01" value={f.hourly_rate} onChange={(e) => setF({ ...f, hourly_rate: e.target.value })} className="input py-1 w-28 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          After-hours ×
          <input type="number" min="0" step="0.05" value={f.after_hours_multiplier} onChange={(e) => setF({ ...f, after_hours_multiplier: e.target.value })} className="input py-1 w-20 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Weekend ×
          <input type="number" min="0" step="0.05" value={f.weekend_multiplier} onChange={(e) => setF({ ...f, weekend_multiplier: e.target.value })} className="input py-1 w-20 text-sm" />
        </label>
        {dirty && <button onClick={save} className="btn btn-sm btn-primary">Save</button>}
        <div className="ml-auto flex items-center gap-3 text-xs">
          {card.is_default ? (
            <span className="px-1.5 py-0.5 rounded bg-brand/15 text-brand">Default</span>
          ) : (
            card.active && <button onClick={() => patch({ is_default: true })} className="text-brand hover:underline">make default</button>
          )}
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" checked={card.active} onChange={() => patch({ active: !card.active })} />
            active
          </label>
          <button onClick={remove} className="text-fg-muted hover:text-red-600">remove</button>
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold text-fg-muted uppercase mb-1">Overrides</p>
        {card.rates.length ? (
          <ul className="divide-y divide-border">
            {card.rates.map((r) => <RateRow key={r.id} card={card} rate={r} onChanged={onChanged} />)}
          </ul>
        ) : (
          <p className="text-xs text-fg-dim">None — every entry bills at the base rate.</p>
        )}
        <form onSubmit={addOverride} className="flex flex-wrap items-center gap-2 mt-2 text-sm">
          <select value={ov.work_type_id} onChange={(e) => setOv({ ...ov, work_type_id: e.target.value })} className="input py-1 w-auto">
            <option value="">Any work type</option>
            {workTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select value={ov.user_id} onChange={(e) => setOv({ ...ov, user_id: e.target.value })} className="input py-1 w-auto">
            <option value="">Any tech</option>
            {techs.map((u) => <option key={u.id} value={u.id}>{u.display_name || u.email}</option>)}
          </select>
          <input
            type="number" min="0" step="0.01" placeholder="Rate / hour"
            value={ov.hourly_rate} onChange={(e) => setOv({ ...ov, hourly_rate: e.target.value })}
            className="input py-1 w-28"
          />
          <button type="submit" className="btn btn-sm btn-secondary" disabled={!ov.hourly_rate || (!ov.work_type_id && !ov.user_id)}>
            Add override
          </button>
        </form>
      </div>
    </div>
  );
}

export function RateCardsCard({ currency }) {
  const [cards, setCards] = useState(null);
  const [workTypes, setWorkTypes] = useState([]);
  const [techs, setTechs] = useState([]);
  const [name, setName] = useState("");
  const [rate, setRate] = useState("");

  const load = () => api.get("/api/billing/rate-cards").then(setCards).catch((e) => toast.error(e.message));
  useEffect(() => {
    load();
    api.get("/api/time-tracking/work-types").then(setWorkTypes).catch(() => {});
    api.get("/api/users")
      .then((us) => setTechs((us || []).filter((u) => ["Admin", "Manager", "Tech"].includes(u.role) && u.status !== "inactive")))
      .catch(() => {});
  }, []);

  async function add(e) {
    e.preventDefault();
    try {
      await api.post("/api/billing/rate-cards", { name: name.trim(), hourly_rate: rate });
      setName("");
      setRate("");
      load();
    } catch (err) { toast.error(err.message); }
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <h3 className="text-sm font-semibold text-fg mb-1">Rate cards</h3>
      <p className="text-xs text-fg-muted mb-3">
        What an hour of billable time costs, in {currency || "USD"}. A
        contract picks a card; customers without one use the default card.
        Overrides price a work type, a tech, or a tech doing a work type —
        the most specific match wins. Time that starts outside the ticket's
        business hours gets the after-hours multiplier; on a non-working day,
        the weekend multiplier.
      </p>
      {cards === null ? (
        <p className="text-sm text-fg-muted">Loading…</p>
      ) : (
        <div className="space-y-3 mb-3">
          {cards.length === 0 && <p className="text-sm text-fg-dim">No rate cards yet. The first one becomes the default.</p>}
          {cards.map((c) => (
            <RateCardEditor key={`${c.id}-${c.updated_at || ""}-${c.rates.length}`} card={c} workTypes={workTypes} techs={techs} onChanged={load} />
          ))}
        </div>
      )}
      <form onSubmit={add} className="flex flex-wrap items-center gap-2 text-sm">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New card, e.g. Standard" className="input py-1 w-48" />
        <input type="number" min="0" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="Rate / hour" className="input py-1 w-28" />
        <button type="submit" className="btn btn-sm btn-secondary" disabled={!name.trim() || rate === ""}>Add rate card</button>
      </form>
    </div>
  );
}

// --- Bill types -----------------------------------------------------------

export function BillingTypesCard() {
  const [types, setTypes] = useState(null);
  const [f, setF] = useState({ name: "", behavior: "hourly", external_code: "" });

  const load = () => api.get("/api/billing/types").then(setTypes).catch((e) => toast.error(e.message));
  useEffect(() => { load(); }, []);

  async function add(e) {
    e.preventDefault();
    try {
      await api.post("/api/billing/types", { ...f, name: f.name.trim(), sort_order: (types?.length || 0) * 10 });
      setF({ name: "", behavior: "hourly", external_code: "" });
      load();
    } catch (err) { toast.error(err.message); }
  }
  async function patch(t, body) {
    try { await api.patch(`/api/billing/types/${t.id}`, body); load(); }
    catch (err) { toast.error(err.message); }
  }
  async function remove(t) {
    if (!window.confirm(`Remove bill type "${t.name}"?`)) return;
    try {
      const r = await api.delete(`/api/billing/types/${t.id}`);
      if (r.retired) toast("A contract uses it, so it was retired instead of deleted.");
      load();
    } catch (err) { toast.error(err.message); }
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <h3 className="text-sm font-semibold text-fg mb-1">Bill types</h3>
      <p className="text-xs text-fg-muted mb-3">
        The kinds of agreement you can put a customer on. Each has a
        behaviour that decides how its time is priced, and an optional
        external code (an item or account code in Xero / QuickBooks) that
        rides along on exports for an accounting system to pick up.
      </p>
      <ul className="text-xs text-fg-muted mb-3 space-y-0.5">
        {BEHAVIORS.map((b) => <li key={b.value}><b className="text-fg">{b.label}</b> — {b.help}</li>)}
      </ul>
      {types === null ? (
        <p className="text-sm text-fg-muted">Loading…</p>
      ) : (
        <ul className="divide-y divide-border border border-border rounded mb-3">
          {types.length === 0 && <li className="px-3 py-2 text-sm text-fg-dim">No bill types yet.</li>}
          {types.map((t) => (
            <li key={t.id} className={`px-3 py-2 flex flex-wrap items-center gap-3 text-sm ${t.active ? "" : "opacity-60"}`}>
              <input
                defaultValue={t.name}
                onBlur={(e) => { const n = e.target.value.trim(); if (n && n !== t.name) patch(t, { name: n }); }}
                className="input py-1 w-44" aria-label="Bill type name"
              />
              <select value={t.behavior} onChange={(e) => patch(t, { behavior: e.target.value })} className="input py-1 w-auto">
                {BEHAVIORS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
              </select>
              <input
                defaultValue={t.external_code || ""}
                onBlur={(e) => { const c = e.target.value.trim(); if (c !== (t.external_code || "")) patch(t, { external_code: c }); }}
                placeholder="External code" className="input py-1 w-32 font-mono" aria-label="External code"
              />
              <label className="inline-flex items-center gap-1">
                <input type="checkbox" checked={t.active} onChange={() => patch(t, { active: !t.active })} />
                active
              </label>
              <button onClick={() => remove(t)} className="ml-auto text-xs text-fg-muted hover:text-red-600">remove</button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="flex flex-wrap items-center gap-2 text-sm">
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="New bill type, e.g. Managed services" className="input py-1 w-56" />
        <select value={f.behavior} onChange={(e) => setF({ ...f, behavior: e.target.value })} className="input py-1 w-auto">
          {BEHAVIORS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
        </select>
        <input value={f.external_code} onChange={(e) => setF({ ...f, external_code: e.target.value })} placeholder="External code" className="input py-1 w-32 font-mono" />
        <button type="submit" className="btn btn-sm btn-secondary" disabled={!f.name.trim()}>Add bill type</button>
      </form>
    </div>
  );
}

// --- Utilisation report -------------------------------------------------------

function ymd(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

export function UtilisationCard() {
  const thisMonday = mondayOf(new Date());
  const [from, setFrom] = useState(ymd(new Date(thisMonday.getTime() - 7 * 86400000)));
  const [to, setTo] = useState(ymd(new Date(thisMonday.getTime() - 86400000)));
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    const [fy, fm, fd] = from.split("-").map(Number);
    const [ty, tm, td] = to.split("-").map(Number);
    const start = new Date(fy, fm - 1, fd);
    const end = new Date(ty, tm - 1, td + 1);
    if (!(end > start)) { toast.error("End date must be on or after the start date"); return; }
    setBusy(true);
    try {
      const qs = new URLSearchParams({ from: start.toISOString(), to: end.toISOString() });
      setData(await api.get(`/api/billing/report/utilisation?${qs}`));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { run(); }, []);

  function shiftWeek(n) {
    const f = new Date(from + "T00:00:00");
    f.setDate(f.getDate() + 7 * n);
    const t = new Date(f);
    t.setDate(t.getDate() + 6);
    setFrom(ymd(f));
    setTo(ymd(t));
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <h3 className="text-sm font-semibold text-fg mb-1">Timesheets &amp; utilisation</h3>
      <p className="text-xs text-fg-muted mb-3">
        Per tech: time logged, how much was billable, and the billed amount
        after rates and contracts. Defaults to last week.
      </p>
      <div className="flex flex-wrap items-center gap-2 text-sm mb-3">
        <button onClick={() => shiftWeek(-1)} className="btn btn-sm btn-ghost" aria-label="Previous week">‹</button>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input py-1 w-40" aria-label="From" />
        <span className="text-fg-muted">to</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input py-1 w-40" aria-label="To" />
        <button onClick={() => shiftWeek(1)} className="btn btn-sm btn-ghost" aria-label="Next week">›</button>
        <button onClick={run} disabled={busy} className="btn btn-sm btn-secondary">{busy ? "Loading…" : "Run"}</button>
      </div>
      {data && (data.rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-fg-muted border-b border-border">
                <th className="py-1 pr-3 font-medium">Tech</th>
                <th className="py-1 pr-3 font-medium text-right">Entries</th>
                <th className="py-1 pr-3 font-medium text-right">Logged</th>
                <th className="py-1 pr-3 font-medium text-right">Billable</th>
                <th className="py-1 pr-3 font-medium text-right">Non-billable</th>
                <th className="py-1 pr-3 font-medium text-right">Utilisation</th>
                <th className="py-1 font-medium text-right">Billed</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.user_id || 0} className="border-b border-border last:border-0">
                  <td className="py-1 pr-3">{r.name}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{r.entries}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{fmtMinutes(r.logged_minutes)}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{fmtMinutes(r.billable_minutes)}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{fmtMinutes(r.non_billable_minutes)}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{r.utilisation}%</td>
                  <td className="py-1 text-right tabular-nums">{formatMoney(r.amount_cents, data.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-fg-dim">No time logged in this range.</p>
      ))}
    </div>
  );
}
