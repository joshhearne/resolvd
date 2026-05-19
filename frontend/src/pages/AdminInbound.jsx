import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Link } from "react-router-dom";
import { api } from "../utils/api";

const STATUSES = ["unmatched", "matched", "discarded", "spam"];

export default function AdminInbound() {
  const [status, setStatus] = useState("unmatched");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [matching, setMatching] = useState(false);
  const [ticketId, setTicketId] = useState("");

  async function reload() {
    setLoading(true);
    try {
      setItems(await api.get(`/api/inbound?status=${status}`));
    } catch (e) { toast.error(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { reload(); }, [status]);

  async function open(id) {
    setOpenId(id);
    setDetail(null);
    setTicketId("");
    try {
      setDetail(await api.get(`/api/inbound/${id}`));
    } catch (e) { toast.error(e.message); }
  }

  async function match() {
    const v = ticketId.trim();
    if (!v) return toast.error("Ticket id or ref required");
    const body = { contact_id: detail?.suggested_contact?.id };
    if (/^\d+$/.test(v)) body.ticket_id = Number(v);
    else body.ticket_ref = v;
    setMatching(true);
    try {
      const r = await api.post(`/api/inbound/${openId}/match`, body);
      toast.success(r.muted ? "Matched (muted on ticket)" : "Matched");
      setOpenId(null);
      await reload();
    } catch (e) { toast.error(e.message); }
    finally { setMatching(false); }
  }

  async function discard(id, reason) {
    try {
      await api.post(`/api/inbound/${id}/discard`, { reason });
      await reload();
      if (openId === id) setOpenId(null);
    } catch (e) { toast.error(e.message); }
  }

  const openItem = items.find((i) => i.id === openId);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-fg mb-1">Inbound email</h1>
        <p className="text-sm text-fg-muted">
          Review and route messages that didn't auto-match a ticket.
        </p>
      </div>

      {/* Filter strip */}
      <div className="flex items-center gap-2 flex-wrap">
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => { setStatus(s); setOpenId(null); }}
            className={`text-xs px-2.5 py-1 rounded transition-colors ${
              status === s
                ? "bg-brand text-white"
                : "bg-surface-2 text-fg-muted hover:text-fg"
            }`}
          >
            {s}
          </button>
        ))}
        <button onClick={reload} className="ml-auto text-xs text-fg-muted hover:text-fg">
          ↻ refresh
        </button>
      </div>

      {/* Master-detail */}
      <div className="flex flex-col lg:flex-row gap-4 items-stretch">
        {/* List pane — collapses on mobile when a message is open */}
        <aside
          className={`
            ${openId ? "hidden lg:block" : "block"}
            lg:w-96 lg:flex-shrink-0 bg-surface border border-border rounded-lg overflow-hidden
          `}
        >
          {loading ? (
            <div className="text-sm text-fg-dim p-4">Loading…</div>
          ) : items.length === 0 ? (
            <div className="text-sm text-fg-dim italic p-4">
              No {status} messages.
            </div>
          ) : (
            <div className="divide-y divide-border max-h-[70vh] overflow-y-auto">
              {items.map((it) => (
                <button
                  key={it.id}
                  onClick={() => open(it.id)}
                  className={`w-full text-left px-3 py-2.5 hover:bg-surface-2 transition-colors ${
                    openId === it.id ? "bg-brand/5 border-l-2 border-brand" : ""
                  }`}
                >
                  <div className="text-sm font-medium text-fg truncate">
                    {it.subject || "(no subject)"}
                  </div>
                  <div className="text-xs text-fg-muted truncate mt-0.5">
                    {it.from_name ? `${it.from_name} <${it.from_addr}>` : it.from_addr}
                  </div>
                  <div className="text-[11px] text-fg-dim mt-1 flex items-center gap-2 flex-wrap">
                    <span>{new Date(it.received_at).toLocaleString()}</span>
                    {it.candidate_ticket_ref && (
                      <span className="font-mono">→ {it.candidate_ticket_ref}</span>
                    )}
                    {it.contact_name && <span>· {it.contact_name}</span>}
                    {it.reject_reason && (
                      <span className="text-amber-700 dark:text-amber-400">
                        · {it.reject_reason}
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </aside>

        {/* Detail pane */}
        <section className={`flex-1 min-w-0 ${openId ? "block" : "hidden lg:block"}`}>
          {!openItem ? (
            <div className="bg-surface border border-border rounded-lg p-8 text-sm text-fg-dim italic text-center">
              Select a message to inspect, match, or discard.
            </div>
          ) : (
            <div className="bg-surface border border-border rounded-lg p-4 space-y-3">
              {/* Mobile back button */}
              <button
                onClick={() => setOpenId(null)}
                className="lg:hidden text-xs text-fg-muted hover:text-fg mb-1"
              >
                ← Back to list
              </button>

              <div>
                <div className="text-sm font-semibold text-fg">
                  {openItem.subject || "(no subject)"}
                </div>
                <div className="text-xs text-fg-muted mt-0.5">
                  From {openItem.from_name
                    ? `${openItem.from_name} <${openItem.from_addr}>`
                    : openItem.from_addr}
                  <span className="mx-1.5">·</span>
                  {new Date(openItem.received_at).toLocaleString()}
                </div>
              </div>

              {!detail ? (
                <div className="text-sm text-fg-dim">Loading message…</div>
              ) : (
                <>
                  <pre className="text-sm whitespace-pre-wrap font-sans text-fg max-h-96 overflow-y-auto bg-surface-2 rounded p-3 border border-border">
                    {detail.message?.body}
                  </pre>

                  {detail.suggested_contact && (
                    <div className="text-xs text-fg-muted">
                      Suggested contact:{" "}
                      <strong>
                        {detail.suggested_contact.name ||
                          detail.suggested_contact.email}
                      </strong>
                      {detail.suggested_contact.company_name && (
                        <> ({detail.suggested_contact.company_name})</>
                      )}
                    </div>
                  )}

                  {openItem.status === "unmatched" ? (
                    <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border">
                      <input
                        value={ticketId}
                        onChange={(e) => setTicketId(e.target.value)}
                        placeholder="Ticket id or ref (e.g. SUP-0042)"
                        className="bg-surface border border-border rounded px-2 py-1 text-sm w-64"
                      />
                      <button
                        onClick={match}
                        disabled={matching}
                        className="btn btn-primary btn-sm disabled:opacity-50"
                      >
                        {matching ? "Matching…" : "Match to ticket"}
                      </button>
                      <button
                        onClick={() => discard(openItem.id, "discarded")}
                        className="btn btn-secondary btn-sm"
                      >
                        Discard
                      </button>
                      <button
                        onClick={() => discard(openItem.id, "spam")}
                        className="text-sm text-red-600 hover:underline ml-1"
                      >
                        Mark spam
                      </button>
                    </div>
                  ) : (
                    <div className="text-xs text-fg-dim pt-2 border-t border-border">
                      {openItem.matched_ticket_ref ? (
                        <>
                          Matched to{" "}
                          <Link
                            to={`/tickets/${openItem.matched_ticket_id}`}
                            className="text-brand underline"
                          >
                            {openItem.matched_ticket_ref}
                          </Link>
                        </>
                      ) : (
                        `Status: ${openItem.status}`
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
