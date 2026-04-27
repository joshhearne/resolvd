import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

function ContactsPanel({ company, onChange }) {
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ name: "", email: "", phone: "", role_title: "" });
  const [adding, setAdding] = useState(false);

  async function reload() {
    setLoading(true);
    try {
      setContacts(await api.get(`/api/companies/${company.id}/contacts`));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { reload(); }, [company.id]);

  async function addContact(e) {
    e.preventDefault();
    if (!form.email.trim()) return toast.error("Email required");
    setAdding(true);
    try {
      await api.post(`/api/companies/${company.id}/contacts`, form);
      setForm({ name: "", email: "", phone: "", role_title: "" });
      await reload();
      onChange?.();
      toast.success("Contact added");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setAdding(false);
    }
  }

  async function deactivate(id) {
    if (!window.confirm("Deactivate this contact? Historical ticket links are preserved.")) return;
    try {
      await api.delete(`/api/contacts/${id}`);
      await reload();
      onChange?.();
    } catch (e) { toast.error(e.message); }
  }

  return (
    <div className="border-t border-border pt-4 mt-4">
      <h4 className="text-sm font-semibold text-fg mb-2">Contacts</h4>
      {loading ? (
        <div className="text-sm text-fg-dim">Loading…</div>
      ) : contacts.length === 0 ? (
        <div className="text-sm text-fg-dim italic">No contacts yet.</div>
      ) : (
        <ul className="space-y-1 mb-3">
          {contacts.map(c => (
            <li key={c.id} className="flex items-center justify-between gap-3 text-sm py-1">
              <div className="min-w-0">
                <span className="text-fg font-medium">{c.name || "(no name)"}</span>
                <span className="text-fg-muted"> · {c.email}</span>
                {c.role_title && <span className="text-fg-dim"> · {c.role_title}</span>}
                {c.phone && <span className="text-fg-dim"> · {c.phone}</span>}
              </div>
              <button onClick={() => deactivate(c.id)}
                className="text-xs text-red-600 hover:underline">Deactivate</button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={addContact} className="grid grid-cols-1 sm:grid-cols-5 gap-2">
        <input className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          placeholder="Name" value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        <input className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          placeholder="Email *" required value={form.email}
          onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
        <input className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          placeholder="Role / Title" value={form.role_title}
          onChange={e => setForm(f => ({ ...f, role_title: e.target.value }))} />
        <input className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          placeholder="Phone" value={form.phone}
          onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
        <button disabled={adding}
          className="bg-brand text-white text-sm font-semibold rounded px-3 py-1 disabled:opacity-50">
          {adding ? "Adding…" : "Add contact"}
        </button>
      </form>
      <p className="text-[11px] text-fg-dim mt-1">
        Generic addresses (support@, helpdesk@, noreply@, …) are rejected to prevent reply loops.
      </p>
    </div>
  );
}

export default function AdminCompanies() {
  const [projects, setProjects] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);
  const [form, setForm] = useState({ name: "", domain: "", notes: "" });
  const [creating, setCreating] = useState(false);

  async function deleteCompany(id, name) {
    if (!window.confirm(`Delete "${name}" and all its contacts? This cannot be undone.`)) return;
    try {
      await api.delete(`/api/companies/${id}`);
      await reload();
      toast.success("Company deleted");
    } catch (e) { toast.error(e.message); }
  }

  async function reload() {
    setLoading(true);
    try {
      const params = projectId ? `?project_id=${projectId}` : "";
      setCompanies(await api.get(`/api/companies${params}`));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    api.get("/api/projects").then(setProjects).catch(() => {});
  }, []);

  useEffect(() => { reload(); }, [projectId]);

  async function createCompany(e) {
    e.preventDefault();
    if (!projectId) return toast.error("Pick a project first");
    if (!form.name.trim()) return toast.error("Name required");
    setCreating(true);
    try {
      await api.post("/api/companies", { ...form, project_id: Number(projectId) });
      setForm({ name: "", domain: "", notes: "" });
      await reload();
      toast.success("Company created");
    } catch (e) { toast.error(e.message); }
    finally { setCreating(false); }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <label className="text-sm text-fg-muted">Project:</label>
        <select value={projectId}
          onChange={e => setProjectId(e.target.value)}
          className="bg-surface-2 border border-border rounded px-2 py-1 text-sm">
          <option value="">All</option>
          {projects.filter(p => p.has_external_vendor).map(p =>
            <option key={p.id} value={p.id}>{p.name}</option>
          )}
        </select>
      </div>

      <form onSubmit={createCompany}
        className="bg-surface border border-border rounded-lg p-4 mb-6 grid grid-cols-1 sm:grid-cols-4 gap-2">
        <input className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          placeholder="Company name *" required value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        <input className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          placeholder="Domain (vendor.com)" value={form.domain}
          onChange={e => setForm(f => ({ ...f, domain: e.target.value }))} />
        <input className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          placeholder="Notes" value={form.notes}
          onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
        <button disabled={creating || !projectId}
          className="bg-brand text-white text-sm font-semibold rounded px-3 py-1 disabled:opacity-50">
          {creating ? "Creating…" : "+ Add company"}
        </button>
      </form>

      {loading ? <div className="text-sm text-fg-dim">Loading…</div> :
        companies.length === 0 ?
          <div className="text-sm text-fg-dim italic">
            No companies yet. Pick a project with an external vendor and add one above.
          </div> :
          <div className="space-y-3">
            {companies.map(c => (
              <div key={c.id} className="bg-surface border border-border rounded-lg p-4">
                <div className="flex items-start justify-between gap-2">
                  <button onClick={() => setOpenId(openId === c.id ? null : c.id)}
                    className="flex items-center justify-between flex-1 text-left min-w-0">
                    <div className="min-w-0">
                      <div className="font-semibold text-fg">{c.name}</div>
                      <div className="text-xs text-fg-muted">
                        {c.project_name}{c.domain ? ` · ${c.domain}` : ""} · {c.active_contact_count || 0} active contact{c.active_contact_count === 1 ? "" : "s"}
                      </div>
                    </div>
                    <span className="text-fg-dim text-xs ml-2">{openId === c.id ? "▾" : "▸"}</span>
                  </button>
                  <button onClick={() => deleteCompany(c.id, c.name)}
                    className="shrink-0 text-xs text-red-600 hover:underline ml-2">
                    Delete
                  </button>
                </div>
                {openId === c.id && <ContactsPanel company={c} onChange={reload} />}
              </div>
            ))}
          </div>
      }
    </div>
  );
}
