import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import { useAuth } from "../context/AuthContext";

const PROVIDER_LABELS = {
  graph_user: "Microsoft 365 (Graph delegated)",
  gmail_user: "Gmail (OAuth)",
  smtp: "SMTP",
};

export default function AdminEmailBackends() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
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
    try {
      await api.delete(`/api/email-backends/${id}`);
      if (selectedId === id) setSelectedId(null);
      await reload();
    } catch (e) { toast.error(e.message); }
  }

  async function toggleMonitor(id, enabled) {
    try {
      await api.post(`/api/email-backends/${id}/monitor`, { enabled });
      await reload();
      toast.success(enabled ? "Inbox monitoring on" : "Inbox monitoring off");
    } catch (e) { toast.error(e.message); }
  }

  async function toggleSendAs(id, enabled) {
    try {
      await api.post(`/api/email-backends/${id}/send-as-submitter`, { enabled });
      await reload();
      toast.success(enabled ? "Send as submitter on" : "Send as submitter off");
    } catch (e) { toast.error(e.message); }
  }

  async function saveBannerPatterns(id, patterns) {
    try {
      await api.post(`/api/email-backends/${id}/banner-patterns`, { patterns });
      await reload();
      toast.success(patterns.length ? `Saved ${patterns.length} pattern(s)` : "Patterns cleared");
    } catch (e) { toast.error(e.message); }
  }

  async function addScope(accountId, projectId, sendEnabled, recvEnabled) {
    try {
      await api.post(`/api/email-backends/${accountId}/scopes`, {
        project_id: projectId,
        send_enabled: sendEnabled,
        recv_enabled: recvEnabled,
      });
      toast.success("Project scoped");
    } catch (e) { toast.error(e.message); }
  }
  async function removeScope(accountId, projectId) {
    try {
      await api.delete(`/api/email-backends/${accountId}/scopes/${projectId}`);
      toast.success("Scope removed");
    } catch (e) { toast.error(e.message); }
  }
  async function approveScope(accountId, projectId) {
    try {
      await api.post(`/api/email-backends/${accountId}/scopes/${projectId}/approve`, {});
      toast.success("Scope approved");
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

  const selected = accounts.find((a) => a.id === selectedId);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-fg mb-1">Email backends</h1>
        <p className="text-sm text-fg-muted">
          Outbound senders + inbound mailboxes. OAuth-backed where possible
          (no shared client secrets, MFA stays with the provider).
        </p>
      </div>

      {/* Connect new mailbox — full-width banner */}
      <div className="bg-surface border border-border rounded-lg p-4">
        <h3 className="text-sm font-semibold text-fg mb-1">Connect a sending mailbox</h3>
        <p className="text-xs text-fg-muted mb-3">
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

      {/* Master-detail */}
      <div className="flex flex-col lg:flex-row gap-4 items-stretch">
        <aside
          className={`
            ${selectedId ? "hidden lg:block" : "block"}
            lg:w-80 lg:flex-shrink-0 bg-surface border border-border rounded-lg overflow-hidden
          `}
        >
          {loading ? (
            <div className="text-sm text-fg-dim p-4">Loading…</div>
          ) : accounts.length === 0 ? (
            <div className="text-sm text-fg-dim italic p-4">
              No backends connected. Pick one above.
            </div>
          ) : (
            <div className="divide-y divide-border max-h-[70vh] overflow-y-auto">
              {accounts.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setSelectedId(a.id)}
                  className={`w-full text-left px-3 py-2.5 hover:bg-surface-2 transition-colors ${
                    selectedId === a.id ? "bg-brand/5 border-l-2 border-brand" : ""
                  }`}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-fg truncate">
                      {a.display_name || a.from_address}
                    </span>
                    {a.is_active && (
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-brand/15 text-brand">
                        Active
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-fg-muted truncate mt-0.5">
                    {a.from_address}
                  </div>
                  <div className="text-[11px] text-fg-dim mt-1 flex items-center gap-2 flex-wrap">
                    <span>{PROVIDER_LABELS[a.provider] || a.provider}</span>
                    {a.inbox_monitor_enabled && (
                      <span className="text-emerald-700 dark:text-emerald-400">
                        · monitor
                      </span>
                    )}
                    {a.send_as_submitter && (
                      <span className="text-amber-700 dark:text-amber-400">
                        · send-as
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section className={`flex-1 min-w-0 ${selectedId ? "block" : "hidden lg:block"}`}>
          {!selected ? (
            <div className="bg-surface border border-border rounded-lg p-8 text-sm text-fg-dim italic text-center">
              Select an account to view and edit its settings.
            </div>
          ) : (
            <AccountDetail
              account={selected}
              currentUser={user}
              onBack={() => setSelectedId(null)}
              onActivate={() => activate(selected.id)}
              onTest={() => test(selected.id)}
              onRemove={() => remove(selected.id)}
              onToggleMonitor={(v) => toggleMonitor(selected.id, v)}
              onToggleSendAs={(v) => toggleSendAs(selected.id, v)}
              onSaveBannerPatterns={(p) => saveBannerPatterns(selected.id, p)}
              onAddScope={(pid, s, r) => addScope(selected.id, pid, s, r).then(reload)}
              onRemoveScope={(pid) => removeScope(selected.id, pid).then(reload)}
              onApproveScope={(pid) => approveScope(selected.id, pid).then(reload)}
            />
          )}
        </section>
      </div>

      <div className="text-xs text-fg-dim">
        OAuth providers require <code>AZURE_CLIENT_ID</code>/<code>AZURE_CLIENT_SECRET</code> (Microsoft) or
        <code> GOOGLE_CLIENT_ID</code>/<code>GOOGLE_CLIENT_SECRET</code> (Google) in <code>.env</code>, plus the
        callback URL <code>{window.location.origin}/api/email-backends/oauth/callback</code> registered as a
        redirect URI on the OAuth app.
      </div>
    </div>
  );
}

function AccountDetail({
  account: a,
  currentUser,
  onBack,
  onActivate,
  onTest,
  onRemove,
  onToggleMonitor,
  onToggleSendAs,
  onSaveBannerPatterns,
  onAddScope,
  onRemoveScope,
  onApproveScope,
}) {
  return (
    <div className="bg-surface border border-border rounded-lg p-4 space-y-4">
      <button
        onClick={onBack}
        className="lg:hidden text-xs text-fg-muted hover:text-fg"
      >
        ← Back to list
      </button>

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-base font-semibold text-fg">
              {a.display_name || a.from_address}
            </h2>
            <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-surface-2 text-fg-muted">
              {PROVIDER_LABELS[a.provider] || a.provider}
            </span>
            {a.is_active && (
              <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-brand/15 text-brand">
                Active
              </span>
            )}
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
              Last test:{" "}
              <span className={a.last_test_status === "ok" ? "text-emerald-600" : "text-red-600"}>
                {a.last_test_status}
              </span>
              {" · "}{new Date(a.last_test_at).toLocaleString()}
              {a.last_test_error && (
                <div className="text-fg-dim text-[11px] mt-0.5">{a.last_test_error}</div>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {!a.is_active && (
            <button onClick={onActivate} className="text-xs bg-brand text-white rounded px-3 py-1">
              Activate
            </button>
          )}
          <button onClick={onTest}
            className="text-xs bg-surface-2 border border-border text-fg-muted hover:text-fg rounded px-3 py-1">
            Send test
          </button>
          <button onClick={onRemove} className="text-xs text-red-600 hover:underline">
            Delete
          </button>
        </div>
      </div>

      {a.provider !== "smtp" && (
        <div className="space-y-3 pt-3 border-t border-border">
          <div className="flex items-center gap-2 flex-wrap">
            <label className="inline-flex items-center gap-1 text-sm text-fg">
              <input type="checkbox" checked={!!a.inbox_monitor_enabled}
                onChange={(e) => onToggleMonitor(e.target.checked)} />
              Monitor inbox (auto-ingest mail)
            </label>
            {a.inbox_monitor_enabled && a.inbox_subscription_expires_at && (
              <span className="text-xs text-fg-dim">
                renews before {new Date(a.inbox_subscription_expires_at).toLocaleString()}
              </span>
            )}
          </div>

          <div>
            <label className="inline-flex items-center gap-1 text-sm text-fg">
              <input type="checkbox" checked={!!a.send_as_submitter}
                onChange={(e) => onToggleSendAs(e.target.checked)} />
              Send vendor emails as submitting user
            </label>
            {a.send_as_submitter && a.provider === "graph_user" && (
              <div className="mt-1.5 rounded bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-700 px-2.5 py-2 text-[11px] text-amber-800 dark:text-amber-300 leading-snug">
                <strong>Exchange admin action required.</strong> This mailbox must have{" "}
                <em>Send on Behalf Of</em> permission granted for each submitter in Exchange Online.
                Open{" "}
                <a href="https://admin.exchange.microsoft.com/#/mailboxes" target="_blank" rel="noopener noreferrer" className="underline font-medium">
                  Exchange admin center → Mailboxes
                </a>
                {" "}→ select this mailbox → Delegation → Send on behalf → add your users.
              </div>
            )}
            {a.send_as_submitter && a.provider === "gmail_user" && (
              <div className="mt-1.5 rounded bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-700 px-2.5 py-2 text-[11px] text-amber-800 dark:text-amber-300 leading-snug">
                <strong>Google Workspace admin action required.</strong> Delegation must be enabled
                for this mailbox in{" "}
                <a href="https://admin.google.com/ac/apps/gmail/defaultsettings" target="_blank" rel="noopener noreferrer" className="underline font-medium">
                  Google Admin → Gmail → Default settings
                </a>
                {" "}and each submitter added as a delegate.
              </div>
            )}
          </div>

          {a.inbox_monitor_enabled && (
            <BannerStripSection account={a} onSave={onSaveBannerPatterns} />
          )}
          <ScopeSection
            account={a}
            currentUser={currentUser}
            onAdd={onAddScope}
            onRemove={onRemoveScope}
            onApprove={onApproveScope}
          />
        </div>
      )}
    </div>
  );
}

function ScopeSection({ account, currentUser, onAdd, onRemove, onApprove, onDefaultChange }) {
  const [open, setOpen] = useState(false);
  const [scopes, setScopes] = useState([]);
  const [projects, setProjects] = useState([]);
  const [pickProject, setPickProject] = useState("");
  const [pickSend, setPickSend] = useState(true);
  const [pickRecv, setPickRecv] = useState(true);
  const [defaultProjectId, setDefaultProjectId] = useState(
    account.default_inbound_project_id ?? ""
  );
  const [savingDefault, setSavingDefault] = useState(false);
  const isAdmin = currentUser?.role === "Admin";

  useEffect(() => {
    if (!open) return;
    api.get(`/api/email-backends/${account.id}/scopes`).then(setScopes).catch(() => setScopes([]));
    api.get("/api/projects").then((all) => {
      const active = (all || []).filter((p) => p.status === "active");
      setProjects(active);
    }).catch(() => setProjects([]));
  }, [open, account.id]);

  async function refreshLocal() {
    const fresh = await api.get(`/api/email-backends/${account.id}/scopes`).catch(() => []);
    setScopes(fresh);
  }

  async function handleAdd(e) {
    e.preventDefault();
    if (!pickProject) return;
    await onAdd(Number(pickProject), pickSend, pickRecv);
    setPickProject("");
    setPickSend(true);
    setPickRecv(true);
    await refreshLocal();
  }
  async function handleRemove(projectId) {
    await onRemove(projectId);
    await refreshLocal();
  }
  async function handleApprove(projectId) {
    await onApprove(projectId);
    await refreshLocal();
  }

  const pendingApproval = scopes.filter((s) => !s.approved_at);
  const isSingleScope = scopes.length === 1;
  const usedIds = new Set(scopes.map((s) => s.project_id));
  const choices = projects.filter((p) => !usedIds.has(p.id));
  // Eligible defaults: approved + recv_enabled scopes only. Single-scope
  // accounts auto-route, so the picker is shown only when there are >=2
  // eligible scopes (which makes prefix-less mail otherwise drop to
  // manual queue).
  const eligibleDefaults = scopes.filter((s) => s.approved_at && s.recv_enabled);
  const showDefaultPicker = eligibleDefaults.length >= 2;

  async function saveDefaultProject(nextId) {
    setSavingDefault(true);
    try {
      const projectId = nextId === "" ? null : Number(nextId);
      const r = await api.put(`/api/email-backends/${account.id}/default-inbound-project`, { project_id: projectId });
      setDefaultProjectId(r.default_inbound_project_id ?? "");
      onDefaultChange?.(account.id, r.default_inbound_project_id ?? null);
      toast.success(projectId
        ? `Default landing project set to ${eligibleDefaults.find((s) => s.project_id === projectId)?.project_name || projectId}`
        : "Default landing project cleared");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSavingDefault(false);
    }
  }

  return (
    <div className="border-t border-border pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-sm text-fg flex items-center gap-1.5 font-medium"
      >
        <span>{open ? "▾" : "▸"}</span>
        Project scope
        {scopes.length > 0 && (
          <span className="ml-1 px-1.5 py-0.5 rounded bg-brand/15 text-brand text-[10px]">
            {scopes.length} project{scopes.length !== 1 ? "s" : ""}
          </span>
        )}
        {pendingApproval.length > 0 && (
          <span className="ml-1 px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 text-[10px]">
            {pendingApproval.length} pending approval
          </span>
        )}
      </button>
      {open && (
        <div className="mt-2 space-y-2 text-xs">
          <p className="text-fg-muted">
            Scope this mailbox to one or more projects. Send / Recv toggle the
            direction independently. When a mailbox is scoped to exactly one
            project, inbound mail auto-routes there without needing a
            <code> #PREFIX</code> subject — but Admin must approve the
            single-scope assignment first.
          </p>

          {scopes.length > 0 && (
            <ul className="border border-border rounded divide-y divide-border">
              {scopes.map((s) => (
                <li key={s.id} className="px-2 py-2 flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-fg">{s.project_name}</span>
                  <span className="text-fg-muted">[{s.project_prefix}]</span>
                  <span className="text-fg-muted">
                    {s.send_enabled && "send"}
                    {s.send_enabled && s.recv_enabled && " · "}
                    {s.recv_enabled && "recv"}
                    {!s.send_enabled && !s.recv_enabled && "send + receive disabled"}
                  </span>
                  {s.approved_at ? (
                    <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                      approved
                    </span>
                  ) : (
                    <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300">
                      pending
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-2">
                    {!s.approved_at && isAdmin && isSingleScope && (
                      <button type="button" onClick={() => handleApprove(s.project_id)} className="text-brand hover:underline">
                        Approve
                      </button>
                    )}
                    <button type="button" onClick={() => handleRemove(s.project_id)} className="text-red-600 hover:underline">
                      Remove
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {isSingleScope && pendingApproval.length > 0 && !isAdmin && (
            <div className="rounded bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-700 px-2.5 py-2 text-amber-800 dark:text-amber-300">
              <strong>Awaiting Admin approval.</strong> An Admin needs to approve
              this single-project scope before inbound mail will auto-route to
              the project.
            </div>
          )}

          {showDefaultPicker && (
            <div className="rounded border border-border bg-surface-2 p-2.5 space-y-1.5">
              <label className="font-semibold text-fg block">
                Default landing project (no <code>#PREFIX</code>)
              </label>
              <p className="text-fg-muted">
                When inbound mail arrives without a <code>#PREFIX</code> and the inbox
                serves several projects, route to this one instead of dropping
                to the manual queue.
              </p>
              <select
                value={defaultProjectId}
                onChange={(e) => saveDefaultProject(e.target.value)}
                disabled={!isAdmin || savingDefault}
                className="bg-surface border border-border rounded px-2 py-1"
              >
                <option value="">— No default (use manual queue) —</option>
                {eligibleDefaults.map((s) => (
                  <option key={s.project_id} value={s.project_id}>
                    {s.project_name} ({s.project_prefix})
                  </option>
                ))}
              </select>
              {!isAdmin && (
                <p className="text-fg-dim">Only Admins can pin a default landing project.</p>
              )}
            </div>
          )}

          {choices.length > 0 && (
            <form onSubmit={handleAdd} className="flex items-center gap-2 flex-wrap">
              <select value={pickProject} onChange={(e) => setPickProject(e.target.value)}
                className="bg-surface-2 border border-border rounded px-2 py-1">
                <option value="">Add project…</option>
                {choices.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} ({p.prefix})</option>
                ))}
              </select>
              <label className="inline-flex items-center gap-1">
                <input type="checkbox" checked={pickSend} onChange={(e) => setPickSend(e.target.checked)} />
                send
              </label>
              <label className="inline-flex items-center gap-1">
                <input type="checkbox" checked={pickRecv} onChange={(e) => setPickRecv(e.target.checked)} />
                recv
              </label>
              <button type="submit" disabled={!pickProject}
                className="text-xs bg-brand text-white rounded px-3 py-1 disabled:opacity-50">
                Add scope
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

const BANNER_PRESETS = [
  {
    key: "inky",
    label: "Inky",
    pattern: "^\\s*Caution:\\s*External[\\s\\S]*?Protection by INKY[^\\n]*",
  },
  {
    key: "mimecast",
    label: "Mimecast",
    pattern: "^\\s*\\[?CAUTION:?\\]?[^\\n]*External[^\\n]{0,300}",
  },
  {
    key: "proofpoint",
    label: "Proofpoint",
    pattern: "\\[EXTERNAL\\][\\s\\S]*?This email originated from outside[^\\n]*",
  },
  {
    key: "avanan",
    label: "Avanan",
    pattern: "^\\s*\\*\\*\\* External Email \\*\\*\\*[^\\n]*",
  },
];

function BannerStripSection({ account, onSave }) {
  const [open, setOpen] = useState(false);
  const initial = (account.inbound_banner_strip_patterns || []).join("\n");
  const [draft, setDraft] = useState(initial);
  const dirty = draft !== initial;

  function addPreset(p) {
    const lines = draft.split("\n").map((s) => s.trim()).filter(Boolean);
    if (lines.includes(p)) return;
    lines.push(p);
    setDraft(lines.join("\n"));
  }

  async function save() {
    const patterns = draft.split("\n").map((s) => s.trim()).filter(Boolean);
    await onSave(patterns);
  }

  const count = (account.inbound_banner_strip_patterns || []).length;

  return (
    <div className="border-t border-border pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-sm text-fg flex items-center gap-1.5 font-medium"
      >
        <span>{open ? "▾" : "▸"}</span>
        Inbound banner stripping
        {count > 0 && (
          <span className="ml-1 px-1.5 py-0.5 rounded bg-brand/15 text-brand text-[10px]">
            {count} active
          </span>
        )}
      </button>
      {open && (
        <div className="mt-2 space-y-2 text-xs">
          <div className="rounded bg-blue-50 dark:bg-blue-950/40 border border-blue-300 dark:border-blue-700 px-2.5 py-2 text-blue-900 dark:text-blue-200 leading-snug">
            <strong>Try the gateway first.</strong> If this is a licensed
            resource mailbox (no human user), most gateways (Inky, Mimecast,
            Proofpoint) let you suppress recipient banners per-mailbox while
            keeping malware/phishing scans active. That delivers cleaner
            replies than regex stripping ever will. Use the patterns below
            only when upstream suppression isn't an option.
          </div>
          <div>
            <span className="text-fg-muted">Presets — click to add: </span>
            {BANNER_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => addPreset(p.pattern)}
                className="ml-1 px-2 py-0.5 rounded bg-surface-2 border border-border hover:bg-surface text-fg-muted hover:text-fg"
              >
                {p.label}
              </button>
            ))}
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="One regex per line. Applied with /im flags."
            rows={Math.max(3, draft.split("\n").length)}
            className="w-full font-mono text-[11px] bg-surface-2 border border-border rounded px-2 py-1"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={!dirty}
              className="text-xs bg-brand text-white rounded px-3 py-1 disabled:opacity-50"
            >
              Save patterns
            </button>
            {dirty && (
              <button
                type="button"
                onClick={() => setDraft(initial)}
                className="text-xs text-fg-muted hover:text-fg"
              >
                Reset
              </button>
            )}
            <span className="text-fg-dim">
              Lines starting with whitespace are stripped.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
