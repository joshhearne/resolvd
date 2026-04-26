import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";

const PROVIDER_LABELS = {
  graph_user: "Microsoft 365 (Graph delegated)",
  gmail_user: "Gmail (OAuth)",
  smtp: "SMTP",
};

export default function AdminEmailBackends() {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showSmtp, setShowSmtp] = useState(false);
  const [smtpForm, setSmtpForm] = useState({
    display_name: "", from_address: "", smtp_host: "", smtp_port: 587,
    smtp_user: "", smtp_password: "", smtp_secure: true,
  });
  const [params, setParams] = useSearchParams();

  async function reload() {
    setLoading(true);
    try { setAccounts(await api.get("/api/email-backends")); }
    catch (e) { toast.error(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { reload(); }, []);

  // Surface OAuth callback outcome from query string
  useEffect(() => {
    const error = params.get("error");
    const connected = params.get("connected");
    if (error) toast.error(error);
    if (connected) toast.success("Account connected");
    if (error || connected) {
      setParams({}, { replace: true });
      reload();
    }
  }, [params, setParams]);

  async function startOAuth(provider) {
    try {
      const r = await api.post("/api/email-backends/oauth/start", { provider });
      window.location.href = r.authorize_url;
    } catch (e) { toast.error(e.message); }
  }

  async function activate(id) {
    try { await api.post(`/api/email-backends/${id}/activate`, {}); await reload(); toast.success("Active"); }
    catch (e) { toast.error(e.message); }
  }

  async function test(id) {
    try {
      const r = await api.post(`/api/email-backends/${id}/test`, {});
      if (r.ok) toast.success("Test email sent");
      else toast.error(r.error || "Test failed");
      await reload();
    } catch (e) { toast.error(e.message); }
  }

  async function remove(id) {
    if (!window.confirm("Delete this email backend?")) return;
    try { await api.delete(`/api/email-backends/${id}`); await reload(); }
    catch (e) { toast.error(e.message); }
  }

  async function toggleMonitor(id, enabled) {
    try {
      await api.post(`/api/email-backends/${id}/monitor`, { enabled });
      await reload();
      toast.success(enabled ? "Inbox monitoring on" : "Inbox monitoring off");
    } catch (e) { toast.error(e.message); }
  }

  async function saveSmtp(e) {
    e.preventDefault();
    try {
      await api.post("/api/email-backends/smtp", smtpForm);
      setShowSmtp(false);
      setSmtpForm({ display_name: "", from_address: "", smtp_host: "", smtp_port: 587, smtp_user: "", smtp_password: "", smtp_secure: true });
      await reload();
      toast.success("SMTP backend saved");
    } catch (e) { toast.error(e.message); }
  }

  return (
    <div className="space-y-4">
      <div className="bg-surface border border-border rounded-lg p-4">
        <h3 className="text-sm font-semibold text-fg mb-1">Connect a sending mailbox</h3>
        <p className="text-xs text-fg-muted mb-3">
          OAuth-backed accounts authenticate as a real user (no shared client secrets, MFA handled by the provider).
          Refresh tokens encrypt at rest under the workspace key.
        </p>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => startOAuth("graph_user")}
            className="bg-[#0078d4] text-white text-sm font-medium rounded px-4 py-1.5 hover:bg-[#106ebe]">
            Connect Microsoft 365
          </button>
          <button onClick={() => startOAuth("gmail_user")}
            className="bg-white border border-border text-fg text-sm font-medium rounded px-4 py-1.5 hover:bg-surface-2">
            <span className="mr-1.5">G</span>Connect Gmail
          </button>
          <button onClick={() => setShowSmtp(s => !s)}
            className="bg-surface-2 border border-border text-fg text-sm rounded px-4 py-1.5 hover:bg-surface">
            {showSmtp ? "Cancel SMTP" : "+ SMTP"}
          </button>
        </div>
        {showSmtp && (
          <form onSubmit={saveSmtp} className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
              placeholder="Display name" value={smtpForm.display_name}
              onChange={e => setSmtpForm(f => ({ ...f, display_name: e.target.value }))} />
            <input className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
              placeholder="From address *" required value={smtpForm.from_address}
              onChange={e => setSmtpForm(f => ({ ...f, from_address: e.target.value }))} />
            <input className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
              placeholder="Host *" required value={smtpForm.smtp_host}
              onChange={e => setSmtpForm(f => ({ ...f, smtp_host: e.target.value }))} />
            <input type="number" className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
              placeholder="Port" value={smtpForm.smtp_port}
              onChange={e => setSmtpForm(f => ({ ...f, smtp_port: parseInt(e.target.value, 10) }))} />
            <input className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
              placeholder="User" value={smtpForm.smtp_user}
              onChange={e => setSmtpForm(f => ({ ...f, smtp_user: e.target.value }))} />
            <input type="password" className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
              placeholder="Password / App Password" value={smtpForm.smtp_password}
              onChange={e => setSmtpForm(f => ({ ...f, smtp_password: e.target.value }))} />
            <label className="text-xs text-fg-muted flex items-center gap-1 sm:col-span-2">
              <input type="checkbox" checked={smtpForm.smtp_secure}
                onChange={e => setSmtpForm(f => ({ ...f, smtp_secure: e.target.checked }))} />
              SSL/TLS (587 = STARTTLS, leave checked; 465 = implicit TLS)
            </label>
            <button className="sm:col-span-2 bg-brand text-white text-sm rounded px-3 py-1.5">Save SMTP</button>
          </form>
        )}
      </div>

      {loading ? <div className="text-sm text-fg-dim">Loading…</div> :
        accounts.length === 0 ?
          <div className="text-sm text-fg-dim italic">No backends connected. Pick one above.</div> :
          <div className="space-y-2">
            {accounts.map(a => (
              <div key={a.id} className={`bg-surface border rounded-lg p-4 ${a.is_active ? "border-brand" : "border-border"}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-fg">{a.display_name || a.from_address}</span>
                      <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-surface-2 text-fg-muted">
                        {PROVIDER_LABELS[a.provider] || a.provider}
                      </span>
                      {a.is_active && <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-brand/15 text-brand">Active</span>}
                    </div>
                    <div className="text-xs text-fg-muted mt-1">
                      {a.from_address}
                      {a.provider !== "smtp" && a.oauth_expires_at && (
                        <> · token refreshes {new Date(a.oauth_expires_at).toLocaleString()}</>
                      )}
                      {a.provider === "smtp" && a.smtp_host && <> · {a.smtp_host}:{a.smtp_port}</>}
                    </div>
                    {a.last_test_at && (
                      <div className="text-xs mt-1">
                        Last test: <span className={a.last_test_status === "ok" ? "text-emerald-600" : "text-red-600"}>
                          {a.last_test_status}
                        </span>
                        {" · "}{new Date(a.last_test_at).toLocaleString()}
                        {a.last_test_error && <div className="text-fg-dim text-[11px] mt-0.5 truncate">{a.last_test_error}</div>}
                      </div>
                    )}
                    {a.provider !== "smtp" && (
                      <div className="text-xs mt-2 flex items-center gap-2 flex-wrap">
                        <label className="inline-flex items-center gap-1 text-fg-muted">
                          <input type="checkbox" checked={!!a.inbox_monitor_enabled}
                            onChange={(e) => toggleMonitor(a.id, e.target.checked)} />
                          Monitor inbox (auto-ingest mail)
                        </label>
                        {a.inbox_monitor_enabled && a.inbox_subscription_expires_at && (
                          <span className="text-fg-dim">
                            renews before {new Date(a.inbox_subscription_expires_at).toLocaleString()}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5 items-end">
                    {!a.is_active && (
                      <button onClick={() => activate(a.id)}
                        className="text-xs bg-brand text-white rounded px-3 py-1">Activate</button>
                    )}
                    <button onClick={() => test(a.id)}
                      className="text-xs bg-surface-2 border border-border text-fg-muted hover:text-fg rounded px-3 py-1">
                      Send test
                    </button>
                    <button onClick={() => remove(a.id)}
                      className="text-xs text-red-600 hover:underline">Delete</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
      }

      <div className="text-xs text-fg-dim">
        OAuth providers require <code>AZURE_CLIENT_ID</code>/<code>AZURE_CLIENT_SECRET</code> (Microsoft) or
        <code> GOOGLE_CLIENT_ID</code>/<code>GOOGLE_CLIENT_SECRET</code> (Google) in <code>.env</code>, plus the
        callback URL <code>{window.location.origin}/api/email-backends/oauth/callback</code> registered as a
        redirect URI on the OAuth app.
      </div>
    </div>
  );
}
