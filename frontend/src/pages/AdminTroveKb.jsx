import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// Admin → Integrations → Trove KB. Two panes:
//   Connection   — Trove KB URL, public KB URL, API key, enabled, Test
//   Collections  — which Trove KB collections Resolvd shows, and to whom:
//                  Internal (handlers only) / Public (everyone) / Hidden
// Resolvd holds ONE Trove KB API key and enforces visibility itself; Trove KB
// never learns who the Resolvd user is.

const SECTIONS = [
  { key: "connection", label: "Connection" },
  { key: "collections", label: "Collections" },
  { key: "migration", label: "Replace local KB" },
];

export default function AdminTroveKb() {
  const [section, setSection] = useState("connection");
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get("/api/trove-kb-settings")
      .then(setSettings)
      .catch((e) => toast.error(e.message || "Failed to load Trove KB settings"))
      .finally(() => setLoading(false));
  }, []);

  async function patch(partial) {
    setBusy(true);
    try {
      const updated = await api.patch("/api/trove-kb-settings", partial);
      setSettings(updated);
      toast.success("Saved");
      return updated;
    } catch (e) {
      toast.error(e.message || "Failed");
      throw e;
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="text-fg-muted">Loading…</div>;
  if (!settings) return <div className="text-red-500">Failed to load</div>;

  return (
    <div className="flex flex-col md:flex-row gap-6 items-start">
      <aside className="md:w-48 md:flex-shrink-0 md:sticky md:top-4 w-full">
        <h1 className="text-lg font-semibold text-fg mb-1">Trove KB</h1>
        <p className="text-xs text-fg-muted mb-3">Company knowledge base</p>
        <nav className="space-y-0.5">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              onClick={() => setSection(s.key)}
              className={`block w-full text-left px-3 py-2 text-sm rounded-md transition-colors ${
                section === s.key ? "bg-brand/10 text-brand font-medium" : "text-fg-muted hover:bg-surface-2 hover:text-fg"
              }`}
            >
              {s.label}
            </button>
          ))}
        </nav>
      </aside>

      <div className="flex-1 min-w-0 w-full">
        {section === "connection" && (
          <ConnectionPane settings={settings} setSettings={setSettings} patch={patch} busy={busy} />
        )}
        {section === "collections" && (
          <CollectionsPane settings={settings} patch={patch} busy={busy} />
        )}
        {section === "migration" && (
          <MigrationPane settings={settings} patch={patch} busy={busy} />
        )}
      </div>
    </div>
  );
}

function StatusLine({ settings }) {
  if (!settings.kms_available) {
    return <Note tone="warn">RESOLVD_MASTER_KEY is not configured, so the Trove KB API key cannot be stored. Set it up under Admin → Encryption first.</Note>;
  }
  if (!settings.has_api_key) return <Note>No API key saved yet.</Note>;
  if (settings.last_error) return <Note tone="warn">Last attempt failed: {settings.last_error}</Note>;
  if (settings.last_ok_at) return <Note tone="ok">Connected. Last successful check {new Date(settings.last_ok_at).toLocaleString()}.</Note>;
  return <Note>Key saved. Run a test to confirm it works.</Note>;
}

function Note({ children, tone = "info" }) {
  const cls = tone === "warn"
    ? "bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-200"
    : tone === "ok"
      ? "bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-700 text-emerald-800 dark:text-emerald-200"
      : "bg-surface-2 border-border text-fg-muted";
  return <div className={`rounded-md border px-3 py-2 text-xs ${cls}`}>{children}</div>;
}

function ConnectionPane({ settings, setSettings, patch, busy }) {
  const [baseUrl, setBaseUrl] = useState(settings.base_url || "");
  const [publicUrl, setPublicUrl] = useState(settings.public_url || "");
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  async function saveUrls() {
    await patch({ base_url: baseUrl.trim() || null, public_url: publicUrl.trim() || null });
  }

  async function saveKey() {
    if (!keyInput.trim()) return;
    try {
      const r = await api.post("/api/trove-kb-settings/api-key", { api_key: keyInput.trim() });
      setSettings((s) => ({ ...s, has_api_key: r.has_api_key, enabled: r.enabled, last_error: null }));
      setKeyInput("");
      toast.success("Trove KB API key saved");
    } catch (e) { toast.error(e.message); }
  }

  async function clearKey() {
    if (!confirm("Remove the Trove KB API key? Resolvd stops reading Trove KB until a new one is saved.")) return;
    try {
      const r = await api.post("/api/trove-kb-settings/api-key", { api_key: "" });
      setSettings((s) => ({ ...s, has_api_key: r.has_api_key, enabled: r.enabled }));
      toast.success("Key removed");
    } catch (e) { toast.error(e.message); }
  }

  const [checking, setChecking] = useState(false);
  async function checkNow() {
    setChecking(true);
    try {
      const r = await api.post("/api/trove-kb-settings/check", {});
      const bits = [`${r.collections} collections`];
      if (r.auto_mapped?.length) bits.push(`mapped ${r.auto_mapped.map((c) => c.name).join(", ")}`);
      else if (r.new_collections?.length) bits.push(`${r.new_collections.length} new, unmapped`);
      if (r.snapshots && !r.snapshots.skipped) bits.push(`${r.snapshots.updated} snapshot rows updated`);
      bits.push("cache cleared");
      toast.success(bits.join(" · "));
      setSettings(await api.get("/api/trove-kb-settings"));
    } catch (e) {
      toast.error(e.message || "Check failed");
      try { setSettings(await api.get("/api/trove-kb-settings")); } catch { /* keep */ }
    } finally { setChecking(false); }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.post("/api/trove-kb-settings/test", {});
      setTestResult(r);
      const fresh = await api.get("/api/trove-kb-settings");
      setSettings(fresh);
      toast.success(`Connected. ${r.collections.length} collection${r.collections.length === 1 ? "" : "s"} readable.`);
    } catch (e) {
      toast.error(e.message || "Test failed");
      try { setSettings(await api.get("/api/trove-kb-settings")); } catch { /* keep */ }
    } finally { setTesting(false); }
  }

  return (
    <div className="space-y-6">
      <section className="bg-surface border border-border rounded-lg p-4 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-fg">Connection</h2>
            <p className="text-xs text-fg-muted mt-1">
              Create an API key in Trove KB (Admin → API keys): scope <code>read</code>, knowledge base only, and grant it read on each collection Resolvd should see.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm whitespace-nowrap">
            <input
              type="checkbox"
              checked={!!settings.admin_enabled}
              disabled={busy}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            Enabled
          </label>
        </div>

        <StatusLine settings={settings} />

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-fg-muted text-xs">Trove KB URL (staff)</span>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://troveKb.example.com"
              className="mt-1 w-full bg-surface-2 border border-border rounded px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-fg-muted text-xs">Public knowledge base URL</span>
            <input
              type="url"
              value={publicUrl}
              onChange={(e) => setPublicUrl(e.target.value)}
              placeholder="https://kb.example.com"
              className="mt-1 w-full bg-surface-2 border border-border rounded px-2 py-1.5 text-sm"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={saveUrls} disabled={busy} className="btn btn-primary btn-sm">Save URLs</button>
          <button onClick={test} disabled={testing || !settings.has_api_key || !settings.base_url} className="btn btn-secondary btn-sm">
            {testing ? "Testing…" : "Test connection"}
          </button>
          <button
            onClick={checkNow}
            disabled={checking || !settings.enabled}
            className="btn btn-secondary btn-sm"
            title="Poll Trove KB now: new collections, fresh article cache, link and runbook titles. Article edits also arrive by webhook as they happen."
          >
            {checking ? "Checking…" : "Check for changes now"}
          </button>
        </div>

        <div className="border-t border-border pt-4 space-y-2">
          <div className="text-sm font-medium text-fg">API key</div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type={showKey ? "text" : "password"}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={settings.has_api_key ? "•••••••• (saved) — paste to replace" : "trove_…"}
              autoComplete="off"
              className="flex-1 min-w-[220px] bg-surface-2 border border-border rounded px-2 py-1.5 text-sm font-mono"
            />
            <button type="button" onClick={() => setShowKey((v) => !v)} className="btn btn-secondary btn-sm">{showKey ? "Hide" : "Show"}</button>
            <button onClick={saveKey} disabled={!keyInput.trim() || !settings.kms_available} className="btn btn-primary btn-sm">Save key</button>
            {settings.has_api_key && (
              <button onClick={clearKey} className="text-xs text-red-600 hover:underline">Remove</button>
            )}
          </div>
        </div>

        {testResult && (
          <div className="border-t border-border pt-3">
            <div className="text-xs text-fg-muted mb-1">Collections this key can read</div>
            <ul className="text-sm space-y-0.5">
              {testResult.collections.map((c) => (
                <li key={c.id} className="flex items-center gap-2">
                  <span className="text-fg">{c.name}</span>
                  <span className="text-xs text-fg-dim font-mono">{c.articles ?? "?"} articles</span>
                  {c.writable && <span className="text-[10px] uppercase px-1.5 rounded bg-brand/10 text-brand">writable</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <WebhookSection settings={settings} setSettings={setSettings} />

      <section className="bg-surface border border-border rounded-lg p-4 space-y-3">
        <h2 className="text-base font-semibold text-fg">Held-back articles</h2>
        <p className="text-xs text-fg-muted">
          Trove KB can hold single articles back from its public site. Resolvd reads through an API key, which sees them anyway, so this decides what non-handlers (Submitters, Viewers) get.
        </p>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.public_strict !== false}
            disabled={busy}
            onChange={(e) => patch({ public_strict: e.target.checked })}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">Strict:</span> non-handlers see an article only when Trove KB confirms it is on the public site.
            <span className="block text-xs text-fg-muted mt-0.5">Until Trove KB returns that confirmation on search results, non-handlers see nothing from Trove KB. Off = trust the whole Public collection, held-back articles included.</span>
          </span>
        </label>
      </section>

      <section className="bg-surface border border-border rounded-lg p-4 space-y-3">
        <h2 className="text-base font-semibold text-fg">Ticket suggestions</h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={!!settings.suggestions_enabled}
            disabled={busy}
            onChange={(e) => patch({ suggestions_enabled: e.target.checked })}
          />
          Suggest Trove KB articles on tickets from the ticket title
        </label>
      </section>
    </div>
  );
}

function CollectionsPane({ settings, patch, busy }) {
  const [live, setLive] = useState(null);
  const [liveError, setLiveError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.get("/api/trove-kb-settings/collections")
      .then((rows) => { if (!cancelled) setLive(rows); })
      .catch((e) => { if (!cancelled) setLiveError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const internal = new Set(settings.internal_collection_ids || []);
  const pub = new Set(settings.public_collection_ids || []);

  // Live list first; mapped ids Trove KB no longer reports are kept so the
  // admin can still un-map them.
  const rows = [];
  const seen = new Set();
  for (const c of live || []) { rows.push({ id: c.id, name: c.name, articles: c.articles, description: c.description, public: c.public, live: true }); seen.add(c.id); }
  for (const id of [...internal, ...pub]) {
    if (!seen.has(id)) rows.push({ id, name: settings.collection_names?.[id] || id, articles: null, live: false });
  }

  function scopeOf(id) { return internal.has(id) ? "internal" : pub.has(id) ? "public" : "hidden"; }

  async function setScope(row, scope) {
    const nextInternal = new Set(internal);
    const nextPub = new Set(pub);
    nextInternal.delete(row.id); nextPub.delete(row.id);
    if (scope === "internal") nextInternal.add(row.id);
    if (scope === "public") nextPub.add(row.id);
    const names = { ...(settings.collection_names || {}) };
    if (row.live) names[row.id] = row.name;
    await patch({
      internal_collection_ids: [...nextInternal],
      public_collection_ids: [...nextPub],
      collection_names: names,
    });
  }

  return (
    <section className="bg-surface border border-border rounded-lg p-4 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-fg">Collections</h2>
        <p className="text-xs text-fg-muted mt-1">
          <strong>Internal</strong> collections show to handlers only (Admin, Manager, Tech, and project handlers).
          <strong> Public</strong> collections show to everyone who can sign in, and link out to the public knowledge base site.
          <strong> Hidden</strong> collections are not shown in Resolvd at all. With nothing mapped, handlers see everything the key can read and everyone else sees nothing.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={settings.auto_map_public !== false} disabled={busy} onChange={(e) => patch({ auto_map_public: e.target.checked })} />
          Map new public collections automatically
        </label>
        <button onClick={async () => { try { const r = await api.post("/api/trove-kb-settings/sync-collections", {}); toast.success(r.auto_mapped?.length ? `Mapped: ${r.auto_mapped.map((c) => c.name).join(", ")}` : r.new_collections?.length ? `${r.new_collections.length} new collection(s) seen, none public` : "Nothing new"); await patch({}); } catch (e) { toast.error(e.message); } }} className="btn btn-secondary btn-sm">Check for new collections</button>
        {settings.collections_synced_at && <span className="text-xs text-fg-dim">Checked hourly; last {new Date(settings.collections_synced_at).toLocaleString()}</span>}
      </div>

      {loading && <div className="text-sm text-fg-muted">Loading collections from Trove KB…</div>}
      {liveError && <Note tone="warn">Could not list collections from Trove KB: {liveError}. Saved mappings are shown below.</Note>}

      {!loading && rows.length === 0 && <div className="text-sm text-fg-dim italic">No collections readable with this key.</div>}

      {rows.length > 0 && (
        <div className="divide-y divide-border border border-border rounded-md">
          {rows.map((row) => {
            const scope = scopeOf(row.id);
            return (
              <div key={row.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <div className="flex-1 min-w-[200px]">
                  <div className="text-sm font-medium text-fg flex items-center gap-2">{row.name}
                    {row.public === true && <span className="text-[9px] uppercase px-1 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-300" title="On Trove KB's public site">public site</span>}
                    {!(settings.known_collection_ids || []).includes(row.id) && row.live && <span className="text-[9px] uppercase px-1 rounded bg-amber-500/15 text-amber-600 dark:text-amber-300">new</span>}
                  </div>
                  <div className="text-[11px] text-fg-dim font-mono">
                    {row.articles != null ? `${row.articles} articles · ` : ""}{row.id}{row.live ? "" : " · not reported by Trove KB"}
                  </div>
                </div>
                <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
                  {["internal", "public", "hidden"].map((s) => (
                    <button
                      key={s}
                      disabled={busy}
                      onClick={() => scope !== s && setScope(row, s)}
                      className={`px-3 py-1.5 capitalize ${scope === s ? "bg-brand text-white" : "bg-surface-2 text-fg-muted hover:text-fg"}`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}


function MigrationPane({ settings, patch, busy }) {
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState(null);

  async function loadPlan() {
    setLoading(true); setError(null);
    try { setPlan(await api.get("/api/trove-kb-settings/migration/plan")); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { loadPlan(); }, []);

  async function apply() {
    if (!plan) return;
    const msg = `Move ${plan.links_movable} ticket link${plan.links_movable === 1 ? "" : "s"} and ${plan.runs_movable} runbook run${plan.runs_movable === 1 ? "" : "s"} to Trove KB, archive ${plan.articles.filter((a) => a.trove_kb_article_id).length} local articles, and turn the local knowledge base off?${plan.missing ? `\n\n${plan.missing} local article(s) have no Trove KB twin and will be left as they are.` : ""}\n\nLocal rows are kept for rollback.`;
    if (!confirm(msg)) return;
    setApplying(true);
    try {
      const r = await api.post("/api/trove-kb-settings/migration/apply", {});
      setResult(r);
      toast.success("Local knowledge base replaced by Trove KB");
      await loadPlan();
      try { await patch({}); } catch { /* refresh only */ }
    } catch (e) { toast.error(e.message); }
    finally { setApplying(false); }
  }

  return (
    <section className="bg-surface border border-border rounded-lg p-4 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-fg">Replace the local knowledge base</h2>
          <p className="text-xs text-fg-muted mt-1">
            Local articles were exported to Trove KB with <code>external_id = resolvd:kb:&lt;id&gt;</code>. This matches each one to its Trove KB twin,
            copies ticket links, re-keys runbook progress onto Trove KB step ids, archives the local articles, and hides the local editor.
            Nothing is deleted.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm whitespace-nowrap">
          <input type="checkbox" checked={settings.local_kb_enabled !== false} disabled={busy} onChange={(e) => patch({ local_kb_enabled: e.target.checked })} />
          Local KB visible
        </label>
      </div>

      {loading && <div className="text-sm text-fg-muted">Matching local articles against Trove KB…</div>}
      {error && <Note tone="warn">{error}</Note>}
      {result && <Note tone="ok">Done: {result.links_copied} links copied, {result.runs_moved} runbook runs moved ({result.runs_steps_dropped} step states had no matching step), {result.articles_archived} local articles archived{result.skipped_missing ? `, ${result.skipped_missing} skipped (no twin)` : ""}.</Note>}

      {plan && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <Stat label="Local articles" value={plan.articles.length} />
            <Stat label="Matched in Trove KB" value={plan.articles.length - plan.missing} warn={plan.missing > 0} />
            <Stat label="Ticket links" value={`${plan.links_movable} / ${plan.links_total}`} />
            <Stat label="Runbook runs" value={`${plan.runs_movable} / ${plan.runs.length}`} />
          </div>
          <div className="overflow-x-auto border border-border rounded-md">
            <table className="w-full text-xs">
              <thead className="bg-surface-2 text-fg-muted">
                <tr><th className="text-left px-2 py-1.5">Local</th><th className="text-left px-2 py-1.5">Project</th><th className="text-left px-2 py-1.5">Kind</th><th className="text-right px-2 py-1.5">Links</th><th className="text-right px-2 py-1.5">Runs</th><th className="text-left px-2 py-1.5">Trove KB twin</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {plan.articles.map((a) => (
                  <tr key={a.local_id}>
                    <td className="px-2 py-1.5 text-fg">{a.title} <span className="text-fg-dim">#{a.local_id}{a.status !== "published" ? ` · ${a.status}` : ""}</span></td>
                    <td className="px-2 py-1.5 text-fg-muted">{a.project}</td>
                    <td className="px-2 py-1.5 text-fg-muted">{a.kind}{a.agent_only ? " · internal" : ""}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{a.links}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{a.runs}</td>
                    <td className="px-2 py-1.5">
                      {a.trove_kb_article_id ? (
                        <span className={a.match === "ok" ? "text-emerald-600 dark:text-emerald-300" : "text-amber-500"}>
                          {a.troveKb_collection} {a.match === "kind_mismatch" ? `(kind: ${a.troveKb_kind})` : ""}
                        </span>
                      ) : <span className="text-red-500">no match</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.runs.some((r) => r.steps && r.steps.matched < r.steps.total) && (
            <Note tone="warn">Some runbook runs have step states that no longer match a step in Trove KB; those checkmarks would be dropped.</Note>
          )}
          <div className="flex items-center gap-3">
            <button onClick={apply} disabled={applying || plan.links_movable + plan.runs_movable + (plan.articles.length - plan.missing) === 0} className="btn btn-primary btn-sm">
              {applying ? "Applying…" : "Replace local KB with Trove KB"}
            </button>
            <button onClick={loadPlan} disabled={loading} className="btn btn-secondary btn-sm">Re-check</button>
          </div>
        </>
      )}
    </section>
  );
}

function Stat({ label, value, warn }) {
  return (
    <div className={`rounded-md border px-3 py-2 ${warn ? "border-amber-400/60" : "border-border"} bg-surface-2/40`}>
      <div className="text-[10px] uppercase tracking-wide text-fg-dim">{label}</div>
      <div className="text-base font-semibold text-fg font-mono">{value}</div>
    </div>
  );
}


// Signed webhooks from Trove KB drop Resolvd's read cache the moment an
// article changes. The secret is shown once when generated here; paste it
// into Trove KB → Admin → Webhooks together with the endpoint URL.
function WebhookSection({ settings, setSettings }) {
  const [shown, setShown] = useState(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  async function generate() {
    setBusy(true);
    try {
      const r = await api.post("/api/trove-kb-settings/webhook-secret", { generate: true });
      setShown(r.secret);
      setSettings((s) => ({ ...s, has_webhook_secret: r.has_webhook_secret }));
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  }
  async function savePasted() {
    if (!pasted.trim()) return;
    setBusy(true);
    try {
      const r = await api.post("/api/trove-kb-settings/webhook-secret", { secret: pasted.trim() });
      setSettings((s) => ({ ...s, has_webhook_secret: r.has_webhook_secret }));
      setPasted(""); setShown(null);
      toast.success("Webhook secret saved");
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  }
  async function clear() {
    if (!confirm("Remove the webhook secret? Deliveries from Trove KB will be rejected until a new one is saved.")) return;
    try {
      const r = await api.post("/api/trove-kb-settings/webhook-secret", { secret: "" });
      setSettings((s) => ({ ...s, has_webhook_secret: r.has_webhook_secret }));
      setShown(null);
    } catch (e) { toast.error(e.message); }
  }
  async function refresh() {
    setRefreshing(true);
    try {
      const r = await api.post("/api/trove-kb-settings/refresh-snapshots", {});
      toast.success(r.skipped ? "Trove KB is off" : `${r.articles} articles checked, ${r.updated} rows updated${r.missing ? `, ${r.missing} missing` : ""}`);
      setSettings(await api.get("/api/trove-kb-settings"));
    } catch (e) { toast.error(e.message); }
    finally { setRefreshing(false); }
  }

  return (
    <section className="bg-surface border border-border rounded-lg p-4 space-y-3">
      <h2 className="text-base font-semibold text-fg">Webhooks from Trove KB</h2>
      <p className="text-xs text-fg-muted">
        When an article is written or archived in Trove KB, Resolvd drops what it cached about it so tickets show the new version at once. Without this, changes appear within a minute anyway.
      </p>
      <div className="text-xs">
        <span className="text-fg-muted">Endpoint to register in Trove KB → Admin → Webhooks:</span>
        <div className="mt-1 flex items-center gap-2">
          <code className="bg-surface-2 border border-border rounded px-2 py-1 font-mono">{settings.webhook_url}</code>
          <button type="button" onClick={() => navigator.clipboard?.writeText(settings.webhook_url).then(() => toast.success("Copied")).catch(() => {})} className="text-brand hover:underline">Copy</button>
        </div>
        <div className="text-fg-dim mt-1">Events: <code>kb.article.upserted</code>, <code>kb.article.archived</code></div>
      </div>

      {shown ? (
        <div className="rounded-md border border-amber-400/60 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs space-y-1">
          <div className="font-medium text-amber-900 dark:text-amber-200">New secret — shown once. Paste it into the Trove KB webhook now.</div>
          <div className="flex items-center gap-2">
            <code className="font-mono break-all">{shown}</code>
            <button type="button" onClick={() => navigator.clipboard?.writeText(shown).then(() => toast.success("Copied")).catch(() => {})} className="text-brand hover:underline whitespace-nowrap">Copy</button>
          </div>
          <button type="button" onClick={() => setShown(null)} className="text-amber-900 dark:text-amber-200 hover:underline">I have saved it</button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={settings.has_webhook_secret ? "text-emerald-600 dark:text-emerald-300" : "text-fg-dim"}>
            {settings.has_webhook_secret ? "Secret saved." : "No secret yet."}
          </span>
          {settings.last_webhook_at && (
            <span className="text-fg-dim">Last delivery {new Date(settings.last_webhook_at).toLocaleString()} ({settings.last_webhook_event})</span>
          )}
          <button onClick={generate} disabled={busy || !settings.kms_available} className="btn btn-primary btn-sm">{settings.has_webhook_secret ? "Rotate secret" : "Generate secret"}</button>
          {settings.has_webhook_secret && <button onClick={clear} className="text-red-600 hover:underline">Remove</button>}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="password"
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder="…or paste a secret issued by Trove KB"
          autoComplete="off"
          className="flex-1 min-w-[220px] bg-surface-2 border border-border rounded px-2 py-1.5 text-sm font-mono"
        />
        <button onClick={savePasted} disabled={busy || !pasted.trim() || !settings.kms_available} className="btn btn-secondary btn-sm">Save pasted secret</button>
      </div>

      <div className="border-t border-border pt-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-fg-muted">Snapshots of linked article titles refresh nightly{settings.snapshots_refreshed_at ? `; last ${new Date(settings.snapshots_refreshed_at).toLocaleString()}` : ""}.</span>
        <button onClick={refresh} disabled={refreshing} className="btn btn-secondary btn-sm">{refreshing ? "Refreshing…" : "Refresh now"}</button>
      </div>
    </section>
  );
}
