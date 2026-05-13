import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import HybridTime from "../components/HybridTime";

const PRESET_LABELS = {
  zabbix: "Zabbix",
  action1: "Action1",
};

function CopyButton({ value, label = "Copy" }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Copy failed");
        }
      }}
      className="text-xs px-2 py-1 rounded bg-surface-2 border border-border hover:bg-surface text-fg-muted hover:text-fg"
    >
      {copied ? "✓ Copied" : label}
    </button>
  );
}

function zabbixSnippet(webhookUrl) {
  return `// Zabbix → Resolvd webhook (paste into Media types → Webhook → script)
// Required parameters (set in the Parameters tab):
//   event_id        {EVENT.ID}
//   event_status    {EVENT.VALUE}        // 1 = problem, 0 = recovery
//   severity        {EVENT.SEVERITY}
//   host_name       {HOST.NAME}
//   trigger_name    {TRIGGER.NAME}
//   trigger_description  {TRIGGER.DESCRIPTION}
//   operational_data     {EVENT.OPDATA}
//   event_tags      {EVENT.TAGS}
//   event_url       {\$ZABBIX.URL}/tr_events.php?triggerid={TRIGGER.ID}&eventid={EVENT.ID}
//   user_email      {INVENTORY.POC.PRIMARY.EMAIL}   // optional — attributes ticket to that user if active in Resolvd
try {
  var p = JSON.parse(value);
  var req = new HttpRequest();
  req.addHeader('Content-Type: application/json');
  var resp = req.post('${webhookUrl}', JSON.stringify(p));
  if (req.getStatus() < 200 || req.getStatus() >= 300) {
    throw 'HTTP ' + req.getStatus() + ': ' + resp;
  }
  return resp;
} catch (e) {
  Zabbix.log(3, '[Resolvd] error: ' + e);
  throw 'Resolvd webhook failed: ' + e;
}`;
}

export default function AdminAlertSources() {
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [projects, setProjects] = useState([]);
  const [presets, setPresets] = useState([]);
  const [newToken, setNewToken] = useState(null);

  async function loadList() {
    setLoading(true);
    try {
      setSources(await api.get("/api/alert-sources"));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadDetail(id) {
    try {
      setDetail(await api.get(`/api/alert-sources/${id}`));
    } catch (e) {
      toast.error(e.message);
    }
  }

  useEffect(() => {
    loadList();
    api.get("/api/projects").then((all) =>
      setProjects((all || []).filter((p) => p.status === "active"))
    ).catch(() => setProjects([]));
    api.get("/api/alert-sources/_meta/presets").then((m) =>
      setPresets(m.presets || [])
    ).catch(() => setPresets([]));
  }, []);

  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId]);

  async function createSource(form) {
    try {
      const r = await api.post("/api/alert-sources", form);
      // Action1 has no webhook channel, so the token is irrelevant — skip
      // the "copy now" banner to avoid implying webhooks exist there.
      if (form.preset !== "action1") {
        setNewToken({ id: r.id, token: r.token });
        toast.success("Source created — copy the token now");
      } else {
        toast.success("Source created — configure API credentials below");
      }
      setShowCreate(false);
      await loadList();
      setSelectedId(r.id);
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function rotateToken(id) {
    if (!window.confirm("Rotate token? The current token will stop working immediately.")) return;
    try {
      const r = await api.post(`/api/alert-sources/${id}/rotate-token`, {});
      setNewToken({ id, token: r.token });
      await loadDetail(id);
      toast.success("Token rotated — copy now");
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function patchSource(id, patch) {
    try {
      await api.patch(`/api/alert-sources/${id}`, patch);
      await loadList();
      await loadDetail(id);
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function deleteSource(id) {
    if (!window.confirm("Delete this alert source? Existing tickets stay; future alerts to this URL will fail.")) return;
    try {
      await api.delete(`/api/alert-sources/${id}`);
      if (selectedId === id) setSelectedId(null);
      await loadList();
    } catch (e) {
      toast.error(e.message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-fg mb-1">Alert sources</h1>
          <p className="text-sm text-fg-muted">
            Inbound webhooks from monitoring tools. Each source has a unique
            token; URL stays stable. Events dedup per source.
          </p>
        </div>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => { setShowCreate(true); setNewToken(null); }}
        >
          + New source
        </button>
      </div>

      {newToken && (
        <NewTokenBanner
          token={newToken.token}
          source={sources.find((s) => s.id === newToken.id)}
          onDismiss={() => setNewToken(null)}
        />
      )}

      {showCreate && (
        <CreateForm
          presets={presets}
          projects={projects}
          onCancel={() => setShowCreate(false)}
          onSubmit={createSource}
        />
      )}

      <div className="flex flex-col lg:flex-row gap-4 items-stretch">
        <aside
          className={`
            ${selectedId ? "hidden lg:block" : "block"}
            lg:w-80 lg:flex-shrink-0 bg-surface border border-border rounded-lg overflow-hidden
          `}
        >
          {loading ? (
            <div className="text-sm text-fg-dim p-4">Loading…</div>
          ) : sources.length === 0 ? (
            <div className="text-sm text-fg-dim italic p-4">
              No sources yet. Click "New source" to add one.
            </div>
          ) : (
            <div className="divide-y divide-border max-h-[70vh] overflow-y-auto">
              {sources.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSelectedId(s.id)}
                  className={`w-full text-left px-3 py-2.5 hover:bg-surface-2 transition-colors ${
                    selectedId === s.id ? "bg-brand/5 border-l-2 border-brand" : ""
                  }`}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-fg truncate">{s.name}</span>
                    {!s.enabled && (
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-fg-dim/15 text-fg-dim">
                        disabled
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-fg-muted truncate mt-0.5">
                    {PRESET_LABELS[s.preset] || s.preset} · {s.event_count} events
                  </div>
                  <div className="text-[11px] text-fg-dim mt-1">
                    {s.last_seen_at ? (
                      <>last seen <HybridTime value={s.last_seen_at} /></>
                    ) : (
                      "never received"
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section className={`flex-1 min-w-0 ${selectedId ? "block" : "hidden lg:block"}`}>
          {!detail ? (
            <div className="bg-surface border border-border rounded-lg p-8 text-sm text-fg-dim italic text-center">
              Select a source on the left, or create a new one.
            </div>
          ) : (
            <SourceDetail
              source={detail}
              projects={projects}
              presets={presets}
              onBack={() => setSelectedId(null)}
              onPatch={(patch) => patchSource(detail.id, patch)}
              onRotate={() => rotateToken(detail.id)}
              onDelete={() => deleteSource(detail.id)}
              onReload={async () => {
                await loadDetail(detail.id);
                await loadList();
              }}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function CreateForm({ presets, projects, onCancel, onSubmit }) {
  const [form, setForm] = useState({
    name: "",
    preset: presets[0]?.name || "zabbix",
    default_project_id: projects[0]?.id || "",
    auto_resolve_on_recovery: false,
  });

  function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim()) return toast.error("Name required");
    if (!form.default_project_id) return toast.error("Project required");
    onSubmit({
      ...form,
      default_project_id: Number(form.default_project_id),
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-surface border border-border rounded-lg p-4 grid grid-cols-1 sm:grid-cols-2 gap-3"
    >
      <div className="sm:col-span-2 text-sm font-semibold text-fg">New alert source</div>
      <label className="text-xs text-fg-muted flex flex-col gap-1">
        Name
        <input
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="Production Zabbix"
          className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          required
        />
      </label>
      <label className="text-xs text-fg-muted flex flex-col gap-1">
        Preset
        <select
          value={form.preset}
          onChange={(e) => setForm((f) => ({ ...f, preset: e.target.value }))}
          className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
        >
          {presets.map((p) => (
            <option key={p.name} value={p.name}>
              {PRESET_LABELS[p.name] || p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-fg-muted flex flex-col gap-1 sm:col-span-2">
        Default project
        <select
          value={form.default_project_id}
          onChange={(e) => setForm((f) => ({ ...f, default_project_id: e.target.value }))}
          className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          required
        >
          <option value="">— pick a project —</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.prefix})
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-fg-muted inline-flex items-center gap-2 sm:col-span-2">
        <input
          type="checkbox"
          checked={form.auto_resolve_on_recovery}
          onChange={(e) => setForm((f) => ({ ...f, auto_resolve_on_recovery: e.target.checked }))}
        />
        Auto-resolve ticket when alert recovers
      </label>
      <div className="sm:col-span-2 flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="btn btn-secondary btn-sm">
          Cancel
        </button>
        <button type="submit" className="btn btn-primary btn-sm">
          Create
        </button>
      </div>
    </form>
  );
}

function NewTokenBanner({ token, source, onDismiss }) {
  return (
    <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-700 rounded-lg p-4 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            Copy this token now
          </div>
          <div className="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
            We only store a hash. You won't be able to see it again — rotate
            via the source if you lose it.
          </div>
        </div>
        <button onClick={onDismiss} className="text-amber-800 dark:text-amber-300 hover:opacity-70">
          ✕
        </button>
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs bg-white/60 dark:bg-black/30 rounded px-2 py-1.5 font-mono break-all">
          {token}
        </code>
        <CopyButton value={token} />
      </div>
      {source && (
        <div className="text-xs text-amber-800 dark:text-amber-300">
          Webhook URL:{" "}
          <code className="font-mono">
            {window.location.origin}/api/webhooks/{source.preset}/{token}
          </code>
        </div>
      )}
    </div>
  );
}

function SourceDetail({ source, projects, presets, onBack, onPatch, onRotate, onDelete, onReload }) {
  const [name, setName] = useState(source.name);
  const [projectId, setProjectId] = useState(source.default_project_id || "");
  const [autoResolve, setAutoResolve] = useState(!!source.auto_resolve_on_recovery);
  const [enabled, setEnabled] = useState(!!source.enabled);
  const [sevText, setSevText] = useState(JSON.stringify(source.severity_map || {}, null, 2));
  const [apiUrl, setApiUrl] = useState(source.api_url || "");
  const [apiTokenInput, setApiTokenInput] = useState("");
  const [apiClientId, setApiClientId] = useState(source.api_client_id || "");
  const [pollInterval, setPollInterval] = useState(
    source.poll_interval_minutes != null ? String(source.poll_interval_minutes) : "0"
  );
  const [affectInventory, setAffectInventory] = useState(!!source.affect_inventory);
  const [backfillOpen, setBackfillOpen] = useState(false);
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [backfillResult, setBackfillResult] = useState(null);
  const [backfillHostGroup, setBackfillHostGroup] = useState("Printers");

  // Resync local state when the selected source changes (different row).
  useEffect(() => {
    setName(source.name);
    setProjectId(source.default_project_id || "");
    setAutoResolve(!!source.auto_resolve_on_recovery);
    setEnabled(!!source.enabled);
    setSevText(JSON.stringify(source.severity_map || {}, null, 2));
    setApiUrl(source.api_url || "");
    setApiTokenInput("");
    setApiClientId(source.api_client_id || "");
    setPollInterval(
      source.poll_interval_minutes != null ? String(source.poll_interval_minutes) : "0"
    );
    setAffectInventory(!!source.affect_inventory);
    setBackfillResult(null);
  }, [source.id]);

  const presetMeta = presets.find((p) => p.name === source.preset);
  const defaultSevMap = presetMeta?.default_severity_map || {};
  const webhookUrlBase = `${window.location.origin}/api/webhooks/${source.preset}`;

  async function saveCore() {
    let parsedSev;
    try {
      parsedSev = JSON.parse(sevText || "{}");
    } catch {
      return toast.error("Severity map must be valid JSON");
    }
    const patch = {
      name: name.trim(),
      default_project_id: Number(projectId),
      auto_resolve_on_recovery: autoResolve,
      enabled,
      severity_map: parsedSev,
      api_url: apiUrl.trim() || null,
      api_client_id: apiClientId.trim() || null,
      poll_interval_minutes: Math.max(0, Math.min(60, Number(pollInterval) || 0)),
      affect_inventory: affectInventory,
    };
    // Only include api_token if the input has a value — empty string means
    // "leave alone". Set to null explicitly via the Clear button.
    if (apiTokenInput.trim()) patch.api_token = apiTokenInput.trim();
    await onPatch(patch);
    setApiTokenInput("");
    toast.success("Saved");
  }

  async function clearApiToken() {
    if (!window.confirm("Clear the API token? Backfill will stop working until you set a new one.")) return;
    await onPatch({ api_token: null });
    setApiTokenInput("");
    toast.success("API token cleared");
  }

  async function runBackfill() {
    setBackfillBusy(true);
    setBackfillResult(null);
    try {
      const r = await api.post(`/api/alert-sources/${source.id}/backfill`, {
        host_group: backfillHostGroup.trim() || null,
      });
      setBackfillResult(r);
      toast.success(`Backfill: ${r.created} new tickets, ${r.deduped} skipped`);
      if (onReload) await onReload();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBackfillBusy(false);
    }
  }

  function resetSevToDefaults() {
    setSevText(JSON.stringify(defaultSevMap, null, 2));
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-4 space-y-4">
      <button onClick={onBack} className="lg:hidden text-xs text-fg-muted hover:text-fg">
        ← Back to list
      </button>

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-semibold text-fg">{source.name}</h2>
          <div className="text-xs text-fg-muted mt-0.5">
            {PRESET_LABELS[source.preset] || source.preset}
            {" · "}
            {source.event_count ?? source.recent_events?.length ?? 0} events received
            {source.last_seen_at && (
              <> · last seen <HybridTime value={source.last_seen_at} /></>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {source.preset !== "action1" && (
            <button onClick={onRotate} className="btn btn-secondary btn-sm">
              Rotate token
            </button>
          )}
          <button onClick={onDelete} className="text-xs text-red-600 hover:underline px-2 py-1">
            Delete
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 border-t border-border">
        <label className="text-xs text-fg-muted flex flex-col gap-1">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs text-fg-muted flex flex-col gap-1">
          Default project
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.prefix})
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-fg-muted inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={autoResolve}
            onChange={(e) => setAutoResolve(e.target.checked)}
          />
          Auto-resolve ticket on alert recovery
        </label>
        <label className="text-xs text-fg-muted inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Enabled (incoming alerts accepted)
        </label>
      </div>

      <div className="space-y-1.5 pt-3 border-t border-border">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-fg">Severity map</span>
          <button onClick={resetSevToDefaults} className="text-xs text-brand hover:underline">
            Reset to defaults
          </button>
        </div>
        <p className="text-xs text-fg-muted">
          Maps the preset's severity strings to Resolvd priority (1 = highest,
          5 = lowest). Missing keys fall back to priority 3.
        </p>
        <textarea
          value={sevText}
          onChange={(e) => setSevText(e.target.value)}
          rows={Math.max(4, sevText.split("\n").length)}
          className="w-full font-mono text-xs bg-surface-2 border border-border rounded px-2 py-1.5"
        />
      </div>

      <div className="flex justify-end pt-2 border-t border-border">
        <button onClick={saveCore} className="btn btn-primary btn-sm">
          Save changes
        </button>
      </div>

      {source.preset !== "action1" && (
        <div className="space-y-2 pt-3 border-t border-border">
          <div className="text-sm font-medium text-fg">Webhook URL template</div>
          <p className="text-xs text-fg-muted">
            Append the source token to this URL. Token is shown only once — use
            "Rotate token" if you've lost it.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-surface-2 rounded border border-border px-2 py-1.5 font-mono break-all">
              {webhookUrlBase}/&lt;your-token&gt;
            </code>
            <CopyButton value={`${webhookUrlBase}/<your-token>`} />
          </div>
        </div>
      )}

      {(source.preset === "zabbix" || source.preset === "action1") && (
        <div className="space-y-3 pt-3 border-t border-border">
          <div className="text-sm font-medium text-fg">
            API connection {source.preset === "action1" ? "(pull alerts from Action1)" : "(optional)"}
          </div>
          <p className="text-xs text-fg-muted">
            {source.preset === "action1" ? (
              <>
                Action1 has no outbound webhook channel and no alerts REST
                endpoint — alerts in their UI are email-only. What's available
                via API is <b>policy execution results</b> per endpoint, and
                failed results are what Resolvd ingests as tickets. Create an
                API client in Action1 (Settings → API → New) with role{" "}
                <b>Enterprise Viewer</b> (or Manager if you want remediation
                actions later). Paste only the base URL below
                (e.g. <code>https://app.action1.com</code>), <b>not</b> the
                full curl example. Client Secret stored encrypted under the
                workspace key.
              </>
            ) : (
              <>
                Lets Resolvd pull from Zabbix (currently: backfill open problems).
                Use a dedicated API token, scoped read-only where possible. Token
                stored encrypted under the workspace key.
              </>
            )}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-xs text-fg-muted flex flex-col gap-1">
              {source.preset === "action1" ? "API base URL" : "API URL"}
              <input
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder={
                  source.preset === "action1"
                    ? "https://app.action1.com"
                    : "https://zabbix.example.com/api_jsonrpc.php"
                }
                className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono"
              />
            </label>
            {source.preset === "action1" && (
              <label className="text-xs text-fg-muted flex flex-col gap-1">
                Client ID
                <input
                  value={apiClientId}
                  onChange={(e) => setApiClientId(e.target.value)}
                  placeholder="from Action1 → API client"
                  className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono"
                />
              </label>
            )}
            <label className="text-xs text-fg-muted flex flex-col gap-1">
              {source.preset === "action1" ? "Client Secret" : "API token"}
              <div className="flex items-center gap-1.5">
                <input
                  type="password"
                  value={apiTokenInput}
                  onChange={(e) => setApiTokenInput(e.target.value)}
                  placeholder={source.api_token_set ? "•••••• (set)" : "paste secret"}
                  className="flex-1 bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono"
                />
                {source.api_token_set && (
                  <button
                    type="button"
                    onClick={clearApiToken}
                    className="text-xs text-red-600 hover:underline whitespace-nowrap"
                  >
                    Clear
                  </button>
                )}
              </div>
            </label>
          </div>
          {source.preset === "action1" && (
            <label className="text-xs text-fg-muted inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={affectInventory}
                onChange={(e) => setAffectInventory(e.target.checked)}
              />
              Feed inventory module (sync managed endpoints as assets on each poll)
            </label>
          )}

          {source.preset === "action1" && (
            <label className="text-xs text-fg-muted flex flex-col gap-1 max-w-xs">
              Poll interval (minutes)
              <input
                type="number"
                min="0"
                max="60"
                value={pollInterval}
                onChange={(e) => setPollInterval(e.target.value)}
                className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono w-24"
              />
              <span className="text-[11px] text-fg-dim">
                0 disables auto-poll. 1–60 min cadence. The "Pull now" button
                still works regardless.
              </span>
              {source.last_poll_at && (
                <span className="text-[11px] text-fg-dim">
                  Last poll: <HybridTime value={source.last_poll_at} />
                </span>
              )}
            </label>
          )}

          {source.api_last_error && (
            <div className="text-xs text-red-600 dark:text-red-400">
              Last API error: {source.api_last_error}
            </div>
          )}
          {source.api_last_ok_at && !source.api_last_error && (
            <div className="text-xs text-emerald-700 dark:text-emerald-400">
              Last API call OK: <HybridTime value={source.api_last_ok_at} />
            </div>
          )}

          <div className="border-t border-border pt-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-fg">
                {source.preset === "action1" ? "Pull failed policy results now" : "Backfill open problems"}
              </div>
              <button
                type="button"
                onClick={() => setBackfillOpen((v) => !v)}
                className="text-xs text-fg-muted hover:text-fg"
              >
                {backfillOpen ? "Hide" : "Show"}
              </button>
            </div>
            {backfillOpen && (
              <div className="mt-2 space-y-2">
                <p className="text-xs text-fg-muted">
                  {source.preset === "action1" ? (
                    <>
                      Pulls failed policy results across every org the API
                      client can see and creates one ticket per failure.
                      Dedup keyed on policy+endpoint+run-timestamp, so re-runs
                      spawn fresh tickets but a single failed run only opens
                      one ticket. Save the API URL, Client ID, and Client
                      Secret first.
                    </>
                  ) : (
                    <>
                      Pulls currently-open problems from Zabbix and ingests each
                      via the same pipeline as a live webhook fire. Already-seen
                      events skip cleanly. Save your API URL + token first.
                    </>
                  )}
                </p>
                <div className="flex items-end gap-2 flex-wrap">
                  {source.preset === "zabbix" && (
                    <label className="text-xs text-fg-muted flex flex-col gap-1">
                      Host group filter (optional)
                      <input
                        value={backfillHostGroup}
                        onChange={(e) => setBackfillHostGroup(e.target.value)}
                        placeholder="Printers"
                        className="bg-surface-2 border border-border rounded px-2 py-1 text-sm w-56"
                      />
                    </label>
                  )}
                  <button
                    type="button"
                    onClick={runBackfill}
                    disabled={
                      backfillBusy ||
                      !source.api_token_set ||
                      !source.api_url ||
                      (source.preset === "action1" && !source.api_client_id)
                    }
                    className="btn btn-primary btn-sm disabled:opacity-50"
                    title={
                      !source.api_token_set
                        ? "Save credentials first"
                        : source.preset === "action1" && !source.api_client_id
                          ? "Save Client ID first"
                          : ""
                    }
                  >
                    {backfillBusy
                      ? "Running…"
                      : source.preset === "action1"
                        ? "Pull now"
                        : "Run backfill"}
                  </button>
                </div>
                {backfillResult && (
                  <div className="text-xs bg-surface-2 border border-border rounded p-2 space-y-0.5">
                    {backfillResult.scan && (
                      <>
                        <div className="text-fg-muted">
                          Walked: {backfillResult.scan.orgCount} org(s),{" "}
                          {backfillResult.scan.policyCount} polic(ies),{" "}
                          {backfillResult.scan.resultCount} endpoint result(s)
                        </div>
                        {backfillResult.scan.statusCounts &&
                          Object.keys(backfillResult.scan.statusCounts).length > 0 && (
                            <div className="text-fg-dim">
                              Status breakdown:{" "}
                              {Object.entries(backfillResult.scan.statusCounts)
                                .map(([k, v]) => `${k}=${v}`)
                                .join(", ")}
                            </div>
                          )}
                      </>
                    )}
                    <div>Matched (failed): {backfillResult.fetched}</div>
                    <div className="text-emerald-700 dark:text-emerald-400">
                      Created: {backfillResult.created}
                    </div>
                    <div className="text-fg-muted">Skipped (already seen): {backfillResult.deduped}</div>
                    {backfillResult.failed > 0 && (
                      <div className="text-red-600">Failed: {backfillResult.failed}</div>
                    )}
                    {backfillResult.inventory && (
                      <div className="pt-1 border-t border-border mt-1">
                        <span className="text-fg-muted">Inventory: </span>
                        {backfillResult.inventory.error ? (
                          <span className="text-red-600">{backfillResult.inventory.error}</span>
                        ) : (
                          <span>
                            {backfillResult.inventory.upserted} upserted,{" "}
                            {backfillResult.inventory.skipped} skipped (
                            {backfillResult.inventory.fetched} endpoints fetched)
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {source.preset === "zabbix" && (
        <div className="space-y-2 pt-3 border-t border-border">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-fg">Zabbix media-type script</div>
            <CopyButton value={zabbixSnippet(`${webhookUrlBase}/<your-token>`)} label="Copy script" />
          </div>
          <p className="text-xs text-fg-muted">
            Paste into Zabbix → Administration → Media types → Webhook → script
            field. Replace <code>&lt;your-token&gt;</code> with the source token.
          </p>
          <pre className="text-[11px] font-mono bg-surface-2 border border-border rounded p-2 overflow-x-auto whitespace-pre">
{zabbixSnippet(`${webhookUrlBase}/<your-token>`)}
          </pre>
        </div>
      )}

      {source.preset === "action1" && (
        <div className="space-y-2 pt-3 border-t border-border">
          <div className="text-sm font-medium text-fg">Severity mapping</div>
          <p className="text-xs text-fg-muted">
            Failed policy results come in as <code>High</code> by default. Add
            other Action1 severity strings (<code>Critical</code>,{" "}
            <code>Warning</code>, <code>Medium</code>, <code>Low</code>,{" "}
            <code>Information</code>) to the map above to override priority
            per rule.
          </p>
        </div>
      )}

      {source.preset === "action1" && source.affect_inventory && (
        <AttributeMappingSection source={source} onReload={onReload} />
      )}

      <div className="space-y-2 pt-3 border-t border-border">
        <div className="text-sm font-medium text-fg">Recent events</div>
        {(!source.recent_events || source.recent_events.length === 0) ? (
          <div className="text-xs text-fg-dim italic">No events yet.</div>
        ) : (
          <div className="border border-border rounded overflow-hidden">
            <table className="min-w-full divide-y divide-border text-xs">
              <thead className="bg-surface-2">
                <tr className="text-fg-dim">
                  <th className="px-3 py-1.5 text-left font-medium">Event ID</th>
                  <th className="px-3 py-1.5 text-left font-medium">Type</th>
                  <th className="px-3 py-1.5 text-left font-medium">Ticket</th>
                  <th className="px-3 py-1.5 text-left font-medium">Received</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {source.recent_events.map((e) => (
                  <tr key={e.id}>
                    <td className="px-3 py-1.5 font-mono text-fg">{e.external_event_id}</td>
                    <td className="px-3 py-1.5 text-fg-muted">{e.event_type}</td>
                    <td className="px-3 py-1.5">
                      {e.ticket_id ? (
                        <a href={`/tickets/${e.ticket_id}`} className="text-brand hover:underline">
                          #{e.ticket_id}
                        </a>
                      ) : (
                        <span className="text-fg-dim">—</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-fg-muted whitespace-nowrap">
                      <HybridTime value={e.received_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// Maps Action1's per-endpoint custom attributes to either a built-in
// asset column or a custom field def. Only renders when the source is
// inventory-enabled — otherwise the data path doesn't exist.
const MAPPABLE_COLUMNS = [
  "hostname", "serial", "mac", "manufacturer", "model",
  "os", "os_version", "cpu", "ip_address",
];

function AttributeMappingSection({ source, onReload }) {
  const [attrs, setAttrs] = useState(null);
  const [hint, setHint] = useState(null);
  const [defs, setDefs] = useState([]);
  const [edits, setEdits] = useState(() => ({ ...(source.attribute_map || {}) }));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const [a, d] = await Promise.all([
          api.get(`/api/alert-sources/${source.id}/attributes`),
          api.get(`/api/custom-field-defs?entity_type=asset`),
        ]);
        setAttrs(a.attributes || []);
        setHint(a.hint || null);
        setDefs(d || []);
      } catch (e) {
        toast.error(e.message || "Failed to load attributes");
        setAttrs([]);
      }
    }
    load();
  }, [source.id]);

  useEffect(() => {
    setEdits({ ...(source.attribute_map || {}) });
  }, [source.id, source.attribute_map]);

  function currentTargetValue(attrName) {
    const m = edits[attrName];
    if (!m) return "";
    if (m.type === "asset_column") return `col:${m.target}`;
    if (m.type === "custom_field") return `cf:${m.target}`;
    return "";
  }

  function setTarget(attrName, raw) {
    setEdits((prev) => {
      const next = { ...prev };
      if (!raw) { delete next[attrName]; return next; }
      const [kind, target] = raw.split(":");
      if (kind === "col") next[attrName] = { type: "asset_column", target };
      else if (kind === "cf") next[attrName] = { type: "custom_field", target: Number(target) };
      return next;
    });
  }

  const initial = JSON.stringify(source.attribute_map || {});
  const current = JSON.stringify(edits);
  const dirty = initial !== current;

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/api/alert-sources/${source.id}`, { attribute_map: edits });
      toast.success("Mapping saved — applies on next Pull / poll");
      if (onReload) await onReload();
    } catch (e) {
      toast.error(e.message || "Failed");
    } finally {
      setSaving(false);
    }
  }

  if (attrs == null) return null;

  return (
    <div className="space-y-2 pt-3 border-t border-border">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-fg">Custom attribute mapping</div>
        {dirty && (
          <button onClick={save} disabled={saving} className="text-xs px-2 py-1 bg-brand text-white rounded disabled:opacity-50">
            {saving ? "Saving…" : "Save mapping"}
          </button>
        )}
      </div>
      <p className="text-xs text-fg-muted">
        Action1's per-endpoint <code>custom</code> attributes (up to 30
        per tenant) can be routed into a built-in asset column or any
        asset custom field. Sample values shown are from the most-recent
        synced endpoint. Mappings apply on the next Pull / scheduled poll.
        Define custom fields under <b>Admin → Workflow → Custom fields</b>.
      </p>
      {attrs.length === 0 ? (
        <div className="text-xs text-fg-dim italic">{hint || "No attributes seen yet."}</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-fg-muted">
            <tr>
              <th className="text-left py-1">Attribute</th>
              <th className="text-left py-1">Sample value</th>
              <th className="text-left py-1">Target</th>
            </tr>
          </thead>
          <tbody>
            {attrs.map((a) => (
              <tr key={a.name} className="border-t border-border">
                <td className="py-1.5 pr-3 font-mono">{a.name}</td>
                <td className="py-1.5 pr-3 text-fg-muted truncate max-w-xs">
                  {a.sample_value || <span className="text-fg-dim italic">empty</span>}
                </td>
                <td className="py-1.5">
                  <select
                    value={currentTargetValue(a.name)}
                    onChange={(e) => setTarget(a.name, e.target.value)}
                    className="border border-border-strong rounded px-2 py-1 text-xs w-full max-w-xs"
                  >
                    <option value="">— skip —</option>
                    <optgroup label="Asset column">
                      {MAPPABLE_COLUMNS.map((c) => <option key={c} value={`col:${c}`}>{c}</option>)}
                    </optgroup>
                    {defs.length > 0 && (
                      <optgroup label="Custom field">
                        {defs.map((d) => (
                          <option key={d.id} value={`cf:${d.id}`}>{d.label} ({d.type})</option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
