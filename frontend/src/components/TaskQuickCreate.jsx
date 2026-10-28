import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// Lightweight task creator that drops over the current page so the
// user keeps context. Reuses the same shape as the full Tasks editor
// for the common case (title + body + one-off due time OR a daily/
// weekly preset). Power users can refine after creation from /tasks.
//
// Props:
//   open                  bool
//   onClose()             dismiss without saving
//   onCreated(task)       optional callback after a successful POST
//   defaultTicketId       prefill the ticket_id linkage (when invoked
//                         from a ticket page so the new follow-up
//                         carries the source ref)
//   defaultTitle          optional prefill for the title input
export default function TaskQuickCreate({ open, onClose, onCreated, defaultTicketId, defaultTitle = "" }) {
  const [title, setTitle] = useState(defaultTitle);
  const [body, setBody] = useState("");
  const [mode, setMode] = useState("once"); // once | daily | weekly
  const [dueAt, setDueAt] = useState(() => localTomorrow9am());
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [weekdays, setWeekdays] = useState([1]);
  const [saving, setSaving] = useState(false);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  useEffect(() => {
    if (!open) return;
    setTitle(defaultTitle || "");
    setBody("");
    setMode("once");
    setDueAt(localTomorrow9am());
    setHour(9);
    setMinute(0);
    setWeekdays([1]);
  }, [open, defaultTitle]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  function toggleWeekday(d) {
    setWeekdays((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]);
  }

  async function save() {
    if (!title.trim()) { toast.error("Title required"); return; }
    setSaving(true);
    try {
      const payload = {
        title: title.trim(),
        body: body || "",
        timezone: tz,
        end_kind: "never",
        ticket_id: defaultTicketId || undefined,
      };
      if (mode === "once") {
        payload.recurrence_kind = "once";
        payload.due_at = dueAt ? new Date(dueAt).toISOString() : null;
      } else {
        payload.recurrence_kind = "preset";
        payload.preset_kind = mode === "daily" ? "daily" : "weekly";
        payload.preset_config = mode === "daily"
          ? { hour, minute }
          : { hour, minute, weekdays: weekdays.length ? weekdays : [1] };
      }
      const r = await api.post(`/api/tasks`, payload);
      toast.success("Task created");
      onCreated?.(r);
      onClose?.();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  // Portal to <body> so the modal escapes the sticky header's
  // backdrop-filter / transform stacking context. Without this the
  // header (z-30) renders ABOVE the modal's z-[100] overlay AND its
  // backdrop-blur makes `fixed inset-0` resolve against the header
  // box instead of the viewport, clipping the modal at the top.
  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4"
         onClick={onClose}>
      <div className="bg-surface border border-border rounded-lg max-w-lg w-full p-5 space-y-3"
           onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-fg">Quick task</h2>
          {defaultTicketId && (
            <span className="text-[10px] uppercase tracking-wide bg-brand/10 text-brand border border-brand/30 rounded px-1.5 py-0.5">
              Linked to ticket
            </span>
          )}
        </div>

        <label className="text-xs text-fg-muted flex flex-col gap-1">Title *
          <input value={title} onChange={(e) => setTitle(e.target.value)}
            autoFocus
            placeholder="What needs doing?"
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm" />
        </label>

        <label className="text-xs text-fg-muted flex flex-col gap-1">Notes (markdown — optional)
          <textarea value={body} onChange={(e) => setBody(e.target.value)}
            rows={3}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono" />
        </label>

        <div className="text-xs text-fg-muted space-y-2">
          <div className="flex gap-3">
            {[["once", "One-off"], ["daily", "Daily"], ["weekly", "Weekly"]].map(([k, label]) => (
              <label key={k} className="flex items-center gap-1">
                <input type="radio" name="qt-mode" checked={mode === k}
                  onChange={() => setMode(k)} /> {label}
              </label>
            ))}
          </div>

          {mode === "once" && (
            <label className="flex flex-col gap-1 w-72">Due
              <input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)}
                className="bg-surface-2 border border-border rounded px-2 py-1 text-sm" />
            </label>
          )}

          {mode !== "once" && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <label className="flex flex-col gap-1 w-20">Hour
                  <input type="number" min="0" max="23" value={hour}
                    onChange={(e) => setHour(parseInt(e.target.value, 10) || 0)}
                    className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono" />
                </label>
                <label className="flex flex-col gap-1 w-20">Minute
                  <input type="number" min="0" max="59" value={minute}
                    onChange={(e) => setMinute(parseInt(e.target.value, 10) || 0)}
                    className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono" />
                </label>
              </div>
              {mode === "weekly" && (
                <div className="flex gap-1 flex-wrap">
                  {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((n, i) => {
                    const on = weekdays.includes(i);
                    return (
                      <button key={i} type="button" onClick={() => toggleWeekday(i)}
                        className={`px-2 py-1 rounded border text-xs ${on
                          ? "bg-brand text-brand-fg border-brand"
                          : "bg-surface-2 border-border text-fg-muted"}`}>
                        {n}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          <div className="text-[10px] text-fg-dim">Timezone: {tz}</div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <button onClick={onClose} className="btn btn-secondary btn-sm">Cancel</button>
          <button onClick={save} disabled={saving} className="btn btn-primary btn-sm disabled:opacity-60">
            {saving ? "Saving…" : "Create"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function localTomorrow9am() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
