import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import MarkdownContent from "../components/MarkdownContent";
import HybridTime from "../components/HybridTime";

const PRESET_KINDS = [
  { value: "daily",       label: "Daily" },
  { value: "weekly",      label: "Weekly (selected days)" },
  { value: "monthly_dom", label: "Monthly on day-N" },
  { value: "monthly_nth", label: "Monthly on the Nth weekday" },
  { value: "yearly",      label: "Yearly" },
];
const WEEKDAYS = [
  { v: 0, n: "Sun" }, { v: 1, n: "Mon" }, { v: 2, n: "Tue" },
  { v: 3, n: "Wed" }, { v: 4, n: "Thu" }, { v: 5, n: "Fri" }, { v: 6, n: "Sat" },
];

function defaultForm() {
  return {
    id: null,
    title: "",
    body: "",
    recurrence_kind: "once",
    due_at: localDatetimeNow(60),
    preset_kind: "daily",
    preset_config: { hour: 9, minute: 0, weekdays: [1], day: 1, nth: 1, weekday: 1, month: 1 },
    cron_expr: "0 9 * * 1",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    end_kind: "never",
    end_count: 1,
    end_date: "",
  };
}

// Format "now + minutes" as a value usable in <input type="datetime-local">.
function localDatetimeNow(addMinutes = 0) {
  const d = new Date(Date.now() + addMinutes * 60_000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function Tasks() {
  const [list, setList] = useState([]);
  const [statusFilter, setStatusFilter] = useState(new Set(["pending"]));
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [view, setView] = useState(null); // task detail viewer
  const [reschedule, setReschedule] = useState(null); // { id, value }

  async function reload() {
    setLoading(true);
    try {
      // Backend supports one status at a time — fan out + merge so the
      // chip toggles can show multiple categories together.
      const states = Array.from(statusFilter);
      const lists = await Promise.all(states.map((s) =>
        api.get(`/api/tasks?status=${encodeURIComponent(s)}`)
      ));
      const merged = lists.flat();
      // Stable sort: pending (due first) -> completed -> cancelled.
      merged.sort((a, b) => {
        const order = { pending: 0, completed: 1, cancelled: 2 };
        if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
        const da = a.next_due_at ? new Date(a.next_due_at).getTime() : Infinity;
        const db = b.next_due_at ? new Date(b.next_due_at).getTime() : Infinity;
        return da - db;
      });
      setList(merged);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); }, [statusFilter]); // eslint-disable-line

  async function save(form) {
    if (!form.title.trim()) { toast.error("Title required"); return; }
    try {
      const payload = buildPayload(form);
      if (form.id) {
        await api.patch(`/api/tasks/${form.id}`, payload);
      } else {
        await api.post(`/api/tasks`, payload);
      }
      toast.success("Saved");
      setEditing(null);
      reload();
    } catch (e) { toast.error(e.message); }
  }

  async function complete(id) {
    try {
      const r = await api.post(`/api/tasks/${id}/complete`, {});
      toast.success(r.completed ? "Task complete" : "Marked complete; next due scheduled");
      reload();
    } catch (e) { toast.error(e.message); }
  }
  async function skip(id) {
    try {
      await api.post(`/api/tasks/${id}/skip`, {});
      toast.success("Skipped to next due");
      reload();
    } catch (e) { toast.error(e.message); }
  }
  async function applyReschedule() {
    if (!reschedule) return;
    try {
      await api.post(`/api/tasks/${reschedule.id}/reschedule`, {
        next_due_at: new Date(reschedule.value).toISOString(),
      });
      toast.success("Rescheduled");
      setReschedule(null);
      reload();
    } catch (e) { toast.error(e.message); }
  }
  async function destroy(id) {
    if (!confirm("Delete this task? Completion history is dropped.")) return;
    try {
      await api.delete(`/api/tasks/${id}`);
      reload();
    } catch (e) { toast.error(e.message); }
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold text-fg">Tasks</h1>
        <button onClick={() => setEditing(defaultForm())} className="btn btn-primary btn-sm">New task</button>
      </div>

      <div className="flex items-center gap-1 flex-wrap text-sm">
        {["pending", "completed", "cancelled"].map((s) => {
          const on = statusFilter.has(s);
          return (
            <button key={s} type="button"
              onClick={() => setStatusFilter((prev) => {
                const next = new Set(prev);
                if (next.has(s)) next.delete(s); else next.add(s);
                if (next.size === 0) next.add("pending");
                return next;
              })}
              className={`text-[11px] uppercase tracking-wide px-2 py-1 rounded border ${on
                ? "bg-brand text-brand-fg border-brand font-semibold"
                : "bg-surface-2 text-fg-muted border-border"}`}>
              {s}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="text-sm text-fg-dim">Loading…</div>
      ) : !list.length ? (
        <div className="text-sm text-fg-dim text-center py-8">No tasks.</div>
      ) : (
        <div className="space-y-2">
          {list.map((t) => <TaskRow key={t.id}
            t={t}
            onView={() => setView(t)}
            onEdit={() => setEditing(populateForm(t))}
            onComplete={() => complete(t.id)}
            onSkip={() => skip(t.id)}
            onReschedule={() => setReschedule({
              id: t.id,
              value: t.next_due_at ? localDatetimeFromIso(t.next_due_at) : localDatetimeNow(60),
            })}
            onDelete={() => destroy(t.id)}
          />)}
        </div>
      )}

      {editing && (
        <EditModal form={editing} setForm={setEditing}
          onSave={() => save(editing)} onCancel={() => setEditing(null)} />
      )}
      {view && (
        <ViewModal task={view} onClose={() => setView(null)} onEdit={() => { setEditing(populateForm(view)); setView(null); }} />
      )}
      {reschedule && (
        <RescheduleModal value={reschedule.value}
          onChange={(v) => setReschedule((r) => ({ ...r, value: v }))}
          onApply={applyReschedule}
          onCancel={() => setReschedule(null)} />
      )}
    </div>
  );
}

function localDatetimeFromIso(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function populateForm(t) {
  return {
    id: t.id,
    title: t.title || "",
    body: t.body || "",
    recurrence_kind: t.recurrence_kind,
    due_at: t.next_due_at ? localDatetimeFromIso(t.next_due_at) : localDatetimeNow(60),
    preset_kind: t.preset_kind || "daily",
    preset_config: t.preset_config || defaultForm().preset_config,
    cron_expr: t.cron_expr || "0 9 * * 1",
    timezone: t.timezone || "UTC",
    end_kind: t.end_kind || "never",
    end_count: t.end_count || 1,
    end_date: t.end_date ? localDatetimeFromIso(t.end_date) : "",
  };
}

function buildPayload(f) {
  const p = {
    title: f.title,
    body: f.body,
    recurrence_kind: f.recurrence_kind,
    timezone: f.timezone || "UTC",
    end_kind: f.end_kind,
    end_count: f.end_kind === "count" ? Number(f.end_count) || 1 : null,
    end_date: f.end_kind === "date" && f.end_date ? new Date(f.end_date).toISOString() : null,
  };
  if (f.recurrence_kind === "once") {
    p.due_at = f.due_at ? new Date(f.due_at).toISOString() : null;
  } else if (f.recurrence_kind === "preset") {
    p.preset_kind = f.preset_kind;
    p.preset_config = f.preset_config;
  } else {
    p.cron_expr = f.cron_expr;
  }
  return p;
}

function TaskRow({ t, onView, onEdit, onComplete, onSkip, onReschedule, onDelete }) {
  const isPending = t.status === "pending";
  const overdue = isPending && t.next_due_at && new Date(t.next_due_at) <= new Date();
  return (
    <div className={`bg-surface border rounded-lg p-3 flex items-start gap-3 ${overdue ? "border-amber-400 dark:border-amber-700" : "border-border"}`}>
      <button
        type="button"
        aria-label={isPending ? "Mark complete" : "Already done"}
        onClick={isPending ? onComplete : undefined}
        className={`mt-0.5 w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 ${isPending
          ? "border-fg-muted hover:border-brand hover:bg-brand/10"
          : "border-emerald-500 bg-emerald-500 text-white"}`}>
        {!isPending && <span className="text-xs">✓</span>}
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <button onClick={onView} className="text-sm font-medium text-fg hover:underline text-left">
            {t.title || "(untitled)"}
          </button>
          {t.recurrence_kind !== "once" && (
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-surface-2 text-fg-muted">
              {t.recurrence_kind === "preset" ? t.preset_kind : "cron"}
            </span>
          )}
          {t.status !== "pending" && (
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-surface-2 text-fg-muted">
              {t.status}
            </span>
          )}
        </div>
        <div className={`text-xs ${overdue ? "text-amber-600 dark:text-amber-400 font-medium" : "text-fg-muted"} mt-0.5`}>
          {isPending
            ? (t.next_due_at ? <>Due <HybridTime value={t.next_due_at} /></> : <span className="text-fg-dim">no due time</span>)
            : (t.completed_at ? <>Completed <HybridTime value={t.completed_at} /></> : null)}
        </div>
      </div>
      {isPending && (
        <div className="flex items-center gap-2 text-xs whitespace-nowrap">
          <button onClick={onReschedule} className="text-fg-muted hover:text-fg">Reschedule</button>
          {t.recurrence_kind !== "once" && (
            <button onClick={onSkip} className="text-fg-muted hover:text-fg">Skip</button>
          )}
          <button onClick={onEdit} className="text-brand hover:underline">Edit</button>
          <button onClick={onDelete} className="text-red-600 dark:text-red-400 hover:underline">Delete</button>
        </div>
      )}
      {!isPending && (
        <div className="flex items-center gap-2 text-xs whitespace-nowrap">
          <button onClick={onDelete} className="text-red-600 dark:text-red-400 hover:underline">Delete</button>
        </div>
      )}
    </div>
  );
}

function ViewModal({ task, onClose, onEdit }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-lg max-w-2xl w-full max-h-[85vh] overflow-y-auto p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-fg">{task.title || "(untitled)"}</h2>
        <div className="text-xs text-fg-muted space-y-0.5">
          {task.next_due_at && <div>Next due: <HybridTime value={task.next_due_at} /></div>}
          {task.last_completed_at && <div>Last completed: <HybridTime value={task.last_completed_at} /></div>}
          {task.recurrence_kind !== "once" && (
            <div>Recurrence: <code className="font-mono">{task.cron_expr}</code> ({task.timezone})</div>
          )}
          {task.fires_count > 0 && <div>Fired {task.fires_count}x</div>}
        </div>
        {task.body ? (
          <div className="border-t border-border pt-3">
            <MarkdownContent>{task.body}</MarkdownContent>
          </div>
        ) : (
          <div className="text-sm text-fg-dim italic">no notes</div>
        )}
        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <button onClick={onEdit} className="btn btn-secondary btn-sm">Edit</button>
          <button onClick={onClose} className="btn btn-primary btn-sm">Close</button>
        </div>
      </div>
    </div>
  );
}

function RescheduleModal({ value, onChange, onApply, onCancel }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div className="bg-surface border border-border rounded-lg max-w-md w-full p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-fg">Reschedule</h2>
        <label className="text-xs text-fg-muted flex flex-col gap-1">New due time
          <input type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm" />
        </label>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="btn btn-secondary btn-sm">Cancel</button>
          <button onClick={onApply} className="btn btn-primary btn-sm">Reschedule</button>
        </div>
      </div>
    </div>
  );
}

function EditModal({ form, setForm, onSave, onCancel }) {
  function set(k, v) { setForm((p) => ({ ...p, [k]: v })); }
  function setCfg(k, v) { setForm((p) => ({ ...p, preset_config: { ...p.preset_config, [k]: v } })); }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div className="bg-surface border border-border rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-fg">{form.id ? "Edit task" : "New task"}</h2>

        <label className="text-xs text-fg-muted flex flex-col gap-1">Title *
          <input value={form.title} onChange={(e) => set("title", e.target.value)}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm" />
        </label>
        <label className="text-xs text-fg-muted flex flex-col gap-1">Notes (markdown)
          <textarea value={form.body} onChange={(e) => set("body", e.target.value)}
            rows={6}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono" />
        </label>

        <div className="border-t border-border pt-3 space-y-3">
          <div className="text-sm font-medium text-fg">When</div>
          <div className="flex gap-3 text-xs text-fg-muted">
            <label className="flex items-center gap-1">
              <input type="radio" name="rk" checked={form.recurrence_kind === "once"}
                onChange={() => set("recurrence_kind", "once")} /> One-off
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" name="rk" checked={form.recurrence_kind === "preset"}
                onChange={() => set("recurrence_kind", "preset")} /> Preset
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" name="rk" checked={form.recurrence_kind === "cron"}
                onChange={() => set("recurrence_kind", "cron")} /> Cron
            </label>
          </div>

          {form.recurrence_kind === "once" && (
            <label className="text-xs text-fg-muted flex flex-col gap-1 w-72">Due
              <input type="datetime-local" value={form.due_at}
                onChange={(e) => set("due_at", e.target.value)}
                className="bg-surface-2 border border-border rounded px-2 py-1 text-sm" />
            </label>
          )}

          {form.recurrence_kind === "preset" && (
            <PresetEditor kind={form.preset_kind} cfg={form.preset_config}
              onKind={(k) => set("preset_kind", k)} onCfg={setCfg} />
          )}

          {form.recurrence_kind === "cron" && (
            <div className="text-xs text-fg-muted space-y-1">
              <label className="flex flex-col gap-1">Cron expression
                <input value={form.cron_expr} onChange={(e) => set("cron_expr", e.target.value)}
                  className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono" />
              </label>
              <div className="text-[11px] text-fg-dim">
                <code className="font-mono">0 9 * * 1</code> = 9:00 every Monday ·
                <code className="font-mono"> 0 0 1 * *</code> = midnight on the 1st.
              </div>
            </div>
          )}

          {form.recurrence_kind !== "once" && (
            <label className="text-xs text-fg-muted flex flex-col gap-1 w-72">Timezone
              <input value={form.timezone} onChange={(e) => set("timezone", e.target.value)}
                className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono" />
            </label>
          )}
        </div>

        {form.recurrence_kind !== "once" && (
          <div className="border-t border-border pt-3 space-y-2">
            <div className="text-sm font-medium text-fg">Stops</div>
            <div className="flex gap-3 text-xs text-fg-muted">
              {[["never", "Never"], ["count", "After N times"], ["date", "Until date"]].map(([k, label]) => (
                <label key={k} className="flex items-center gap-1">
                  <input type="radio" name="ek" checked={form.end_kind === k}
                    onChange={() => set("end_kind", k)} /> {label}
                </label>
              ))}
            </div>
            {form.end_kind === "count" && (
              <label className="flex flex-col gap-1 text-xs text-fg-muted w-32">N
                <input type="number" min="1" value={form.end_count}
                  onChange={(e) => set("end_count", e.target.value)}
                  className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono" />
              </label>
            )}
            {form.end_kind === "date" && (
              <label className="flex flex-col gap-1 text-xs text-fg-muted w-72">End date / time
                <input type="datetime-local" value={form.end_date}
                  onChange={(e) => set("end_date", e.target.value)}
                  className="bg-surface-2 border border-border rounded px-2 py-1 text-sm" />
              </label>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <button onClick={onCancel} className="btn btn-secondary btn-sm">Cancel</button>
          <button onClick={onSave} className="btn btn-primary btn-sm">{form.id ? "Save" : "Create"}</button>
        </div>
      </div>
    </div>
  );
}

function PresetEditor({ kind, cfg, onKind, onCfg }) {
  return (
    <div className="space-y-2 text-xs text-fg-muted">
      <label className="flex flex-col gap-1 w-64">Preset
        <select value={kind} onChange={(e) => onKind(e.target.value)}
          className="bg-surface-2 border border-border rounded px-2 py-1 text-sm">
          {PRESET_KINDS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </label>
      <div className="flex gap-2">
        <label className="flex flex-col gap-1 w-24">Hour
          <input type="number" min="0" max="23" value={cfg.hour}
            onChange={(e) => onCfg("hour", parseInt(e.target.value, 10) || 0)}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono" />
        </label>
        <label className="flex flex-col gap-1 w-24">Minute
          <input type="number" min="0" max="59" value={cfg.minute}
            onChange={(e) => onCfg("minute", parseInt(e.target.value, 10) || 0)}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono" />
        </label>
      </div>
      {kind === "weekly" && (
        <div>
          <div className="mb-1">Weekdays</div>
          <div className="flex gap-1 flex-wrap">
            {WEEKDAYS.map((d) => {
              const active = Array.isArray(cfg.weekdays) && cfg.weekdays.includes(d.v);
              return (
                <button key={d.v} type="button"
                  onClick={() => {
                    const list = Array.isArray(cfg.weekdays) ? cfg.weekdays : [];
                    onCfg("weekdays", active ? list.filter((x) => x !== d.v) : [...list, d.v]);
                  }}
                  className={`px-2 py-1 rounded border text-xs ${active ? "bg-brand text-brand-fg border-brand" : "border-border bg-surface-2"}`}>
                  {d.n}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {kind === "monthly_dom" && (
        <label className="flex flex-col gap-1 w-24">Day (1–28)
          <input type="number" min="1" max="28" value={cfg.day}
            onChange={(e) => onCfg("day", parseInt(e.target.value, 10) || 1)}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono" />
        </label>
      )}
      {kind === "monthly_nth" && (
        <div className="flex gap-2">
          <label className="flex flex-col gap-1 w-32">Nth
            <select value={cfg.nth} onChange={(e) => onCfg("nth", parseInt(e.target.value, 10))}
              className="bg-surface-2 border border-border rounded px-2 py-1 text-sm">
              <option value={1}>1st</option><option value={2}>2nd</option>
              <option value={3}>3rd</option><option value={4}>4th</option>
              <option value={5}>Last</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 w-32">Weekday
            <select value={cfg.weekday} onChange={(e) => onCfg("weekday", parseInt(e.target.value, 10))}
              className="bg-surface-2 border border-border rounded px-2 py-1 text-sm">
              {WEEKDAYS.map((d) => <option key={d.v} value={d.v}>{d.n}</option>)}
            </select>
          </label>
        </div>
      )}
      {kind === "yearly" && (
        <div className="flex gap-2">
          <label className="flex flex-col gap-1 w-24">Month
            <input type="number" min="1" max="12" value={cfg.month}
              onChange={(e) => onCfg("month", parseInt(e.target.value, 10) || 1)}
              className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono" />
          </label>
          <label className="flex flex-col gap-1 w-24">Day (1–28)
            <input type="number" min="1" max="28" value={cfg.day}
              onChange={(e) => onCfg("day", parseInt(e.target.value, 10) || 1)}
              className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono" />
          </label>
        </div>
      )}
    </div>
  );
}
