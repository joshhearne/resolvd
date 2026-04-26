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
    if (!ticketId) return toast.error("Ticket id required");
    setMatching(true);
    try {
      const r = await api.post(`/api/inbound/${openId}/match`, {
        ticket_id: Number(ticketId),
        contact_id: detail?.suggested_contact?.id,
      });
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

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        {STATUSES.map(s => (
          <button key={s} onClick={() => setStatus(s)}
            className={`text-xs px-2 py-1 rounded ${status === s ? "bg-brand text-white" : "bg-surface-2 text-fg-muted hover:text-fg"}`}>
            {s}
          </button>
        ))}
        <button onClick={reload} className="ml-auto text-xs text-fg-muted hover:text-fg">↻ refresh</button>
      </div>

      {loading ? <div className="text-sm text-fg-dim">Loading…</div> :
        items.length === 0 ?
          <div className="text-sm text-fg-dim italic">No {status} messages.</div> :
          <div className="bg-surface border border-border rounded-lg divide-y divide-border">
            {items.map(it => (
              <div key={it.id}>
                <button onClick={() => open(it.id)}
                  className={`w-full text-left px-4 py-3 hover:bg-surface-2 ${openId === it.id ? "bg-surface-2" : ""}`}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-fg truncate">
                        {it.subject || "(no subject)"}
                      </div>
                      <div className="text-xs text-fg-muted truncate">
                        From {it.from_name ? `${it.from_name} <${it.from_addr}>` : it.from_addr}
                        {it.candidate_ticket_ref && <> · candidate <span className="font-mono">{it.candidate_ticket_ref}</span></>}
                        {it.contact_name && <> · matches contact <strong>{it.contact_name}</strong></>}
                        {it.reject_reason && <> · <span className="text-amber-700">{it.reject_reason}</span></>}
                      </div>
                    </div>
                    <div className="text-xs text-fg-dim whitespace-nowrap">
                      {new Date(it.received_at).toLocaleString()}
                    </div>
                  </div>
                </button>
                {openId === it.id && detail && (
                  <div className="px-4 pb-4 bg-surface-2 border-t border-border">
                    <pre className="text-sm whitespace-pre-wrap font-sans text-fg my-3 max-h-64 overflow-y-auto">{detail.message?.body}</pre>
                    {detail.suggested_contact && (
                      <div className="text-xs text-fg-muted mb-2">
                        Suggested contact: <strong>{detail.suggested_contact.name || detail.suggested_contact.email}</strong>
                        {detail.suggested_contact.company_name && <> ({detail.suggested_contact.company_name})</>}
                      </div>
                    )}
                    {it.status === "unmatched" ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <input value={ticketId} onChange={e => setTicketId(e.target.value)}
                          placeholder="Target ticket id (e.g. 123)"
                          className="bg-surface border border-border rounded px-2 py-1 text-sm w-48" />
                        <button onClick={match} disabled={matching}
                          className="bg-brand text-white text-sm rounded px-3 py-1 disabled:opacity-50">
                          {matching ? "Matching…" : "Match to ticket"}
                        </button>
                        <button onClick={() => discard(it.id, "discarded")}
                          className="text-sm text-fg-muted hover:text-fg border border-border rounded px-3 py-1">
                          Discard
                        </button>
                        <button onClick={() => discard(it.id, "spam")}
                          className="text-sm text-red-600 hover:underline">
                          Mark spam
                        </button>
                      </div>
                    ) : (
                      <div className="text-xs text-fg-dim">
                        {it.matched_ticket_ref ? <>Matched to <Link to={`/tickets/${it.matched_ticket_id}`} className="text-brand underline">{it.matched_ticket_ref}</Link></> : `Status: ${it.status}`}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
      }
    </div>
  );
}
