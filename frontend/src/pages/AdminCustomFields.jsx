import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// Custom field definitions admin. Phase 1C-1 surfaces this for the
// Asset entity; ticket-side wiring lands later. Slug is derived from
// the label and used as the stable handle (so renames don't break
// downstream attribute mappings).

const ENTITY_TYPES = [
  { value: "asset", label: "Asset" },
  // Ticket entity surfaced once the asset side has settled.
];

const FIELD_TYPES = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "bool", label: "Yes / no" },
  { value: "select", label: "Select" },
];

export default function AdminCustomFields() {
  const [entityType, setEntityType] = useState("asset");
  const [defs, setDefs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState({});
  const [newRow, setNewRow] = useState({
    label: "",
    type: "text",
    options: "",
    required: false,
    help_text: "",
  });

  async function load() {
    setLoading(true);
    try {
      const r = await api.get(`/api/custom-field-defs?entity_type=${entityType}`);
      setDefs(r);
    } catch (e) {
      toast.error(e.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, [entityType]);

  function parseOptions(s) {
    if (!s) return [];
    // Accept "value:label, value:label" OR "label, label" (slug auto).
    return String(s).split(",").map((seg) => {
      const t = seg.trim();
      if (!t) return null;
      const [v, l] = t.includes(":") ? t.split(":").map((x) => x.trim()) : [t, t];
      return { value: v.toLowerCase().replace(/\s+/g, "_"), label: l };
    }).filter(Boolean);
  }

  function fmtOptions(options) {
    if (!Array.isArray(options) || !options.length) return "";
    return options.map((o) => (o.value === o.label ? o.label : `${o.value}:${o.label}`)).join(", ");
  }

  async function addDef() {
    if (!newRow.label.trim()) return toast.error("Label required");
    try {
      const body = {
        entity_type: entityType,
        label: newRow.label.trim(),
        type: newRow.type,
        options: newRow.type === "select" ? parseOptions(newRow.options) : [],
        required: !!newRow.required,
        help_text: newRow.help_text.trim() || null,
        sort_order: (defs[defs.length - 1]?.sort_order ?? -1) + 1,
      };
      if (body.type === "select" && !body.options.length) {
        return toast.error("Select fields need at least one option");
      }
      await api.post(`/api/custom-field-defs`, body);
      toast.success("Field added");
      setNewRow({ label: "", type: "text", options: "", required: false, help_text: "" });
      await load();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  async function saveDef(d) {
    const e = edits[d.id];
    if (!e) return;
    try {
      const body = { ...e };
      if (body.options !== undefined && typeof body.options === "string") {
        body.options = parseOptions(body.options);
      }
      await api.patch(`/api/custom-field-defs/${d.id}`, body);
      toast.success("Saved");
      setEdits((prev) => { const n = { ...prev }; delete n[d.id]; return n; });
      await load();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  async function deleteDef(id) {
    if (!confirm("Delete this field and all stored values?")) return;
    try {
      await api.delete(`/api/custom-field-defs/${id}`);
      toast.success("Deleted");
      await load();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  return (
    <div className="space-y-5">
      <div className="bg-surface border border-border rounded-lg p-4">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold text-fg">Custom fields</h2>
          <select
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
            className="border border-border-strong rounded px-2 py-1 text-sm"
          >
            {ENTITY_TYPES.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
          </select>
        </div>
        <p className="text-xs text-fg-muted mb-3">
          Define ad-hoc attributes per entity. Slug is generated from the
          label and stays stable across renames so attribute mappings
          don't break. For <code>select</code> fields, list options as{" "}
          <code>value:label, value:label</code> (or just labels — slug
          will be derived).
        </p>

        <div className="border border-border rounded p-3 mb-4 bg-surface-2/40">
          <h3 className="text-xs font-semibold text-fg-muted mb-2 uppercase">Add field</h3>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Label</span>
              <input value={newRow.label} onChange={(e) => setNewRow((p) => ({ ...p, label: e.target.value }))}
                placeholder="e.g. Asset Tag" className="border border-border-strong rounded px-2 py-1 text-sm w-48" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Type</span>
              <select value={newRow.type} onChange={(e) => setNewRow((p) => ({ ...p, type: e.target.value }))}
                className="border border-border-strong rounded px-2 py-1 text-sm">
                {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            {newRow.type === "select" && (
              <label className="flex flex-col gap-1 flex-1 min-w-[12rem]">
                <span className="text-xs text-fg-muted">Options</span>
                <input value={newRow.options} onChange={(e) => setNewRow((p) => ({ ...p, options: e.target.value }))}
                  placeholder="Onsite, Remote, Warehouse" className="border border-border-strong rounded px-2 py-1 text-sm" />
              </label>
            )}
            <label className="flex flex-col gap-1 flex-1 min-w-[10rem]">
              <span className="text-xs text-fg-muted">Help text (optional)</span>
              <input value={newRow.help_text} onChange={(e) => setNewRow((p) => ({ ...p, help_text: e.target.value }))}
                className="border border-border-strong rounded px-2 py-1 text-sm" />
            </label>
            <label className="text-xs text-fg-muted inline-flex items-center gap-1">
              <input type="checkbox" checked={newRow.required}
                onChange={(e) => setNewRow((p) => ({ ...p, required: e.target.checked }))} />
              Required
            </label>
            <button onClick={addDef} className="px-3 py-1.5 text-sm bg-brand text-white rounded">Add</button>
          </div>
        </div>

        {loading ? (
          <div className="text-sm text-fg-muted">Loading…</div>
        ) : defs.length === 0 ? (
          <div className="text-sm text-fg-muted">No custom fields defined for this entity.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-fg-muted">
              <tr>
                <th className="text-left py-1">Label</th>
                <th className="text-left py-1">Slug</th>
                <th className="text-left py-1">Type</th>
                <th className="text-left py-1">Options / help</th>
                <th className="text-left py-1">Order</th>
                <th className="text-left py-1">Req</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {defs.map((d) => {
                const e = edits[d.id] || {};
                const merged = { ...d, ...e };
                const dirty = !!Object.keys(e).length;
                const optsText = e.options !== undefined ? e.options : fmtOptions(d.options);
                return (
                  <tr key={d.id} className="border-t border-border align-top">
                    <td className="py-2 pr-3">
                      <input value={merged.label}
                        onChange={(ev) => setEdits((prev) => ({ ...prev, [d.id]: { ...prev[d.id], label: ev.target.value } }))}
                        className="border border-border-strong rounded px-2 py-1 text-sm w-44" />
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs text-fg-muted">{d.slug}</td>
                    <td className="py-2 pr-3">
                      <select value={merged.type}
                        onChange={(ev) => setEdits((prev) => ({ ...prev, [d.id]: { ...prev[d.id], type: ev.target.value } }))}
                        className="border border-border-strong rounded px-2 py-1 text-sm">
                        {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                    </td>
                    <td className="py-2 pr-3">
                      {merged.type === "select" ? (
                        <input value={optsText}
                          onChange={(ev) => setEdits((prev) => ({ ...prev, [d.id]: { ...prev[d.id], options: ev.target.value } }))}
                          placeholder="value:label, value:label"
                          className="border border-border-strong rounded px-2 py-1 text-sm w-48" />
                      ) : (
                        <input value={merged.help_text || ""}
                          onChange={(ev) => setEdits((prev) => ({ ...prev, [d.id]: { ...prev[d.id], help_text: ev.target.value } }))}
                          placeholder="help text"
                          className="border border-border-strong rounded px-2 py-1 text-sm w-48" />
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <input type="number" value={merged.sort_order ?? 0}
                        onChange={(ev) => setEdits((prev) => ({ ...prev, [d.id]: { ...prev[d.id], sort_order: Number(ev.target.value) || 0 } }))}
                        className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-16" />
                    </td>
                    <td className="py-2 pr-3">
                      <input type="checkbox" checked={!!merged.required}
                        onChange={(ev) => setEdits((prev) => ({ ...prev, [d.id]: { ...prev[d.id], required: ev.target.checked } }))} />
                    </td>
                    <td className="py-2 flex gap-2">
                      {dirty && <button onClick={() => saveDef(d)} className="text-xs px-2 py-1 bg-brand text-white rounded">Save</button>}
                      <button onClick={() => deleteDef(d.id)} className="text-xs px-2 py-1 text-red-600 hover:underline">Delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
