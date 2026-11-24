import React, { useEffect, useState } from "react";
import { api } from "../utils/api";
import { callOptions } from "../utils/phone";

// Contacts tab on a ticket (#153): the requester and the contacts attached
// to the ticket, with tap-to-call links. On a phone the links dial
// directly; on a desktop they open the VoIP app registered for tel:.
// Numbers that aren't on file are left out. Ticket handlers only.

function Person({ p }) {
  const calls = callOptions(p);
  const where = [p.title, p.company_name, p.location_name].filter(Boolean).join(" · ");
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-sm font-medium text-fg">{p.name}</span>
        <span className="text-[11px] uppercase tracking-wide text-fg-dim">{p.kind === "requester" ? "Requester" : "Contact"}</span>
      </div>
      {where && <div className="text-xs text-fg-muted">{where}</div>}
      {p.email && (
        <a href={`mailto:${p.email}`} className="text-xs text-brand hover:underline break-all">{p.email}</a>
      )}
      {calls.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {calls.map((c) => (
            <a
              key={c.key}
              href={c.href}
              className="inline-flex items-center gap-2 rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-fg hover:border-brand hover:text-brand min-h-[2.5rem]"
              aria-label={`Call ${p.name}, ${c.label}: ${c.display}`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 shrink-0" aria-hidden="true">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
              </svg>
              <span className="flex flex-col leading-tight">
                <span className="text-[11px] text-fg-muted">{c.label}</span>
                <span className="tabular-nums">{c.display}</span>
              </span>
            </a>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-xs text-fg-dim italic">No phone numbers on file.</p>
      )}
    </li>
  );
}

export default function TicketPeople({ ticketId, reloadKey }) {
  const [people, setPeople] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    api.get(`/api/tickets/${ticketId}/people`)
      .then((r) => { if (alive) setPeople(r.people || []); })
      .catch((e) => { if (alive) { setPeople([]); setError(e.message); } });
    return () => { alive = false; };
  }, [ticketId, reloadKey]);

  if (people == null) return <p className="text-sm text-fg-dim py-4">Loading…</p>;
  if (error) return <p className="text-sm text-red-600 dark:text-red-400 py-4">{error}</p>;
  if (!people.length) return <p className="text-sm text-fg-dim text-center py-6">No requester or contacts on this ticket.</p>;
  return (
    <div>
      <ul className="divide-y divide-border">
        {people.map((p) => <Person key={`${p.kind}-${p.id}`} p={p} />)}
      </ul>
      <p className="mt-4 text-[11px] text-fg-dim">
        Phone numbers are edited under Admin → Companies (Members or Contacts).
      </p>
    </div>
  );
}
