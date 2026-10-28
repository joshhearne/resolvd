import { useState } from "react";
import TimeField from "./TimeField";
import AiRewriteButton from "./AiRewriteButton";
import NumberInput from "./NumberInput";
import {
  TRIANGLE_KEYS, editTriangle, formatShortDate, sameDay, toDateInput,
} from "../utils/timeEntry";

// Log or edit a time entry. Start, duration and stop form a triangle:
// edit any two and the third follows. The piece recomputed is always the
// one touched least recently, e.g. set start 8:30 + duration 30m → stop
// fills in 9:00; then move stop to 9:15 → start becomes 8:45.
//
// Reset puts every field back the way the form opened.

function DurationInputs({ minutes, onChange, highlight }) {
  const total = Math.max(0, Number(minutes) || 0);
  const h = Math.floor(total / 60);
  const m = total % 60;
  const set = (nh, nm) => onChange(Math.max(0, (Number(nh) || 0) * 60 + (Number(nm) || 0)));
  const cls = `input w-16 py-1 ${highlight ? "bg-brand/5" : ""}`;
  return (
    <span className="inline-flex items-center gap-1">
      <NumberInput min="0" max="24" value={h} emptyValue={0} onChange={(n) => set(n, m)} className={cls} aria-label="Hours" />
      <span className="text-xs text-fg-muted">h</span>
      <NumberInput min="0" max="59" value={m} emptyValue={0} onChange={(n) => set(h, n)} className={cls} aria-label="Minutes" />
      <span className="text-xs text-fg-muted">m</span>
    </span>
  );
}

function fmtMinutes(minutes) {
  const t = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(t / 60);
  const r = t % 60;
  if (!h) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

const FUTURE_SLACK_MS = 5 * 60 * 1000;

export default function TimeEntryForm({
  initial,           // { start: Date, end: Date, minutes, note, visibility, work_type_id }
  workTypes = [],    // active work types; the picker hides when there are none
  settings,          // time-tracking settings (min_note_chars, can_choose_visibility, default_visibility)
  showVisibility = true,
  submitLabel = "Log",
  busy = false,
  onSubmit,          // ({ started_at, ended_at, minutes, note, visibility, work_type_id }, andStatus?) => Promise
  onCancel,
  renderStatusAction, // optional ({ disabled, onPick(status) }) => node — "Log & <status>" menu
  aiProjectId = null, // project context for the note's AI rewrite
}) {
  const fresh = () => ({
    values: { start: new Date(initial.start), end: new Date(initial.end), minutes: initial.minutes },
    order: [...TRIANGLE_KEYS],
    note: initial.note || "",
    visibility: initial.visibility || settings.default_visibility || "private",
    workTypeId: initial.work_type_id ?? null,
  });
  const [state, setState] = useState(fresh);
  const { values, order, note, visibility, workTypeId } = state;

  const edit = (key, value) =>
    setState((s) => ({ ...s, ...editTriangle(s.values, s.order, key, value) }));

  const minChars = settings.min_note_chars || 1;
  const noteLen = note.trim().length;
  let problem = null;
  if (values.minutes <= 0 || values.end <= values.start) problem = "Stop must be after start";
  else if (values.minutes > 24 * 60) problem = "A single entry cannot exceed 24 hours";
  else if (values.end.getTime() > Date.now() + FUTURE_SLACK_MS) problem = "Stop time is in the future";

  function setEndDate(ymd) {
    if (!ymd) return;
    const [y, mo, d] = ymd.split("-").map(Number);
    const next = new Date(values.end);
    next.setFullYear(y, mo - 1, d);
    edit("end", next);
  }

  async function submit(e, andStatus = null) {
    e?.preventDefault();
    if (problem || noteLen < minChars) return;
    await onSubmit({
      started_at: values.start.toISOString(),
      ended_at: values.end.toISOString(),
      minutes: values.minutes,
      note: note.trim(),
      visibility,
      work_type_id: workTypeId,
    }, andStatus);
  }

  const auto = order[0];
  const autoTag = (key) =>
    auto === key ? <span className="text-[10px] uppercase tracking-wide text-fg-dim">auto</span> : null;
  const today = new Date();

  return (
    <form onSubmit={submit} className="mt-2 border border-border rounded-md p-3 bg-surface space-y-3 max-w-xl">
      <div className="grid grid-cols-[auto,1fr] items-center gap-x-3 gap-y-2 text-sm">
        <label className="text-xs text-fg-muted">Start</label>
        <span className="inline-flex flex-wrap items-center gap-2">
          <TimeField label="Start time" value={values.start} onChange={(d) => edit("start", d)} highlight={auto === "start"} />
          {!sameDay(values.start, values.end) && (
            <span className="text-xs text-fg-muted">{formatShortDate(values.start)}</span>
          )}
          {autoTag("start")}
        </span>

        <label className="text-xs text-fg-muted">Duration</label>
        <span className="inline-flex flex-wrap items-center gap-2">
          <DurationInputs minutes={values.minutes} onChange={(m) => edit("minutes", m)} highlight={auto === "minutes"} />
          {autoTag("minutes")}
        </span>

        <label className="text-xs text-fg-muted">Stop</label>
        <span className="inline-flex flex-wrap items-center gap-2">
          <TimeField label="Stop time" value={values.end} onChange={(d) => edit("end", d)} highlight={auto === "end"} />
          <input
            type="date"
            value={toDateInput(values.end)}
            max={toDateInput(today)}
            onChange={(e) => setEndDate(e.target.value)}
            className="input py-1 text-xs w-36"
            aria-label="Stop date"
          />
          {autoTag("end")}
        </span>
      </div>
      {(workTypes.length > 0 || initial.work_type_id) && (
        <label className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-xs text-fg-muted">Type</span>
          <select
            value={workTypeId ?? ""}
            onChange={(e) => setState((s) => ({ ...s, workTypeId: e.target.value ? Number(e.target.value) : null }))}
            className="input py-1 w-auto"
          >
            <option value="">—</option>
            {initial.work_type_id && !workTypes.some((t) => t.id === initial.work_type_id) && (
              <option value={initial.work_type_id}>{initial.work_type_name || "Retired type"} (retired)</option>
            )}
            {workTypes.map((t) => (
              <option key={t.id} value={t.id}>{t.name}{t.billable ? "" : " (non-billable)"}</option>
            ))}
          </select>
        </label>
      )}
      <p className="text-[11px] text-fg-dim -mt-1">
        Set any two of start, duration and stop; the one marked <i>auto</i> follows.
        Type times like <code>830a</code> or <code>2:15p</code>, press <kbd>a</kbd>/<kbd>p</kbd> to flip AM/PM.
      </p>

      <div>
        <div className="flex justify-end mb-1">
          <AiRewriteButton
            value={note}
            surface="time_note"
            projectId={aiProjectId}
            size="xs"
            onChange={(t) => setState((s) => ({ ...s, note: t }))}
          />
        </div>
        <textarea
          value={note}
          onChange={(e) => setState((s) => ({ ...s, note: e.target.value }))}
          rows={3}
          placeholder="What did you do? (required)"
          className="input w-full text-sm"
        />
        {noteLen < minChars && (
          <p className="text-[11px] text-fg-dim">
            {minChars - noteLen} more character{minChars - noteLen === 1 ? "" : "s"} needed
          </p>
        )}
      </div>

      {showVisibility && (
        settings.can_choose_visibility ? (
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="inline-flex items-center gap-1">
              <input type="radio" checked={visibility === "private"} onChange={() => setState((s) => ({ ...s, visibility: "private" }))} />
              Private note (handlers only)
            </label>
            <label className="inline-flex items-center gap-1">
              <input type="radio" checked={visibility === "public"} onChange={() => setState((s) => ({ ...s, visibility: "public" }))} />
              Public comment
            </label>
          </div>
        ) : (
          <p className="text-xs text-fg-muted">
            Saved as a {settings.default_visibility === "public" ? "public comment" : "private note (handlers only)"}
          </p>
        )
      )}

      {problem && <p className="text-xs text-red-600 dark:text-red-400">{problem}</p>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick={() => setState(fresh())} className="btn btn-sm btn-ghost">
          Reset
        </button>
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} className="btn btn-sm btn-secondary">Cancel</button>
          <button type="submit" disabled={busy || !!problem || noteLen < minChars} className="btn btn-sm btn-primary">
            {submitLabel} {values.minutes > 0 ? fmtMinutes(values.minutes) : ""}
          </button>
          {renderStatusAction?.({
            disabled: busy || !!problem || noteLen < minChars,
            onPick: (status) => submit(null, status),
          })}
        </div>
      </div>
    </form>
  );
}
