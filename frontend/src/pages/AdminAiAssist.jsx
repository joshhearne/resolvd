import { useState, useEffect } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// Three-section admin AI hub. Master-detail style left rail picks the
// section; right pane edits.
//   1. Integration       — provider / endpoint / model / API key /
//                          locked / BYOK toggle / Test connection
//   2. Permissions       — feature enabled, audience for usage badge,
//                          project context feature toggle
//   3. Project contexts  — list of projects → select → edit AI context
//                          markdown + per-project enabled toggle.
//
// Master-detail like Email backends: list left, detail right. Save
// per-section. New context for a project just means selecting it in
// the list and pasting markdown — no separate "create" step.

const SECTIONS = [
  { key: "integration", label: "Integration" },
  { key: "permissions", label: "Permissions" },
  { key: "project_contexts", label: "Project contexts" },
];

export default function AdminAiAssist() {
  const [section, setSection] = useState("integration");
  const [settings, setSettings] = useState(null);
  const [meta, setMeta] = useState(null); // providers + tones + verbosities
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get("/api/ai-settings")
      .then((d) => {
        setSettings(d);
        setMeta({ providers: d.providers, tones: d.tones, verbosities: d.verbosities });
        setLoading(false);
      })
      .catch((e) => {
        toast.error(e.message || "Failed to load AI settings");
        setLoading(false);
      });
  }, []);

  async function patch(partial) {
    setBusy(true);
    try {
      const updated = await api.patch("/api/ai-settings", partial);
      setSettings((s) => ({ ...s, ...updated }));
      toast.success("Saved");
    } catch (e) {
      toast.error(e.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="text-fg-muted">Loading…</div>;
  if (!settings) return <div className="text-red-500">Failed to load</div>;

  return (
    <div className="flex flex-col md:flex-row gap-6 items-start">
      <aside className="md:w-48 md:flex-shrink-0 md:sticky md:top-4 w-full">
        <h1 className="text-lg font-semibold text-fg mb-3">AI Assist</h1>
        <nav className="space-y-0.5">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              onClick={() => setSection(s.key)}
              className={`block w-full text-left px-3 py-2 text-sm rounded-md transition-colors ${
                section === s.key
                  ? "bg-brand/10 text-brand font-medium"
                  : "text-fg-muted hover:bg-surface-2 hover:text-fg"
              }`}
            >
              {s.label}
            </button>
          ))}
        </nav>
      </aside>

      <div className="flex-1 min-w-0 w-full">
        {section === "integration" && (
          <IntegrationPane settings={settings} meta={meta} patch={patch} busy={busy} setSettings={setSettings} />
        )}
        {section === "permissions" && (
          <PermissionsPane settings={settings} patch={patch} busy={busy} />
        )}
        {section === "project_contexts" && (
          <ProjectContextsPane />
        )}
      </div>
    </div>
  );
}

function IntegrationPane({ settings, meta, patch, busy, setSettings }) {
  const [keyInput, setKeyInput] = useState("");
  const [showKeyEditor, setShowKeyEditor] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState(null);
  const [liveCount, setLiveCount] = useState(0);
  const provider = meta?.providers.find((p) => p.id === settings.org_provider);

  // Curated list refreshes whenever provider changes. Live fetch only
  // on Refresh-button click.
  useEffect(() => {
    if (!settings.org_provider) {
      setModels([]); setLiveCount(0); setModelsError(null);
      return;
    }
    loadModels(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.org_provider]);

  async function loadModels(live) {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const r = await api.get(`/api/ai-settings/models${live ? "?live=true" : ""}`);
      setModels(r.models || []);
      setLiveCount(r.live_count || 0);
      if (r.live_error) setModelsError(r.live_error);
    } catch (e) {
      setModelsError(e.message || "Failed to load models");
    } finally {
      setModelsLoading(false);
    }
  }

  async function saveKey() {
    if (!keyInput.trim()) return;
    try {
      const r = await api.post("/api/ai-settings/api-key", { api_key: keyInput.trim() });
      setSettings((s) => ({ ...s, has_org_key: !!r.has_org_key }));
      setKeyInput("");
      setShowKeyEditor(false);
      toast.success("Org API key saved");
    } catch (e) {
      toast.error(e.message || "Failed");
    }
  }

  async function clearKey() {
    if (!confirm("Remove the org API key? Users falling back to org config will lose access until a new key is set.")) return;
    try {
      await api.post("/api/ai-settings/api-key", { api_key: null });
      setSettings((s) => ({ ...s, has_org_key: false }));
      toast.success("Org API key removed");
    } catch (e) {
      toast.error(e.message || "Failed");
    }
  }

  async function testConnection() {
    setTestResult(null);
    try {
      const r = await api.post("/api/ai-settings/test", {});
      setTestResult({ ok: true, msg: `OK · ${r.model} · ${r.latency_ms}ms` });
    } catch (e) {
      setTestResult({
        ok: false,
        msg: e.message || "Failed",
        providerMessage: e.body?.provider_message || null,
      });
    }
  }

  return (
    <div className="bg-surface rounded-lg border border-border shadow-sm p-5 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-fg mb-1">Integration</h2>
        <p className="text-sm text-fg-muted">
          Org-level provider config. When set + Lock is ON, every user routes
          through this provider/key. When BYOK is ON, users may set their
          own credentials and bypass the org config.
        </p>
      </div>

      {!settings.kms_available && (
        <MasterKeySetup
          onGenerated={() => { /* admin must restart to pick up; banner will clear next load */ }}
        />
      )}

      <label className="block">
        <span className="block text-sm font-medium text-fg mb-1">Provider</span>
        <select
          value={settings.org_provider || ""}
          onChange={(e) => patch({ org_provider: e.target.value || null })}
          disabled={busy}
          className="w-full border border-border-strong rounded-md px-2 py-1 text-sm bg-surface"
        >
          <option value="">— pick a provider —</option>
          {meta?.providers.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </label>

      {provider && (provider.setup_hint || provider.console_url) && (
        <div className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-fg-muted">
          {provider.setup_hint && <p className="leading-snug">{provider.setup_hint}</p>}
          {provider.console_url && (
            <p className="mt-1">
              <a
                href={provider.console_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand hover:underline"
              >
                Open {provider.console_label || "console"} ↗
              </a>
            </p>
          )}
        </div>
      )}

      <label className="block">
        <span className="block text-sm font-medium text-fg mb-1">Endpoint URL</span>
        <input
          type="text"
          placeholder={provider?.default_endpoint || "https://api.example.com"}
          value={settings.org_endpoint || ""}
          onChange={(e) => setSettings((s) => ({ ...s, org_endpoint: e.target.value }))}
          onBlur={(e) => patch({ org_endpoint: e.target.value || null })}
          disabled={busy}
          className="w-full border border-border-strong rounded-md px-2 py-1 text-sm font-mono"
        />
        <span className="block text-xs text-fg-muted mt-1">
          Leave blank to use provider default ({provider?.default_endpoint || "—"}).
        </span>
      </label>

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="block text-sm font-medium text-fg">Model</span>
          <button
            type="button"
            onClick={() => loadModels(true)}
            disabled={busy || modelsLoading || !provider || (provider.needs_api_key && !settings.has_org_key)}
            className="text-xs text-brand hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
            title={provider?.needs_api_key && !settings.has_org_key ? "Save an API key first" : "Fetch the live model list from the provider"}
          >
            {modelsLoading ? "Refreshing…" : "Refresh from provider"}
          </button>
        </div>
        {(() => {
          const grouped = {
            cheap:    { label: "Cheap / fast",   items: [] },
            balanced: { label: "Balanced",       items: [] },
            heavy:    { label: "Heavy / pricey", items: [] },
            live:     { label: "Other (live)",   items: [] },
          };
          for (const m of models) {
            const tier = grouped[m.tier] ? m.tier : "live";
            grouped[tier].items.push(m);
          }
          const includesCurrent = settings.org_model && models.some(m => m.id === settings.org_model);
          return (
            <select
              value={settings.org_model || ""}
              onChange={(e) => {
                const v = e.target.value;
                setSettings((s) => ({ ...s, org_model: v }));
                patch({ org_model: v || null });
              }}
              disabled={busy || !provider}
              className="w-full border border-border-strong rounded-md px-2 py-1 text-sm font-mono bg-surface"
            >
              <option value="">— pick a model —</option>
              {!includesCurrent && settings.org_model && (
                <option value={settings.org_model}>{settings.org_model} (custom)</option>
              )}
              {Object.entries(grouped).map(([key, g]) =>
                g.items.length > 0 ? (
                  <optgroup key={key} label={g.label}>
                    {g.items.map(m => (
                      <option key={m.id} value={m.id}>
                        {m.label}{m.recommended ? " — recommended" : ""}
                      </option>
                    ))}
                  </optgroup>
                ) : null
              )}
            </select>
          );
        })()}
        {(() => {
          const cur = models.find(m => m.id === settings.org_model);
          if (cur && cur.note) return <div className="mt-1 text-xs text-fg-muted">{cur.note}</div>;
          if (liveCount > 0) return <div className="mt-1 text-xs text-fg-dim">{liveCount} live model{liveCount === 1 ? "" : "s"} fetched from provider.</div>;
          return null;
        })()}
        {modelsError && <div className="mt-1 text-xs text-amber-600">{modelsError}</div>}
      </div>

      <div>
        <span className="block text-sm font-medium text-fg mb-1">API key</span>
        {!settings.kms_available && (
          <div className="text-xs text-amber-600 mb-1">
            Configure the master key above before saving an API key.
          </div>
        )}
        {!settings.has_org_key && !showKeyEditor && (
          <button
            type="button"
            onClick={() => setShowKeyEditor(true)}
            className="text-sm text-brand hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={!provider || provider.needs_api_key === false || !settings.kms_available}
          >
            {provider?.needs_api_key === false ? "Provider doesn't require a key" : "Set API key"}
          </button>
        )}
        {settings.has_org_key && !showKeyEditor && (
          <div className="flex items-center gap-3">
            <span className="font-mono text-sm text-fg-muted">·······························</span>
            <button onClick={() => setShowKeyEditor(true)} className="text-sm text-brand hover:underline">Replace</button>
            <button onClick={clearKey} className="text-sm text-red-500 hover:underline">Remove</button>
          </div>
        )}
        {showKeyEditor && (
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="paste API key"
              className="flex-1 border border-border-strong rounded-md px-2 py-1 text-sm font-mono"
            />
            <button onClick={saveKey} className="px-3 py-1 bg-brand text-white text-sm rounded-md hover:bg-brand/90">Save</button>
            <button onClick={() => { setShowKeyEditor(false); setKeyInput(""); }} className="text-sm text-fg-muted hover:text-fg">Cancel</button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={testConnection}
          disabled={busy || !settings.org_provider || !settings.org_model || (provider?.needs_api_key !== false && !settings.has_org_key)}
          className="px-3 py-1.5 text-sm border border-border-strong rounded-md hover:bg-surface-2 disabled:opacity-50"
        >
          Test connection
        </button>
        {testResult && (
          <div className="flex-1 text-xs">
            <div className={testResult.ok ? "text-green-600" : "text-red-600"}>{testResult.msg}</div>
            {testResult.providerMessage && (
              <details className="mt-0.5 text-fg-dim">
                <summary className="cursor-pointer select-none">Provider details</summary>
                <pre className="mt-1 p-2 bg-surface-2 rounded text-[11px] whitespace-pre-wrap">
{testResult.providerMessage}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PermissionsPane({ settings, patch, busy }) {
  return (
    <div className="bg-surface rounded-lg border border-border shadow-sm p-5 space-y-5">
      <div>
        <h2 className="text-base font-semibold text-fg mb-1">Permissions</h2>
        <p className="text-sm text-fg-muted">
          Org-wide feature gates and visibility tiers. These layer on top
          of per-user opt-ins.
        </p>
      </div>

      <CheckRow
        id="enabled"
        label="AI Assist available org-wide"
        hint="Master switch. When OFF, the AI rewrite button is hidden everywhere and the per-user AI Assist card is locked."
        checked={settings.enabled}
        onChange={(v) => patch({ enabled: v })}
        disabled={busy}
      />

      <CheckRow
        id="org_locked"
        label="Lock users to org config"
        hint="Users cannot set their own provider/model/key — every rewrite uses the org config. Requires the Integration section to be filled out."
        checked={settings.org_locked}
        onChange={(v) => patch({ org_locked: v })}
        disabled={busy || !settings.enabled}
      />

      <CheckRow
        id="allow_user_byok"
        label="Allow user BYOK (bring-your-own-key)"
        hint="When ON and not locked, users may set personal provider/model/key. Their config takes precedence over the org fallback."
        checked={settings.allow_user_byok}
        onChange={(v) => patch({ allow_user_byok: v })}
        disabled={busy || !settings.enabled || settings.org_locked}
      />

      <CheckRow
        id="project_context_enabled"
        label="Allow project AI context"
        hint="Admins can author per-project glossaries that get prepended to AI rewrites. Adds input tokens per call."
        checked={settings.project_context_enabled}
        onChange={(v) => patch({ project_context_enabled: v })}
        disabled={busy || !settings.enabled}
      />

      <div>
        <label htmlFor="audience" className="block text-sm font-medium text-fg mb-1">
          AI usage disclosure
        </label>
        <p className="text-xs text-fg-muted mb-2">
          Who sees the "✨ AI" badge on comments + tickets. Comment author + Admin/Manager
          always see. Vendors never see. Per-user opt-in to publish own usage org-wide
          overrides this for their own posts only.
        </p>
        <select
          id="audience"
          value={settings.disclosure_audience}
          onChange={(e) => patch({ disclosure_audience: e.target.value })}
          disabled={busy || !settings.enabled}
          className="border border-border-strong rounded-md px-2 py-1 text-sm disabled:opacity-50"
        >
          <option value="self_and_admin">Author + Admins/Managers (default)</option>
          <option value="admin_only">Admins/Managers only</option>
          <option value="all_users">Every internal user</option>
        </select>
      </div>
    </div>
  );
}

function ProjectContextsPane() {
  const [projects, setProjects] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [editing, setEditing] = useState({ md: "", enabled: true });
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get("/api/ai-settings/projects")
      .then((rows) => {
        setProjects(rows);
        if (rows.length > 0) setSelectedId(rows[0].id);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    api.get(`/api/ai-settings/projects/${selectedId}`)
      .then((d) => {
        setDetail(d);
        setEditing({ md: d.ai_context_md || "", enabled: d.ai_context_enabled !== false });
      })
      .catch(() => setDetail(null));
  }, [selectedId]);

  async function save() {
    setSaving(true);
    try {
      const r = await api.patch(`/api/ai-settings/projects/${selectedId}`, {
        ai_context_md: editing.md || null,
        ai_context_enabled: editing.enabled,
      });
      setDetail(r);
      // Reflect updated has_context flag in the left list
      setProjects((all) =>
        all.map((p) =>
          p.id === selectedId
            ? {
                ...p,
                ai_context_enabled: r.ai_context_enabled,
                has_context: !!(r.ai_context_md && r.ai_context_md.trim()),
                context_length: (r.ai_context_md || "").length,
              }
            : p,
        ),
      );
      toast.success("Saved");
    } catch (e) {
      toast.error(e.message || "Failed");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="text-fg-muted">Loading projects…</div>;

  return (
    <div className="bg-surface rounded-lg border border-border shadow-sm overflow-hidden">
      <div className="p-4 border-b border-border">
        <h2 className="text-base font-semibold text-fg mb-1">Project contexts</h2>
        <p className="text-sm text-fg-muted">
          Per-project markdown blob prepended to AI rewrites for tickets in
          that project. Capped at 8000 chars. Use it to teach the model your
          sites, integrations, and glossary.
        </p>
      </div>
      <div className="flex flex-col md:flex-row min-h-[400px]">
        <div className="md:w-64 md:flex-shrink-0 border-b md:border-b-0 md:border-r border-border overflow-y-auto max-h-[500px]">
          {projects.length === 0 ? (
            <div className="p-3 text-xs text-fg-dim">No active projects</div>
          ) : (
            <ul className="divide-y divide-border">
              {projects.map((p) => (
                <li key={p.id}>
                  <button
                    onClick={() => setSelectedId(p.id)}
                    className={`w-full text-left px-3 py-2 transition-colors ${
                      selectedId === p.id
                        ? "bg-brand/10"
                        : "hover:bg-surface-2"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-fg">
                        <span className="font-mono text-fg-muted text-xs">{p.prefix}</span>
                        {" "}
                        {p.name}
                      </span>
                      {p.has_context && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand/15 text-brand">
                          {p.context_length}c
                        </span>
                      )}
                    </div>
                    {!p.ai_context_enabled && p.has_context && (
                      <div className="text-[10px] text-amber-500 mt-0.5">disabled</div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex-1 p-4 min-w-0">
          {!detail ? (
            <div className="text-fg-dim text-sm">Pick a project</div>
          ) : (
            <>
              <div className="mb-3 flex items-center justify-between flex-wrap gap-2">
                <div>
                  <span className="font-mono text-fg-muted text-xs">{detail.prefix}</span>
                  <span className="ml-2 font-semibold text-fg">{detail.name}</span>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={editing.enabled}
                    onChange={(e) => setEditing((p) => ({ ...p, enabled: e.target.checked }))}
                    className="h-4 w-4 rounded border-border-strong text-brand"
                  />
                  Inject context into rewrites
                </label>
              </div>
              <textarea
                value={editing.md}
                onChange={(e) => setEditing((p) => ({ ...p, md: e.target.value }))}
                placeholder={"# Sites\n- example.com\n\n# Integrations\n- GitHub (org: acme)\n\n# Glossary\n- \"the bot\" = our Slack notifier"}
                rows={20}
                className="w-full border border-border-strong rounded-md px-2 py-1.5 text-xs font-mono"
              />
              <div className="mt-2 flex items-center justify-between gap-3 flex-wrap">
                <span className="text-[11px] text-fg-dim">
                  {(editing.md || "").length} / 8000 chars
                </span>
                <button
                  onClick={save}
                  disabled={saving || (editing.md || "").length > 8000}
                  className="px-3 py-1 bg-brand text-white text-sm rounded-md hover:bg-brand/90 disabled:opacity-50"
                >
                  Save context
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Inline banner shown in the Integration pane when RESOLVD_MASTER_KEY is
// absent. Generates a fresh key on demand and walks the admin through
// adding it to .env + restarting the backend. The key never leaves this
// modal — the server returns it once and does not persist it anywhere.
function MasterKeySetup({ onGenerated }) {
  const [generating, setGenerating] = useState(false);
  const [shown, setShown] = useState(null); // { key, instructions }
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  async function generate() {
    setGenerating(true);
    try {
      const r = await api.post("/api/ai-settings/generate-master-key", {});
      setShown(r);
      onGenerated?.();
    } catch (e) {
      toast.error(e.message || "Failed to generate key");
    } finally {
      setGenerating(false);
    }
  }

  async function copy() {
    if (!shown?.key) return;
    try {
      await navigator.clipboard.writeText(shown.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Clipboard unavailable — copy manually.");
    }
  }

  function close() {
    if (!acknowledged) {
      if (!confirm("This key will not be shown again. Did you copy and back it up?")) return;
    }
    setShown(null);
    setAcknowledged(false);
  }

  return (
    <>
      <div className="rounded-md border border-amber-400/60 bg-amber-50 dark:bg-amber-900/20 px-3 py-3 text-sm">
        <div className="font-medium text-amber-900 dark:text-amber-200 mb-1">
          AI Assist is disabled — master key not configured
        </div>
        <p className="text-xs text-amber-900/80 dark:text-amber-200/80 mb-2">
          AI provider keys are stored encrypted using <code className="font-mono">RESOLVD_MASTER_KEY</code>.
          Without it the AI module stays off for the whole org. Generate a key
          below, paste it into your <code className="font-mono">.env</code>, then restart the backend.
        </p>
        <button
          type="button"
          onClick={generate}
          disabled={generating}
          className="px-3 py-1.5 text-sm bg-amber-600 hover:bg-amber-700 text-white rounded-md disabled:opacity-50"
        >
          {generating ? "Generating…" : "Generate master key"}
        </button>
      </div>

      {shown && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <div className="bg-surface rounded-lg shadow-xl border border-border max-w-lg w-full p-5 space-y-4">
            <div>
              <h3 className="text-base font-semibold text-fg">Your new master key</h3>
              <p className="text-xs text-fg-muted mt-1">
                Shown <span className="font-semibold">once</span>. Resolvd does not store this anywhere — copy it now, back it up
                outside the database, then paste into <code className="font-mono">.env</code> and restart the backend.
              </p>
            </div>

            <div className="rounded-md border border-border-strong bg-surface-2 px-3 py-2 font-mono text-xs break-all select-all">
              {shown.key}
            </div>

            <button
              type="button"
              onClick={copy}
              className="w-full px-3 py-1.5 text-sm border border-border-strong rounded-md hover:bg-surface-2"
            >
              {copied ? "Copied ✓" : "Copy to clipboard"}
            </button>

            <ol className="text-xs text-fg-muted list-decimal pl-5 space-y-1">
              {(shown.instructions || []).map((line, i) => <li key={i}>{line}</li>)}
            </ol>

            <label className="flex items-start gap-2 text-xs text-fg cursor-pointer">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-border-strong text-brand"
              />
              <span>I have copied this key and backed it up in a secure location.</span>
            </label>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={close}
                className="px-3 py-1.5 text-sm bg-brand text-white rounded-md hover:bg-brand/90"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function CheckRow({ id, label, hint, checked, onChange, disabled }) {
  return (
    <label htmlFor={id} className="flex items-start gap-3 cursor-pointer">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-border-strong text-brand disabled:opacity-40"
      />
      <span className="text-sm text-fg">
        {label}
        {hint && <span className="block text-xs text-fg-muted mt-0.5">{hint}</span>}
      </span>
    </label>
  );
}
