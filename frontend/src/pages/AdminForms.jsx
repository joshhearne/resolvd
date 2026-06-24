import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// Project-scoped custom forms admin: project → categories → forms → field
// bindings. Required-ness is set per form on the binding (the anti-bleed
// guarantee) — a field is only mandatory on the forms that opt in. Fields are
// project-local by default (slug auto-prefixed with the project tag, e.g.
// "hr-username"); tick "Shared" to put one in the cross-project library.

const FIELD_TYPES = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "bool", label: "Yes / no" },
  { value: "select", label: "Select" },
];

function parseOptions(s) {
  if (!s) return [];
  return String(s).split(",").map((seg) => {
    const t = seg.trim();
    if (!t) return null;
    const [v, l] = t.includes(":") ? t.split(":").map((x) => x.trim()) : [t, t];
    return { value: v.toLowerCase().replace(/\s+/g, "_"), label: l };
  }).filter(Boolean);
}

export default function AdminForms() {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [categories, setCategories] = useState([]);
  const [forms, setForms] = useState([]);
  const [defs, setDefs] = useState([]); // ticket field defs in scope (shared + this project)
  const [categoryId, setCategoryId] = useState("");
  const [formId, setFormId] = useState("");
  const [binding, setBinding] = useState([]); // [{field_def_id, required, sort_order}]
  const [formDraft, setFormDraft] = useState({ default_title: "", default_description: "" });
  const [newCategory, setNewCategory] = useState("");
  const [newForm, setNewForm] = useState("");
  const [newField, setNewField] = useState({ label: "", type: "text", options: "", help_text: "", sensitive: false, shared: false, agent_only: false });

  useEffect(() => {
    api.get("/api/projects").then((all) => setProjects(all.filter((p) => p.status === "active"))).catch((e) => toast.error(e.message));
  }, []);

  async function loadProjectScope() {
    if (!projectId) { setCategories([]); setForms([]); setDefs([]); return; }
    try {
      const [cats, fms, fieldDefs] = await Promise.all([
        api.get(`/api/forms/categories?project_id=${projectId}`),
        api.get(`/api/forms?project_id=${projectId}&include_disabled=1`),
        api.get(`/api/custom-field-defs?entity_type=ticket&project_id=${projectId}`),
      ]);
      setCategories(cats); setForms(fms); setDefs(fieldDefs);
    } catch (e) { toast.error(e.message); }
  }
  useEffect(() => {
    setCategoryId(""); setFormId(""); setBinding([]);
    loadProjectScope();
  }, [projectId]);

  useEffect(() => {
    if (!formId) { setBinding([]); return; }
    const sf = forms.find((f) => String(f.id) === String(formId));
    setFormDraft({ default_title: sf?.default_title || "", default_description: sf?.default_description || "" });
    api.get(`/api/forms/${formId}`).then((r) => {
      setBinding((r.fields || []).map((f) => ({ field_def_id: f.def_id, required: !!f.required, sort_order: f.sort_order })));
    }).catch((e) => toast.error(e.message));
  }, [formId]);

  async function saveFormDefaults() {
    try {
      await api.patch(`/api/forms/${formId}`, { default_title: formDraft.default_title, default_description: formDraft.default_description });
      toast.success("Form defaults saved"); await loadProjectScope();
    } catch (e) { toast.error(e.message); }
  }

  async function addCategory() {
    if (!newCategory.trim()) return toast.error("Category name required");
    try {
      await api.post("/api/forms/categories", { project_id: Number(projectId), name: newCategory.trim(), sort_order: categories.length });
      setNewCategory(""); toast.success("Category added"); await loadProjectScope();
    } catch (e) { toast.error(e.message); }
  }
  async function delCategory(id) {
    if (!confirm("Delete this category and all its forms? Stored ticket values are kept.")) return;
    try { await api.delete(`/api/forms/categories/${id}`); if (String(categoryId) === String(id)) setCategoryId(""); toast.success("Deleted"); await loadProjectScope(); }
    catch (e) { toast.error(e.message); }
  }

  async function addForm() {
    if (!categoryId) return toast.error("Pick a category first");
    if (!newForm.trim()) return toast.error("Form name required");
    try {
      await api.post("/api/forms", { category_id: Number(categoryId), name: newForm.trim(), sort_order: forms.filter((f) => String(f.category_id) === String(categoryId)).length });
      setNewForm(""); toast.success("Form added"); await loadProjectScope();
    } catch (e) { toast.error(e.message); }
  }
  async function delForm(id) {
    if (!confirm("Delete this form? Stored ticket values are kept.")) return;
    try { await api.delete(`/api/forms/${id}`); if (String(formId) === String(id)) setFormId(""); toast.success("Deleted"); await loadProjectScope(); }
    catch (e) { toast.error(e.message); }
  }
  async function toggleFormEnabled(f) {
    try { await api.patch(`/api/forms/${f.id}`, { enabled: !f.enabled }); await loadProjectScope(); }
    catch (e) { toast.error(e.message); }
  }
  // Visibility lives on the field def (agent-only everywhere), so this PATCH
  // affects the field on every form it appears on.
  async function toggleDefAgentOnly(d) {
    try { await api.patch(`/api/custom-field-defs/${d.id}`, { agent_only: !d.agent_only }); await loadProjectScope(); }
    catch (e) { toast.error(e.message); }
  }

  async function createField() {
    if (!newField.label.trim()) return toast.error("Field label required");
    try {
      const body = {
        entity_type: "ticket",
        label: newField.label.trim(),
        type: newField.type,
        options: newField.type === "select" ? parseOptions(newField.options) : [],
        help_text: newField.help_text.trim() || null,
        sensitive: !!newField.sensitive,
        agent_only: !!newField.agent_only,
        project_id: newField.shared ? null : Number(projectId),
      };
      if (body.type === "select" && !body.options.length) return toast.error("Select fields need at least one option");
      const created = await api.post("/api/custom-field-defs", body);
      toast.success(`Field created (slug: ${created.slug})`);
      setNewField({ label: "", type: "text", options: "", help_text: "", sensitive: false, shared: false, agent_only: false });
      await loadProjectScope();
    } catch (e) {
      // 409 → slug collision; the server message names the clashing slug.
      toast.error(e.message);
    }
  }

  // Binding helpers ---------------------------------------------------------
  const bound = (defId) => binding.find((b) => b.field_def_id === defId);
  function toggleBound(defId) {
    setBinding((prev) => prev.find((b) => b.field_def_id === defId)
      ? prev.filter((b) => b.field_def_id !== defId)
      : [...prev, { field_def_id: defId, required: false, sort_order: prev.length }]);
  }
  function setBoundField(defId, patch) {
    setBinding((prev) => prev.map((b) => b.field_def_id === defId ? { ...b, ...patch } : b));
  }
  async function saveBinding() {
    try { await api.put(`/api/forms/${formId}/fields`, binding); toast.success("Form fields saved"); }
    catch (e) { toast.error(e.message); }
  }

  const formsInCategory = forms.filter((f) => String(f.category_id) === String(categoryId));
  const selectedForm = forms.find((f) => String(f.id) === String(formId));

  return (
    <div className="space-y-5">
      <div className="bg-surface border border-border rounded-lg p-4">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold text-fg">Forms</h2>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="border border-border-strong rounded px-2 py-1 text-sm">
            <option value="">Select project…</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.prefix})</option>)}
          </select>
        </div>
        <p className="text-xs text-fg-muted mb-3">
          Build request forms scoped to one project. Mark a field <em>required</em> per form — it stays optional everywhere else. Fields are project-local (slug auto-prefixed, e.g. <code>hr-username</code>); tick <em>Shared</em> to reuse one across projects.
        </p>

        {!projectId ? (
          <div className="text-sm text-fg-muted">Pick a project to manage its categories and forms.</div>
        ) : (
          <div className="space-y-5">
            {/* Categories */}
            <section className="border border-border rounded p-3 bg-surface-2/40">
              <h3 className="text-xs font-semibold text-fg-muted mb-2 uppercase">Categories</h3>
              <div className="flex flex-wrap gap-2 mb-2">
                {categories.map((c) => (
                  <button key={c.id} onClick={() => { setCategoryId(c.id); setFormId(""); }}
                    className={`text-sm px-3 py-1 rounded border ${String(categoryId) === String(c.id) ? "bg-brand/5 border-brand text-brand" : "border-border hover:bg-surface-2"}`}>
                    {c.name}
                    <span onClick={(e) => { e.stopPropagation(); delCategory(c.id); }} className="ml-2 text-red-600 hover:underline">×</span>
                  </button>
                ))}
                {!categories.length && <span className="text-sm text-fg-muted">No categories yet.</span>}
              </div>
              <div className="flex items-end gap-2">
                <input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder="e.g. Service Request, HR"
                  className="border border-border-strong rounded px-2 py-1 text-sm w-56" />
                <button onClick={addCategory} className="btn btn-secondary btn-sm">Add category</button>
              </div>
            </section>

            {/* Forms in selected category */}
            {categoryId && (
              <section className="border border-border rounded p-3 bg-surface-2/40">
                <h3 className="text-xs font-semibold text-fg-muted mb-2 uppercase">Forms</h3>
                <div className="flex flex-wrap gap-2 mb-2">
                  {formsInCategory.map((f) => (
                    <span key={f.id} className={`text-sm px-3 py-1 rounded border inline-flex items-center gap-2 ${String(formId) === String(f.id) ? "bg-brand/5 border-brand" : "border-border"}`}>
                      <button onClick={() => setFormId(f.id)} className={String(formId) === String(f.id) ? "text-brand" : ""}>{f.name}</button>
                      {!f.enabled && <span className="text-xs text-fg-muted">(disabled)</span>}
                      <button onClick={() => toggleFormEnabled(f)} className="text-xs text-fg-muted hover:underline">{f.enabled ? "disable" : "enable"}</button>
                      <button onClick={() => delForm(f.id)} className="text-xs text-red-600 hover:underline">×</button>
                    </span>
                  ))}
                  {!formsInCategory.length && <span className="text-sm text-fg-muted">No forms in this category.</span>}
                </div>
                <div className="flex items-end gap-2">
                  <input value={newForm} onChange={(e) => setNewForm(e.target.value)} placeholder="e.g. Onboarding"
                    className="border border-border-strong rounded px-2 py-1 text-sm w-56" />
                  <button onClick={addForm} className="btn btn-secondary btn-sm">Add form</button>
                </div>
              </section>
            )}

            {/* Field binding for selected form */}
            {formId && (
              <section className="border border-border rounded p-3">
                {/* Default Title/Description that pre-fill the new-ticket form
                    when this form is picked. Fields carry the real request. */}
                <div className="border border-border rounded p-3 mb-4 bg-surface-2/40">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-xs font-semibold text-fg-muted uppercase">Pre-fill defaults</h3>
                    <button onClick={saveFormDefaults} className="btn btn-secondary btn-sm">Save defaults</button>
                  </div>
                  <label className="flex flex-col gap-1 mb-2">
                    <span className="text-xs text-fg-muted">Default title</span>
                    <input value={formDraft.default_title} onChange={(e) => setFormDraft((p) => ({ ...p, default_title: e.target.value }))}
                      placeholder="e.g. New hire onboarding" className="border border-border-strong rounded px-2 py-1 text-sm" />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-fg-muted">Default description</span>
                    <textarea value={formDraft.default_description} onChange={(e) => setFormDraft((p) => ({ ...p, default_description: e.target.value }))}
                      rows={3} placeholder="Boilerplate body; the fields below carry the structured request." className="border border-border-strong rounded px-2 py-1 text-sm" />
                  </label>
                </div>

                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-semibold text-fg-muted uppercase">Fields on “{selectedForm?.name}”</h3>
                  <button onClick={saveBinding} className="btn btn-primary btn-sm">Save form fields</button>
                </div>
                <table className="w-full text-sm mb-4">
                  <thead className="text-xs text-fg-muted">
                    <tr><th className="text-left py-1 w-10">On</th><th className="text-left py-1">Field</th><th className="text-left py-1">Slug</th><th className="text-left py-1">Type</th><th className="text-left py-1">Visibility</th><th className="text-left py-1 w-16">Req</th><th className="text-left py-1 w-20">Order</th></tr>
                  </thead>
                  <tbody>
                    {defs.map((d) => {
                      const b = bound(d.id);
                      return (
                        <tr key={d.id} className="border-t border-border">
                          <td className="py-2"><input type="checkbox" checked={!!b} onChange={() => toggleBound(d.id)} /></td>
                          <td className="py-2 pr-3">{d.label}{d.sensitive && <span className="ml-1 text-xs text-fg-muted">(sensitive)</span>}{d.project_id == null && <span className="ml-1 text-xs text-fg-muted">(shared)</span>}</td>
                          <td className="py-2 pr-3 font-mono text-xs text-fg-muted">{d.slug}</td>
                          <td className="py-2 pr-3">{d.type}</td>
                          <td className="py-2 pr-3">
                            <button onClick={() => toggleDefAgentOnly(d)} title="Agent-only fields are hidden from the submitter form; agents fill them on the ticket"
                              className={`text-xs px-2 py-0.5 rounded border ${d.agent_only ? "border-amber-500 text-amber-600" : "border-border text-fg-muted"}`}>
                              {d.agent_only ? "Agent-only" : "Submitter"}
                            </button>
                          </td>
                          <td className="py-2 pr-3"><input type="checkbox" disabled={!b} checked={!!b?.required} onChange={(e) => setBoundField(d.id, { required: e.target.checked })} /></td>
                          <td className="py-2 pr-3"><input type="number" disabled={!b} value={b?.sort_order ?? ""} onChange={(e) => setBoundField(d.id, { sort_order: Number(e.target.value) || 0 })} className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-16 disabled:opacity-40" /></td>
                        </tr>
                      );
                    })}
                    {!defs.length && <tr><td colSpan={7} className="py-2 text-fg-muted">No ticket fields yet — create one below.</td></tr>}
                  </tbody>
                </table>

                {/* Inline field creation */}
                <div className="border border-border rounded p-3 bg-surface-2/40">
                  <h4 className="text-xs font-semibold text-fg-muted mb-2 uppercase">New field</h4>
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-fg-muted">Label</span>
                      <input value={newField.label} onChange={(e) => setNewField((p) => ({ ...p, label: e.target.value }))} placeholder="e.g. Username" className="border border-border-strong rounded px-2 py-1 text-sm w-44" />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-fg-muted">Type</span>
                      <select value={newField.type} onChange={(e) => setNewField((p) => ({ ...p, type: e.target.value }))} className="border border-border-strong rounded px-2 py-1 text-sm">
                        {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                    </label>
                    {newField.type === "select" && (
                      <label className="flex flex-col gap-1 flex-1 min-w-[12rem]">
                        <span className="text-xs text-fg-muted">Options</span>
                        <input value={newField.options} onChange={(e) => setNewField((p) => ({ ...p, options: e.target.value }))} placeholder="value:label, value:label" className="border border-border-strong rounded px-2 py-1 text-sm" />
                      </label>
                    )}
                    <label className="flex flex-col gap-1 flex-1 min-w-[10rem]">
                      <span className="text-xs text-fg-muted">Help text (optional)</span>
                      <input value={newField.help_text} onChange={(e) => setNewField((p) => ({ ...p, help_text: e.target.value }))} className="border border-border-strong rounded px-2 py-1 text-sm" />
                    </label>
                    <label className="text-xs text-fg-muted inline-flex items-center gap-1">
                      <input type="checkbox" checked={newField.sensitive} onChange={(e) => setNewField((p) => ({ ...p, sensitive: e.target.checked }))} /> Sensitive
                    </label>
                    <label className="text-xs text-fg-muted inline-flex items-center gap-1">
                      <input type="checkbox" checked={newField.agent_only} onChange={(e) => setNewField((p) => ({ ...p, agent_only: e.target.checked }))} /> Agent-only
                    </label>
                    <label className="text-xs text-fg-muted inline-flex items-center gap-1">
                      <input type="checkbox" checked={newField.shared} onChange={(e) => setNewField((p) => ({ ...p, shared: e.target.checked }))} /> Shared
                    </label>
                    <button onClick={createField} className="px-3 py-1.5 text-sm bg-brand text-white rounded">Create field</button>
                  </div>
                  <p className="text-xs text-fg-muted mt-2">Project-local fields get the project tag prefixed to their slug. Tick <em>Shared</em> to add to the cross-project library instead.</p>
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
