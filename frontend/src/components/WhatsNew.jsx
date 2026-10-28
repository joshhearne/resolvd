import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../utils/api";
import ChangeList, { ChangeKey } from "./ChangeList";

// Opens a release from anywhere (the bell uses this).
export function openWhatsNew(releaseId) {
  window.dispatchEvent(new CustomEvent("resolvd:whats-new", { detail: { releaseId } }));
}

function title(version) {
  return version && version !== "dev" ? `What's new: ${version}` : "What's new";
}

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
}

// What's new pop-up. Shows itself after sign-in when the system was updated
// since the user last closed it (the server filters entries by role), and
// when a "Resolvd was updated" bell entry is clicked.
export default function WhatsNew() {
  const [releases, setReleases] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.get("/api/whats-new/unseen")
      .then((d) => { if (!cancelled && d.releases?.length) setReleases(d.releases); })
      .catch(() => {});
    function onOpen(e) {
      const id = e.detail?.releaseId;
      if (!id) return;
      api.get(`/api/whats-new/${id}`)
        .then((d) => { if (d.release) setReleases([d.release]); })
        .catch(() => {});
    }
    window.addEventListener("resolvd:whats-new", onOpen);
    return () => {
      cancelled = true;
      window.removeEventListener("resolvd:whats-new", onOpen);
    };
  }, []);

  useEffect(() => {
    if (!releases) return undefined;
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  function close() {
    const newest = Math.max(...releases.map((r) => r.id));
    setReleases(null);
    api.post("/api/whats-new/seen", { release_id: newest })
      .then(() => window.dispatchEvent(new Event("resolvd:notifications-changed")))
      .catch(() => {});
  }

  if (!releases) return null;
  const several = releases.length > 1;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="whats-new-title" className="bg-surface rounded-lg shadow-xl max-w-lg w-full max-h-[85vh] flex flex-col">
        <div className="px-6 pt-5 pb-3 border-b border-border">
          <h3 id="whats-new-title" className="text-lg font-semibold text-fg">{title(releases[0].version)}</h3>
          <p className="text-xs text-fg-dim mt-0.5">
            {several ? `${releases.length} updates since you last looked` : `Updated ${fmtDate(releases[0].deployed_at)}`}
          </p>
        </div>
        <div className="px-6 py-4 overflow-y-auto space-y-5">
          {releases.map((r) => (
            <div key={r.id}>
              {several && (
                <div className="text-[10px] uppercase tracking-wide text-fg-dim mb-2">
                  <span className="font-mono normal-case">{r.version || "Update"}</span> · {fmtDate(r.deployed_at)}
                </div>
              )}
              <ChangeList entries={r.entries} />
            </div>
          ))}
        </div>
        <div className="px-6 py-3 border-t border-border flex flex-wrap items-center justify-between gap-3">
          <ChangeKey />
          <button onClick={close} className="btn btn-primary">Got it</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
