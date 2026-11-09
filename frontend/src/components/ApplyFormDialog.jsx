import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import MarkdownContent from "./MarkdownContent";

// "Apply form" for an existing ticket: pick project → category → request type,
// optionally fill the form's fields, and convert. If the form lives in another
// project the ticket moves there (new ref). The submitter's title/description
// are kept; the form's template text is posted as a system note server-side.
export default function ApplyFormDialog({ open, ticket, onCancel, onApplied }) {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [categories, setCategories] = useState([]);
  const [forms, setForms] = useState([]);
  const [categoryId, setCategoryId] = useState("");
  const [formId, setFormId] = useState("");
  const [formMeta, setFormMeta] = useState(null);
  const [fields, setFields] = useState([]);
  const [values, setValues] = useState({});
  const [submitting, setSubmitting] = useState(false);

  // Reset + load projects whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setProjectId(String(ticket.project_id));
    setCategoryId(""); setFormId(""); setFormMeta(null); setFields([]); setValues({});
    api.get("/api/projects")
      .then((all) => setProjects(all.filter((p) => p.status === "active")))
      .catch(() => setProjects([]));
  }, [open, ticket.project_id]);

  // Categories + forms for the chosen project.
  useEffect(() => {
    if (!open || !projectId) return;
    setCategoryId(""); setFormId("");
    let alive = true;
    Promise.all([
      api.get(`/api/forms/categories?project_id=${projectId}`).catch(() => []),
      api.get(`/api/forms?project_id=${projectId}`).catch(() => []),
    ]).then(([cats, fms]) => {
      if (!alive) return;
      // Only categories that actually have an enabled form are useful here.
      const withForms = new Set(fms.map((f) => String(f.category_id)));
      setCategories(cats.filter((c) => withForms.has(String(c.id))));
      setForms(fms);
    });
    return () => { alive = false; };
  }, [open, projectId]);

  // Fields of the chosen form, seeded from the ticket's existing values so
  // shared fields carry over visibly.
  useEffect(() => {
    if (!formId) { setFormMeta(null); setFields([]); setValues({}); return; }
    let alive = true;
    api.get(`/api/forms/${formId}`).then((r) => {
      if (!alive) return;
      const fs = (r.fields || []).filter((f) => !f.computed);
      setFormMeta(r.form || null);
      setFields(fs);
      const cur = Array.isArray(ticket.custom_fields) ? ticket.custom_fields : [];
      const seed = {};
      fs.forEach((f) => {
        const v = cur.find((x) => x.def_id === f.def_id);
        if (f.type === "multiselect") seed[f.def_id] = v && Array.isArray(v.value) ? v.value : [];
        else if (f.type === "bool") seed[f.def_id] = v ? !!v.value : false;
        else seed[f.def_id] = v && v.value != null ? v.value : "";
      });
      setValues(seed);
    }).catch(() => { if (alive) { setFormMeta(null); setFields([]); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formId]);

  const inCategory = useMemo(
    () => forms.filter((f) => String(f.category_id) === String(categoryId)),
    [forms, categoryId],
  );

  if (!open) return null;

  const moving = projectId && String(projectId) !== String(ticket.project_id);
  const targetProject = projects.find((p) => String(p.id) === String(projectId));
  const sameForm = formId && Number(formId) === ticket.form_id;
  const tplTitle = (formMeta?.default_title || "").trim();
  const tplDesc = (formMeta?.default_description || "").trim();

  function pickCategory(cid) {
    setCategoryId(cid);
    const cat = categories.find((c) => String(c.id) === String(cid));
    const list = forms.filter((f) => String(f.category_id) === String(cid));
    const def = cat?.default_form_id && list.some((f) => f.id === cat.default_form_id)
      ? String(cat.default_form_id)
      : list.length === 1 ? String(list[0].id) : "";
    setFormId(def);
  }

  async function submit() {
    if (!formId || sameForm) return;
    setSubmitting(true);
    try {
      // Only send non-empty values; blanks are left for later.
      const custom_fields = fields
        .map((f) => ({ def_id: f.def_id, value: values[f.def_id] }))
        .filter(({ value }) => !(value == null || value === "" || (Array.isArray(value) && !value.length)));
      const r = await api.post(`/api/tickets/${ticket.id}/apply-form`, {
        form_id: Number(formId),
        ...(custom_fields.length ? { custom_fields } : {}),
      });
      toast.success(r.moved ? `Form applied · moved ${r.old_ref} → ${r.new_ref}` : "Form applied");
      if (r.missing_required?.length) {
        toast(`Still required: ${r.missing_required.join(", ")}`, { icon: "⚠️", duration: 6000 });
      }
      onApplied?.(r);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  const sel = "w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40";

  function control(f) {
    const v = values[f.def_id];
    const setV = (val) => setValues((p) => ({ ...p, [f.def_id]: val }));
    if (f.type === "bool") {
      return (
        <label className="inline-flex items-center gap-2 text-sm text-fg">
          <input type="checkbox" checked={!!v} onChange={(e) => setV(e.target.checked)} /> Yes
        </label>
      );
    }
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
        <select value={v ?? ""} onChange={(e) => setV(e.target.value)} className={sel}>
          <option value="">Select…</option>
          {(f.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    }
    const type = f.sensitive && f.type === "text" ? "password" : f.type === "number" ? "number" : f.type === "date" ? "date" : "text";
    const val = f.type === "date" && v ? String(v).slice(0, 10) : (v ?? "");
    return (
      <input type={type} value={val} onChange={(e) => setV(e.target.value)} className={sel}
        placeholder={f.help_text || ""} autoComplete={f.sensitive ? "new-password" : "off"} />
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 px-4">
      <div className="bg-surface border border-border rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] flex flex-col">
        <div className="p-5 pb-3">
          <h3 className="text-lg font-semibold text-fg mb-1">
            {ticket.form_id ? "Change request type" : "Apply form"}
          </h3>
          <p className="text-sm text-fg-muted">
            Convert <strong>{ticket.internal_ref}</strong> to a request type. The original
            title and description stay as filed. The form's template text and a
            summary of the changes are posted as a system note.
          </p>
        </div>

        <div className="px-5 space-y-3 overflow-y-auto">
          <div>
            <label className="block text-xs font-medium text-fg-muted mb-1">Project</label>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={sel}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.prefix}){p.id === ticket.project_id ? " · current" : ""}
                </option>
              ))}
            </select>
          </div>

          {categories.length === 0 ? (
            <p className="text-sm text-fg-muted">This project has no request forms.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-fg-muted mb-1">Category</label>
                <select value={categoryId} onChange={(e) => pickCategory(e.target.value)} className={sel}>
                  <option value="">Select…</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-fg-muted mb-1">Request type</label>
                <select value={formId} onChange={(e) => setFormId(e.target.value)} className={sel} disabled={!categoryId}>
                  <option value="">Select…</option>
                  {inCategory.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}{f.id === ticket.form_id ? " · current" : ""}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {moving && (
            <div className="text-xs rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 px-3 py-2">
              The ticket will move to <strong>{targetProject?.name}</strong> and get a new reference.
              Vendor contacts will be detached. Comments, attachments, history and followers carry over.
            </div>
          )}
          {sameForm && <p className="text-xs text-fg-muted">The ticket already uses this form.</p>}

          {formId && !sameForm && fields.length > 0 && (
            <div className="space-y-3 border border-border rounded-md p-3 bg-surface-2/30">
              <p className="text-xs text-fg-muted">
                Fill what you can now. Anything left blank can be completed from the Custom Fields panel.
              </p>
              {fields.map((f) => (
                <div key={f.def_id}>
                  <label className="block text-xs font-medium text-fg mb-1">
                    {f.label}{f.required && <span className="text-red-500"> *</span>}
                    {f.agent_only && <span className="ml-1 text-fg-muted font-normal">(agent)</span>}
                    {f.sensitive && <span className="ml-1">🔒</span>}
                  </label>
                  {control(f)}
                </div>
              ))}
            </div>
          )}

          {formId && !sameForm && (tplTitle || tplDesc) && (
            <div>
              <div className="text-xs font-medium text-fg-muted mb-1">Template text (posted as a system note)</div>
              <div className="text-sm border-l-2 border-brand/40 pl-3 text-fg-muted">
                {tplTitle && <div className="font-semibold text-fg">{tplTitle}</div>}
                {tplDesc && <MarkdownContent>{tplDesc}</MarkdownContent>}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 p-5 pt-4 border-t border-border mt-4">
          <button onClick={onCancel} className="btn-secondary btn btn-sm" disabled={submitting}>Cancel</button>
          <button
            onClick={submit}
            disabled={!formId || sameForm || submitting}
            className="btn-primary btn btn-sm disabled:opacity-50"
          >
            {submitting ? "Applying…" : moving ? "Move & apply" : "Apply form"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
