import React, { useState, useEffect } from "react";
import { useNavigate, useSearchParams, useParams } from "react-router-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import {
  computePriority,
  IMPACT_LABELS,
  URGENCY_LABELS,
} from "../utils/helpers";
import PriorityBadge from "../components/PriorityBadge";
import { useAuth } from "../context/AuthContext";
import DuplicateWarningModal from "../components/DuplicateWarningModal";
import MarkdownEditor from "../components/MarkdownEditor";
import AiRewriteButton from "../components/AiRewriteButton";
import PageShell from "../components/PageShell";

export default function NewTicket() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryProjectId = searchParams.get("project_id")
    ? Number(searchParams.get("project_id"))
    : null;
  const fromFilter = searchParams.get("from_filter") === "1";
  // Deep-link path: /tickets/new/<project-prefix>/<category-slug>/<form-slug>
  const splat = (useParams()["*"] || "").split("/").filter(Boolean);
  const [pathProject, pathCategory, pathForm] = splat;
  const { user } = useAuth();
  const [projects, setProjects] = useState([]);
  const [form, setForm] = useState({
    project_id: "",
    title: "",
    description: "",
    impact: 2,
    urgency: 2,
    external_ticket_ref: "",
  });
  // Captured from the AI modal when the user accepts a description
  // rewrite. Sent up with the ticket POST + cleared on submit.
  const [aiLogId, setAiLogId] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [duplicates, setDuplicates] = useState(null); // null = no check yet, [] = none found, [...] = matches
  const [pendingFiles, setPendingFiles] = useState([]);
  const [projectContacts, setProjectContacts] = useState([]);
  const [selectedContactIds, setSelectedContactIds] = useState([]);
  const [users, setUsers] = useState([]);
  const [onBehalfOfId, setOnBehalfOfId] = useState("");
  const canFileOnBehalf = ["Admin", "Manager"].includes(user?.role);
  // Project-scoped custom forms: category → request-type form → custom fields.
  const [categories, setCategories] = useState([]);
  const [projectForms, setProjectForms] = useState([]);
  const [categoryId, setCategoryId] = useState("");
  const [formId, setFormId] = useState("");
  const [formFields, setFormFields] = useState([]);
  const [cfValues, setCfValues] = useState({}); // def_id -> value

  useEffect(() => {
    if (!canFileOnBehalf) return;
    api.get("/api/users").then(setUsers).catch(() => setUsers([]));
  }, [canFileOnBehalf]);

  useEffect(() => {
    api
      .get("/api/projects")
      .then((all) => {
        const active = all.filter((p) => p.status === "active");
        setProjects(active);
        // Precedence: deep-link path prefix > ?project_id query > user default > only-one.
        const defaultId = user?.defaultProjectId;
        const pathProj = pathProject && active.find((p) => String(p.prefix).toLowerCase() === pathProject.toLowerCase());
        if (pathProj) {
          setForm((f) => ({ ...f, project_id: pathProj.id }));
        } else if (queryProjectId && active.find((p) => p.id === queryProjectId)) {
          setForm((f) => ({ ...f, project_id: queryProjectId }));
          if (
            fromFilter &&
            defaultId &&
            queryProjectId !== defaultId
          ) {
            const proj = active.find((p) => p.id === queryProjectId);
            const def = active.find((p) => p.id === defaultId);
            toast(
              `Scope set to ${proj?.name || "filtered project"} (your default is ${def?.name || "another project"}).`,
              { icon: "ℹ️", duration: 5000 },
            );
          }
        } else if (defaultId && active.find((p) => p.id === defaultId)) {
          setForm((f) => ({ ...f, project_id: defaultId }));
        } else if (active.length === 1) {
          setForm((f) => ({ ...f, project_id: active[0].id }));
        }
      })
      .catch(() => toast.error("Failed to load projects"));
  }, []);

  const computed = computePriority(form.impact, form.urgency);
  const selectedProject = projects.find(
    (p) => String(p.id) === String(form.project_id),
  );
  const hasExternalVendor = selectedProject
    ? selectedProject.has_external_vendor !== false
    : true;

  useEffect(() => {
    if (!form.project_id) { setProjectContacts([]); setSelectedContactIds([]); return; }
    const proj = projects.find(p => String(p.id) === String(form.project_id));
    if (!proj || proj.has_external_vendor === false) { setProjectContacts([]); setSelectedContactIds([]); return; }
    api.get(`/api/projects/${form.project_id}/contacts`)
      .then(setProjectContacts)
      .catch(() => setProjectContacts([]));
    setSelectedContactIds([]);
  }, [form.project_id, projects]);

  // Load this project's categories + forms for the request-type picker.
  // Reset any prior selection when the project changes.
  useEffect(() => {
    setCategoryId(""); setFormId(""); setFormFields([]); setCfValues({});
    setCategories([]); setProjectForms([]);
    if (!form.project_id) return;
    let alive = true;
    Promise.all([
      api.get(`/api/forms/categories?project_id=${form.project_id}`).catch(() => []),
      api.get(`/api/forms?project_id=${form.project_id}`).catch(() => []),
    ]).then(([cats, fms]) => {
      if (!alive) return;
      setCategories(cats); setProjectForms(fms);
      // Deep-link: resolve category + form by slug from the URL path.
      if (!pathCategory) return;
      const cat = cats.find((c) => c.slug === pathCategory);
      if (!cat) return;
      setCategoryId(String(cat.id));
      const inCat = fms.filter((x) => String(x.category_id) === String(cat.id));
      if (pathForm) {
        const f = inCat.find((x) => x.slug === pathForm);
        if (f) setFormId(String(f.id));
      } else if (cat.default_form_id && inCat.some((x) => x.id === cat.default_form_id)) {
        setFormId(String(cat.default_form_id));
      } else if (inCat.length === 1) {
        setFormId(String(inCat[0].id));
      }
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.project_id]);

  // When a form is chosen, fetch its bound fields + seed default values.
  useEffect(() => {
    if (!formId) { setFormFields([]); setCfValues({}); return; }
    api.get(`/api/forms/${formId}`).then((r) => {
      // Agent-only fields never render on the submitter form; agents filing
      // can still fill them here. Backend re-enforces this on create.
      const isAgent = ["Admin", "Manager", "Tech"].includes(user?.role);
      const fields = (r.fields || []).filter((f) => isAgent || !f.agent_only);
      setFormFields(fields);
      const seed = {};
      fields.forEach((f) => { seed[f.def_id] = f.type === "bool" ? false : ""; });
      // Deep-link prefills: ?<field-slug>=<value>. Selects take a 1-based
      // option number; bools take 1/true; others take the literal value.
      fields.forEach((f) => {
        const raw = searchParams.get(f.slug);
        if (raw == null) return;
        if (f.type === "select") {
          const opt = (f.options || [])[parseInt(raw, 10) - 1];
          if (opt) seed[f.def_id] = opt.value;
        } else if (f.type === "bool") {
          seed[f.def_id] = raw === "1" || raw.toLowerCase() === "true";
        } else {
          seed[f.def_id] = raw;
        }
      });
      setCfValues(seed);
      // Pre-fill Title/Description from the form's boilerplate, but never
      // clobber what the user already typed.
      const meta = r.form || {};
      setForm((prev) => ({
        ...prev,
        title: prev.title?.trim() ? prev.title : (meta.default_title || ""),
        description: prev.description?.trim() ? prev.description : (meta.default_description || ""),
      }));
    }).catch(() => { setFormFields([]); setCfValues({}); });
  }, [formId]);

  function renderField(f) {
    const v = cfValues[f.def_id];
    const setV = (val) => setCfValues((p) => ({ ...p, [f.def_id]: val }));
    const cls = "w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40";
    if (f.type === "bool") {
      return (
        <label className="inline-flex items-center gap-2 text-sm text-fg">
          <input type="checkbox" checked={!!v} onChange={(e) => setV(e.target.checked)} />
          {f.label}{f.required && <span className="text-red-500">*</span>}
        </label>
      );
    }
    const inputType = f.sensitive && f.type === "text" ? "password"
      : f.type === "number" ? "number" : f.type === "date" ? "date" : "text";
    return (
      <div>
        <label className="block text-sm font-medium text-fg mb-1">
          {f.label}{f.required && <span className="text-red-500"> *</span>}
          {f.sensitive && <span className="ml-1 text-xs text-fg-muted">(sensitive)</span>}
        </label>
        {f.type === "select" ? (
          <select value={v ?? ""} onChange={(e) => setV(e.target.value)} className={cls}>
            <option value="">Select…</option>
            {(f.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : (
          <input type={inputType} value={v ?? ""} onChange={(e) => setV(e.target.value)}
            className={cls} placeholder={f.help_text || ""} autoComplete={f.sensitive ? "new-password" : "off"} />
        )}
        {f.help_text && f.type !== "select" && <p className="text-xs text-fg-muted mt-1">{f.help_text}</p>}
      </div>
    );
  }

  function toggleContact(id) {
    setSelectedContactIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  }

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.project_id) {
      toast.error("Select a project");
      return;
    }
    if (!form.title.trim()) {
      toast.error("Title required");
      return;
    }

    // Skip duplicate check if user already dismissed the warning
    if (duplicates !== null) {
      doCreate();
      return;
    }

    try {
      const qs = new URLSearchParams({ title: form.title.trim() });
      if (form.external_ticket_ref?.trim())
        qs.set("external_ref", form.external_ticket_ref.trim());
      if (form.project_id) qs.set("project_id", form.project_id);
      const matches = await api.get(`/api/tickets/similar?${qs}`);
      if (matches.length > 0) {
        setDuplicates(matches);
      } else {
        doCreate();
      }
    } catch (err) {
      console.error("Duplicate check failed:", err);
      toast(
        "Could not check for duplicates — please verify no similar ticket exists before submitting.",
        {
          icon: "⚠️",
          duration: 6000,
        },
      );
      setDuplicates([]); // treat as checked so next submit goes through
      // Don't auto-create — let user confirm with a second submit
    }
  }

  async function doCreate() {
    // Client-side required-field guard (server re-validates against the form).
    for (const f of formFields) {
      if (!f.required) continue;
      const v = cfValues[f.def_id];
      const empty = v == null || v === "" || (f.type === "bool" && !v);
      if (empty) { toast.error(`"${f.label}" is required`); return; }
    }
    setSubmitting(true);
    try {
      const ticket = await api.post("/api/tickets", {
        project_id: Number(form.project_id),
        title: form.title.trim(),
        description: form.description.trim() || null,
        impact: Number(form.impact),
        urgency: Number(form.urgency),
        external_ticket_ref: form.external_ticket_ref.trim() || null,
        contact_ids: selectedContactIds,
        submitted_by: onBehalfOfId ? Number(onBehalfOfId) : undefined,
        ...(aiLogId ? { ai_rewrite_log_id: aiLogId } : {}),
        ...(formId ? { form_id: Number(formId) } : {}),
        ...(formFields.length ? { custom_fields: formFields.map((f) => ({ def_id: f.def_id, value: cfValues[f.def_id] })) } : {}),
      });

      if (pendingFiles.length > 0) {
        const fd = new FormData();
        pendingFiles.forEach((f) => fd.append("files", f));
        try {
          const res = await fetch(`/api/tickets/${ticket.id}/attachments`, {
            method: "POST",
            credentials: "include",
            body: fd,
          });
          if (!res.ok) throw new Error("attachment upload failed");
        } catch (err) {
          toast.error(
            "Ticket created, but some attachments failed to upload. Add them from the ticket page.",
          );
        }
      }

      toast.success(`Ticket ${ticket.internal_ref} created`);
      navigate(`/tickets/${ticket.id}`);
    } catch (err) {
      toast.error(err.message);
      setSubmitting(false);
    }
  }

  function addFiles(fileList) {
    const incoming = Array.from(fileList || []);
    if (incoming.length === 0) return;
    setPendingFiles((prev) => [...prev, ...incoming]);
  }

  function removeFile(idx) {
    setPendingFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  return (
    <PageShell variant="narrow">
      {duplicates?.length > 0 && (
        <DuplicateWarningModal
          matches={duplicates}
          newDescription={form.description}
          onCreateAnyway={() => {
            setDuplicates([]);
            doCreate();
          }}
          onClose={() => setDuplicates(null)}
        />
      )}
      <h1 className="text-xl font-semibold text-fg mb-6">New Ticket</h1>
      <form
        onSubmit={handleSubmit}
        className="bg-surface rounded-lg border border-border shadow-sm p-6 space-y-5"
      >
        <div>
          <label className="block text-sm font-medium text-fg mb-1">
            Project <span className="text-red-500">*</span>
          </label>
          <select
            value={form.project_id}
            onChange={(e) => set("project_id", e.target.value)}
            className="w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
          >
            <option value="">Select project…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.prefix})
              </option>
            ))}
          </select>
          {canFileOnBehalf && (
            <div className="mt-3">
              <label className="block text-sm font-medium text-fg mb-1">
                Submit on behalf of{" "}
                <span className="text-fg-muted font-normal">
                  (optional — defaults to you)
                </span>
              </label>
              <select
                value={onBehalfOfId}
                onChange={(e) => setOnBehalfOfId(e.target.value)}
                className="w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
              >
                <option value="">Yourself ({user?.displayName || user?.email})</option>
                {users
                  .filter((u) => u.id !== user?.id && u.status === "active")
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.display_name || u.email} ({u.role})
                    </option>
                  ))}
              </select>
            </div>
          )}
        </div>

        {categories.length > 0 && (
          <div className="space-y-4 border border-border rounded-md p-4 bg-surface-2/30">
            <div>
              <label className="block text-sm font-medium text-fg mb-1">
                Category{" "}
                <span className="text-fg-muted font-normal">(optional)</span>
              </label>
              <select
                value={categoryId}
                onChange={(e) => {
                  const cid = e.target.value;
                  setCategoryId(cid);
                  // Pre-select the category's default form, or the only form if
                  // there's just one; otherwise leave it to the user.
                  const cat = categories.find((c) => String(c.id) === String(cid));
                  const inCat = projectForms.filter((f) => String(f.category_id) === String(cid));
                  const def = cat?.default_form_id && inCat.some((f) => f.id === cat.default_form_id)
                    ? String(cat.default_form_id)
                    : (inCat.length === 1 ? String(inCat[0].id) : "");
                  setFormId(def);
                }}
                className="w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
              >
                <option value="">No category</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            {categoryId && (
              <div>
                <label className="block text-sm font-medium text-fg mb-1">Request type</label>
                <select
                  value={formId}
                  onChange={(e) => setFormId(e.target.value)}
                  className="w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
                >
                  <option value="">Select form…</option>
                  {projectForms
                    .filter((f) => String(f.category_id) === String(categoryId))
                    .map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </div>
            )}
            {formFields.map((f) => (
              <React.Fragment key={f.def_id}>{renderField(f)}</React.Fragment>
            ))}
          </div>
        )}

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-sm font-medium text-fg">
              Title <span className="text-red-500">*</span>
            </label>
            <AiRewriteButton
              value={form.title}
              surface="ticket_subject"
              projectId={form.project_id || null}
              size="xs"
              onChange={(t, meta) => {
                set("title", t);
                if (meta?.logId) setAiLogId(meta.logId);
              }}
            />
          </div>
          <input
            type="text"
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
            className="w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
            placeholder="Brief description of the issue"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-fg mb-1">
            Description
          </label>
          <MarkdownEditor
            aiSurface="ticket_description"
            aiProjectId={form.project_id || null}
            value={form.description}
            onChange={(e) => {
              set("description", e.target.value);
              if (Object.prototype.hasOwnProperty.call(e.target, "_aiLogId")) {
                setAiLogId(e.target._aiLogId);
              }
            }}
            rows={4}
            placeholder="Steps to reproduce, expected vs actual behavior, etc."
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-fg mb-1">
              Impact
            </label>
            <select
              value={form.impact}
              onChange={(e) => set("impact", Number(e.target.value))}
              className="w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
            >
              {[1, 2, 3].map((v) => (
                <option key={v} value={v}>
                  {IMPACT_LABELS[v]}
                </option>
              ))}
            </select>
            <p className="text-xs text-fg-dim mt-1">
              How severely does this affect operations?
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-fg mb-1">
              Urgency
            </label>
            <select
              value={form.urgency}
              onChange={(e) => set("urgency", Number(e.target.value))}
              className="w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
            >
              {[1, 2, 3].map((v) => (
                <option key={v} value={v}>
                  {URGENCY_LABELS[v]}
                </option>
              ))}
            </select>
            <p className="text-xs text-fg-dim mt-1">
              How soon does this need to be resolved?
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 bg-surface-2 rounded-md px-4 py-3 border border-border">
          <span className="text-sm font-medium text-fg-muted">
            Computed Priority:
          </span>
          <PriorityBadge priority={computed} />
          <span className="text-xs text-fg-dim">
            (Impact {form.impact} + Urgency {form.urgency})
          </span>
        </div>

        {hasExternalVendor && (
          <div>
            <label className="block text-sm font-medium text-fg mb-1">
              External Ticket Ref{" "}
              <span className="text-fg-dim font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={form.external_ticket_ref}
              onChange={(e) => set("external_ticket_ref", e.target.value)}
              className="w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
              placeholder="External ticket ID if known"
            />
          </div>
        )}

        {hasExternalVendor && projectContacts.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-fg mb-1">
              Vendor Contacts{" "}
              <span className="text-fg-dim font-normal">(optional)</span>
            </label>
            <div className="border border-border rounded-md divide-y divide-border max-h-48 overflow-y-auto">
              {(() => {
                const byCompany = projectContacts.reduce((acc, c) => {
                  const key = c.company_id;
                  if (!acc[key]) acc[key] = { name: c.company_name, contacts: [] };
                  acc[key].contacts.push(c);
                  return acc;
                }, {});
                return Object.values(byCompany).map(group => (
                  <div key={group.name}>
                    <div className="px-3 py-1 bg-surface-2 text-[11px] font-semibold text-fg-muted uppercase tracking-wide">
                      {group.name}
                    </div>
                    {group.contacts.map(c => (
                      <label key={c.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedContactIds.includes(c.id)}
                          onChange={() => toggleContact(c.id)}
                          className="rounded"
                        />
                        <span className="text-sm text-fg">{c.name}</span>
                        {c.role_title && <span className="text-xs text-fg-muted">· {c.role_title}</span>}
                        {c.email && <span className="text-xs text-fg-dim ml-auto">{c.email}</span>}
                      </label>
                    ))}
                  </div>
                ));
              })()}
            </div>
            {selectedContactIds.length > 0 && (
              <p className="text-xs text-fg-muted mt-1">
                {selectedContactIds.length} contact{selectedContactIds.length !== 1 ? "s" : ""} will be attached
              </p>
            )}
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-fg mb-1">
            Attachments{" "}
            <span className="text-fg-dim font-normal">(optional)</span>
          </label>
          <div className="flex items-center gap-2">
            <label className="btn-secondary btn btn-sm cursor-pointer">
              + Add files
              <input
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <span className="text-xs text-fg-dim">
              {pendingFiles.length === 0
                ? "Any file type · 50 MB max each"
                : `${pendingFiles.length} file${pendingFiles.length === 1 ? "" : "s"} ready`}
            </span>
          </div>
          {pendingFiles.length > 0 && (
            <ul className="mt-2 divide-y divide-border border border-border rounded-md">
              {pendingFiles.map((f, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between px-3 py-2 text-sm"
                >
                  <span className="truncate text-fg">{f.name}</span>
                  <span className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-xs text-fg-dim">
                      {(f.size / 1024).toFixed(0)} KB
                    </span>
                    <button
                      type="button"
                      onClick={() => removeFile(i)}
                      className="text-xs text-fg-dim hover:text-red-500 transition-colors"
                    >
                      Remove
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={submitting}
            className="btn-primary btn disabled:opacity-60"
          >
            {submitting ? "Creating..." : "Create Ticket"}
          </button>
          <button
            type="button"
            onClick={() => navigate("/tickets")}
            className="btn-secondary btn"
          >
            Cancel
          </button>
        </div>
      </form>
    </PageShell>
  );
}
