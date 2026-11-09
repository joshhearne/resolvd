import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// Right-hand "Custom Fields" card on the ticket page. For handlers this is an
// always-editable panel — each bound field renders with its current value, a
// per-field Save, plus a master "Save all" when there's more than one. This is
// where agents fill agent-only fields (e.g. a temp password) after the ticket
// is created. Handlers can also attach individual fields ad hoc ("+ Add
// field") with or without a form, and remove ad-hoc ones again.
// Non-handlers get a read-only list (sensitive values masked).
export default function CustomFieldsCard({ ticket, canEdit, onUpdated, onApplyForm }) {
  const [fields, setFields] = useState(null); // ticket's field set (form + ad hoc)
  const [draft, setDraft] = useState({}); // def_id -> value
  const [savingId, setSavingId] = useState(null); // def_id | 'all' | null
  const [adding, setAdding] = useState(false);
  const [available, setAvailable] = useState([]); // eligible defs for "+ Add field"
  const [addId, setAddId] = useState("");

  const values = Array.isArray(ticket.custom_fields) ? ticket.custom_fields : [];
  const hasForm = !!ticket.form_id;

  // Load the ticket's full field set (form + ad hoc) once (handlers only).
  // Seed the draft from current values; after a save we update the draft from
  // the response rather than refetching, so this effect only depends on the
  // ticket/form/project identity.
  useEffect(() => {
    if (!canEdit) { setFields(null); return; }
    let alive = true;
    api.get(`/api/tickets/${ticket.id}/fields`).then((f) => {
      if (!alive) return;
      setFields(f || []);
      setDraft(seedFrom(f || [], ticket.custom_fields));
    }).catch(() => { if (alive) setFields(null); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket.id, ticket.form_id, ticket.project_id, canEdit]);

  // Eligible defs for "+ Add field": shared + this project's local ticket
  // fields, fetched when the picker opens.
  useEffect(() => {
    if (!adding) return;
    let alive = true;
    api.get(`/api/custom-fields?entity_type=ticket&project_id=${ticket.project_id}`)
      .then((defs) => { if (alive) setAvailable(defs || []); })
      .catch(() => { if (alive) setAvailable([]); });
    return () => { alive = false; };
  }, [adding, ticket.project_id]);

  function applyResponse(r) {
    const nextFields = r.fields || fields || [];
    const nextVals = r.custom_fields || [];
    setFields(nextFields);
    onUpdated?.(nextVals);
    setDraft(seedFrom(nextFields, nextVals));
  }

  async function addField() {
    if (!addId) return;
    setSavingId("add");
    try {
      const r = await api.post(`/api/tickets/${ticket.id}/fields`, { def_ids: [Number(addId)] });
      applyResponse(r);
      const def = available.find((d) => String(d.id) === String(addId));
      toast.success(`${def?.label || "Field"} added`);
      setAddId("");
      setAdding(false);
    } catch (e) { toast.error(e.message); }
    finally { setSavingId(null); }
  }

  async function removeField(f) {
    const hasValue = values.some((v) => v.def_id === f.def_id && v.value != null && v.value !== "");
    if (hasValue && !window.confirm(`Remove "${f.label}" from this ticket? Its value will be cleared.`)) return;
    setSavingId(`rm-${f.def_id}`);
    try {
      const r = await api.delete(`/api/tickets/${ticket.id}/fields/${f.def_id}`);
      applyResponse(r);
      toast.success(`${f.label} removed`);
    } catch (e) { toast.error(e.message); }
    finally { setSavingId(null); }
  }

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

  // Re-run the form's computed (formula) fields against the ticket's current
  // inputs and refresh their displayed values.
  async function recompute() {
    setSavingId("recompute");
    try {
      const r = await api.post(`/api/tickets/${ticket.id}/recompute-fields`, {});
      const next = r.custom_fields || [];
      toast.success(r.recomputed ? `Recomputed ${r.recomputed} field${r.recomputed > 1 ? "s" : ""}` : "Nothing to recompute");
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

  // ---- Handler editable panel (form fields + ad-hoc fields) ----
  if (canEdit) {
    if (fields === null) return null; // still loading
    const present = new Set(fields.map((f) => f.def_id));
    const addable = available.filter((d) => !present.has(d.id));
    const editable = fields.filter((f) => !f.computed);
    const derived = fields.filter((f) => f.computed);
    // Current value of a computed field, read from the ticket's stored values.
    const curVal = (f) => {
      const v = values.find((x) => x.def_id === f.def_id);
      return v ? v.value : "";
    };
    return (
      <div className="bg-surface rounded-lg border border-border shadow-sm p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-fg">Custom Fields</h2>
            {hasForm ? (
              <p className="text-xs text-fg-muted truncate">
                {ticket.form_category_name ? `${ticket.form_category_name} › ` : ""}{ticket.form_name}
                {onApplyForm && (
                  <button onClick={onApplyForm} className="ml-2 text-brand hover:underline">Change</button>
                )}
              </p>
            ) : (
              <p className="text-xs text-fg-muted">
                No request type
                {onApplyForm && (
                  <button onClick={onApplyForm} className="ml-2 text-brand hover:underline">Apply form…</button>
                )}
              </p>
            )}
          </div>
          {editable.length > 1 && (
            <button onClick={() => save(editable, "all")} disabled={!!savingId} className="text-xs text-brand hover:underline disabled:opacity-50">
              {savingId === "all" ? "Saving…" : "Save all"}
            </button>
          )}
        </div>
        {editable.map((f) => (
          <div key={f.def_id} className="space-y-1">
            <label className="block text-xs text-fg-muted">
              {f.label}{f.required && <span className="text-red-500"> *</span>}
              {f.agent_only && <span className="ml-1">(agent)</span>}
              {f.sensitive && <span className="ml-1">🔒</span>}
              {f.source === "adhoc" && <span className="ml-1 text-fg-dim">(added)</span>}
            </label>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">{control(f)}</div>
              <button onClick={() => save([f], f.def_id)} disabled={!!savingId} className="btn btn-secondary btn-sm shrink-0">
                {savingId === f.def_id ? "…" : "Save"}
              </button>
              {f.source === "adhoc" && (
                <button
                  onClick={() => removeField(f)}
                  disabled={!!savingId}
                  className="text-fg-dim hover:text-red-500 text-sm shrink-0 px-1"
                  title={`Remove ${f.label} from this ticket`}
                  aria-label={`Remove ${f.label}`}
                >
                  ×
                </button>
              )}
            </div>
          </div>
        ))}

        {derived.length > 0 && (
          <div className="pt-2 border-t border-border space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-fg-muted">Derived (auto)</span>
              <button onClick={recompute} disabled={!!savingId} className="text-xs text-brand hover:underline disabled:opacity-50">
                {savingId === "recompute" ? "Recomputing…" : "↻ Recompute"}
              </button>
            </div>
            {derived.map((f) => {
              const cv = curVal(f);
              return (
                <div key={f.def_id} className="flex flex-col">
                  <span className="text-xs text-fg-muted">{f.label}{f.sensitive && <span className="ml-1">🔒</span>}</span>
                  <code className="text-sm text-fg break-all font-mono">
                    {cv == null || cv === "" ? <span className="text-fg-dim font-sans">—</span> : String(cv)}
                  </code>
                </div>
              );
            })}
          </div>
        )}
        {!fields.length && !adding && (
          <p className="text-xs text-fg-muted">No fields yet. Apply a form, or add individual fields.</p>
        )}

        <div className="pt-2 border-t border-border">
          {adding ? (
            <div className="flex items-center gap-2">
              <select
                autoFocus
                value={addId}
                onChange={(e) => setAddId(e.target.value)}
                className="flex-1 min-w-0 border border-border-strong rounded-md px-2 py-1.5 text-sm"
              >
                <option value="">{addable.length ? "Choose a field…" : "No other fields available"}</option>
                {addable.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}{d.project_id ? "" : " · shared"}
                  </option>
                ))}
              </select>
              <button onClick={addField} disabled={!addId || !!savingId} className="btn btn-primary btn-sm shrink-0">
                {savingId === "add" ? "…" : "Add"}
              </button>
              <button onClick={() => { setAdding(false); setAddId(""); }} className="btn btn-secondary btn-sm shrink-0">
                Cancel
              </button>
            </div>
          ) : (
            <button onClick={() => setAdding(true)} className="text-xs text-brand hover:underline">
              + Add field
            </button>
          )}
        </div>
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
