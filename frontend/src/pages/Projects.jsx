import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api } from '../utils/api';

function StatusPill({ status }) {
  return status === 'archived'
    ? <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">Archived</span>
    : <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">Active</span>;
}

export default function Projects() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', prefix: '', description: '', has_external_vendor: true });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/api/projects')
      .then(setProjects)
      .catch(() => toast.error('Failed to load projects'))
      .finally(() => setLoading(false));
  }, []);

  function set(field, value) {
    setForm(f => ({ ...f, [field]: value }));
    // Auto-uppercase prefix
    if (field === 'prefix') setForm(f => ({ ...f, prefix: value.toUpperCase().replace(/[^A-Z0-9]/g, '') }));
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (!form.name.trim()) { toast.error('Name required'); return; }
    if (!form.prefix.trim()) { toast.error('Prefix required'); return; }
    setSaving(true);
    try {
      const p = await api.post('/api/projects', form);
      setProjects(prev => [...prev, p].sort((a, b) => a.name.localeCompare(b.name)));
      setForm({ name: '', prefix: '', description: '', has_external_vendor: true });
      setShowForm(false);
      toast.success(`Project "${p.name}" created`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleArchive(proj) {
    const newStatus = proj.status === 'active' ? 'archived' : 'active';
    try {
      const updated = await api.patch(`/api/projects/${proj.id}`, { status: newStatus });
      setProjects(prev => prev.map(p => p.id === proj.id ? { ...p, ...updated } : p));
      toast.success(`Project ${newStatus === 'archived' ? 'archived' : 'restored'}`);
    } catch (err) {
      toast.error(err.message);
    }
  }

  const active = projects.filter(p => p.status === 'active');
  const archived = projects.filter(p => p.status === 'archived');

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Projects</h1>
        <button onClick={() => setShowForm(s => !s)} className="btn-primary btn btn-sm">
          {showForm ? 'Cancel' : '+ New Project'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="bg-white border border-gray-200 rounded-lg shadow-sm p-5 space-y-4">
          <h2 className="font-medium text-gray-800">New Project</h2>
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Project Name <span className="text-red-500">*</span>
              </label>
              <input type="text" value={form.name}
                onChange={e => set('name', e.target.value)}
                placeholder="e.g. Motorhomes of Texas Website"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Prefix <span className="text-red-500">*</span>
              </label>
              <input type="text" value={form.prefix}
                onChange={e => set('prefix', e.target.value)}
                placeholder="WEB"
                maxLength={8}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <p className="text-xs text-gray-400 mt-1">Ticket prefix (e.g. WEB-0001)</p>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <input type="text" value={form.description}
              onChange={e => set('description', e.target.value)}
              placeholder="Brief description of this project"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="has_external_vendor" checked={form.has_external_vendor}
              onChange={e => set('has_external_vendor', e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
            <label htmlFor="has_external_vendor" className="text-sm text-gray-700">
              This project has an external vendor
              <span className="text-gray-400 font-normal ml-1">(shows vendor status/ref fields on tickets)</span>
            </label>
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={saving} className="btn-primary btn btn-sm disabled:opacity-60">
              {saving ? 'Creating…' : 'Create Project'}
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="btn-secondary btn btn-sm">Cancel</button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="text-center text-gray-400 py-12">Loading…</div>
      ) : (
        <>
          <ProjectTable projects={active} onToggleArchive={toggleArchive} />
          {archived.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-2">Archived</h2>
              <ProjectTable projects={archived} onToggleArchive={toggleArchive} />
            </div>
          )}
          {projects.length === 0 && (
            <div className="text-center text-gray-400 py-12">No projects yet. Create one above.</div>
          )}
        </>
      )}
    </div>
  );
}

function ProjectTable({ projects, onToggleArchive }) {
  if (projects.length === 0) return null;
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Project</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Prefix</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Status</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Tickets</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Members</th>
            <th className="px-4 py-2.5"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {projects.map(p => (
            <tr key={p.id} className="hover:bg-gray-50 transition-colors">
              <td className="px-4 py-3">
                <Link to={`/projects/${p.id}`} className="font-medium text-blue-700 hover:underline">{p.name}</Link>
                {p.description && <p className="text-xs text-gray-400 mt-0.5 truncate max-w-xs">{p.description}</p>}
              </td>
              <td className="px-4 py-3">
                <span className="font-mono text-sm bg-gray-100 px-2 py-0.5 rounded">{p.prefix}</span>
              </td>
              <td className="px-4 py-3"><StatusPill status={p.status} /></td>
              <td className="px-4 py-3 text-sm text-gray-600">{p.ticket_count ?? 0}</td>
              <td className="px-4 py-3 text-sm text-gray-600">{p.member_count ?? 0}</td>
              <td className="px-4 py-3 text-right space-x-2">
                <Link to={`/projects/${p.id}`}
                  className="text-xs text-blue-600 hover:underline">Manage</Link>
                <button onClick={() => onToggleArchive(p)}
                  className="text-xs text-gray-400 hover:text-gray-600">
                  {p.status === 'active' ? 'Archive' : 'Restore'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
