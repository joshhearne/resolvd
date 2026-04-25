import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
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

export default function NewTicket() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [projects, setProjects] = useState([]);
  const [form, setForm] = useState({
    project_id: "",
    title: "",
    description: "",
    impact: 2,
    urgency: 2,
    coastal_ticket_ref: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [duplicates, setDuplicates] = useState(null); // null = no check yet, [] = none found, [...] = matches
  const [pendingFiles, setPendingFiles] = useState([]);

  useEffect(() => {
    api
      .get("/api/projects")
      .then((all) => {
        const active = all.filter((p) => p.status === "active");
        setProjects(active);
        const defaultId = user?.defaultProjectId;
        if (defaultId && active.find((p) => p.id === defaultId)) {
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
      if (form.coastal_ticket_ref?.trim())
        qs.set("external_ref", form.coastal_ticket_ref.trim());
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
    setSubmitting(true);
    try {
      const ticket = await api.post("/api/tickets", {
        project_id: Number(form.project_id),
        title: form.title.trim(),
        description: form.description.trim() || null,
        impact: Number(form.impact),
        urgency: Number(form.urgency),
        coastal_ticket_ref: form.coastal_ticket_ref.trim() || null,
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

      toast.success(`Ticket ${ticket.mot_ref} created`);
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
    <div className="max-w-2xl">
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
        </div>

        <div>
          <label className="block text-sm font-medium text-fg mb-1">
            Title <span className="text-red-500">*</span>
          </label>
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
          <textarea
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            rows={4}
            className="w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
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
              value={form.coastal_ticket_ref}
              onChange={(e) => set("coastal_ticket_ref", e.target.value)}
              className="w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
              placeholder="External ticket ID if known"
            />
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
    </div>
  );
}
