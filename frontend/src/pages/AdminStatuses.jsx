import React, { useEffect, useState, useMemo } from "react";
import toast from "react-hot-toast";

const SEMANTIC_TAGS = [
  { value: "", label: "— none —" },
  { value: "in_progress", label: "in_progress" },
  { value: "reopened", label: "reopened" },
  { value: "resolved_pending_close", label: "resolved_pending_close" },
  { value: "pending_review", label: "pending_review" },
  { value: "on_hold", label: "on_hold" },
];

const MAP_KIND_LABELS = {
  suggest: "Suggest (UI hint)",
  mirror: "Mirror (auto-sync)",
};

function StatusPill({ status }) {
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border"
      style={{
        borderColor: status.color,
        color: status.color,
        backgroundColor: `${status.color}14`,
      }}
    >
      {status.name}
    </span>
  );
}

function FlagBadge({ active, label, tone = "gray" }) {
  if (!active) return null;
  const tones = {
    blue: "bg-brand/15 text-brand",
    amber:
      "bg-amber-100 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300",
    emerald:
      "bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300",
    gray: "bg-surface-2 text-fg",
  };
  return (
    <span
      className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${tones[tone]}`}
    >
      {label}
    </span>
  );
}

export default function AdminStatuses() {
  const [data, setData] = useState({
    internal: [],
    external: [],
    transitions: [],
    mappings: [],
  });
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [editingTransitionsId, setEditingTransitionsId] = useState(null);

  async function load() {
    try {
      const res = await fetch("/api/statuses", { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      const d = await res.json();
      setData(d);
    } catch (err) {
      toast.error("Failed to load statuses");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function createStatus(kind, payload) {
    const res = await fetch("/api/statuses", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, ...payload }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error || "Failed");
      return;
    }
    toast.success("Status created");
    load();
  }

  async function updateStatus(id, patch) {
    const res = await fetch(`/api/statuses/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error || "Failed");
      return;
    }
    toast.success("Saved");
    setEditingId(null);
    load();
  }

  async function deleteStatus(id) {
    if (!confirm("Delete this status? Will fail if any ticket still uses it."))
      return;
    const res = await fetch(`/api/statuses/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error || "Failed");
      return;
    }
    toast.success("Deleted");
    load();
  }

  async function saveTransitions(fromId, toIds) {
    const res = await fetch(`/api/statuses/${fromId}/transitions`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to_ids: toIds }),
    });
    if (!res.ok) {
      toast.error("Failed");
      return;
    }
    toast.success("Transitions updated");
    setEditingTransitionsId(null);
    load();
  }

  async function createMapping(internalId, externalId, kind) {
    const res = await fetch("/api/statuses/mappings", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        internal_status_id: internalId,
        external_status_id: externalId,
        kind,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error || "Failed");
      return;
    }
    toast.success("Mapping added");
    load();
  }

  async function deleteMapping(id) {
    const res = await fetch(`/api/statuses/mappings/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!res.ok) {
      toast.error("Failed");
      return;
    }
    load();
  }

  if (loading) return <div className="text-fg-muted">Loading…</div>;

  return (
    <div className="space-y-10">
      <div>
        <p className="text-sm text-fg-muted">
          Define status options for tickets. <strong>Internal</strong> statuses
          live on your team's view of the work.
          <strong> External</strong> statuses describe how a partner or vendor
          sees the same ticket.
          <em> Transitions</em> are advisory — they suggest the next step in the
          workflow.
          <em> Mappings</em> link related statuses across the two views.
        </p>
      </div>

      <StatusList
        kind="internal"
        title="Internal statuses"
        statuses={data.internal}
        transitions={data.transitions}
        editingId={editingId}
        editingTransitionsId={editingTransitionsId}
        onEdit={setEditingId}
        onCancelEdit={() => setEditingId(null)}
        onUpdate={updateStatus}
        onDelete={deleteStatus}
        onCreate={(p) => createStatus("internal", p)}
        onEditTransitions={setEditingTransitionsId}
        onCancelTransitions={() => setEditingTransitionsId(null)}
        onSaveTransitions={saveTransitions}
      />

      <StatusList
        kind="external"
        title="External statuses"
        statuses={data.external}
        transitions={data.transitions}
        editingId={editingId}
        editingTransitionsId={editingTransitionsId}
        onEdit={setEditingId}
        onCancelEdit={() => setEditingId(null)}
        onUpdate={updateStatus}
        onDelete={deleteStatus}
        onCreate={(p) => createStatus("external", p)}
        onEditTransitions={setEditingTransitionsId}
        onCancelTransitions={() => setEditingTransitionsId(null)}
        onSaveTransitions={saveTransitions}
      />

      <MappingsBlock
        internal={data.internal}
        external={data.external}
        mappings={data.mappings}
        onCreate={createMapping}
        onDelete={deleteMapping}
      />

      <GratitudePhrasesBlock />
    </div>
  );
}

function GratitudePhrasesBlock() {
  const [phrases, setPhrases] = useState([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const res = await fetch("/api/statuses/auto-resolve/phrases", {
        credentials: "include",
      });
      if (!res.ok) throw new Error(await res.text());
      const d = await res.json();
      setPhrases(d.phrases || []);
    } catch {
      toast.error("Failed to load gratitude phrases");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function save(next) {
    setSaving(true);
    try {
      const res = await fetch("/api/statuses/auto-resolve/phrases", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrases: next }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed");
        return;
      }
      setPhrases(body.phrases || []);
      toast.success("Saved");
    } finally {
      setSaving(false);
    }
  }

  function addPhrase(e) {
    e.preventDefault();
    const v = draft.trim().toLowerCase();
    if (!v) return;
    if (phrases.includes(v)) {
      setDraft("");
      return;
    }
    save([...phrases, v]);
    setDraft("");
  }

  function remove(p) {
    save(phrases.filter((x) => x !== p));
  }

  return (
    <section>
      <h2 className="text-lg font-semibold text-fg mb-1">
        Auto-resolve gratitude phrases
      </h2>
      <p className="text-sm text-fg-muted mb-3">
        When a contact replies to a ticket sitting in a status tagged{" "}
        <code>resolved_pending_close</code>, the reply is matched against this
        list. Matches are treated as a closeout (ticket stays in resolved).
        Anything else auto-reopens the ticket. Comparison is case-insensitive,
        ignores trailing punctuation, and tolerates short trailing filler like
        "thanks!" or "thanks guys" — but a phrase followed by words like
        "but", "still", "issue", "fix" falls through and reopens.
      </p>
      {loading ? (
        <div className="text-fg-muted text-sm">Loading…</div>
      ) : (
        <div className="border border-border rounded-lg p-3 bg-surface">
          <div className="flex flex-wrap gap-2 mb-3">
            {phrases.length === 0 && (
              <span className="text-sm text-fg-muted italic">
                No phrases — every reply will auto-reopen.
              </span>
            )}
            {phrases.map((p) => (
              <span
                key={p}
                className="inline-flex items-center gap-1 bg-surface-2 border border-border rounded-full pl-3 pr-1 py-0.5 text-sm"
              >
                {p}
                <button
                  onClick={() => remove(p)}
                  disabled={saving}
                  className="text-fg-muted hover:text-red-600 px-1"
                  title="Remove"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <form onSubmit={addPhrase} className="flex items-center gap-2">
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. thanks, much appreciated"
              className="flex-1 border border-border-strong rounded-md px-3 py-1.5 text-sm"
            />
            <button
              type="submit"
              disabled={saving || !draft.trim()}
              className="px-3 py-1.5 bg-brand hover:bg-brand-bright disabled:opacity-60 text-brand-fg text-sm rounded-md"
            >
              Add phrase
            </button>
          </form>
        </div>
      )}
    </section>
  );
}

function StatusList({
  kind,
  title,
  statuses,
  transitions,
  editingId,
  editingTransitionsId,
  onEdit,
  onCancelEdit,
  onUpdate,
  onDelete,
  onCreate,
  onEditTransitions,
  onCancelTransitions,
  onSaveTransitions,
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-fg mb-3">{title}</h2>
      <div className="border border-border rounded-lg divide-y">
        {statuses.map((s) => (
          <StatusRow
            key={s.id}
            status={s}
            siblings={statuses}
            transitions={transitions}
            isEditing={editingId === s.id}
            isEditingTransitions={editingTransitionsId === s.id}
            onEdit={() => onEdit(s.id)}
            onCancelEdit={onCancelEdit}
            onSave={(patch) => onUpdate(s.id, patch)}
            onDelete={() => onDelete(s.id)}
            onEditTransitions={() => onEditTransitions(s.id)}
            onCancelTransitions={onCancelTransitions}
            onSaveTransitions={(ids) => onSaveTransitions(s.id, ids)}
          />
        ))}
        {statuses.length === 0 && (
          <div className="p-4 text-sm text-fg-muted">No statuses yet.</div>
        )}
      </div>
      <NewStatusForm kind={kind} onCreate={onCreate} />
    </section>
  );
}

function StatusRow({
  status,
  siblings,
  transitions,
  isEditing,
  isEditingTransitions,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
  onEditTransitions,
  onCancelTransitions,
  onSaveTransitions,
}) {
  const [draft, setDraft] = useState(status);
  useEffect(() => {
    setDraft(status);
  }, [status, isEditing]);

  const outgoing = useMemo(
    () =>
      transitions
        .filter((t) => t.from_status_id === status.id)
        .map((t) => t.to_status_id),
    [transitions, status.id],
  );

  if (isEditing) {
    return (
      <div className="p-3 bg-surface-2 grid grid-cols-1 md:grid-cols-12 gap-2 items-center">
        <input
          className="col-span-3 border border-border-strong rounded-md px-2 py-1 text-sm"
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          placeholder="Name"
        />
        <input
          type="color"
          className="col-span-1 h-8 w-12 border border-border-strong rounded"
          value={draft.color}
          onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))}
        />
        <input
          type="number"
          className="col-span-1 border border-border-strong rounded-md px-2 py-1 text-sm"
          value={draft.sort_order}
          onChange={(e) =>
            setDraft((d) => ({ ...d, sort_order: Number(e.target.value) }))
          }
        />
        <select
          className="col-span-2 border border-border-strong rounded-md px-2 py-1 text-sm"
          value={draft.semantic_tag || ""}
          onChange={(e) =>
            setDraft((d) => ({ ...d, semantic_tag: e.target.value }))
          }
        >
          {SEMANTIC_TAGS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <div className="col-span-3 flex flex-wrap gap-3 text-xs">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={!!draft.is_initial}
              onChange={(e) =>
                setDraft((d) => ({ ...d, is_initial: e.target.checked }))
              }
            />{" "}
            Initial
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={!!draft.is_terminal}
              onChange={(e) =>
                setDraft((d) => ({ ...d, is_terminal: e.target.checked }))
              }
            />{" "}
            Terminal
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={!!draft.is_blocker}
              onChange={(e) =>
                setDraft((d) => ({ ...d, is_blocker: e.target.checked }))
              }
            />{" "}
            Blocker
          </label>
        </div>
        {draft.semantic_tag === "resolved_pending_close" && (
          <label className="col-span-12 flex items-center gap-2 text-xs">
            Auto-close after
            <input
              type="number"
              min="0"
              value={
                draft.auto_close_after_days === null ||
                draft.auto_close_after_days === undefined
                  ? ""
                  : draft.auto_close_after_days
              }
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  auto_close_after_days:
                    e.target.value === "" ? null : Number(e.target.value),
                }))
              }
              className="w-20 border border-border-strong rounded-md px-2 py-1 text-sm"
              placeholder="days"
            />
            days (blank disables auto-close)
          </label>
        )}
        <div className="col-span-2 flex gap-2 justify-end">
          <button
            onClick={onCancelEdit}
            className="px-2 py-1 text-sm border border-border-strong rounded hover:bg-surface"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave(draft)}
            className="px-2 py-1 text-sm bg-brand hover:bg-brand-bright text-brand-fg rounded"
          >
            Save
          </button>
        </div>
      </div>
    );
  }

  if (isEditingTransitions) {
    return (
      <TransitionsEditor
        status={status}
        siblings={siblings.filter((x) => x.id !== status.id)}
        currentToIds={outgoing}
        onCancel={onCancelTransitions}
        onSave={onSaveTransitions}
      />
    );
  }

  return (
    <div className="p-3 flex items-center gap-3">
      <StatusPill status={status} />
      <span className="text-xs text-fg-muted">order {status.sort_order}</span>
      <div className="flex gap-1">
        <FlagBadge active={status.is_initial} label="initial" tone="blue" />
        <FlagBadge
          active={status.is_terminal}
          label="terminal"
          tone="emerald"
        />
        <FlagBadge active={status.is_blocker} label="blocker" tone="amber" />
        {status.semantic_tag && (
          <FlagBadge active label={`tag: ${status.semantic_tag}`} tone="gray" />
        )}
        {status.semantic_tag === "resolved_pending_close" &&
          status.auto_close_after_days != null && (
            <FlagBadge
              active
              label={`auto-close: ${status.auto_close_after_days}d`}
              tone="emerald"
            />
          )}
      </div>
      <div className="ml-auto flex items-center gap-2 text-xs">
        <span className="text-fg-muted">
          {outgoing.length} transition{outgoing.length === 1 ? "" : "s"}
        </span>
        <button
          onClick={onEditTransitions}
          className="px-2 py-1 border border-border-strong rounded hover:bg-surface-2"
        >
          Transitions
        </button>
        <button
          onClick={onEdit}
          className="px-2 py-1 border border-border-strong rounded hover:bg-surface-2"
        >
          Edit
        </button>
        <button
          onClick={onDelete}
          className="px-2 py-1 border border-red-200 dark:border-red-900/50 text-red-700 dark:text-red-300 rounded hover:bg-red-50 dark:hover:bg-red-950/40 dark:bg-red-950/40"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function TransitionsEditor({
  status,
  siblings,
  currentToIds,
  onCancel,
  onSave,
}) {
  const [selected, setSelected] = useState(new Set(currentToIds));
  function toggle(id) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }
  return (
    <div className="p-3 bg-surface-2">
      <div className="flex items-center gap-3 mb-2">
        <span className="text-sm">Allowed next steps from</span>
        <StatusPill status={status} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3">
        {siblings.map((s) => (
          <label key={s.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.has(s.id)}
              onChange={() => toggle(s.id)}
            />
            <StatusPill status={s} />
          </label>
        ))}
        {siblings.length === 0 && (
          <span className="text-sm text-fg-muted">
            No other statuses to transition to.
          </span>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="px-3 py-1 text-sm border border-border-strong rounded hover:bg-surface"
        >
          Cancel
        </button>
        <button
          onClick={() => onSave(Array.from(selected))}
          className="px-3 py-1 text-sm bg-brand hover:bg-brand-bright text-brand-fg rounded"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function NewStatusForm({ kind, onCreate }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#6b7280");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    await onCreate({ name: name.trim(), color, sort_order: 100 });
    setBusy(false);
    setName("");
  }
  return (
    <form onSubmit={submit} className="mt-3 flex items-center gap-2">
      <input
        type="text"
        placeholder={`New ${kind} status name`}
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="flex-1 border border-border-strong rounded-md px-3 py-1.5 text-sm"
      />
      <input
        type="color"
        value={color}
        onChange={(e) => setColor(e.target.value)}
        className="h-9 w-12 border border-border-strong rounded"
      />
      <button
        type="submit"
        disabled={busy || !name.trim()}
        className="px-3 py-1.5 bg-brand hover:bg-brand-bright disabled:opacity-60 text-brand-fg text-sm rounded-md"
      >
        Add
      </button>
    </form>
  );
}

function MappingsBlock({ internal, external, mappings, onCreate, onDelete }) {
  const [internalId, setInternalId] = useState("");
  const [externalId, setExternalId] = useState("");
  const [kind, setKind] = useState("suggest");

  function lookup(id, list) {
    return list.find((s) => s.id === id);
  }

  async function submit(e) {
    e.preventDefault();
    if (!internalId || !externalId) return;
    await onCreate(Number(internalId), Number(externalId), kind);
    setInternalId("");
    setExternalId("");
    setKind("suggest");
  }

  return (
    <section>
      <h2 className="text-lg font-semibold text-fg mb-1">Mappings</h2>
      <p className="text-sm text-fg-muted mb-3">
        Link related internal and external statuses. Currently advisory: changes
        are <strong>suggested</strong> in the UI, not auto-applied.
      </p>
      <div className="border border-border rounded-lg divide-y">
        {mappings.map((m) => {
          const i = lookup(m.internal_status_id, internal);
          const e = lookup(m.external_status_id, external);
          if (!i || !e) return null;
          return (
            <div key={m.id} className="p-3 flex items-center gap-3">
              <StatusPill status={i} />
              <span className="text-fg-dim">↔</span>
              <StatusPill status={e} />
              <span className="text-xs text-fg-muted">
                {MAP_KIND_LABELS[m.kind] || m.kind}
              </span>
              <button
                onClick={() => onDelete(m.id)}
                className="ml-auto px-2 py-1 text-xs border border-red-200 dark:border-red-900/50 text-red-700 dark:text-red-300 rounded hover:bg-red-50 dark:hover:bg-red-950/40 dark:bg-red-950/40"
              >
                Remove
              </button>
            </div>
          );
        })}
        {mappings.length === 0 && (
          <div className="p-4 text-sm text-fg-muted">No mappings yet.</div>
        )}
      </div>

      <form
        onSubmit={submit}
        className="mt-3 flex flex-wrap items-center gap-2"
      >
        <select
          value={internalId}
          onChange={(e) => setInternalId(e.target.value)}
          className="border border-border-strong rounded-md px-2 py-1.5 text-sm"
        >
          <option value="">Internal status…</option>
          {internal.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <span className="text-fg-dim">↔</span>
        <select
          value={externalId}
          onChange={(e) => setExternalId(e.target.value)}
          className="border border-border-strong rounded-md px-2 py-1.5 text-sm"
        >
          <option value="">External status…</option>
          {external.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="border border-border-strong rounded-md px-2 py-1.5 text-sm"
        >
          <option value="suggest">Suggest</option>
          <option value="mirror">
            Mirror (reserved — advisory only for now)
          </option>
        </select>
        <button
          type="submit"
          disabled={!internalId || !externalId}
          className="px-3 py-1.5 bg-brand hover:bg-brand-bright disabled:opacity-60 text-brand-fg text-sm rounded-md"
        >
          Add mapping
        </button>
      </form>
    </section>
  );
}
