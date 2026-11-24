import React, { useEffect, useRef, useState } from "react";
import { api } from "../utils/api";
import { callOptions, telHref } from "../utils/phone";
import { useAuth } from "../context/AuthContext";

// Contacts tab on a ticket (#153): the requester and the contacts attached
// to the ticket, with tap-to-call links. Links open the viewer's calling
// app (Account → Preferences → Call with, else the organisation default;
// Admin → Calling apps). When that isn't the phone app, a small Phone link
// sits beside each button: a browser can't tell whether an app is
// installed, and an app link with nothing to open it does nothing.
// If an app link leaves the page untouched (nothing installed to open it),
// the button shows a nudge to install the app, with the store page for the
// viewer's platform when the admin has one. Numbers that aren't on file
// are left out. Ticket handlers only.

// The viewer's calling app: their preference if it's still enabled, else
// the organisation default, else the built-in phone app.
export function useCallingApp() {
  const { user } = useAuth();
  const [state, setState] = useState({ app: null, apps: [] });
  const pref = user?.preferences?.calling_app ?? null;
  useEffect(() => {
    let alive = true;
    api.get("/api/calling-apps")
      .then((r) => {
        if (!alive) return;
        const apps = r?.apps || [];
        const app = apps.find((a) => a.id === Number(pref)) || apps.find((a) => a.id === r?.default_id) || null;
        setState({ app, apps });
      })
      .catch(() => { if (alive) setState({ app: null, apps: [] }); });
    return () => { alive = false; };
  }, [pref]);
  return state;
}

// How long an app link has to take the page out of view before we assume
// nothing opened it. Apps launch well inside this; iOS shows its "Open in
// …?" prompt (which blurs the page) inside it too.
const LAUNCH_WAIT_MS = 1800;

function platform() {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  if (/android/i.test(ua)) return "android";
  // iPadOS reports itself as a Mac; touch support gives it away.
  if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  return "other";
}

// Calls onFail if the page is still visible and focused LAUNCH_WAIT_MS
// after an app link was tapped: the link went nowhere. Any sign the app
// (or the browser's "open this app?" prompt) took over cancels it.
function useLaunchWatch() {
  const cleanup = useRef(null);
  useEffect(() => () => cleanup.current?.(), []);
  return (onFail) => {
    cleanup.current?.();
    const cancel = () => cleanup.current?.();
    const onVis = () => { if (document.visibilityState === "hidden") cancel(); };
    const timer = setTimeout(() => {
      const stillHere = document.visibilityState === "visible" && (typeof document.hasFocus !== "function" || document.hasFocus());
      cancel();
      if (stillHere) onFail();
    }, LAUNCH_WAIT_MS);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", cancel);
    window.addEventListener("blur", cancel);
    cleanup.current = () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", cancel);
      window.removeEventListener("blur", cancel);
      cleanup.current = null;
    };
  };
}

function InstallNudge({ app, phoneHref, onClose }) {
  const plat = platform();
  const store = plat === "ios" ? app.ios_install_url : plat === "android" ? app.android_install_url : null;
  const storeName = plat === "ios" ? "the App Store" : "Google Play";
  return (
    <div role="status" className="mt-1 max-w-xs rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-fg">
      <div className="flex items-start gap-2">
        <p className="flex-1">
          Nothing happened? <b>{app.name}</b> may not be installed on this device.{" "}
          {store ? (
            <>Install it from <a href={store} target="_blank" rel="noopener noreferrer" className="text-brand underline">{storeName}</a>, then try again</>
          ) : (
            <>Install it from your device's app store, then try again</>
          )}
          {phoneHref ? <>, or <a href={phoneHref} className="text-brand underline">call with the Phone app</a>.</> : "."}
        </p>
        <button type="button" onClick={onClose} className="text-fg-muted hover:text-fg leading-none" aria-label="Dismiss">×</button>
      </div>
    </div>
  );
}

function Person({ p, app }) {
  const calls = callOptions(p, app);
  const [stuck, setStuck] = useState(null); // key of the button whose app didn't open
  const watch = useLaunchWatch();
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
            <span key={c.key} className="inline-flex flex-col gap-1">
            <a
              href={c.href}
              onClick={app && (c.phoneHref || c.key === "ext") ? () => { setStuck(null); watch(() => setStuck(c.key)); } : undefined}
              className="inline-flex items-center gap-2 rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-fg hover:border-brand hover:text-brand min-h-[2.5rem]"
              aria-label={`Call ${p.name}, ${c.label}: ${c.display}${c.viaPhone ? " with the phone app" : app && (c.phoneHref || c.key === "ext") ? ` with ${app.name}` : ""}`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 shrink-0" aria-hidden="true">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
              </svg>
              <span className="flex flex-col leading-tight">
                <span className="text-[11px] text-fg-muted">
                  {c.label}{c.viaPhone ? " · Phone app" : app && (c.phoneHref || c.key === "ext") ? ` · ${app.name}` : ""}
                </span>
                <span className="tabular-nums">{c.display}</span>
              </span>
            </a>
            {(c.extToDial || c.phoneHref) && (
              <span className="flex items-center gap-2 px-1 text-[11px] text-fg-muted">
                {c.extToDial && <span>then dial ext {c.extToDial}</span>}
                {c.phoneHref && (
                  <a href={c.phoneHref} className="text-brand hover:underline" aria-label={`Call ${p.name}, ${c.label}, with the phone app`}>
                    Phone app
                  </a>
                )}
              </span>
            )}
            {stuck === c.key && app && (
              <InstallNudge app={app} phoneHref={c.phoneHref || (telHref(p.direct || p.mobile) || telHref(p.location_phone, p.extension))} onClose={() => setStuck(null)} />
            )}
            </span>
          ))}
        </div>
      ) : !p.ext_internal_only ? (
        <p className="mt-1 text-xs text-fg-dim italic">No phone numbers on file.</p>
      ) : null}
      {p.ext_internal_only && !calls.some((c) => c.key === "ext") && (
        <p className="mt-1 text-xs text-fg-muted">
          Ext {String(p.extension).replace(/\D/g, "")} <span className="text-fg-dim">· internal use only</span>
        </p>
      )}
    </li>
  );
}

export default function TicketPeople({ ticketId, reloadKey }) {
  const [people, setPeople] = useState(null);
  const [error, setError] = useState(null);
  const { app } = useCallingApp();

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
        {people.map((p) => <Person key={`${p.kind}-${p.id}`} p={p} app={app} />)}
      </ul>
      <p className="mt-4 text-[11px] text-fg-dim">
        Phone numbers are edited under Admin → Companies (Members or Contacts). Choose your calling app under Account → Preferences.
      </p>
    </div>
  );
}
