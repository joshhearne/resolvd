import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../utils/api";
import toast from "react-hot-toast";

// AI rewrite preview modal. Receives the current text + the surface
// label (drives prompt context) + an onAccept callback that commits the
// rewrite back to the composer. User can change tone/verbosity, toggle
// ELI5 (if eligible per /api/ai/providers), and re-roll until happy.
//
// Always preview-before-send: we never silently mutate the text. Modal
// surfaces provider/model + token usage when available.

export default function AiRewriteModal({ open, onClose, originalText, surface, projectId = null, onAccept }) {
  const [providers, setProviders] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [tone, setTone] = useState("neutral");
  const [verbosity, setVerbosity] = useState("functional");
  const [eli5, setEli5] = useState(false);
  const [rewritten, setRewritten] = useState("");
  const [usage, setUsage] = useState(null);
  const [provider, setProvider] = useState(null);
  const [model, setModel] = useState(null);
  const [contextUsed, setContextUsed] = useState(false);
  const [logId, setLogId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    Promise.all([
      api.get("/api/ai/providers"),
      api.get("/api/ai/config"),
    ]).then(([p, c]) => {
      setProviders(p);
      setCfg(c);
      setTone(c.default_tone || "neutral");
      setVerbosity(c.default_verbosity || "functional");
      setRewritten("");
      setUsage(null);
      setError(null);
    }).catch(e => setError(e.message || "Failed to load AI config"));
  }, [open]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  const ineligibleEli5 = providers && !providers.eligible_for_eli5;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post("/api/ai/rewrite", {
        text: originalText,
        surface,
        tone,
        verbosity,
        eli5,
        project_id: projectId,
      });
      setRewritten(r.rewritten || "");
      setUsage(r.usage || null);
      setProvider(r.provider);
      setModel(r.model);
      setContextUsed(!!r.project_context_used);
      setLogId(r.log_id || null);
    } catch (e) {
      setError({
        msg: e.message || "Rewrite failed",
        providerMessage: e.body?.provider_message || null,
      });
    } finally {
      setBusy(false);
    }
  }

  function accept() {
    if (!rewritten) return;
    onAccept(rewritten, { logId });
    toast.success("Applied");
    onClose();
  }

  // Surface label for the header
  const surfaceLabel = {
    comment_internal: "internal comment",
    comment_vendor: "vendor comment",
    ticket_description: "ticket description",
    ticket_subject: "subject line",
  }[surface] || surface;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-3" onClick={onClose}>
      <div
        className="bg-surface rounded-lg shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div>
            <h3 className="text-base font-semibold text-fg">AI Assist — rewrite {surfaceLabel}</h3>
            {(provider || model) && (
              <p className="text-[11px] text-fg-muted mt-0.5 font-mono">
                {provider}{model ? ` · ${model}` : ""}
                {usage ? ` · ${usage.input_tokens || 0} in / ${usage.output_tokens || 0} out tokens` : ""}
                {contextUsed && <span className="ml-2 text-brand">· project context applied</span>}
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-fg-muted hover:text-fg text-xl leading-none">×</button>
        </div>

        <div className="px-4 py-3 border-b border-border space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <span className="block text-xs font-medium text-fg-muted mb-1">Tone</span>
              <select
                value={tone}
                onChange={(e) => setTone(e.target.value)}
                disabled={busy || !providers}
                className="w-full border border-border-strong rounded-md px-2 py-1 text-sm"
              >
                {(providers?.tones || []).map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-fg-muted mb-1">Verbosity</span>
              <select
                value={verbosity}
                onChange={(e) => setVerbosity(e.target.value)}
                disabled={busy || !providers}
                className="w-full border border-border-strong rounded-md px-2 py-1 text-sm"
              >
                {(providers?.verbosities || []).map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="flex items-end gap-2 pb-1">
              <input
                type="checkbox"
                checked={eli5}
                onChange={(e) => setEli5(e.target.checked)}
                disabled={busy || ineligibleEli5}
              />
              <span className={`text-sm ${ineligibleEli5 ? "text-fg-muted line-through" : "text-fg"}`}>
                ELI5 mode {ineligibleEli5 && "(admin/manager only)"}
              </span>
            </label>
          </div>

          {!cfg?.enabled && (
            <div className="text-xs text-amber-600">
              AI Assist isn't enabled in your account preferences. Enable it under
              Account → Preferences → AI Assist first.
            </div>
          )}
          {!cfg?.org_enabled && (
            <div className="text-xs text-amber-600">
              {cfg?.kms_available === false
                ? "AI Assist has not yet been enabled by your administrator."
                : "AI Assist is disabled organization-wide."}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <h4 className="text-xs font-semibold text-fg-muted mb-1 uppercase tracking-wide">Original</h4>
            <pre className="text-sm whitespace-pre-wrap break-words bg-surface-2 border border-border rounded-md p-2 max-h-72 overflow-y-auto">
              {originalText || <span className="text-fg-muted italic">(empty)</span>}
            </pre>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-fg-muted mb-1 uppercase tracking-wide">Rewritten</h4>
            <pre className="text-sm whitespace-pre-wrap break-words bg-brand/5 border border-brand/30 rounded-md p-2 max-h-72 overflow-y-auto">
              {busy
                ? <span className="text-fg-muted italic">Thinking…</span>
                : rewritten
                  ? rewritten
                  : <span className="text-fg-muted italic">Click "Rewrite" to generate</span>}
            </pre>
          </div>
        </div>

        {error && (
          <div className="px-4 py-2 border-t border-border bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-xs">
            <div>{typeof error === "string" ? error : error.msg}</div>
            {typeof error === "object" && error.providerMessage && (
              <details className="mt-1">
                <summary className="cursor-pointer select-none opacity-80">Provider details</summary>
                <pre className="mt-1 p-2 bg-surface-2 rounded text-[11px] text-fg-muted whitespace-pre-wrap">
{error.providerMessage}
                </pre>
              </details>
            )}
          </div>
        )}

        <div className="px-4 py-3 border-t border-border flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm border border-border-strong rounded-md hover:bg-surface-2">
            Cancel
          </button>
          <button
            onClick={run}
            disabled={busy || !originalText?.trim() || !cfg?.enabled || !cfg?.org_enabled}
            className="px-3 py-1.5 text-sm border border-border-strong rounded-md hover:bg-surface-2 disabled:opacity-50"
          >
            {rewritten ? "Re-roll" : "Rewrite"}
          </button>
          <button
            onClick={accept}
            disabled={!rewritten || busy}
            className="px-3 py-1.5 text-sm bg-brand text-white rounded-md disabled:opacity-50"
          >
            Apply
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
