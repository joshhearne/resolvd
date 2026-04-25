import React, { useEffect, useState, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api } from '../utils/api';
import { formatDateTime, priorityRowClass } from '../utils/helpers';
import { useAuth } from '../context/AuthContext';
import PriorityBadge from '../components/PriorityBadge';
import StatusBadge from '../components/StatusBadge';

function DateTimeStack({ value }) {
  if (!value) return <span className="text-gray-300">—</span>;
  const d = new Date(value.endsWith('Z') ? value : value + 'Z');
  const date = d.toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true });
  return <><div>{date}</div><div className="text-gray-400">{time}</div></>;
}

const BLANK_FILTERS = {
  internal_status: '', coastal_status: '', effective_priority: '',
  blocker_type: '', flagged_for_review: '',
};

// Predefined sidebar views — each maps to a filter state
const PREDEFINED = [
  {
    group: 'Overview',
    items: [
      { key: 'all', label: 'All Tickets', countKey: 'total', filters: BLANK_FILTERS },
      { key: 'active', label: 'All Active', countKey: 'active', filters: BLANK_FILTERS, excludeClosed: true },
    ],
  },
  {
    group: 'By Status',
    items: [
      { key: 'open',           label: 'Open',               countKey: 'open',         filters: { ...BLANK_FILTERS, internal_status: 'Open' } },
      { key: 'in_progress',    label: 'In Progress',        countKey: 'in_progress',  filters: { ...BLANK_FILTERS, internal_status: 'In Progress' } },
      { key: 'awaiting_mot',   label: 'Awaiting Input',     countKey: 'awaiting_mot', filters: { ...BLANK_FILTERS, internal_status: 'Awaiting Input' } },
      { key: 'pending_review', label: 'Pending Review',     countKey: 'pending_review', filters: { ...BLANK_FILTERS, internal_status: 'Pending Review' } },
      { key: 'reopened',       label: 'Reopened',           countKey: 'reopened',     filters: { ...BLANK_FILTERS, internal_status: 'Reopened' } },
      { key: 'flagged',        label: 'Flagged for Review', countKey: 'flagged',      filters: { ...BLANK_FILTERS, flagged_for_review: 'true' } },
      { key: 'closed',         label: 'Closed',             countKey: 'closed',       filters: { ...BLANK_FILTERS, internal_status: 'Closed' } },
    ],
  },
  {
    group: 'By Priority',
    items: [
      { key: 'p1', label: 'P1 — Critical', countKey: 'p1', filters: { ...BLANK_FILTERS, effective_priority: '1' } },
      { key: 'p2', label: 'P2 — High',     countKey: 'p2', filters: { ...BLANK_FILTERS, effective_priority: '2' } },
    ],
  },
  {
    group: 'External',
    items: [
      { key: 'coastal_unacked',  label: 'Unacknowledged', countKey: 'coastal_unacked',  filters: { ...BLANK_FILTERS, coastal_status: 'Unacknowledged' } },
      { key: 'coastal_resolved', label: 'Marked Resolved', countKey: 'coastal_resolved', filters: { ...BLANK_FILTERS, coastal_status: 'Resolved' } },
      { key: 'mot_blocker',      label: 'Team Owes Input', countKey: 'mot_blocker',      filters: { ...BLANK_FILTERS, blocker_type: 'mot_input' } },
    ],
  },
];

const URGENT_KEYS = new Set(['awaiting_mot', 'pending_review', 'flagged', 'p1', 'mot_blocker']);

function CountBadge({ count, urgent }) {
  if (!count) return null;
  return (
    <span className={`ml-auto text-xs font-semibold px-1.5 py-0.5 rounded-full ${
      urgent && count > 0 ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'
    }`}>
      {count}
    </span>
  );
}

const LIMIT = 50;

export default function TicketList() {
  const { user, setDefaultProject } = useAuth();
  const canManageViews = ['Admin','Manager'].includes(user?.role) || user?.role === 'Submitter';
  const [searchParams, setSearchParams] = useSearchParams();

  const [tickets, setTickets] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState({});
  const [q, setQ] = useState(searchParams.get('q') || '');
  const allItems = PREDEFINED.flatMap(g => g.items);
  const presetKey = searchParams.get('preset');
  const presetItem = presetKey ? allItems.find(i => i.key === presetKey) : null;
  const [activeKey, setActiveKey] = useState(presetItem ? presetItem.key : 'active');
  const [filters, setFilters] = useState(presetItem ? { ...presetItem.filters } : { ...BLANK_FILTERS });
  const [sortBy, setSortBy] = useState('updated_at');
  const [sortDir, setSortDir] = useState('desc');
  const [page, setPage] = useState(1);

  // Projects
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState(
    searchParams.get('project_id') ? Number(searchParams.get('project_id'))
    : user?.defaultProjectId || null
  );

  // Sidebar mobile state
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Saved views
  const [savedViews, setSavedViews] = useState([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [viewName, setViewName] = useState('');
  const [savingView, setSavingView] = useState(false);

  // Load projects + saved views once
  useEffect(() => {
    api.get('/api/projects').then(all => setProjects(all.filter(p => p.status === 'active'))).catch(() => {});
    api.get('/api/views').then(setSavedViews).catch(() => {});
  }, []);

  const selectedProject = selectedProjectId ? projects.find(p => p.id === selectedProjectId) : null;
  const showVendorCols = !selectedProject || selectedProject.has_external_vendor !== false;

  // Load counts — scoped to selected project if set
  useEffect(() => {
    const qs = selectedProjectId ? `?project_id=${selectedProjectId}` : '';
    api.get(`/api/tickets/counts${qs}`).then(setCounts).catch(() => {});
  }, [selectedProjectId]);

  // Refresh counts after ticket changes
  const refreshCounts = useCallback(() => {
    const qs = selectedProjectId ? `?project_id=${selectedProjectId}` : '';
    api.get(`/api/tickets/counts${qs}`).then(setCounts).catch(() => {});
  }, [selectedProjectId]);

  // Sync q from nav search bar
  useEffect(() => {
    const urlQ = searchParams.get('q') || '';
    if (urlQ !== q) { setQ(urlQ); setPage(1); }
  }, [searchParams.get('q')]);

  function buildQuery() {
    const p = new URLSearchParams();
    if (selectedProjectId) p.set('project_id', selectedProjectId);
    if (q.trim()) p.set('q', q.trim());
    Object.entries(filters).forEach(([k, v]) => { if (v) p.set(k, v); });
    const item = PREDEFINED.flatMap(g => g.items).find(i => i.key === activeKey);
    if (item?.excludeClosed) p.set('exclude_closed', '1');
    p.set('sort_by', sortBy);
    p.set('sort_dir', sortDir);
    p.set('page', page);
    p.set('limit', LIMIT);
    return p.toString();
  }

  useEffect(() => {
    setLoading(true);
    api.get(`/api/tickets?${buildQuery()}`)
      .then(data => { setTickets(data.tickets); setTotal(data.total); setLoading(false); })
      .catch(() => setLoading(false));
  }, [filters, sortBy, sortDir, page, q, activeKey, selectedProjectId]);

  function selectProject(projId) {
    setSelectedProjectId(projId);
    setPage(1);
    setSidebarOpen(false);
  }

  function selectPredefined(item) {
    setFilters({ ...item.filters });
    setActiveKey(item.key);
    setQ('');
    setPage(1);
    setSidebarOpen(false);
  }

  function selectSavedView(view) {
    const f = view.filters;
    setFilters({
      internal_status: f.internal_status || '',
      coastal_status: f.coastal_status || '',
      effective_priority: f.effective_priority || '',
      blocker_type: f.blocker_type || '',
      flagged_for_review: f.flagged_for_review || '',
    });
    setQ(f.q || '');
    setSortBy(f.sort_by || 'updated_at');
    setSortDir(f.sort_dir || 'desc');
    setActiveKey(`saved_${view.id}`);
    setPage(1);
    setSidebarOpen(false);
  }

  async function saveView() {
    if (!viewName.trim()) { toast.error('Name required'); return; }
    setSavingView(true);
    try {
      const v = await api.post('/api/views', {
        name: viewName.trim(),
        filters: { q, ...filters, sort_by: sortBy, sort_dir: sortDir },
      });
      setSavedViews(prev => [...prev, v].sort((a, b) => a.name.localeCompare(b.name)));
      setViewName('');
      setSaveOpen(false);
      toast.success(`View "${v.name}" saved`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingView(false);
    }
  }

  async function deleteView(e, id) {
    e.stopPropagation();
    try {
      await api.delete(`/api/views/${id}`);
      setSavedViews(prev => prev.filter(v => v.id !== id));
      if (activeKey === `saved_${id}`) { selectPredefined(PREDEFINED[0].items[1]); }
      toast.success('View deleted');
    } catch (err) {
      toast.error(err.message);
    }
  }

  function handleSort(col) {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('desc'); }
    setPage(1);
  }

  function SortHeader({ col, label }) {
    const active = sortBy === col;
    return (
      <button onClick={() => handleSort(col)}
        className={`text-left font-medium text-xs uppercase tracking-wide hover:text-blue-700 transition-colors ${active ? 'text-blue-700' : 'text-gray-500'}`}>
        {label} {active ? (sortDir === 'asc' ? '↑' : '↓') : ''}
      </button>
    );
  }

  // Sidebar link style
  function sidebarItemClass(key) {
    const base = 'flex items-center gap-2 w-full px-3 py-1.5 rounded-md text-sm transition-colors text-left';
    return activeKey === key
      ? `${base} bg-blue-600 text-white font-medium`
      : `${base} text-gray-600 hover:bg-gray-100`;
  }

  return (
    <div className="flex gap-5 items-start">
      {/* ── Mobile backdrop ── */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── Sidebar ── */}
      <aside className={`
        space-y-4 p-4 md:p-0
        md:block md:relative md:w-52 md:flex-shrink-0 md:sticky md:top-4 md:shadow-none md:overflow-visible md:bg-transparent
        ${sidebarOpen
          ? 'fixed inset-y-0 left-0 z-50 w-72 bg-white shadow-xl overflow-y-auto'
          : 'hidden'}
      `}>
        {/* Close button — mobile only */}
        <div className="flex items-center justify-between mb-2 md:hidden">
          <span className="font-semibold text-gray-700 text-sm">Filters</span>
          <button onClick={() => setSidebarOpen(false)}
            className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
        </div>
        {PREDEFINED.filter(group => showVendorCols || group.group !== 'External').map(group => (
          <div key={group.group}>
            <div className="text-xs font-semibold uppercase tracking-wider text-gray-400 px-3 mb-1">{group.group}</div>
            <div className="space-y-0.5">
              {group.items.map(item => {
                const count = counts[item.countKey];
                const urgent = URGENT_KEYS.has(item.key);
                return (
                  <button key={item.key} onClick={() => selectPredefined(item)} className={sidebarItemClass(item.key)}>
                    <span className="flex-1 text-left">{item.label}</span>
                    <CountBadge count={count} urgent={urgent} />
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {/* Projects */}
        {projects.length > 0 && (
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-gray-400 px-3 mb-1">Projects</div>
            <div className="space-y-0.5">
              <div className={`flex items-center gap-1 rounded-md ${selectedProjectId === null ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`}>
                <button onClick={() => selectProject(null)} className="flex items-center gap-2 flex-1 px-3 py-1.5 text-sm text-left">
                  <span className="flex-1">All Projects</span>
                </button>
                {user?.defaultProjectId && (
                  <button
                    title="Clear default project"
                    onClick={() => setDefaultProject(null)}
                    className={`pr-2 text-xs hover:opacity-75 ${selectedProjectId === null ? 'text-blue-200' : 'text-gray-400'}`}
                  >✕</button>
                )}
              </div>
              {projects.map(proj => {
                const isActive = selectedProjectId === proj.id;
                const isDefault = user?.defaultProjectId === proj.id;
                const cls = `flex items-center gap-1 rounded-md ${isActive ? 'bg-blue-600 text-white font-medium' : 'text-gray-600 hover:bg-gray-100'}`;
                return (
                  <div key={proj.id} className={cls}>
                    <button onClick={() => selectProject(proj.id)} className="flex items-center gap-2 flex-1 px-3 py-1.5 text-sm text-left min-w-0">
                      <span className={`font-mono text-xs px-1.5 py-0.5 rounded flex-shrink-0 ${isActive ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-500'}`}>
                        {proj.prefix}
                      </span>
                      <span className="flex-1 truncate">{proj.name}</span>
                      {isDefault && <span className={`text-xs flex-shrink-0 ${isActive ? 'text-blue-200' : 'text-gray-400'}`}>★</span>}
                    </button>
                    <button
                      title={isDefault ? 'Clear default' : 'Set as default project'}
                      onClick={() => setDefaultProject(isDefault ? null : proj.id)}
                      className={`pr-2 text-xs flex-shrink-0 hover:opacity-75 ${isDefault ? (isActive ? 'text-blue-200' : 'text-amber-500') : (isActive ? 'text-blue-300 opacity-50 hover:opacity-100' : 'text-gray-300 hover:text-gray-500')}`}
                    >
                      {isDefault ? '★' : '☆'}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Saved views */}
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-400 px-3 mb-1">Saved Views</div>
          <div className="space-y-0.5">
            {savedViews.length === 0 && (
              <p className="text-xs text-gray-400 px-3 py-1">None yet</p>
            )}
            {savedViews.map(v => (
              <div key={v.id} className={`${sidebarItemClass(`saved_${v.id}`)}`}>
                <button className="flex-1 text-left truncate" onClick={() => selectSavedView(v)} title={v.name}>
                  {v.name}
                </button>
                {(['Admin','Manager'].includes(user?.role) || v.user_id === user?.id) && (
                  <button onClick={e => deleteView(e, v.id)}
                    className={`flex-shrink-0 text-base leading-none ${activeKey === `saved_${v.id}` ? 'text-blue-200 hover:text-white' : 'text-gray-300 hover:text-red-500'}`}>×</button>
                )}
              </div>
            ))}
            {canManageViews && (
              saveOpen ? (
                <div className="px-1 pt-1 space-y-1">
                  <input autoFocus type="text" value={viewName}
                    onChange={e => setViewName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') saveView(); if (e.key === 'Escape') { setSaveOpen(false); setViewName(''); } }}
                    placeholder="View name…"
                    className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" />
                  <div className="flex gap-1">
                    <button onClick={saveView} disabled={savingView} className="btn-primary btn btn-sm text-xs flex-1 disabled:opacity-50">Save</button>
                    <button onClick={() => { setSaveOpen(false); setViewName(''); }} className="btn-secondary btn btn-sm text-xs">✕</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setSaveOpen(true)}
                  className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs text-gray-400 hover:text-blue-600 transition-colors">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Save current view
                </button>
              )
            )}
          </div>
        </div>
      </aside>

      {/* ── Main content ── */}
      <div className="flex-1 min-w-0 space-y-4">
        {/* Header row */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            {/* Mobile sidebar toggle */}
            <button
              onClick={() => setSidebarOpen(true)}
              className="md:hidden p-1.5 rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
              aria-label="Open filters"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
              </svg>
            </button>
            <h1 className="text-xl font-semibold text-gray-900">
              Tickets <span className="text-base font-normal text-gray-400">({total})</span>
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <input type="text" value={q}
                onChange={e => { setQ(e.target.value); setPage(1); setActiveKey(''); }}
                placeholder="Search…"
                className="border border-gray-300 rounded-md px-3 py-1.5 pr-7 text-sm w-48 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              {q && (
                <button onClick={() => { setQ(''); setSearchParams({}); setPage(1); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
              )}
            </div>
            <Link to="/tickets/new" className="btn-primary btn btn-sm whitespace-nowrap">+ New Ticket</Link>
          </div>
        </div>

        {/* Table */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          {loading ? (
            <div className="text-center text-gray-400 py-12">Loading…</div>
          ) : tickets.length === 0 ? (
            <div className="text-center text-gray-400 py-12">No tickets found</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2.5"><SortHeader col="mot_ref" label="Ref" /></th>
                    <th className="px-4 py-2.5 text-left"><SortHeader col="title" label="Title" /></th>
                    <th className="px-4 py-2.5"><SortHeader col="effective_priority" label="Pri" /></th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Internal</th>
                    {showVendorCols && <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">External</th>}
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Blocker</th>
                    <th className="px-4 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wide">★</th>
                    <th className="px-4 py-2.5"><SortHeader col="updated_at" label="Updated" /></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {tickets.map(t => (
                    <tr key={t.id} className={`${priorityRowClass(t.effective_priority)} transition-colors`}>
                      <td className="px-4 py-3 text-sm font-mono font-medium whitespace-nowrap">
                        <Link to={`/tickets/${t.id}`} className="text-blue-700 hover:underline">{t.mot_ref}</Link>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-900 w-48">
                        <Link to={`/tickets/${t.id}`} className="hover:text-blue-700 leading-snug">{t.title}</Link>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <PriorityBadge priority={t.effective_priority} override={t.priority_override} computed={t.computed_priority} showOverrideInfo={false} />
                      </td>
                      <td className="px-4 py-3"><StatusBadge status={t.internal_status} /></td>
                      {showVendorCols && <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">{t.coastal_status}</td>}
                      <td className="px-4 py-3 text-sm">
                        {t.blocker_type === 'mot_input' && <span className="text-amber-600 font-medium">Team Input</span>}
                        {t.blocker_type === 'internal' && <span className="text-red-600 font-medium">{t.blocking_ticket_ref || 'Internal'}</span>}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {t.flagged_for_review ? <span className="text-purple-600 font-bold">★</span> : null}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500 w-20">
                        <DateTimeStack value={t.updated_at} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Pagination */}
        {total > LIMIT && (
          <div className="flex items-center justify-between text-sm text-gray-500">
            <span>Showing {(page - 1) * LIMIT + 1}–{Math.min(page * LIMIT, total)} of {total}</span>
            <div className="flex gap-2">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="btn-secondary btn btn-sm disabled:opacity-50">Previous</button>
              <button onClick={() => setPage(p => p + 1)} disabled={page * LIMIT >= total} className="btn-secondary btn btn-sm disabled:opacity-50">Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
