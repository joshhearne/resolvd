import { useEffect, useState, useRef, Fragment } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// Context tags always available to a formula (resolved by buildContext on the
// server). Form-field tags are appended per project from the field defs.
const CONTEXT_TAGS = [
  { token: "{ticket.title}", hint: "Ticket title" },
  { token: "{ticket.ref}", hint: "Ticket ref (e.g. HR-0312)" },
  { token: "{ticket.priority}", hint: "Priority" },
  { token: "{submitter.name}", hint: "Submitter full name" },
  { token: "{submitter.firstname}", hint: "Submitter first name" },
  { token: "{submitter.email}", hint: "Submitter email" },
  { token: "{assignee.name}", hint: "Assignee name" },
  { token: "{assignee.email}", hint: "Assignee email" },
  { token: "{actor.name}", hint: "Acting agent name" },
  { token: "{actor.email}", hint: "Acting agent email" },
];

// Formula editor: a textarea plus clickable tag chips that insert {field.<slug>}
// (and context tags) at the cursor, and an inline demo preview. fieldDefs is
// the project's field-def list; computed/archived defs are excluded (a computed
// field can't reference another computed field, v1 single-pass).
function FormulaField({ value, onChange, placeholder, fieldDefs, onPreview }) {
  const ref = useRef(null);
  const [preview, setPreview] = useState(null);
  const fieldTags = (fieldDefs || [])
    .filter((d) => !d.computed && !d.archived)
    .map((d) => ({ token: `{field.${d.slug}}`, hint: d.label }));

  function insert(token) {
    const el = ref.current;
    const start = el ? el.selectionStart : value.length;
    const end = el ? el.selectionEnd : value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      if (!el) return;
      const pos = start + token.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  async function preview_() {
    if (!value.trim()) { setPreview({ ok: false, error: "Enter a formula first" }); return; }
    setPreview(await onPreview(value));
  }

  const Chip = ({ token, hint }) => (
    <button type="button" key={token} onClick={() => insert(token)} title={hint}
      className="text-xs font-mono px-1.5 py-0.5 rounded border border-border-strong bg-surface-2/60 hover:border-brand hover:text-brand">
      {token}
    </button>
  );

  return (
    <div className="space-y-2">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        spellCheck={false}
        placeholder={placeholder}
        className="w-full border border-border-strong rounded px-2 py-1.5 text-sm font-mono"
      />
      <div className="space-y-1">
        {!!fieldTags.length && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-xs text-fg-muted mr-1">Form fields:</span>
            {fieldTags.map((t) => <Chip key={t.token} {...t} />)}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-fg-muted mr-1">Ticket / people:</span>
          {CONTEXT_TAGS.map((t) => <Chip key={t.token} {...t} />)}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={preview_} className="btn btn-secondary btn-sm">Preview (demo: John Doe, DOB 2000-03-12)</button>
        {preview && (preview.ok
          ? <span className="text-xs text-fg">→ <code className="font-mono text-emerald-600">{preview.value || "(empty)"}</code></span>
          : <span className="text-xs text-red-600">{preview.error}</span>)}
      </div>
    </div>
  );
}

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
  { value: "multiselect", label: "Multi-select" },
];
const HAS_OPTIONS = (t) => t === "select" || t === "multiselect";

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
  const [editingDefId, setEditingDefId] = useState(null);
  const [defEdit, setDefEdit] = useState({ label: "", help_text: "", options: "", sensitive: false, agent_only: false, formula: "" });
  const [slugDraft, setSlugDraft] = useState({ category: "", form: "" });
  const [linkPrefills, setLinkPrefills] = useState({}); // field slug -> prefill value
  const [newCategory, setNewCategory] = useState("");
  const [newForm, setNewForm] = useState("");
  const [newField, setNewField] = useState({ label: "", type: "text", options: "", help_text: "", sensitive: false, shared: false, agent_only: false, computed: false, formula: "" });

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
    const cat = categories.find((c) => String(c.id) === String(sf?.category_id));
    setFormDraft({ default_title: sf?.default_title || "", default_description: sf?.default_description || "" });
    setSlugDraft({ category: cat?.slug || "", form: sf?.slug || "" });
    setLinkPrefills({});
    api.get(`/api/forms/${formId}`).then((r) => {
      setBinding((r.fields || []).map((f) => ({ field_def_id: f.def_id, required: !!f.required, sort_order: f.sort_order })));
    }).catch((e) => toast.error(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formId]);

  async function saveSlugs() {
    try {
      if (slugDraft.category) await api.patch(`/api/forms/categories/${categoryId}`, { slug: slugDraft.category });
      if (slugDraft.form) await api.patch(`/api/forms/${formId}`, { slug: slugDraft.form });
      toast.success("Slugs saved"); await loadProjectScope();
    } catch (e) { toast.error(e.message); }
  }
  function copyLink(url) {
    navigator.clipboard?.writeText(url).then(() => toast.success("Link copied")).catch(() => toast.error("Copy failed"));
  }

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

  function fmtOptions(options) {
    if (!Array.isArray(options) || !options.length) return "";
    return options.map((o) => (o.value === o.label ? o.label : `${o.value}:${o.label}`)).join(", ");
  }
  // Edit an existing def's mutable attributes. Label + type stay locked (they
  // anchor the slug + stored value shape). Archive lives here, not in the list.
  function openDefEditor(d) {
    setEditingDefId(d.id);
    setDefEdit({ label: d.label || "", help_text: d.help_text || "", options: fmtOptions(d.options), sensitive: !!d.sensitive, agent_only: !!d.agent_only, formula: d.formula || "" });
  }
  async function saveDefEdit(d) {
    try {
      if (!defEdit.label.trim()) return toast.error("Label required");
      const body = { label: defEdit.label.trim(), help_text: defEdit.help_text.trim() || null, sensitive: defEdit.sensitive, agent_only: defEdit.agent_only };
      if (HAS_OPTIONS(d.type)) {
        const opts = parseOptions(defEdit.options);
        if (!opts.length) return toast.error("Select/multi-select fields need at least one option");
        body.options = opts;
      }
      if (d.computed) {
        if (!defEdit.formula.trim()) return toast.error("Computed fields need a formula");
        body.formula = defEdit.formula.trim();
      }
      await api.patch(`/api/custom-field-defs/${d.id}`, body);
      toast.success("Field updated"); setEditingDefId(null); await loadProjectScope();
    } catch (e) { toast.error(e.message); }
  }
  async function archiveDef(d) {
    if (!confirm(`Archive "${d.label}"? It's hidden from forms going forward; stored ticket values are kept.`)) return;
    try {
      await api.delete(`/api/custom-field-defs/${d.id}`);
      setBinding((prev) => prev.filter((b) => b.field_def_id !== d.id)); // drop stale binding
      toast.success("Field archived"); setEditingDefId(null); await loadProjectScope();
    } catch (e) { toast.error(e.message); }
  }

  async function createField() {
    if (!newField.label.trim()) return toast.error("Field label required");
    try {
      const body = {
        entity_type: "ticket",
        label: newField.label.trim(),
        type: newField.type,
        options: HAS_OPTIONS(newField.type) ? parseOptions(newField.options) : [],
        help_text: newField.help_text.trim() || null,
        sensitive: !!newField.sensitive,
        agent_only: !!newField.agent_only,
        project_id: newField.shared ? null : Number(projectId),
      };
      if (newField.computed) {
        if (!newField.formula.trim()) return toast.error("Computed fields need a formula");
        body.computed = true;
        body.formula = newField.formula.trim();
      } else if (HAS_OPTIONS(body.type) && !body.options.length) {
        return toast.error("Select/multi-select fields need at least one option");
      }
      const created = await api.post("/api/custom-field-defs", body);
      toast.success(`Field created (slug: ${created.slug})`);
      setNewField({ label: "", type: "text", options: "", help_text: "", sensitive: false, shared: false, agent_only: false, computed: false, formula: "" });
      await loadProjectScope();
    } catch (e) {
      // 409 → slug collision; the server message names the clashing slug.
      toast.error(e.message);
    }
  }

  // Dry-run a formula against demo inputs so the admin can eyeball the output
  // before saving. Each {field.<slug>} referenced gets a sensible demo value:
  // first→John, last→Doe, dob/birth/date→2000-03-12, else "Sample".
  async function previewFormula(src) {
    const formula = String(src || "").trim();
    if (!formula) return { ok: false, error: "Enter a formula first" };
    const field = {};
    const re = /\{field\.([a-z0-9_-]+)\}/gi;
    let m;
    while ((m = re.exec(formula))) {
      const slug = m[1].toLowerCase();
      field[slug] = /first/.test(slug) ? "John"
        : /last|surname/.test(slug) ? "Doe"
        : /dob|birth|date/.test(slug) ? "2000-03-12"
        : "Sample";
    }
    try {
      return await api.post("/api/custom-field-defs/formula-preview", {
        formula, field,
        ticket: { title: "Demo ticket" }, submitter: { name: "John Doe", firstname: "John" },
      });
    } catch (e) { return { ok: false, error: e.message }; }
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
  const selectedCategory = categories.find((c) => String(c.id) === String(categoryId));
  const selectedProject = projects.find((p) => String(p.id) === String(projectId));

  // Bound fields (ordered) for the link-builder param reference.
  const boundFields = binding
    .slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((b) => defs.find((d) => d.id === b.field_def_id)).filter(Boolean);
  const deepLinkBase = selectedProject && selectedForm
    ? `${window.location.origin}/tickets/new/${String(selectedProject.prefix).toLowerCase()}/${slugDraft.category || selectedCategory?.slug || ""}/${slugDraft.form || selectedForm?.slug || ""}`
    : "";
  const deepLinkQuery = Object.entries(linkPrefills)
    .filter(([, v]) => v !== "" && v != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const deepLinkFull = deepLinkBase + (deepLinkQuery ? `?${deepLinkQuery}` : "");

  async function setCategoryDefault(val) {
    try {
      await api.patch(`/api/forms/categories/${categoryId}`, { default_form_id: val ? Number(val) : null });
      toast.success("Default form set"); await loadProjectScope();
    } catch (e) { toast.error(e.message); }
  }

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
                {formsInCategory.length > 0 && (
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs text-fg-muted">Default form (pre-selected on new ticket):</span>
                    <select value={selectedCategory?.default_form_id || ""} onChange={(e) => setCategoryDefault(e.target.value)}
                      className="border border-border-strong rounded px-2 py-1 text-sm">
                      <option value="">None — user picks{formsInCategory.length === 1 ? " (single form auto-selects)" : ""}</option>
                      {formsInCategory.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
                  </div>
                )}
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

                {/* Deep-link / bookmark builder. Admins hand these out to
                    pre-open this form, optionally pre-filling fields. */}
                <div className="border border-border rounded p-3 mb-4 bg-surface-2/40">
                  <h3 className="text-xs font-semibold text-fg-muted mb-2 uppercase">Shareable link</h3>
                  <div className="flex flex-wrap items-end gap-2 mb-2">
                    <label className="flex flex-col gap-1"><span className="text-xs text-fg-muted">Category slug</span>
                      <input value={slugDraft.category} onChange={(e) => setSlugDraft((p) => ({ ...p, category: e.target.value }))} className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-40" /></label>
                    <label className="flex flex-col gap-1"><span className="text-xs text-fg-muted">Form slug</span>
                      <input value={slugDraft.form} onChange={(e) => setSlugDraft((p) => ({ ...p, form: e.target.value }))} className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-40" /></label>
                    <button onClick={saveSlugs} className="btn btn-secondary btn-sm">Save slugs</button>
                  </div>
                  {/* Optional per-field prefills */}
                  {boundFields.length > 0 && (
                    <div className="space-y-1 mb-2">
                      <div className="text-xs text-fg-muted">Optional prefills (query params):</div>
                      {boundFields.map((d) => (
                        <div key={d.id} className="flex items-center gap-2">
                          <code className="text-[11px] text-fg-muted w-56 truncate" title={d.slug}>{d.slug}</code>
                          {d.type === "select" ? (
                            <select value={linkPrefills[d.slug] || ""} onChange={(e) => setLinkPrefills((p) => ({ ...p, [d.slug]: e.target.value }))}
                              className="border border-border-strong rounded px-2 py-1 text-sm">
                              <option value="">— none —</option>
                              {(d.options || []).map((o, i) => <option key={o.value} value={i + 1}>{i + 1} — {o.label}</option>)}
                            </select>
                          ) : d.type === "bool" ? (
                            <select value={linkPrefills[d.slug] || ""} onChange={(e) => setLinkPrefills((p) => ({ ...p, [d.slug]: e.target.value }))}
                              className="border border-border-strong rounded px-2 py-1 text-sm">
                              <option value="">— none —</option><option value="1">true</option><option value="0">false</option>
                            </select>
                          ) : (
                            <input value={linkPrefills[d.slug] || ""} onChange={(e) => setLinkPrefills((p) => ({ ...p, [d.slug]: e.target.value }))}
                              placeholder="value" className="border border-border-strong rounded px-2 py-1 text-sm flex-1 min-w-0" />
                          )}
                        </div>
                      ))}
                      <div className="text-[11px] text-fg-dim">Selects use the option number (1 = first). Save slugs above before copying if you just changed them.</div>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <input readOnly value={deepLinkFull} className="border border-border-strong rounded px-2 py-1 text-xs font-mono flex-1 min-w-0 bg-surface" />
                    <button onClick={() => copyLink(deepLinkFull)} className="btn btn-secondary btn-sm shrink-0">Copy</button>
                  </div>
                </div>

                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-semibold text-fg-muted uppercase">Fields on “{selectedForm?.name}”</h3>
                  <button onClick={saveBinding} className="btn btn-primary btn-sm">Save form fields</button>
                </div>
                <table className="w-full text-sm mb-4">
                  <thead className="text-xs text-fg-muted">
                    <tr><th className="text-left py-1 w-10">On</th><th className="text-left py-1">Field</th><th className="text-left py-1">Slug</th><th className="text-left py-1">Type</th><th className="text-left py-1">Visibility</th><th className="text-left py-1 w-16">Req</th><th className="text-left py-1 w-20">Order</th><th className="py-1 w-12"></th></tr>
                  </thead>
                  <tbody>
                    {defs.map((d) => {
                      const b = bound(d.id);
                      const open = editingDefId === d.id;
                      return (
                        <Fragment key={d.id}>
                        <tr className="border-t border-border">
                          <td className="py-2"><input type="checkbox" checked={!!b} onChange={() => toggleBound(d.id)} /></td>
                          <td className="py-2 pr-3">{d.label}{d.computed && <span className="ml-1 text-xs text-brand">ƒ computed</span>}{d.sensitive && <span className="ml-1 text-xs text-fg-muted">(sensitive)</span>}{d.project_id == null && <span className="ml-1 text-xs text-fg-muted">(shared)</span>}</td>
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
                          <td className="py-2 text-right">
                            <button onClick={() => open ? setEditingDefId(null) : openDefEditor(d)} className="text-xs text-brand hover:underline">{open ? "Close" : "Edit"}</button>
                          </td>
                        </tr>
                        {open && (
                          <tr className="bg-surface-2/40">
                            <td colSpan={8} className="p-3">
                              <div className="flex flex-wrap items-end gap-3">
                                <label className="flex flex-col gap-1"><span className="text-xs text-fg-muted">Label</span>
                                  <input value={defEdit.label} onChange={(e) => setDefEdit((p) => ({ ...p, label: e.target.value }))} className="border border-border-strong rounded px-2 py-1 text-sm w-44" /></label>
                                <div className="text-xs text-fg-muted">Type<br /><span className="text-sm text-fg">{d.type}</span> <span className="text-fg-dim">(locked)</span></div>
                                <div className="text-xs text-fg-muted">Slug<br /><span className="text-sm font-mono text-fg-dim">{d.slug}</span> <span className="text-fg-dim">(locked)</span></div>
                                {HAS_OPTIONS(d.type) && (
                                  <label className="flex flex-col gap-1 flex-1 min-w-[12rem]"><span className="text-xs text-fg-muted">Options</span>
                                    <input value={defEdit.options} onChange={(e) => setDefEdit((p) => ({ ...p, options: e.target.value }))} placeholder="value:label, value:label" className="border border-border-strong rounded px-2 py-1 text-sm" /></label>
                                )}
                                <label className="flex flex-col gap-1 flex-1 min-w-[10rem]"><span className="text-xs text-fg-muted">Help text</span>
                                  <input value={defEdit.help_text} onChange={(e) => setDefEdit((p) => ({ ...p, help_text: e.target.value }))} className="border border-border-strong rounded px-2 py-1 text-sm" /></label>
                                <label className="text-xs text-fg-muted inline-flex items-center gap-1"><input type="checkbox" checked={defEdit.sensitive} onChange={(e) => setDefEdit((p) => ({ ...p, sensitive: e.target.checked }))} /> Sensitive</label>
                                <label className="text-xs text-fg-muted inline-flex items-center gap-1"><input type="checkbox" checked={defEdit.agent_only} onChange={(e) => setDefEdit((p) => ({ ...p, agent_only: e.target.checked }))} /> Agent-only</label>
                                <button onClick={() => saveDefEdit(d)} className="btn btn-primary btn-sm">Save</button>
                                <button onClick={() => archiveDef(d)} className="text-xs text-red-600 hover:underline">Archive</button>
                              </div>
                              {d.computed && (
                                <div className="mt-3 w-full">
                                  <span className="text-xs text-fg-muted">Formula (computed field) — click a tag to insert, <code>~</code> concats.</span>
                                  <FormulaField
                                    value={defEdit.formula}
                                    onChange={(v) => setDefEdit((p) => ({ ...p, formula: v }))}
                                    fieldDefs={defs}
                                    onPreview={previewFormula}
                                  />
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                        </Fragment>
                      );
                    })}
                    {!defs.length && <tr><td colSpan={8} className="py-2 text-fg-muted">No ticket fields yet — create one below.</td></tr>}
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
                    {!newField.computed && (
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-fg-muted">Type</span>
                      <select value={newField.type} onChange={(e) => setNewField((p) => ({ ...p, type: e.target.value }))} className="border border-border-strong rounded px-2 py-1 text-sm">
                        {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                    </label>
                    )}
                    {!newField.computed && HAS_OPTIONS(newField.type) && (
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
                    <label className="text-xs text-fg-muted inline-flex items-center gap-1">
                      <input type="checkbox" checked={newField.computed} onChange={(e) => setNewField((p) => ({ ...p, computed: e.target.checked }))} /> Computed
                    </label>
                    <button onClick={createField} className="px-3 py-1.5 text-sm bg-brand text-white rounded">Create field</button>
                  </div>

                  {newField.computed && (
                    <div className="mt-3 space-y-2 border-t border-border pt-3">
                      <span className="text-xs text-fg-muted block">
                        Formula — derive this field's value from form inputs. Click a tag to insert; concatenate with <code>~</code>.
                        Functions: <code>slice, left, right, upper, lower, cap, pad, trim, len, digits, replace, match, datepart, if, default</code>.
                        Computed fields are always agent-only and stored as text.
                      </span>
                      <FormulaField
                        value={newField.formula}
                        onChange={(v) => setNewField((p) => ({ ...p, formula: v }))}
                        fieldDefs={defs}
                        onPreview={previewFormula}
                        placeholder={`lower( slice({field.${String(selectedProject?.prefix || "hr").toLowerCase()}-first_name},0,1) ~ {field.${String(selectedProject?.prefix || "hr").toLowerCase()}-last_name} )`}
                      />
                    </div>
                  )}
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
