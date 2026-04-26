import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// Read-only status surface for the encryption foundation. Mode flips are
// not exposed in the UI yet — they require a master key in .env and a
// backfill script run against the live DB, both of which an operator
// performs via shell, not through a browser button. This page keeps
// admins informed about the current state and where to find the
// runbook.
export default function AdminEncryption() {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // No first-class settings endpoint yet; pull what the auth-settings
    // page already exposes for sibling fields. For now, present a static
    // explanation page until a settings GET is added.
    setLoading(false);
  }, []);

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="bg-surface border border-border rounded-lg p-4">
        <h3 className="text-sm font-semibold text-fg mb-2">Encryption status</h3>
        <p className="text-sm text-fg-muted">
          Resolvd ships with at-rest envelope encryption available in three modes:
        </p>
        <dl className="mt-3 space-y-2 text-sm">
          <div className="grid grid-cols-[6rem,1fr] gap-3">
            <dt className="text-xs uppercase tracking-wider text-fg-dim pt-0.5">off</dt>
            <dd className="text-fg-muted">Default. Data stored as plaintext. Identical behaviour to a non-encrypted deployment.</dd>
          </div>
          <div className="grid grid-cols-[6rem,1fr] gap-3">
            <dt className="text-xs uppercase tracking-wider text-fg-dim pt-0.5">standard</dt>
            <dd className="text-fg-muted">
              Server holds the master key. All sensitive columns + attachment file bodies encrypt under per-row data keys
              wrapped by the master KEK. Search on titles still works via a HMAC blind index.
            </dd>
          </div>
          <div className="grid grid-cols-[6rem,1fr] gap-3">
            <dt className="text-xs uppercase tracking-wider text-fg-dim pt-0.5">vault</dt>
            <dd className="text-fg-muted">
              Customer-held key (browser-derived). Server cannot decrypt without an active support grant. Reserved for
              workspaces with strict zero-knowledge requirements. Not yet exposed in the UI.
            </dd>
          </div>
        </dl>
      </div>

      <div className="bg-surface border border-border rounded-lg p-4">
        <h3 className="text-sm font-semibold text-fg mb-2">Enabling Standard mode</h3>
        <ol className="list-decimal pl-5 text-sm text-fg-muted space-y-1">
          <li>Generate a 32-byte master key on the host:
            <pre className="bg-surface-2 border border-border rounded px-2 py-1 mt-1 text-xs font-mono">{`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`}</pre>
          </li>
          <li>Add it to <code>.env</code> as <code>RESOLVD_MASTER_KEY=…</code>. <strong>Back this up.</strong> Losing the key after enabling encryption permanently destroys access.</li>
          <li>Restart the backend container.</li>
          <li>Flip the row in <code>encryption_settings</code>: <code>UPDATE encryption_settings SET mode='standard' WHERE id = 1;</code></li>
          <li>Run the backfill: <code>node backend/scripts/encrypt-backfill.js</code> (use <code>--verify</code> on first run).</li>
        </ol>
        <p className="text-xs text-fg-dim mt-3">
          See the runbook in the repo for support-access-grant flows and rotation procedures.
        </p>
      </div>
    </div>
  );
}
