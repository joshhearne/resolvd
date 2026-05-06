import React, { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../utils/api";

// Typeahead-driven ticket merge picker. Two slots (A, B). When invoked
// with an anchor (from inside a ticket), slot A is pre-filled; the user
// only searches for the partner. With no anchor (global merge tool),
// both slots start empty and the project locks to whichever ticket is
// picked first. The winner toggle lets the admin pick direction without
// re-opening the dialog from a different ticket.
//
// onConfirm receives `{ loserId, winnerId }`. The caller POSTs the merge
// and is responsible for navigating away from the loser if needed.
export default function MergePicker({ open, anchorTicket = null, onCancel, onConfirm }) {
  const [slotA, setSlotA] = useState(null);
  const [slotB, setSlotB] = useState(null);
  // Which slot is the winner. The other becomes the loser (gets closed).
  const [winner, setWinner] = useState("B");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSlotA(anchorTicket || null);
    setSlotB(null);
    // When opened from a ticket, the anchor is the most likely loser
    // (admin clicked Merge on the duplicate). Default winner to B.
    setWinner("B");
    setSubmitting(false);
  }, [open, anchorTicket]);

  if (!open) return null;

  // Project constraint: once either slot is filled, search is locked to
  // that project. Merges across projects aren't supported by the backend.
  const lockedProjectId = slotA?.project_id ?? slotB?.project_id ?? null;

  const winnerTicket = winner === "A" ? slotA : slotB;
  const loserTicket = winner === "A" ? slotB : slotA;
  const ready = !!slotA && !!slotB && slotA.id !== slotB.id && !submitting;

  async function submit() {
    if (!ready) return;
    setSubmitting(true);
    try {
      await onConfirm({ loserId: loserTicket.id, winnerId: winnerTicket.id });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="bg-surface border border-border rounded-lg shadow-xl max-w-xl w-full p-5 space-y-4">
        <div>
          <h3 className="text-lg font-semibold text-fg">Merge tickets</h3>
          <p className="text-xs text-fg-muted mt-1">
            Comments, attachments, audit history, vendor contacts, and followers
            from the loser get reassigned to the winner. The loser is then
            closed with a pointer to the winner. Tickets must share a project.
          </p>
        </div>

        <Slot
          label="Ticket A"
          ticket={slotA}
          onPick={setSlotA}
          onClear={() => setSlotA(null)}
          lockedProjectId={lockedProjectId}
          excludeId={slotB?.id || null}
        />
        <Slot
          label="Ticket B"
          ticket={slotB}
          onPick={setSlotB}
          onClear={() => setSlotB(null)}
          lockedProjectId={lockedProjectId}
          excludeId={slotA?.id || null}
        />

        {slotA && slotB && (
          <div className="rounded border border-border bg-surface-2 p-3 text-sm">
            <div className="text-xs text-fg-muted mb-2">Direction</div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-fg">
                <strong className="text-red-600">{loserTicket.internal_ref}</strong>
                {" "}(loser, will close)
              </span>
              <span className="text-fg-muted">→</span>
              <span className="text-fg">
                <strong className="text-emerald-600">{winnerTicket.internal_ref}</strong>
                {" "}(winner, keeps ref)
              </span>
              <button
                type="button"
                onClick={() => setWinner((w) => (w === "A" ? "B" : "A"))}
                className="ml-auto text-xs text-brand hover:underline"
              >
                Swap winner ⇄
              </button>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="btn-secondary btn btn-sm">Cancel</button>
          <button
            onClick={submit}
            disabled={!ready}
            className="btn-primary btn btn-sm disabled:opacity-50"
          >
            {submitting ? "Merging…" : "Merge"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Slot({ label, ticket, onPick, onClear, lockedProjectId, excludeId }) {
  if (ticket) {
    return (
      <div className="rounded border border-border bg-surface-2 p-3">
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <div className="text-xs text-fg-muted mb-0.5">{label}</div>
            <div className="text-sm font-semibold text-fg">
              {ticket.internal_ref}
              <span className="text-fg-muted font-normal"> · {ticket.project_name}</span>
            </div>
            <div className="text-sm text-fg truncate">{ticket.title}</div>
            <div className="text-[11px] text-fg-muted mt-0.5">
              {ticket.internal_status}
              {ticket.submitted_by_name && ` · ${ticket.submitted_by_name}`}
            </div>
          </div>
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-fg-muted hover:text-fg"
          >
            Change
          </button>
        </div>
      </div>
    );
  }
  return (
    <div>
      <div className="text-xs text-fg-muted mb-1">{label}</div>
      <SearchPicker
        onPick={onPick}
        lockedProjectId={lockedProjectId}
        excludeId={excludeId}
      />
    </div>
  );
}

function SearchPicker({ onPick, lockedProjectId, excludeId }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef(null);

  const runSearch = useCallback(async (term) => {
    if (!term || term.trim().length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams({ q: term.trim(), limit: "10" });
      if (lockedProjectId) params.set("project_id", String(lockedProjectId));
      const r = await api.get(`/api/tickets?${params.toString()}`);
      const filtered = (r.tickets || []).filter((t) => t.id !== excludeId);
      setResults(filtered);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [lockedProjectId, excludeId]);

  function onChange(e) {
    const v = e.target.value;
    setQ(v);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(v), 200);
  }

  return (
    <div>
      <input
        type="text"
        value={q}
        onChange={onChange}
        autoFocus
        placeholder={
          lockedProjectId
            ? "Search by ref (WEB-0042), title, or description…"
            : "Search any project — first pick locks the project…"
        }
        className="w-full bg-surface-2 border border-border rounded px-3 py-2 text-sm"
      />
      {loading && (
        <div className="text-xs text-fg-muted mt-1">Searching…</div>
      )}
      {!loading && q.trim().length >= 2 && results.length === 0 && (
        <div className="text-xs text-fg-muted mt-1">No matches.</div>
      )}
      {results.length > 0 && (
        <ul className="mt-2 border border-border rounded divide-y divide-border max-h-64 overflow-y-auto">
          {results.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => { setQ(""); setResults([]); onPick(t); }}
                className="w-full text-left px-3 py-2 hover:bg-surface-2"
              >
                <div className="text-sm font-semibold text-fg">
                  {t.internal_ref}
                  <span className="text-fg-muted font-normal"> · {t.project_name}</span>
                  <span className="text-[11px] text-fg-muted ml-2">{t.internal_status}</span>
                </div>
                <div className="text-sm text-fg truncate">{t.title}</div>
                {t.description && (
                  <div className="text-[11px] text-fg-muted truncate">{t.description}</div>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
