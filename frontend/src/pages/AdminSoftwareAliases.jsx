import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// Software alias management. Admin maps a pattern (SQL LIKE by
// default; regex when toggled) to a canonical name + vendor. Pull
// adapters consult the table at insert time and stamp asset_software
// with canonical columns so cross-vendor reports group correctly.
//
// Near-duplicates panel surfaces top similar raw names from the
// existing install base (pg_trgm similarity). Click a row to pre-fill
// the add form with one of the names as the pattern and a guess at
// the canonical.

function emptyForm() {
  return {
    pattern: "",
    is_regex: false,
    canonical_name: "",
    canonical_vendor: "",
    priority: 100,
  };
}

export default function AdminSoftwareAliases() {
  const [aliases, setAliases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm());
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [suggestions, setSuggestions] = useState([]);

  async function load() {
    setLoading(true);
    try {
      setAliases(await api.get("/api/software-aliases"));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
    api.get("/api/software-aliases/_meta/near-dupes")
      .then(setSuggestions)
      .catch(() => setSuggestions([]));
  }
  useEffect(() => { load(); }, []);

  function resetForm() {
    setForm(emptyForm());
    setEditingId(null);
  }

  async function save(e) {
    e?.preventDefault();
    if (!form.pattern.trim() || !form.canonical_name.trim()) {
      return toast.error("Pattern and canonical name required");
    }
    setSaving(true);
    try {
      const body = {
        pattern: form.pattern.trim(),
        is_regex: !!form.is_regex,
        canonical_name: form.canonical_name.trim(),
        canonical_vendor: form.canonical_vendor.trim() || null,
        priority: Number(form.priority) || 100,
      };
      if (editingId) {
        await api.patch(`/api/software-aliases/${editingId}`, body);
        toast.success("Alias updated");
      } else {
        await api.post("/api/software-aliases", body);
        toast.success("Alias added");
      }
      resetForm();
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(id) {
    if (!window.confirm("Delete this alias? Affected asset_software rows revert to raw names on next sync.")) return;
    try {
      await api.delete(`/api/software-aliases/${id}`);
      toast.success("Deleted");
      if (editingId === id) resetForm();
      await load();
    } catch (e) {
      toast.error(e.message);
    }
  }

  function editRow(a) {
    setEditingId(a.id);
    setForm({
      pattern: a.pattern,
      is_regex: a.is_regex,
      canonical_name: a.canonical_name,
      canonical_vendor: a.canonical_vendor || "",
      priority: a.priority,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // Pre-fill the add form when the admin clicks a suggestion. We use
  // the LONGER name as the pattern (less likely to mass-match unrelated
  // products) and the SHORTER as the canonical (probably the cleaner
  // marketing name). Admin can edit before saving.
  function fromSuggestion(s) {
    const longer = s.a_name.length >= s.b_name.length ? s.a_name : s.b_name;
    const shorter = s.a_name.length >= s.b_name.length ? s.b_name : s.a_name;
    setEditingId(null);
    setForm({
      pattern: longer,
      is_regex: false,
      canonical_name: shorter,
      canonical_vendor: "",
      priority: 100,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-fg mb-1">Software aliases</h1>
        <p className="text-sm text-fg-muted">
          Normalize software names across RMM vendors. Map a pattern to
          a canonical name; software-sync writes the canonical onto each
          asset_software row so reports group correctly across "Adobe
          Acrobat DC" + "Adobe Acrobat Pro DC 64-bit" + others.
          Patterns are SQL LIKE by default (use <code>%</code> as the
          wildcard, e.g. <code>Adobe Acrobat%</code>) or regex when the
          toggle is on. First match wins, lowest priority first.
        </p>
      </div>

      <form
        onSubmit={save}
        className="bg-surface border border-border rounded-lg p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
      >
        <div className="sm:col-span-2 lg:col-span-3 text-sm font-semibold text-fg">
          {editingId ? "Edit alias" : "Add alias"}
        </div>
        <label className="text-xs text-fg-muted flex flex-col gap-1 lg:col-span-2">
          Pattern
          <input
            value={form.pattern}
            onChange={(e) => setForm((f) => ({ ...f, pattern: e.target.value }))}
            placeholder="Adobe Acrobat%"
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono"
          />
        </label>
        <label className="text-xs text-fg-muted inline-flex items-center gap-2 self-end pb-1">
          <input
            type="checkbox"
            checked={form.is_regex}
            onChange={(e) => setForm((f) => ({ ...f, is_regex: e.target.checked }))}
          />
          Regex
        </label>
        <label className="text-xs text-fg-muted flex flex-col gap-1 lg:col-span-2">
          Canonical name
          <input
            value={form.canonical_name}
            onChange={(e) => setForm((f) => ({ ...f, canonical_name: e.target.value }))}
            placeholder="Adobe Acrobat"
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs text-fg-muted flex flex-col gap-1">
          Priority
          <input
            type="number" min="0" max="10000"
            value={form.priority}
            onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono w-24"
          />
        </label>
        <label className="text-xs text-fg-muted flex flex-col gap-1 sm:col-span-2 lg:col-span-3">
          Canonical vendor (optional)
          <input
            value={form.canonical_vendor}
            onChange={(e) => setForm((f) => ({ ...f, canonical_vendor: e.target.value }))}
            placeholder="Adobe"
            className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          />
        </label>
        <div className="sm:col-span-2 lg:col-span-3 flex gap-2 justify-end">
          {editingId && (
            <button type="button" onClick={resetForm} className="btn btn-secondary btn-sm">
              Cancel edit
            </button>
          )}
          <button type="submit" disabled={saving} className="btn btn-primary btn-sm disabled:opacity-50">
            {saving ? "Saving…" : editingId ? "Save changes" : "Add alias"}
          </button>
        </div>
      </form>

      {suggestions.length > 0 && (
        <div className="bg-surface border border-border rounded-lg p-4 space-y-2">
          <div className="text-sm font-semibold text-fg">Near-duplicate suggestions</div>
          <p className="text-xs text-fg-muted">
            Raw names from installed software that look like the same
            product (pg_trgm similarity ≥ 0.65). Click a row to pre-fill
            the form with one as the pattern and the other as canonical.
          </p>
          <div className="border border-border rounded overflow-hidden">
            <table className="min-w-full divide-y divide-border text-xs">
              <thead className="bg-surface-2 text-fg-dim">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">Name A</th>
                  <th className="px-3 py-1.5 text-left font-medium">Name B</th>
                  <th className="px-3 py-1.5 text-left font-medium">Sim</th>
                  <th className="px-3 py-1.5 text-left font-medium">Installs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {suggestions.map((s, i) => (
                  <tr key={i} className="cursor-pointer hover:bg-surface-2" onClick={() => fromSuggestion(s)}>
                    <td className="px-3 py-1.5 font-mono">{s.a_name}</td>
                    <td className="px-3 py-1.5 font-mono">{s.b_name}</td>
                    <td className="px-3 py-1.5 text-fg-muted">{Number(s.sim).toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-fg-muted">{s.a_count} / {s.b_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        {loading ? (
          <div className="text-sm text-fg-dim p-4">Loading…</div>
        ) : aliases.length === 0 ? (
          <div className="text-sm text-fg-dim italic p-4">No aliases yet.</div>
        ) : (
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="bg-surface-2 text-xs text-fg-dim">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Priority</th>
                <th className="px-3 py-2 text-left font-medium">Pattern</th>
                <th className="px-3 py-2 text-left font-medium">→ Canonical</th>
                <th className="px-3 py-2 text-left font-medium">Vendor</th>
                <th className="px-3 py-2 text-left font-medium">Matches</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {aliases.map((a) => (
                <tr key={a.id} className={editingId === a.id ? "bg-brand/5" : ""}>
                  <td className="px-3 py-1.5 font-mono text-xs text-fg-muted">{a.priority}</td>
                  <td className="px-3 py-1.5 font-mono">
                    {a.pattern}
                    {a.is_regex && (
                      <span className="ml-2 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-brand/15 text-brand">regex</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">{a.canonical_name}</td>
                  <td className="px-3 py-1.5 text-fg-muted">{a.canonical_vendor || "—"}</td>
                  <td className="px-3 py-1.5 text-xs text-fg-muted">{a.match_count}</td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                    <button onClick={() => editRow(a)} className="text-xs text-brand hover:underline mr-3">Edit</button>
                    <button onClick={() => remove(a.id)} className="text-xs text-red-600 hover:underline">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
