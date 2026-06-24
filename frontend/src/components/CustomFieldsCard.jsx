import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// Right-hand "Custom Fields" card on the ticket page. For handlers this is an
// always-editable panel — each bound field renders with its current value, a
// per-field Save, plus a master "Save all" when there's more than one. This is
// where agents fill agent-only fields (e.g. a temp password) after the ticket
// is created. Non-handlers get a read-only list (sensitive values masked).
export default function CustomFieldsCard({ ticket, canEdit, onUpdated }) {
  const [fields, setFields] = useState(null); // form's bound field defs
  const [draft, setDraft] = useState({}); // def_id -> value
  const [savingId, setSavingId] = useState(null); // def_id | 'all' | null

  const values = Array.isArray(ticket.custom_fields) ? ticket.custom_fields : [];
  const hasForm = !!ticket.form_id;

  // Load the form's full field set once (handlers only). Seed the draft from
  // current values; after a save we update the draft from the response rather
  // than refetching, so this effect only depends on the ticket/form identity.
  useEffect(() => {
    if (!canEdit || !hasForm) { setFields(null); return; }
    let alive = true;
    api.get(`/api/forms/${ticket.form_id}`).then((r) => {
      if (!alive) return;
      const f = r.fields || [];
      setFields(f);
      setDraft(seedFrom(f, ticket.custom_fields));
    }).catch(() => { if (alive) setFields(null); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket.id, ticket.form_id, canEdit]);

  function seedFrom(f, vals) {
    const cur = Array.isArray(vals) ? vals : [];
    const seed = {};
    f.forEach((fld) => {
      const v = cur.find((x) => x.def_id === fld.def_id);
      if (fld.type === "multiselect") seed[fld.def_id] = v && Array.isArray(v.value) ? v.value : [];
      else if (fld.type === "bool") seed[fld.def_id] = v ? !!v.value : false;
      else seed[fld.def_id] = v ? (v.value ?? "") : "";
    });
    return seed;
  }

  async function save(items, key) {
    setSavingId(key);
    try {
      const payload = items.map((f) => ({ def_id: f.def_id, value: draft[f.def_id] }));
      const r = await api.patch(`/api/tickets/${ticket.id}/custom-fields`, payload);
      toast.success(items.length > 1 ? "Fields saved" : `${items[0].label} saved`);
      const next = r.custom_fields || [];
      onUpdated?.(next);
      if (fields) setDraft(seedFrom(fields, next));
    } catch (e) { toast.error(e.message); }
    finally { setSavingId(null); }
  }

  function control(f) {
    const v = draft[f.def_id];
    const setV = (val) => setDraft((p) => ({ ...p, [f.def_id]: val }));
    const cls = "w-full border border-border-strong rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40";
    if (f.type === "bool") return <input type="checkbox" checked={!!v} onChange={(e) => setV(e.target.checked)} />;
    if (f.type === "multiselect") {
      const arr = Array.isArray(v) ? v : [];
      const toggle = (val) => setV(arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val]);
      return (
        <div className="space-y-1">
          {(f.options || []).map((o) => (
            <label key={o.value} className="flex items-center gap-2 text-sm text-fg">
              <input type="checkbox" checked={arr.includes(o.value)} onChange={() => toggle(o.value)} /> {o.label}
            </label>
          ))}
        </div>
      );
    }
    if (f.type === "select") {
      return (
        <select value={v ?? ""} onChange={(e) => setV(e.target.value)} className={cls}>
          <option value="">Select…</option>
          {(f.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    }
    const inputType = f.sensitive && f.type === "text" ? "password" : f.type === "number" ? "number" : f.type === "date" ? "date" : "text";
    return <input type={inputType} value={v ?? ""} onChange={(e) => setV(e.target.value)} className={cls} autoComplete={f.sensitive ? "new-password" : "off"} placeholder={f.help_text || ""} />;
  }

  // ---- Handler editable panel ----
  if (canEdit && hasForm) {
    if (fields === null) return null; // still loading
    if (!fields.length && !values.length) return null;
    return (
      <div className="bg-surface rounded-lg border border-border shadow-sm p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg">Custom Fields</h2>
          {fields.length > 1 && (
            <button onClick={() => save(fields, "all")} disabled={!!savingId} className="text-xs text-brand hover:underline disabled:opacity-50">
              {savingId === "all" ? "Saving…" : "Save all"}
            </button>
          )}
        </div>
        {fields.map((f) => (
          <div key={f.def_id} className="space-y-1">
            <label className="block text-xs text-fg-muted">
              {f.label}{f.required && <span className="text-red-500"> *</span>}
              {f.agent_only && <span className="ml-1">(agent)</span>}
              {f.sensitive && <span className="ml-1">🔒</span>}
            </label>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">{control(f)}</div>
              <button onClick={() => save([f], f.def_id)} disabled={!!savingId} className="btn btn-secondary btn-sm shrink-0">
                {savingId === f.def_id ? "…" : "Save"}
              </button>
            </div>
          </div>
        ))}
        {!fields.length && <p className="text-sm text-fg-muted">This form has no fields.</p>}
      </div>
    );
  }

  // ---- Read-only (non-handler) ----
  if (!values.length) return null;
  return (
    <div className="bg-surface rounded-lg border border-border shadow-sm p-4 space-y-3">
      <h2 className="text-sm font-semibold text-fg">Custom Fields</h2>
      <dl className="space-y-2">
        {values.map((cf) => (
          <div key={cf.slug} className="flex flex-col">
            <dt className="text-xs text-fg-muted">{cf.label}{cf.sensitive && <span className="ml-1">🔒</span>}</dt>
            <dd className="text-sm text-fg break-words">
              {Array.isArray(cf.value)
                ? (cf.value.length ? cf.value.join(", ") : <span className="text-fg-dim">—</span>)
                : cf.value == null || cf.value === ""
                ? <span className="text-fg-dim">—</span>
                : cf.type === "bool" ? (cf.value ? "Yes" : "No")
                : cf.type === "date" ? new Date(cf.value).toLocaleDateString()
                : String(cf.value)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
