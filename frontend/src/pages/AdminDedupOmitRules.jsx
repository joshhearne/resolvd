import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// Dedup-omit rules admin. Inbound auto-create normally merges same-title
// mail onto an existing ticket / defers strong-overlap mail to the manual
// queue. Automated and user-reporter mail (e.g. Inky phish reports) reuses
// one fixed subject on every message, so that dedup wrongly collapses them.
// A rule whose regex matches the inbound title/body (per its scope) tells
// the pipeline to SKIP dedup so each message gets its own ticket.

const SCOPES = [
  { value: "title", label: "Titles" },
  { value: "body", label: "Bodies" },
  { value: "title_body", label: "Titles + Bodies" },
];

function scopeLabel(v) {
  return SCOPES.find((s) => s.value === v)?.label || v;
}

// Local mirror of the server matcher for the tester's instant feedback.
// Same JS RegExp engine as the backend, so results match. Returns
// { match, error }.
function evalRegex(pattern, flags, sample) {
  if (!pattern) return { match: false, error: "pattern is required" };
  if (!/^[gimsuy]*$/.test(flags || "")) {
    return { match: false, error: `invalid flags "${flags}"` };
  }
  try {
    const re = new RegExp(pattern, flags || "");
    return { match: re.test(sample || ""), error: null };
  } catch (e) {
    return { match: false, error: e.message };
  }
}

export default function AdminDedupOmitRules() {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState({});
  const [newRow, setNewRow] = useState({ name: "", pattern: "", flags: "i", scope: "title" });

  // Tester panel state — independent of the rules list.
  const [test, setTest] = useState({ pattern: "", flags: "i", sample: "" });
  const testResult = evalRegex(test.pattern, test.flags, test.sample);

  async function load() {
    setLoading(true);
    try {
      setRules(await api.get("/api/dedup-omit-rules"));
    } catch (e) {
      toast.error(e.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function addRule() {
    if (!newRow.name.trim() || !newRow.pattern) {
      toast.error("Name and pattern are required");
      return;
    }
    const chk = evalRegex(newRow.pattern, newRow.flags, "");
    if (chk.error) { toast.error(`Pattern: ${chk.error}`); return; }
    try {
      await api.post("/api/dedup-omit-rules", { ...newRow, name: newRow.name.trim() });
      toast.success("Rule added");
      setNewRow({ name: "", pattern: "", flags: "i", scope: "title" });
      await load();
    } catch (e) {
      toast.error(e.message || "Failed");
    }
  }

  async function saveRow(r) {
    const e = edits[r.id];
    if (!e) return;
    try {
      await api.patch(`/api/dedup-omit-rules/${r.id}`, e);
      toast.success("Saved");
      setEdits((prev) => { const n = { ...prev }; delete n[r.id]; return n; });
      await load();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  async function toggleEnabled(r, value) {
    try {
      await api.patch(`/api/dedup-omit-rules/${r.id}`, { enabled: value });
      await load();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  async function deleteRule(id) {
    if (!confirm("Delete this rule?")) return;
    try {
      await api.delete(`/api/dedup-omit-rules/${id}`);
      toast.success("Deleted");
      await load();
    } catch (err) {
      toast.error(err.message || "Failed");
    }
  }

  function RuleRow({ r }) {
    const e = edits[r.id] || {};
    const merged = { ...r, ...e };
    const dirty = !!Object.keys(e).length;
    const set = (patch) => setEdits((prev) => ({ ...prev, [r.id]: { ...prev[r.id], ...patch } }));
    return (
      <tr className="border-t border-border align-top">
        <td className="py-2 pr-3">
          <input
            value={merged.name}
            onChange={(ev) => set({ name: ev.target.value })}
            className="border border-border-strong rounded px-2 py-1 text-sm w-full"
          />
        </td>
        <td className="py-2 pr-3">
          <input
            value={merged.pattern}
            onChange={(ev) => set({ pattern: ev.target.value })}
            className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-full"
          />
        </td>
        <td className="py-2 pr-3">
          <input
            value={merged.flags}
            onChange={(ev) => set({ flags: ev.target.value })}
            className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-16"
            title="JS regex flags (g i m s u y)"
          />
        </td>
        <td className="py-2 pr-3">
          <select
            value={merged.scope}
            onChange={(ev) => set({ scope: ev.target.value })}
            className="border border-border-strong rounded px-2 py-1 text-sm"
          >
            {SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </td>
        <td className="py-2 pr-3">
          <input
            type="checkbox"
            checked={!!merged.enabled}
            onChange={(ev) => toggleEnabled(r, ev.target.checked)}
          />
        </td>
        <td className="py-2 flex gap-2 items-start">
          {dirty && <button onClick={() => saveRow(r)} className="text-xs px-2 py-1 bg-brand text-white rounded">Save</button>}
          <button onClick={() => deleteRule(r.id)} className="text-xs px-2 py-1 text-red-600 hover:underline">Delete</button>
        </td>
      </tr>
    );
  }

  return (
    <div className="space-y-5">
      <div className="bg-surface border border-border rounded-lg p-4">
        <h2 className="text-base font-semibold text-fg mb-1">Dedup omit rules</h2>
        <p className="text-xs text-fg-muted mb-3">
          Inbound mail that auto-creates a ticket normally runs a dedup
          pass: an identical-title message from the same sender within 7
          days is appended as a comment, and a strong-overlap match in the
          same project within 24h is deferred to the manual queue. Automated
          and user-reporter mail (e.g. <b>Inky phish reports</b>) reuses one
          fixed subject on every message, so dedup wrongly collapses them.
          A rule whose regex matches the inbound{" "}
          <b>title</b>, <b>body</b>, or both <b>skips dedup</b> so each
          message gets its own ticket.
        </p>

        <div className="border border-border rounded p-3 mb-4 bg-surface-2/40">
          <h3 className="text-xs font-semibold text-fg-muted mb-2 uppercase">Add rule</h3>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Name</span>
              <input
                value={newRow.name}
                onChange={(e) => setNewRow((p) => ({ ...p, name: e.target.value }))}
                placeholder="e.g. Inky phish reports"
                className="border border-border-strong rounded px-2 py-1 text-sm w-48"
              />
            </label>
            <label className="flex flex-col gap-1 flex-1 min-w-[16rem]">
              <span className="text-xs text-fg-muted">Pattern (regex)</span>
              <input
                value={newRow.pattern}
                onChange={(e) => setNewRow((p) => ({ ...p, pattern: e.target.value }))}
                placeholder="User Report via Inky Phish Fence"
                className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-full"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Flags</span>
              <input
                value={newRow.flags}
                onChange={(e) => setNewRow((p) => ({ ...p, flags: e.target.value }))}
                className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-16"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Scope</span>
              <select
                value={newRow.scope}
                onChange={(e) => setNewRow((p) => ({ ...p, scope: e.target.value }))}
                className="border border-border-strong rounded px-2 py-1 text-sm"
              >
                {SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </label>
            <button onClick={addRule} className="px-3 py-1.5 text-sm bg-brand text-white rounded">Add</button>
          </div>
        </div>

        {loading ? (
          <div className="text-sm text-fg-muted">Loading…</div>
        ) : rules.length === 0 ? (
          <div className="text-sm text-fg-muted">No dedup omit rules configured.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-fg-muted">
              <tr>
                <th className="text-left py-1">Name</th>
                <th className="text-left py-1">Pattern</th>
                <th className="text-left py-1">Flags</th>
                <th className="text-left py-1">Scope</th>
                <th className="text-left py-1">On</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => <RuleRow key={r.id} r={r} />)}
            </tbody>
          </table>
        )}
      </div>

      {/* Tester — paste a regex + a sample to see whether it would omit. */}
      <div className="bg-surface border border-border rounded-lg p-4">
        <h2 className="text-base font-semibold text-fg mb-1">Test a pattern</h2>
        <p className="text-xs text-fg-muted mb-3">
          Paste a regex and a sample title/body to check the syntax and see
          the verdict. <b className="text-green-700 dark:text-green-300">Matches (OMITTED)</b> means dedup is skipped — the
          message gets its own ticket. <b className="text-red-700 dark:text-red-300">Doesn't Match (DEDUPES)</b> means the
          normal dedup pass runs.
        </p>
        <div className="flex flex-wrap items-end gap-2 mb-3">
          <label className="flex flex-col gap-1 flex-1 min-w-[16rem]">
            <span className="text-xs text-fg-muted">Pattern (regex)</span>
            <input
              value={test.pattern}
              onChange={(e) => setTest((t) => ({ ...t, pattern: e.target.value }))}
              placeholder="User Report via Inky Phish Fence"
              className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-full"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">Flags</span>
            <input
              value={test.flags}
              onChange={(e) => setTest((t) => ({ ...t, flags: e.target.value }))}
              className="border border-border-strong rounded px-2 py-1 text-sm font-mono w-16"
            />
          </label>
        </div>
        <label className="flex flex-col gap-1 mb-3">
          <span className="text-xs text-fg-muted">Sample (paste a title or body)</span>
          <textarea
            value={test.sample}
            onChange={(e) => setTest((t) => ({ ...t, sample: e.target.value }))}
            rows={4}
            placeholder="User Report via Inky Phish Fence (threat level: Caution (1), user label: phish, rid: …)"
            className="w-full border border-border-strong rounded px-2 py-1 text-sm font-mono"
          />
        </label>
        {test.pattern && (
          testResult.error ? (
            <div className="px-3 py-2 rounded text-sm font-mono bg-red-500/15 border border-red-500/30 text-red-700 dark:text-red-300">
              ✗ Invalid regex: {testResult.error}
            </div>
          ) : (
            <div className={`px-3 py-2 rounded text-sm font-semibold ${
              testResult.match
                ? "bg-green-500/15 border border-green-500/30 text-green-700 dark:text-green-300"
                : "bg-red-500/15 border border-red-500/30 text-red-700 dark:text-red-300"
            }`}>
              {testResult.match ? "✓ Matches (OMITTED) — dedup skipped" : "✗ Doesn't Match (DEDUPES) — dedup runs"}
            </div>
          )
        )}
      </div>
    </div>
  );
}
