import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import MarkdownContent from "./MarkdownContent";

// Runbooks from Bothy on a ticket. Steps come live from Bothy; checkbox
// state lives in Resolvd per (ticket, runbook), keyed by Bothy step id.
// A step's `canned` (from "@canned:[Name]" in its text) becomes a pill
// that renders the canned response into the comment composer.
//   GET    /api/bothy/runbooks?project_id=
//   GET    /api/bothy/tickets/:id/runbook-runs
//   POST   /api/bothy/tickets/:id/runbook-runs { article_id }
//   PATCH  /api/bothy/tickets/:id/runbook-runs/:articleId { step_states | completed }
//   DELETE /api/bothy/tickets/:id/runbook-runs/:articleId
export default function BothyRunbookPanel({ ticket, user, onApplyCanned }) {
  const [enabled, setEnabled] = useState(null);
  const [runs, setRuns] = useState([]);
  const [runbooks, setRunbooks] = useState([]);
  const [canned, setCanned] = useState([]);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get("/api/bothy/status").then((s) => setEnabled(!!s.enabled)).catch(() => setEnabled(false));
  }, []);

  async function load() {
    try { setRuns(await api.get(`/api/bothy/tickets/${ticket.id}/runbook-runs`)); } catch { setRuns([]); }
  }
  useEffect(() => {
    if (!enabled) return;
    load();
    api.get(`/api/bothy/runbooks?project_id=${ticket.project_id}`).then(setRunbooks).catch(() => setRunbooks([]));
    api.get(`/api/canned-responses?project_id=${ticket.project_id}`).then((r) => setCanned(Array.isArray(r) ? r : [])).catch(() => setCanned([]));
  }, [enabled, ticket.id, ticket.project_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const cannedByTitle = useMemo(() => new Map(canned.map((c) => [String(c.title || "").toLowerCase(), c])), [canned]);

  async function start(articleId) {
    if (!articleId) return;
    setBusy(true);
    try {
      await api.post(`/api/bothy/tickets/${ticket.id}/runbook-runs`, { article_id: articleId });
      setPick("");
      await load();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  }
  async function toggle(run, stepId, checked) {
    const next = { [stepId]: { checked, checked_by: user?.id ?? null, checked_at: new Date().toISOString() } };
    setRuns((all) => all.map((r) => (r.id === run.id ? { ...r, step_states: { ...(r.step_states || {}), ...next } } : r)));
    try {
      const allChecked = (run.steps || []).every((s) => (s.id === stepId ? checked : run.step_states?.[s.id]?.checked));
      await api.patch(`/api/bothy/tickets/${ticket.id}/runbook-runs/${run.bothy_article_id}`, { step_states: next, completed: allChecked });
      if (allChecked) await load();
    } catch (e) { toast.error(e.message); await load(); }
  }
  async function reset(run) {
    if (!confirm("Reset this runbook's progress on this ticket?")) return;
    try { await api.delete(`/api/bothy/tickets/${ticket.id}/runbook-runs/${run.bothy_article_id}`); await load(); }
    catch (e) { toast.error(e.message); }
  }
  async function applyCanned(c) {
    try {
      const r = await api.post(`/api/canned-responses/${c.id}/render`, { ticket_id: ticket.id, record_use: true });
      onApplyCanned?.(r.rendered ?? r.body ?? "");
      toast.success(`"${c.title}" applied to the composer`);
    } catch (e) { toast.error(e.message); }
  }

  if (!enabled) return null;

  const available = runbooks.filter((rb) => !runs.some((r) => r.bothy_article_id === rb.article_id));
  const home = available.filter((rb) => rb.home);
  const others = available.filter((rb) => !rb.home);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-fg">Runbooks <span className="text-fg-muted normal-case tracking-normal font-normal">from Bothy</span></div>
        {available.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <select value={pick} onChange={(e) => setPick(e.target.value)} className="bg-surface-2 border border-border rounded px-2 py-1 text-xs max-w-[320px]">
              <option value="">Start a runbook…</option>
              {home.length > 0 && <optgroup label="This project">{home.map((rb) => <option key={rb.article_id} value={rb.article_id}>{rb.title}</option>)}</optgroup>}
              {others.length > 0 && <optgroup label="Other collections">{others.map((rb) => <option key={rb.article_id} value={rb.article_id}>{rb.title} — {rb.collection_name}</option>)}</optgroup>}
            </select>
            <button onClick={() => start(pick)} disabled={!pick || busy} className="text-xs px-2 py-1 bg-brand text-white rounded disabled:opacity-50">Start</button>
          </div>
        )}
      </div>

      {runs.length === 0 && <div className="text-xs text-fg-dim italic">No Bothy runbook running on this ticket.</div>}

      {runs.map((run) => {
        const steps = run.steps || [];
        const done = steps.filter((s) => run.step_states?.[s.id]?.checked).length;
        return (
          <div key={run.id} className="bg-surface border border-border rounded-lg p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Link to={`/kb/article/${run.bothy_article_id}?ticket=${ticket.id}`} className="text-sm font-medium text-fg hover:text-accent">{run.title}</Link>
              {run.collection_name && <span className="text-[10px] text-fg-dim">{run.collection_name}</span>}
              <span className={`ml-auto text-[11px] font-mono ${run.completed_at ? "text-emerald-600 dark:text-emerald-300" : "text-fg-muted"}`}>{done}/{steps.length}{run.completed_at ? " · complete" : ""}</span>
              <button onClick={() => reset(run)} className="text-[11px] text-fg-dim hover:text-red-500" title="Reset progress">reset</button>
            </div>
            {run.unavailable && <div className="text-xs text-amber-500">This runbook is no longer readable in Bothy.</div>}
            <ol className="space-y-1.5">
              {steps.map((s, i) => {
                const st = run.step_states?.[s.id];
                const c = s.canned ? cannedByTitle.get(String(s.canned).toLowerCase()) : null;
                return (
                  <li key={s.id} className="flex items-start gap-2">
                    <input type="checkbox" checked={!!st?.checked} onChange={(e) => toggle(run, s.id, e.target.checked)} className="mt-1" />
                    <div className={`flex-1 min-w-0 text-sm ${st?.checked ? "text-fg-dim line-through" : "text-fg"}`}>
                      <span className="text-fg-dim font-mono text-[11px] mr-1">{i + 1}.</span>
                      <span className="inline [&_p]:inline"><MarkdownContent>{String(s.text || "").replace(/@canned:\[[^\]]+\]/g, "").trim()}</MarkdownContent></span>
                      {s.canned && (
                        c ? (
                          <button onClick={() => applyCanned(c)} className="ml-2 inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-brand/10 text-brand hover:bg-brand/20" title={`Apply canned response "${c.title}" to the comment composer`}>📋 {c.title}</button>
                        ) : (
                          <span className="ml-2 text-[11px] text-fg-dim" title="No canned response with this title in this project">@canned:{s.canned} (?)</span>
                        )
                      )}
                      {s.note && <div className="text-xs text-fg-muted mt-1 pl-4 border-l border-border"><MarkdownContent>{s.note}</MarkdownContent></div>}
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        );
      })}
    </div>
  );
}
