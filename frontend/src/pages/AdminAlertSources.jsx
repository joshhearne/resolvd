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
  const [adapters, setAdapters] = useState([]);
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
    api.get("/api/alert-sources/_meta/registry").then((m) =>
      setAdapters(m.adapters || [])
    ).catch(() => setAdapters([]));
  }, []);

  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId]);

  async function createSource(form) {
    try {
      const r = await api.post("/api/alert-sources", form);
      // Action1 (and any future pull-only RMM) has no webhook channel,
      // so the token is irrelevant — skip the "copy now" banner.
      const vendor = form.vendor || form.preset;
      const isPullOnly = vendor === "action1";
      if (!isPullOnly) {
        setNewToken({ id: r.id, token: r.token });
        toast.success("Integration created — copy the token now");
      } else {
        toast.success("Integration created — configure API credentials below");
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
      // If the newly-created token banner belongs to this source,
      // clear it — otherwise it sticks around pointing at a row that
      // no longer exists.
      if (newToken?.id === id) setNewToken(null);
      await loadList();
    } catch (e) {
      toast.error(e.message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-fg mb-1">Integrations</h1>
          <p className="text-sm text-fg-muted">
            Connect monitoring + RMM vendors. Each integration declares
            capabilities (alerts, inventory, software, vulnerabilities,
            companies) — toggle which ones are active per row. Named
            adapters (Action1, Zabbix, …) work out of the box;
            webhook-only vendors map JSON via the tabular field map.
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
          adapters={adapters}
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
              {sources.map((s) => {
                const adapter = adapters.find((a) => a.vendor === (s.vendor || s.preset));
                const label = adapter?.label || PRESET_LABELS[s.preset] || s.preset;
                const caps = Array.isArray(s.capabilities) ? s.capabilities : [];
                return (
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
                        alerting disabled
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-fg-muted truncate mt-0.5">
                    {label} · {s.event_count} events
                  </div>
                  {caps.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {caps.map((c) => (
                        <span key={c} className="text-[10px] px-1.5 py-0.5 rounded bg-brand/10 text-brand">
                          {c}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="text-[11px] text-fg-dim mt-1">
                    {s.last_seen_at ? (
                      <>last seen <HybridTime value={s.last_seen_at} /></>
                    ) : (
                      "never received"
                    )}
                  </div>
                </button>
                );
              })}
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
              adapters={adapters}
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

// Registry-driven Add-integration form. Renders the credentialsSchema
// fields the adapter declares (so adding NinjaOne / Datto / Action1
// asks for the right inputs without code changes here). For
// "Generic webhook" (no adapter), only name + project + the token are
// needed — credentials live nowhere; the user maps payloads via the
// field-map editor on the detail page after create.
const GENERIC_VENDOR_OPT = {
  vendor: "__generic__",
  label: "Generic webhook (no adapter)",
  kind: "webhook_only",
  capabilities: ["alerts"],
  credentialsSchema: [],
};

function CreateForm({ presets, adapters, projects, onCancel, onSubmit }) {
  // Build a single dropdown list = registry adapters + the synthetic
  // "generic webhook" option so users can onboard any vendor that can
  // POST JSON without waiting for a code-side adapter.
  const vendorOpts = [...adapters, GENERIC_VENDOR_OPT];
  const [vendor, setVendor] = useState(vendorOpts[0]?.vendor || "");
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id || "");
  const [autoResolve, setAutoResolve] = useState(false);
  const [creds, setCreds] = useState({});         // credentialsSchema fields keyed by name
  const [picked, setPicked] = useState([]);       // capabilities[]

  const adapter = vendorOpts.find((a) => a.vendor === vendor) || GENERIC_VENDOR_OPT;
  const isGeneric = adapter.vendor === GENERIC_VENDOR_OPT.vendor;
  const schema = adapter.credentialsSchema || [];
  const allowedCaps = adapter.capabilities || ["alerts"];

  // Reset creds + picked when vendor changes — different adapters
  // expose different fields.
  useEffect(() => {
    const fresh = {};
    for (const f of schema) fresh[f.name] = "";
    setCreds(fresh);
    setPicked(allowedCaps);
  }, [vendor]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim()) return toast.error("Name required");
    if (!projectId) return toast.error("Project required");
    if (!picked.length) return toast.error("Pick at least one capability");
    // Validate required credential fields per the schema.
    for (const f of schema) {
      if (f.required && !(creds[f.name] || "").trim()) {
        return toast.error(`${f.label || f.name} required`);
      }
    }
    const body = {
      name: name.trim(),
      default_project_id: Number(projectId),
      auto_resolve_on_recovery: autoResolve,
      capabilities: picked,
    };
    if (isGeneric) {
      // Generic vendor maps to webhook-only kind. Backend stamps preset
      // = vendor when missing; pick a stable string so the row doesn't
      // collide with the named adapter slot.
      body.vendor = "webhook";
      body.kind = "webhook_only";
    } else {
      body.vendor = adapter.vendor;
      body.kind = adapter.kind;
    }
    // Credential fields land at their declared column name. Backend
    // route accepts api_url / api_client_id / api_token explicitly;
    // unknown extras are ignored.
    for (const f of schema) {
      const v = (creds[f.name] || "").trim();
      if (v) body[f.name] = v;
    }
    onSubmit(body);
  }

  function toggleCap(c) {
    setPicked((prev) => prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-surface border border-border rounded-lg p-4 grid grid-cols-1 sm:grid-cols-2 gap-3"
    >
      <div className="sm:col-span-2 text-sm font-semibold text-fg">New integration</div>

      <label className="text-xs text-fg-muted flex flex-col gap-1">
        Vendor
        <select
          value={vendor}
          onChange={(e) => setVendor(e.target.value)}
          className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
        >
          {vendorOpts.map((a) => (
            <option key={a.vendor} value={a.vendor}>
              {a.label} {a.kind ? `· ${a.kind}` : ""}
            </option>
          ))}
        </select>
        {isGeneric && (
          <span className="text-[11px] text-fg-dim mt-0.5">
            Use for any tool that can POST JSON. Map payloads via the
            field-map editor after creating.
          </span>
        )}
      </label>

      <label className="text-xs text-fg-muted flex flex-col gap-1">
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={isGeneric ? "Datto RMM (webhook)" : `Production ${adapter.label}`}
          className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          required
        />
      </label>

      <label className="text-xs text-fg-muted flex flex-col gap-1 sm:col-span-2">
        Default project
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
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

      {/* Adapter-declared credential fields. Renders 0 inputs for
          webhook-only vendors; the token comes from the create
          response and is shown in the NewTokenBanner. */}
      {schema.length > 0 && (
        <>
          <div className="sm:col-span-2 text-xs font-medium text-fg pt-1">
            Credentials
          </div>
          {schema.map((f) => (
            <label key={f.name} className="text-xs text-fg-muted flex flex-col gap-1 sm:col-span-2">
              {f.label || f.name}
              {f.required && <span className="text-red-500 inline ml-0.5">*</span>}
              <input
                type={f.kind === "secret" ? "password" : (f.kind === "url" ? "url" : "text")}
                value={creds[f.name] || ""}
                onChange={(e) => setCreds((prev) => ({ ...prev, [f.name]: e.target.value }))}
                placeholder={f.kind === "url" ? "https://…" : ""}
                className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono"
                autoComplete={f.kind === "secret" ? "new-password" : "off"}
              />
              {f.encrypted && (
                <span className="text-[11px] text-fg-dim">Encrypted at rest.</span>
              )}
            </label>
          ))}
        </>
      )}

      <div className="sm:col-span-2 text-xs font-medium text-fg pt-1">Capabilities</div>
      <div className="sm:col-span-2 grid grid-cols-2 sm:grid-cols-3 gap-2">
        {allowedCaps.map((c) => (
          <label key={c} className="flex items-center gap-2 text-xs text-fg-muted">
            <input
              type="checkbox"
              checked={picked.includes(c)}
              onChange={() => toggleCap(c)}
            />
            {c}
          </label>
        ))}
      </div>

      <label className="text-xs text-fg-muted inline-flex items-center gap-2 sm:col-span-2">
        <input
          type="checkbox"
          checked={autoResolve}
          onChange={(e) => setAutoResolve(e.target.checked)}
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

function SourceDetail({ source, projects, presets, adapters, onBack, onPatch, onRotate, onDelete, onReload }) {
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
  const [inventoryCompanyId, setInventoryCompanyId] = useState(
    source.inventory_company_id ? String(source.inventory_company_id) : ""
  );
  const [companies, setCompanies] = useState([]);
  useEffect(() => {
    api.get('/api/companies').then(setCompanies).catch(() => setCompanies([]));
  }, []);
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
    setInventoryCompanyId(source.inventory_company_id ? String(source.inventory_company_id) : "");
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
      inventory_company_id: inventoryCompanyId ? Number(inventoryCompanyId) : null,
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
          <p className="text-xs text-fg-muted pt-1">
            Generic intake (works for any vendor — runs the registered
            adapter when one matches, otherwise falls back to the field
            map below):
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-surface-2 rounded border border-border px-2 py-1.5 font-mono break-all">
              {window.location.origin}/api/webhooks/in/&lt;your-token&gt;
            </code>
            <CopyButton value={`${window.location.origin}/api/webhooks/in/<your-token>`} />
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

          {source.preset === "action1" && affectInventory && (
            <label className="text-xs text-fg-muted flex flex-col gap-1 max-w-md">
              <span>Inventory company override</span>
              <select
                value={inventoryCompanyId}
                onChange={(e) => setInventoryCompanyId(e.target.value)}
                className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
              >
                <option value="">— resolve from Action1 organization —</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <span className="text-[11px] text-fg-dim">
                Pin every asset from this source to one Resolvd company
                when the entire source belongs to one customer (single-
                tenant integrations). Leave blank when Action1 ships
                multiple orgs and you want per-asset resolution — see
                the org → company mapping table further down for fine
                control over exotic / multi-site names.
              </span>
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

      {source.preset === "action1" && source.affect_inventory && !source.inventory_company_id && (
        <CompanyMapSection source={source} onReload={onReload} />
      )}

      <CapabilitiesSection source={source} adapters={adapters} onPatch={onPatch} onReload={onReload} />

      <FieldMapSection source={source} onReload={onReload} />

      <AlertRulesSection source={source} />

      <InboundEventsSection source={source} />

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

// Hudu-style: list the distinct org names this source has shipped, let
// admin map each exotic name (e.g. "Motorhomes of Texas — Site 1",
// "Internal IT Infrastructure") to a Resolvd company. Used when the
// source is multi-tenant (Action1 with N orgs, NinjaOne customers)
// AND the integration's org names don't match Resolvd company names
// verbatim. Hidden when inventory_company_id is set (whole-source
// pin takes precedence).
function CompanyMapSection({ source, onReload }) {
  const [orgs, setOrgs] = useState(null);
  const [companies, setCompanies] = useState([]);
  const [edits, setEdits] = useState(() => ({ ...(source.company_map || {}) }));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const [seen, cos] = await Promise.all([
          api.get(`/api/alert-sources/${source.id}/seen-orgs`),
          api.get(`/api/companies`),
        ]);
        setOrgs(seen.orgs || []);
        setCompanies(cos || []);
      } catch (e) {
        toast.error(e.message || "Failed to load orgs");
        setOrgs([]);
      }
    }
    load();
  }, [source.id]);

  useEffect(() => {
    setEdits({ ...(source.company_map || {}) });
  }, [source.id, source.company_map]);

  const initial = JSON.stringify(source.company_map || {});
  const current = JSON.stringify(edits);
  const dirty = initial !== current;

  function setMap(orgName, val) {
    setEdits((prev) => {
      const next = { ...prev };
      if (!val) delete next[orgName];
      else next[orgName] = Number(val);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/api/alert-sources/${source.id}`, { company_map: edits });
      toast.success("Mapping saved — applies on next Pull / poll");
      if (onReload) await onReload();
    } catch (e) {
      toast.error(e.message || "Failed");
    } finally {
      setSaving(false);
    }
  }

  if (orgs == null) return null;

  return (
    <div className="space-y-2 pt-3 border-t border-border">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-fg">Source org → Resolvd company</div>
        {dirty && (
          <button onClick={save} disabled={saving}
            className="text-xs px-2 py-1 bg-brand text-white rounded disabled:opacity-50">
            {saving ? "Saving…" : "Save mapping"}
          </button>
        )}
      </div>
      <p className="text-xs text-fg-muted">
        Routes exotic source-reported org names to a Resolvd company.
        Useful for multi-site customers (e.g. "Motorhomes of Texas — HQ"
        + "Motorhomes of Texas — Site 1" → one MOT company) and for
        cases where the integration ships an org that doesn't have an
        exact Resolvd company match (e.g. "Internal IT Infrastructure"
        → map to the parent org). Falls back to auto-resolve by exact
        name when an org isn't explicitly mapped. Sync the source at
        least once to populate this list with real names.
      </p>
      {orgs.length === 0 ? (
        <div className="text-xs text-fg-dim italic">
          No orgs seen yet for this source — Pull now to populate.
        </div>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-fg-muted">
            <tr>
              <th className="text-left py-1">Source org name</th>
              <th className="text-left py-1">→ Resolvd company</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((name) => (
              <tr key={name} className="border-t border-border">
                <td className="py-1.5 pr-3 font-mono">{name}</td>
                <td className="py-1.5">
                  <select
                    value={edits[name] || ""}
                    onChange={(e) => setMap(name, e.target.value)}
                    className="border border-border-strong rounded px-2 py-1 text-xs w-full max-w-xs"
                  >
                    <option value="">— auto (exact-name match) —</option>
                    {companies.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
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

// Per-integration capability toggles. The adapter declares the upper
// bound (what's possible); the admin narrows to the effective set
// (what's active). Disabling a capability stops the scheduler from
// invoking that path AND hides matching admin sections without
// destroying credentials — re-enabling brings the integration back
// the moment the box is ticked. Empty capabilities sources behave
// as a legacy row (trust the adapter) for backwards compat.
const ALL_CAPABILITIES = [
  { value: "alerts",          label: "Alerts",           hint: "Accept webhook events / pull alert rules." },
  { value: "inventory",       label: "Inventory",        hint: "Pull managed devices into the asset register." },
  { value: "software",        label: "Software",         hint: "Per-device installed software inventory." },
  { value: "vulnerabilities", label: "Vulnerabilities",  hint: "Per-CVE rows where the vendor exposes them." },
  { value: "companies",       label: "Companies",        hint: "Map vendor orgs / customers to Resolvd companies." },
];

function CapabilitiesSection({ source, adapters, onPatch, onReload }) {
  const adapter = adapters.find((a) => a.vendor === (source.vendor || source.preset));
  const allowed = adapter?.capabilities || ALL_CAPABILITIES.map((c) => c.value);
  const initial = Array.isArray(source.capabilities) && source.capabilities.length
    ? source.capabilities
    : allowed;
  const [picked, setPicked] = useState(initial);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPicked(Array.isArray(source.capabilities) && source.capabilities.length
      ? source.capabilities
      : allowed);
  }, [source.id, source.capabilities, adapter?.vendor]);

  function toggle(cap) {
    setPicked((prev) => prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap]);
  }

  const dirty = JSON.stringify([...picked].sort()) !== JSON.stringify([...(source.capabilities || [])].sort());

  async function save() {
    if (!picked.length) { toast.error("At least one capability required"); return; }
    setSaving(true);
    try {
      await onPatch({ capabilities: picked });
      toast.success("Capabilities saved");
      if (onReload) await onReload();
    } catch (e) {
      toast.error(e.message || "Save failed");
    } finally { setSaving(false); }
  }

  return (
    <div className="space-y-2 pt-3 border-t border-border">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-fg">Capabilities</div>
        {dirty && (
          <button onClick={save} disabled={saving} className="text-xs px-2 py-1 bg-brand text-white rounded disabled:opacity-50">
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </div>
      <p className="text-xs text-fg-muted">
        Toggle which capabilities this integration actively contributes.
        Adapter declares what's possible
        ({adapter ? `${adapter.label}: ${allowed.join(", ")}` : "no adapter — accepts all"}).
        Disabling a capability stops the scheduler / webhook intake from
        invoking it but keeps the integration credentials intact.
      </p>
      <div className="grid sm:grid-cols-2 gap-2">
        {ALL_CAPABILITIES.map((c) => {
          const allowedHere = allowed.includes(c.value);
          return (
            <label
              key={c.value}
              className={`flex items-start gap-2 p-2 rounded border ${
                allowedHere
                  ? "border-border hover:bg-surface-2 cursor-pointer"
                  : "border-border/40 opacity-50 cursor-not-allowed"
              }`}
            >
              <input
                type="checkbox"
                checked={picked.includes(c.value)}
                disabled={!allowedHere}
                onChange={() => allowedHere && toggle(c.value)}
                className="mt-0.5"
              />
              <div className="min-w-0">
                <div className="text-xs font-medium text-fg">{c.label}</div>
                <div className="text-[11px] text-fg-muted">{c.hint}</div>
                {!allowedHere && (
                  <div className="text-[11px] text-fg-dim italic mt-0.5">
                    not supported by this vendor's adapter
                  </div>
                )}
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}

// Tabular field-map editor. Vendor-agnostic: pull a JSON path from
// the inbound payload, optionally transform, optionally enum-remap,
// write to a known target. Powers the generic /api/webhooks/in/:token
// intake. Falls back to the named adapter's mapper when one exists,
// so this is for webhook-only vendors and overrides.
const FIELD_MAP_TARGETS = [
  { value: "external_event_id", label: "Event ID (required, dedup key)" },
  { value: "event_type",        label: "Event type (problem | recovery)" },
  { value: "severity",          label: "Severity (raw — mapped to priority below)" },
  { value: "title",             label: "Title" },
  { value: "description",       label: "Description (markdown ok)" },
  { value: "vendor_ref",        label: "Vendor reference URL / id" },
  { value: "user_email",        label: "Contact email (assigns to active user)" },
];
const TRANSFORM_KINDS = [
  { value: "",               label: "(none)" },
  { value: "trim",           label: "trim" },
  { value: "lower",          label: "lower" },
  { value: "upper",          label: "upper" },
  { value: "regex_extract",  label: "regex extract" },
  { value: "prepend",        label: "prepend" },
  { value: "append",         label: "append" },
  { value: "replace",        label: "replace (regex)" },
];

function newFieldMapRow() {
  return { source_path: "", target: "title", transform: "", value_map_text: "" };
}

function FieldMapSection({ source, onReload }) {
  function toEditorRows(rows) {
    return (rows || []).map((r) => {
      const base = {
        source_path: r.source_path || "",
        target: r.target || "title",
        transform: "",
        value_map_text: r.value_map ? JSON.stringify(r.value_map, null, 0) : "",
      };
      const t = r.transform;
      if (typeof t === "string") {
        base.transform = t;
      } else if (t && typeof t === "object") {
        base.transform = t.kind || "";
        if (t.pattern != null) base.transform_pattern = t.pattern;
        if (t.group != null) base.transform_group = t.group;
        if (t.text != null) base.transform_text = t.text;
        if (t.replacement != null) base.transform_replacement = t.replacement;
      }
      return base;
    });
  }
  const [rows, setRows] = useState(() => toEditorRows(source.field_map?.rows));
  const [saving, setSaving] = useState(false);
  const [events, setEvents] = useState([]);
  const [previewEventId, setPreviewEventId] = useState("");
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    setRows(toEditorRows(source.field_map?.rows));
    setPreview(null);
  }, [source.id, source.field_map]);

  useEffect(() => {
    api.get(`/api/alert-sources/${source.id}/inbound-events`)
      .then(setEvents)
      .catch(() => setEvents([]));
  }, [source.id]);

  function update(i, patch) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function remove(i) {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
  }
  function add() {
    setRows((prev) => [...prev, newFieldMapRow()]);
  }

  function toServerRows() {
    return rows.map((r) => {
      const out = { source_path: r.source_path.trim(), target: r.target };
      const kind = r.transform;
      if (kind === "trim" || kind === "lower" || kind === "upper") {
        out.transform = kind;
      } else if (kind === "regex_extract") {
        out.transform = { kind: "regex_extract", pattern: r.transform_pattern || "", group: r.transform_group ? Number(r.transform_group) : 0 };
      } else if (kind === "prepend" || kind === "append") {
        out.transform = { kind, text: r.transform_text || "" };
      } else if (kind === "replace") {
        out.transform = { kind: "replace", pattern: r.transform_pattern || "", replacement: r.transform_replacement || "" };
      }
      if (r.value_map_text && r.value_map_text.trim()) {
        try { out.value_map = JSON.parse(r.value_map_text); }
        catch { /* surfaced on save */ }
      }
      return out;
    });
  }

  async function save() {
    for (let i = 0; i < rows.length; i++) {
      const txt = rows[i].value_map_text;
      if (!txt || !txt.trim()) continue;
      try { JSON.parse(txt); }
      catch (e) { return toast.error(`row ${i + 1} value_map: ${e.message}`); }
    }
    setSaving(true);
    try {
      const serverRows = toServerRows();
      await api.patch(`/api/alert-sources/${source.id}`, {
        field_map: serverRows.length ? { rows: serverRows } : {},
      });
      toast.success("Field map saved");
      if (onReload) await onReload();
    } catch (e) {
      toast.error(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function runPreview() {
    if (!previewEventId) return;
    try {
      const r = await api.post(
        `/api/alert-sources/${source.id}/inbound-events/${previewEventId}/preview`,
        { field_map: { rows: toServerRows() } }
      );
      setPreview(r.resolved || {});
    } catch (e) {
      toast.error(e.message || "Preview failed");
    }
  }

  return (
    <div className="space-y-3 pt-3 border-t border-border">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-fg">Field map (tabular)</div>
        <div className="flex gap-2">
          <button onClick={add} className="text-xs px-2 py-1 bg-surface-2 border border-border rounded hover:bg-surface">
            + Add row
          </button>
          <button onClick={save} disabled={saving} className="text-xs px-2 py-1 bg-brand text-white rounded disabled:opacity-50">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <p className="text-xs text-fg-muted">
        Used by the generic <code>/api/webhooks/in/&lt;token&gt;</code>
        intake when no named adapter (Action1, Zabbix, …) covers this
        source. Each row picks a path from the inbound JSON payload and
        writes it to a known target field. Transforms run after path
        extraction; value-maps run last (case-insensitive enum lookup).
        Empty map = adapter-only mode.
      </p>

      {rows.length === 0 ? (
        <div className="text-xs text-fg-dim italic">No rows. Add one to start mapping.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-fg-muted">
              <tr>
                <th className="text-left py-1 pr-2">Source path</th>
                <th className="text-left py-1 pr-2">Target</th>
                <th className="text-left py-1 pr-2">Transform</th>
                <th className="text-left py-1 pr-2">Value map (JSON)</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-border align-top">
                  <td className="py-1.5 pr-2">
                    <input
                      type="text"
                      value={r.source_path}
                      onChange={(e) => update(i, { source_path: e.target.value })}
                      placeholder="$.event.id"
                      className="border border-border-strong rounded px-2 py-1 text-xs font-mono w-full min-w-[10rem]"
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <select
                      value={r.target}
                      onChange={(e) => update(i, { target: e.target.value })}
                      className="border border-border-strong rounded px-2 py-1 text-xs w-full"
                    >
                      {FIELD_MAP_TARGETS.map((t) => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-1.5 pr-2 space-y-1">
                    <select
                      value={r.transform}
                      onChange={(e) => update(i, { transform: e.target.value })}
                      className="border border-border-strong rounded px-2 py-1 text-xs w-full"
                    >
                      {TRANSFORM_KINDS.map((t) => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                    {(r.transform === "regex_extract" || r.transform === "replace") && (
                      <input
                        type="text"
                        value={r.transform_pattern || ""}
                        onChange={(e) => update(i, { transform_pattern: e.target.value })}
                        placeholder="pattern"
                        className="border border-border-strong rounded px-2 py-1 text-xs font-mono w-full"
                      />
                    )}
                    {r.transform === "regex_extract" && (
                      <input
                        type="number" min="0"
                        value={r.transform_group || ""}
                        onChange={(e) => update(i, { transform_group: e.target.value })}
                        placeholder="group (0 = whole match)"
                        className="border border-border-strong rounded px-2 py-1 text-xs font-mono w-full"
                      />
                    )}
                    {r.transform === "replace" && (
                      <input
                        type="text"
                        value={r.transform_replacement || ""}
                        onChange={(e) => update(i, { transform_replacement: e.target.value })}
                        placeholder="replacement"
                        className="border border-border-strong rounded px-2 py-1 text-xs font-mono w-full"
                      />
                    )}
                    {(r.transform === "prepend" || r.transform === "append") && (
                      <input
                        type="text"
                        value={r.transform_text || ""}
                        onChange={(e) => update(i, { transform_text: e.target.value })}
                        placeholder="text"
                        className="border border-border-strong rounded px-2 py-1 text-xs font-mono w-full"
                      />
                    )}
                  </td>
                  <td className="py-1.5 pr-2">
                    <textarea
                      value={r.value_map_text}
                      onChange={(e) => update(i, { value_map_text: e.target.value })}
                      placeholder='{"CRITICAL":"1","HIGH":"2"}'
                      rows={2}
                      className="border border-border-strong rounded px-2 py-1 text-xs font-mono w-full min-w-[12rem]"
                    />
                  </td>
                  <td className="py-1.5">
                    <button
                      onClick={() => remove(i)}
                      className="text-xs text-red-600 hover:underline"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {events.length > 0 && (
        <div className="pt-2 space-y-2">
          <div className="text-xs font-medium text-fg">Preview against saved payload</div>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={previewEventId}
              onChange={(e) => setPreviewEventId(e.target.value)}
              className="border border-border-strong rounded px-2 py-1 text-xs"
            >
              <option value="">— pick an inbound event —</option>
              {events.slice(0, 20).map((ev) => (
                <option key={ev.id} value={ev.id}>
                  #{ev.id} · {ev.status} · {new Date(ev.received_at).toLocaleString()}
                </option>
              ))}
            </select>
            <button
              onClick={runPreview}
              disabled={!previewEventId}
              className="text-xs px-2 py-1 bg-surface-2 border border-border rounded hover:bg-surface disabled:opacity-50"
            >
              Run preview
            </button>
          </div>
          {preview && (
            <pre className="text-[11px] font-mono bg-surface-2 border border-border rounded p-2 overflow-x-auto whitespace-pre-wrap">
{JSON.stringify(preview, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// Recent inbound webhook events for this source. Distinct from
// "Recent events" higher up (which is the de-duped alert log) — this
// one shows raw payloads landing on /api/webhooks/in/<token>, status,
// error_message. Click a row to peek the payload.
function InboundEventsSection({ source }) {
  const [list, setList] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);

  async function reload() {
    try {
      setList(await api.get(`/api/alert-sources/${source.id}/inbound-events`));
    } catch (e) {
      toast.error(e.message || "Failed to load inbound events");
    }
  }
  useEffect(() => { reload(); }, [source.id]);

  async function openRow(id) {
    if (openId === id) { setOpenId(null); setDetail(null); return; }
    setOpenId(id);
    try {
      setDetail(await api.get(`/api/alert-sources/${source.id}/inbound-events/${id}`));
    } catch (e) {
      toast.error(e.message);
    }
  }

  if (!list.length) return null;

  return (
    <div className="space-y-2 pt-3 border-t border-border">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-fg">Inbound webhook events</div>
        <button onClick={reload} className="text-xs px-2 py-1 bg-surface-2 border border-border rounded hover:bg-surface">
          Refresh
        </button>
      </div>
      <p className="text-xs text-fg-muted">
        Last 50 raw payloads received on this source's webhook URL,
        before mapping ran. Click to inspect — useful for tuning the
        field map when a vendor's JSON shape isn't what you expected.
      </p>
      <div className="border border-border rounded overflow-hidden">
        <table className="min-w-full divide-y divide-border text-xs">
          <thead className="bg-surface-2">
            <tr className="text-fg-dim">
              <th className="px-3 py-1.5 text-left font-medium">ID</th>
              <th className="px-3 py-1.5 text-left font-medium">Status</th>
              <th className="px-3 py-1.5 text-left font-medium">Ticket</th>
              <th className="px-3 py-1.5 text-left font-medium">Received</th>
              <th className="px-3 py-1.5 text-left font-medium">Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {list.map((ev) => (
              <React.Fragment key={ev.id}>
                <tr
                  className="cursor-pointer hover:bg-surface-2"
                  onClick={() => openRow(ev.id)}
                >
                  <td className="px-3 py-1.5 font-mono">{ev.id}</td>
                  <td className="px-3 py-1.5">
                    <span className={
                      ev.status === "processed" ? "text-emerald-600 dark:text-emerald-400" :
                      ev.status === "error" ? "text-red-600" :
                      "text-fg-muted"
                    }>{ev.status}</span>
                  </td>
                  <td className="px-3 py-1.5">
                    {ev.ticket_id ? (
                      <a href={`/tickets/${ev.ticket_id}`} className="text-brand hover:underline">#{ev.ticket_id}</a>
                    ) : <span className="text-fg-dim">—</span>}
                  </td>
                  <td className="px-3 py-1.5 text-fg-muted whitespace-nowrap">
                    <HybridTime value={ev.received_at} />
                  </td>
                  <td className="px-3 py-1.5 text-fg-muted truncate max-w-xs">
                    {ev.error_message || ""}
                  </td>
                </tr>
                {openId === ev.id && detail && (
                  <tr>
                    <td colSpan={5} className="px-3 py-2 bg-surface-2/40">
                      <pre className="text-[11px] font-mono whitespace-pre-wrap overflow-x-auto">
{JSON.stringify(detail.payload, null, 2)}
                      </pre>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Alert promotion rules per integration. First match wins (priority ASC).
function AlertRulesSection({ source }) {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await api.get(`/api/alert-sources/${source.id}/rules`);
      setRules(Array.isArray(r) ? r : []);
    } catch { setRules([]); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [source.id]);

  function newDraft() {
    return {
      id: null,
      name: "",
      priority: 100,
      enabled: true,
      action: "create_ticket",
      delay_minutes: 0,
      match_conditions: {
        severity_min_rank: null,
        title_contains: [],
        title_excludes: [],
        description_contains: [],
        description_excludes: [],
        user_email_domain: "",
      },
    };
  }

  async function save() {
    setSaving(true);
    try {
      const body = {
        name: draft.name || "Unnamed rule",
        priority: Number(draft.priority) || 100,
        enabled: !!draft.enabled,
        action: draft.action,
        delay_minutes: Number(draft.delay_minutes) || 0,
        match_conditions: normalizeMatch(draft.match_conditions),
      };
      if (draft.id) {
        await api.patch(`/api/alert-sources/${source.id}/rules/${draft.id}`, body);
        toast.success("Rule updated");
      } else {
        await api.post(`/api/alert-sources/${source.id}/rules`, body);
        toast.success("Rule created");
      }
      setDraft(null);
      await load();
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  }

  async function remove(id) {
    if (!window.confirm("Delete this rule?")) return;
    try {
      await api.delete(`/api/alert-sources/${source.id}/rules/${id}`);
      toast.success("Rule deleted");
      await load();
    } catch (e) { toast.error(e.message); }
  }

  return (
    <div className="space-y-2 pt-3 border-t border-border">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-fg">Alert promotion rules</div>
        <button
          onClick={() => setDraft(newDraft())}
          className="text-xs px-2 py-1 rounded bg-brand text-white"
        >+ Add rule</button>
      </div>
      <p className="text-xs text-fg-muted">
        First match wins (lowest priority number first). Alerts that
        match no rule stay on the Alerts page without becoming a
        ticket. Use <code>Delay minutes</code> with <code>Create ticket</code>
        to defer promotion (e.g. printer toner: ignore unless still
        firing after 120 minutes).
      </p>

      {loading ? (
        <div className="text-xs text-fg-dim italic">Loading rules…</div>
      ) : rules.length === 0 ? (
        <div className="text-xs text-fg-dim italic">No rules yet.</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-fg-muted">
            <tr>
              <th className="text-left py-1 px-2">Priority</th>
              <th className="text-left py-1 px-2">Name</th>
              <th className="text-left py-1 px-2">Match</th>
              <th className="text-left py-1 px-2">Action</th>
              <th className="text-left py-1 px-2">Delay</th>
              <th className="text-right py-1 px-2"></th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className={r.enabled ? "" : "opacity-50"}>
                <td className="py-1 px-2 font-mono">{r.priority}</td>
                <td className="py-1 px-2">{r.name}</td>
                <td className="py-1 px-2 text-fg-muted">{summarizeMatch(r.match_conditions)}</td>
                <td className="py-1 px-2">{r.action}</td>
                <td className="py-1 px-2">{r.delay_minutes ? `${r.delay_minutes}m` : "—"}</td>
                <td className="py-1 px-2 text-right space-x-2">
                  <button onClick={() => setDraft({ ...r, match_conditions: { ...newDraft().match_conditions, ...(r.match_conditions || {}) } })}
                    className="text-brand hover:underline">Edit</button>
                  <button onClick={() => remove(r.id)} className="text-red-500 hover:underline">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {draft && (
        <RuleEditor draft={draft} setDraft={setDraft} onSave={save} onCancel={() => setDraft(null)} saving={saving} />
      )}
    </div>
  );
}

function summarizeMatch(c) {
  if (!c) return "(any)";
  const bits = [];
  if (c.severity_min_rank) bits.push(`sev<=${c.severity_min_rank}`);
  if (Array.isArray(c.title_contains) && c.title_contains.length) bits.push(`title has [${c.title_contains.join(",")}]`);
  if (Array.isArray(c.title_excludes) && c.title_excludes.length) bits.push(`title not [${c.title_excludes.join(",")}]`);
  if (Array.isArray(c.description_contains) && c.description_contains.length) bits.push(`desc has [${c.description_contains.join(",")}]`);
  if (Array.isArray(c.description_excludes) && c.description_excludes.length) bits.push(`desc not [${c.description_excludes.join(",")}]`);
  if (c.user_email_domain) bits.push(`email@${c.user_email_domain}`);
  if (c.title_regex) bits.push(`re(title)`);
  return bits.length ? bits.join(" · ") : "(any)";
}

function normalizeMatch(c) {
  const out = {};
  if (c.severity_min_rank) out.severity_min_rank = Number(c.severity_min_rank);
  for (const k of ["title_contains", "title_excludes", "description_contains", "description_excludes"]) {
    const arr = Array.isArray(c[k]) ? c[k] : String(c[k] || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (arr.length) out[k] = arr;
  }
  if (c.user_email_domain) out.user_email_domain = c.user_email_domain.trim();
  if (c.title_regex) out.title_regex = c.title_regex.trim();
  return out;
}

function RuleEditor({ draft, setDraft, onSave, onCancel, saving }) {
  const m = draft.match_conditions;
  function setM(patch) { setDraft({ ...draft, match_conditions: { ...m, ...patch } }); }
  function csvField(label, key, placeholder) {
    return (
      <label className="block">
        <span className="block text-[11px] text-fg-muted">{label}</span>
        <input
          value={Array.isArray(m[key]) ? m[key].join(", ") : (m[key] || "")}
          onChange={(e) => setM({ [key]: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
          placeholder={placeholder}
          className="w-full bg-surface-2 border border-border rounded px-2 py-1 text-xs"
        />
      </label>
    );
  }
  return (
    <div className="border border-border rounded p-3 bg-surface-2/50 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <label className="block sm:col-span-2">
          <span className="block text-[11px] text-fg-muted">Name</span>
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="e.g. Critical disk -> ticket"
            className="w-full bg-surface border border-border rounded px-2 py-1 text-xs" />
        </label>
        <label className="block">
          <span className="block text-[11px] text-fg-muted">Priority (lower = first)</span>
          <input type="number" value={draft.priority}
            onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
            className="w-full bg-surface border border-border rounded px-2 py-1 text-xs" />
        </label>
        <label className="block">
          <span className="block text-[11px] text-fg-muted">Action</span>
          <select value={draft.action}
            onChange={(e) => setDraft({ ...draft, action: e.target.value })}
            className="w-full bg-surface border border-border rounded px-2 py-1 text-xs">
            <option value="create_ticket">Create ticket</option>
            <option value="suppress">Suppress (mark handled)</option>
            <option value="ignore">Ignore (default)</option>
          </select>
        </label>
        <label className="block">
          <span className="block text-[11px] text-fg-muted">Delay (minutes)</span>
          <input type="number" min="0" value={draft.delay_minutes}
            onChange={(e) => setDraft({ ...draft, delay_minutes: e.target.value })}
            disabled={draft.action !== "create_ticket"}
            className="w-full bg-surface border border-border rounded px-2 py-1 text-xs disabled:opacity-50" />
        </label>
        <label className="flex items-center gap-2 text-xs text-fg-muted">
          <input type="checkbox" checked={!!draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
          Enabled
        </label>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1 border-t border-border">
        <label className="block">
          <span className="block text-[11px] text-fg-muted">Severity rank &lt;= (1=Disaster, 5=Info)</span>
          <input type="number" min="1" max="5" value={m.severity_min_rank || ""}
            onChange={(e) => setM({ severity_min_rank: e.target.value ? Number(e.target.value) : null })}
            className="w-full bg-surface border border-border rounded px-2 py-1 text-xs" />
        </label>
        <label className="block">
          <span className="block text-[11px] text-fg-muted">User email ends with</span>
          <input value={m.user_email_domain || ""}
            onChange={(e) => setM({ user_email_domain: e.target.value })}
            placeholder="@example.com"
            className="w-full bg-surface border border-border rounded px-2 py-1 text-xs" />
        </label>
        {csvField("Title contains (any-of, comma-separated)", "title_contains", "disk full, oom")}
        {csvField("Title excludes (none-of)", "title_excludes", "replace, swap")}
        {csvField("Description contains (any-of)", "description_contains", "fatal, error")}
        {csvField("Description excludes (none-of)", "description_excludes", "ignore")}
      </div>
      <div className="flex items-center justify-end gap-2 pt-2">
        <button onClick={onCancel} className="text-xs text-fg-muted hover:text-fg">Cancel</button>
        <button onClick={onSave} disabled={saving}
          className="text-xs px-3 py-1 bg-brand text-white rounded disabled:opacity-50">
          {saving ? "Saving..." : draft.id ? "Update rule" : "Create rule"}
        </button>
      </div>
    </div>
  );
}
