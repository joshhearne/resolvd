import React, { useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import { appHref, telHref, isPhoneApp, formatPhone } from "../utils/phone";
import { useCallingApp } from "./TicketPeople";

// Ticket → Vendor support tab (agents only): the helpdesks of the vendors
// linked to this ticket's project, with the channels recommended for its
// priority first. Email channels forward the ticket (with an optional
// message and its attachments); portals open in a new tab; phone numbers
// open the agent's calling app, with the call notes alongside.

const KIND_LABEL = { phone: "Call", portal: "Portal", email: "Email" };
const range = (c) => (c.min_priority === c.max_priority ? `P${c.min_priority}` : `P${c.min_priority}–P${c.max_priority}`);

function Forward({ ticketId, channel, onDone, onCancel }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function send(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post(`/api/tickets/${ticketId}/vendor-support/forward`, { channel_id: channel.id, message });
      toast.success(`Sent to ${r.to}${r.attachments ? ` with ${r.attachments} attachment${r.attachments === 1 ? "" : "s"}` : ""}`);
      onDone();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={send} className="mt-2 space-y-2">
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={3}
        maxLength={10000}
        placeholder="Message to their support team (optional): account number, what's affected, how urgent."
        className="w-full bg-surface border border-border rounded px-2 py-1.5 text-sm"
        aria-label={`Message to ${channel.value}`}
      />
      <p className="text-[11px] text-fg-muted">
        Sends the ticket's title, description and attachments to <b>{channel.value}</b> using your vendor "new ticket" email template.
        It's recorded as an internal note.
      </p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn btn-secondary btn-sm">Cancel</button>
        <button type="submit" disabled={busy} className="btn btn-primary btn-sm">{busy ? "Sending…" : "Send"}</button>
      </div>
    </form>
  );
}

function Channel({ ticketId, c, app, prominent, onForwarded }) {
  const [open, setOpen] = useState(false);
  const btn = prominent
    ? "inline-flex items-center gap-2 rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-fg hover:border-brand hover:text-brand min-h-[2.5rem]"
    : "text-sm text-brand hover:underline";
  let action = null;
  if (c.kind === "phone") {
    const link = appHref(app, c.value, null);
    const tel = telHref(c.value);
    const shown = formatPhone(c.value) || c.value;
    action = (
      <span className="inline-flex items-center gap-2 flex-wrap">
        <a href={link?.href || tel || "#"} className={btn}>{prominent ? `Call ${shown}` : shown}</a>
        {app && !isPhoneApp(app) && tel && <a href={tel} className="text-[11px] text-brand hover:underline">Phone app</a>}
      </span>
    );
  } else if (c.kind === "portal") {
    action = <a href={c.value} target="_blank" rel="noopener noreferrer" className={`${btn} break-all`}>{prominent ? "Open portal" : c.value}</a>;
  } else {
    action = (
      <button type="button" onClick={() => setOpen((v) => !v)} className={btn} aria-expanded={open}>
        {`Forward to ${c.value}`}
      </button>
    );
  }
  return (
    <li className={prominent ? "py-2" : "py-1.5"}>
      <div className="flex items-start gap-3 flex-wrap">
        <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-surface-2 text-fg-muted mt-1 w-14 text-center shrink-0">{KIND_LABEL[c.kind]}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {c.label && <span className="text-sm font-medium text-fg">{c.label}</span>}
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-brand/10 text-brand">{range(c)}</span>
            {c.kind === "portal" && prominent && <span className="text-xs text-fg-muted break-all">{c.value}</span>}
          </div>
          <div className="mt-1">{action}</div>
          {c.notes && <div className="mt-1 text-xs text-fg-muted whitespace-pre-wrap border-l-2 border-border pl-2">{c.notes}</div>}
          {open && <Forward ticketId={ticketId} channel={c} onCancel={() => setOpen(false)} onDone={() => { setOpen(false); onForwarded?.(); }} />}
        </div>
      </div>
    </li>
  );
}

export default function TicketVendorSupport({ ticketId, data, onForwarded }) {
  const { app } = useCallingApp();
  if (!data) return <p className="text-sm text-fg-dim py-4">Loading…</p>;
  if (!data.vendors.length) return <p className="text-sm text-fg-dim text-center py-6">No vendor support channels for this ticket's project.</p>;
  return (
    <div className="space-y-5">
      {data.vendors.map((v) => {
        const rec = v.channels.filter((c) => c.recommended);
        const other = v.channels.filter((c) => !c.recommended);
        return (
          <section key={v.company.id}>
            <div className="flex items-baseline gap-2 flex-wrap">
              <h3 className="text-sm font-semibold text-fg">{v.company.name}</h3>
              <span className="text-xs text-fg-muted">support · ticket is P{data.priority}</span>
              {v.has_conditions && !v.matched && (
                <span className="text-[11px] text-fg-dim" title={v.reasons.join("; ")}>doesn't match this vendor's conditions</span>
              )}
            </div>
            {rec.length > 0 ? (
              <ul className="divide-y divide-border">
                {rec.map((c) => <Channel key={c.id} ticketId={ticketId} c={c} app={app} prominent onForwarded={onForwarded} />)}
              </ul>
            ) : (
              <p className="text-xs text-fg-muted mt-1">No channel is set for P{data.priority}; other options below.</p>
            )}
            {other.length > 0 && (
              <div className="mt-2">
                <div className="text-[11px] uppercase tracking-wide text-fg-dim">Other options</div>
                <ul>
                  {other.map((c) => <Channel key={c.id} ticketId={ticketId} c={c} app={app} onForwarded={onForwarded} />)}
                </ul>
              </div>
            )}
          </section>
        );
      })}
      <p className="text-[11px] text-fg-dim">
        Channels are set under Admin → Companies → (vendor) → Support. Record the vendor's ticket number in External ref.
      </p>
    </div>
  );
}
