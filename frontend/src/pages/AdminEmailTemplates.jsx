import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

const TAGS = [
  "{vendor.name}", "{vendor.contact}", "{vendor.contact_email}", "{vendor.contact_role}",
  "{ticket.ref}", "{ticket.external_ref}", "{ticket.title}", "{ticket.description}",
  "{ticket.status}", "{ticket.priority}", "{ticket.url}",
  "{ticket.reply}", "{ticket.replies.3}", "{ticket.replies.5}",
  "{actor.name}", "{site.name}", "{site.url}",
];

export default function AdminEmailTemplates() {
  const [templates, setTemplates] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [editing, setEditing] = useState(null);
  const [preview, setPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  async function reload() {
    setLoading(true);
    try {
      const list = await api.get("/api/email-templates");
      setTemplates(list);
      if (!selectedId && list[0]) setSelectedId(list[0].id);
    } catch (e) { toast.error(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { reload(); }, []);

  useEffect(() => {
    const t = templates.find(t => t.id === selectedId);
    setEditing(t ? { ...t } : null);
    setPreview(null);
  }, [selectedId, templates]);

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/api/email-templates/${editing.id}`, {
        subject_template: editing.subject_template,
        body_template: editing.body_template,
        is_html: editing.is_html,
        enabled: editing.enabled,
        default_replies_count: editing.default_replies_count,
      });
      toast.success("Saved");
      await reload();
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  }

  async function runPreview() {
    if (!editing) return;
    try {
      const r = await api.post(`/api/email-templates/${editing.id}/preview`, {
        subject_template: editing.subject_template,
        body_template: editing.body_template,
        is_html: editing.is_html,
      });
      setPreview(r);
    } catch (e) { toast.error(e.message); }
  }

  function insertTag(tag) {
    setEditing(t => ({ ...t, body_template: (t.body_template || "") + tag }));
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[18rem,1fr] gap-4">
      <div className="bg-surface border border-border rounded-lg p-2">
        <div className="text-xs uppercase text-fg-dim px-2 py-1">Templates</div>
        {loading ? <div className="text-sm text-fg-dim p-2">Loading…</div> :
          <ul className="text-sm">
            {templates.map(t => (
              <li key={t.id}>
                <button onClick={() => setSelectedId(t.id)}
                  className={`w-full text-left px-2 py-1.5 rounded ${selectedId === t.id ? "bg-surface-2 text-fg" : "text-fg-muted hover:bg-surface-2"}`}>
                  <div className="font-medium">{t.event_type}</div>
                  <div className="text-xs text-fg-dim">{t.audience} {t.enabled ? "" : "· disabled"}</div>
                </button>
              </li>
            ))}
          </ul>
        }
      </div>

      <div>
        {!editing ? <div className="text-sm text-fg-dim">Select a template.</div> : (
          <div className="space-y-3">
            <div className="bg-surface border border-border rounded-lg p-4 space-y-3">
              <div className="flex items-center gap-3">
                <span className="text-xs uppercase text-fg-dim">Event</span>
                <span className="text-sm font-medium text-fg">{editing.event_type}</span>
                <span className="text-xs text-fg-dim">→</span>
                <span className="text-sm text-fg">{editing.audience}</span>
                <label className="ml-auto inline-flex items-center gap-1 text-xs text-fg-muted">
                  <input type="checkbox" checked={editing.enabled}
                    onChange={e => setEditing({ ...editing, enabled: e.target.checked })} />
                  Enabled
                </label>
                <label className="inline-flex items-center gap-1 text-xs text-fg-muted">
                  <input type="checkbox" checked={editing.is_html}
                    onChange={e => setEditing({ ...editing, is_html: e.target.checked })} />
                  HTML
                </label>
              </div>

              <div>
                <label className="text-xs text-fg-dim">Subject</label>
                <input className="w-full bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono"
                  value={editing.subject_template}
                  onChange={e => setEditing({ ...editing, subject_template: e.target.value })} />
              </div>

              <div>
                <label className="text-xs text-fg-dim">Body</label>
                <textarea rows={12}
                  className="w-full bg-surface-2 border border-border rounded px-2 py-1 text-sm font-mono"
                  value={editing.body_template}
                  onChange={e => setEditing({ ...editing, body_template: e.target.value })} />
              </div>

              <div>
                <div className="text-xs text-fg-dim mb-1">Default replies count when {"{ticket.replies.N}"} not specified:</div>
                <input type="number" min="0" max="20"
                  className="bg-surface-2 border border-border rounded px-2 py-1 text-sm w-20"
                  value={editing.default_replies_count}
                  onChange={e => setEditing({ ...editing, default_replies_count: parseInt(e.target.value, 10) })} />
              </div>

              <div className="flex flex-wrap gap-1">
                <span className="text-xs text-fg-dim mr-1">Insert:</span>
                {TAGS.map(tag => (
                  <button key={tag} onClick={() => insertTag(tag)}
                    className="text-xs font-mono px-1.5 py-0.5 rounded bg-surface-2 hover:bg-surface text-fg-muted hover:text-fg border border-border">
                    {tag}
                  </button>
                ))}
              </div>

              <div className="flex gap-2">
                <button disabled={saving}
                  onClick={save}
                  className="bg-brand text-white text-sm font-semibold rounded px-4 py-1.5 disabled:opacity-50">
                  {saving ? "Saving…" : "Save"}
                </button>
                <button onClick={runPreview}
                  className="bg-surface-2 border border-border text-sm rounded px-4 py-1.5 hover:bg-surface">
                  Preview
                </button>
              </div>
            </div>

            {preview && (
              <div className="bg-surface border border-border rounded-lg p-4">
                <div className="text-xs uppercase text-fg-dim mb-1">Preview — Subject</div>
                <div className="text-sm font-medium text-fg mb-3">{preview.subject}</div>
                <div className="text-xs uppercase text-fg-dim mb-1">Body</div>
                {preview.is_html ? (
                  <div className="bg-surface-2 border border-border rounded p-3"
                    dangerouslySetInnerHTML={{ __html: preview.body }} />
                ) : (
                  <pre className="bg-surface-2 border border-border rounded p-3 text-sm font-mono whitespace-pre-wrap text-fg">{preview.body}</pre>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
