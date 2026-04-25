import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../utils/api';
import { formatDateTime } from '../utils/helpers';
import StatusBadge from '../components/StatusBadge';
import PriorityBadge from '../components/PriorityBadge';

function StatCard({ label, value, color = 'blue', urgent = false, to }) {
  const inner = (
    <>
      <div className={`text-3xl font-bold ${urgent ? 'text-amber-600' : `text-${color}-600`}`}>{value}</div>
      <div className="text-sm text-gray-500 mt-1">{label}</div>
    </>
  );
  const base = `bg-white rounded-lg border p-4 shadow-sm transition-shadow ${urgent ? 'border-amber-400 ring-1 ring-amber-300' : 'border-gray-200'}`;
  if (to) {
    return (
      <Link to={to} className={`${base} hover:shadow-md hover:border-blue-300 cursor-pointer block`}>
        {inner}
      </Link>
    );
  }
  return <div className={base}>{inner}</div>;
}

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [activity, setActivity] = useState([]);
  const [pendingTickets, setPendingTickets] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get('/api/dashboard/stats'),
      api.get('/api/dashboard/activity'),
      api.get('/api/tickets?internal_status=Pending+Review&sort_by=updated_at&sort_dir=desc&limit=10'),
    ]).then(([s, a, pt]) => {
      setStats(s);
      setActivity(a);
      setPendingTickets(pt.tickets || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-gray-400 py-12 text-center">Loading dashboard...</div>;

  const priorities = [1, 2, 3, 4, 5];
  const priorityMap = {};
  (stats?.priority_distribution || []).forEach(r => { priorityMap[r.effective_priority] = r.count; });
  const totalActive = priorities.reduce((sum, p) => sum + (priorityMap[p] || 0), 0);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-gray-900">Dashboard</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <StatCard label="Open" value={stats?.total_open || 0} color="blue" to="/tickets?preset=open" />
        <StatCard label="In Progress" value={stats?.total_in_progress || 0} color="indigo" to="/tickets?preset=in_progress" />
        <StatCard label="Awaiting Input" value={stats?.total_awaiting_mot || 0} color="amber" urgent={stats?.total_awaiting_mot > 0} to="/tickets?preset=awaiting_mot" />
        <StatCard label="Pending Review" value={stats?.total_pending_review || 0} color="purple" urgent={stats?.total_pending_review > 0} to="/tickets?preset=pending_review" />
        <StatCard label="Flagged for Review" value={stats?.flagged_for_review || 0} color="red" urgent={stats?.flagged_for_review > 0} to="/tickets?preset=flagged" />
        <StatCard label="Closed" value={stats?.total_closed || 0} color="gray" to="/tickets?preset=closed" />
      </div>

      {/* Priority bar */}
      {totalActive > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Priority Distribution (Active Tickets)</h2>
          <div className="flex gap-2 items-end h-16">
            {priorities.map(p => {
              const count = priorityMap[p] || 0;
              const pct = totalActive > 0 ? (count / totalActive) * 100 : 0;
              const colors = ['bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-gray-400', 'bg-gray-300'];
              return (
                <div key={p} className="flex flex-col items-center gap-1 flex-1">
                  <span className="text-xs font-medium text-gray-600">{count}</span>
                  <div className={`w-full ${colors[p - 1]} rounded-t transition-all`} style={{ height: `${Math.max(pct, 4)}%` }} />
                  <span className="text-xs text-gray-500">P{p}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Pending Review */}
        {pendingTickets.length > 0 && (
          <div className="bg-white rounded-lg border-2 border-purple-300 shadow-sm">
            <div className="px-4 py-3 border-b border-purple-200 bg-purple-50 rounded-t-lg">
              <h2 className="text-sm font-semibold text-purple-800">Pending Review — Action Required</h2>
            </div>
            <ul className="divide-y divide-gray-100">
              {pendingTickets.map(t => (
                <li key={t.id} className="px-4 py-3 flex items-center justify-between hover:bg-gray-50">
                  <div>
                    <Link to={`/tickets/${t.id}`} className="text-sm font-medium text-blue-700 hover:underline">
                      {t.mot_ref}
                    </Link>
                    <span className="ml-2 text-sm text-gray-700">{t.title}</span>
                  </div>
                  <PriorityBadge priority={t.effective_priority} override={t.priority_override} computed={t.computed_priority} showOverrideInfo={false} />
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Recent activity */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
          <div className="px-4 py-3 border-b border-gray-200">
            <h2 className="text-sm font-semibold text-gray-700">Recent Activity</h2>
          </div>
          {activity.length === 0 ? (
            <p className="text-sm text-gray-400 px-4 py-6 text-center">No activity yet</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {activity.map(a => (
                <li key={a.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-sm">
                      {a.mot_ref && (
                        <Link to={`/tickets/${a.ticket_id}`} className="font-medium text-blue-700 hover:underline mr-1">
                          {a.mot_ref}
                        </Link>
                      )}
                      <span className="text-gray-600">{a.action.replace(/_/g, ' ')}</span>
                      {a.new_value && <span className="text-gray-500"> → {a.new_value}</span>}
                    </div>
                    <span className="text-xs text-gray-400 whitespace-nowrap">{formatDateTime(a.created_at)}</span>
                  </div>
                  {a.user_name && <div className="text-xs text-gray-400 mt-0.5">{a.user_name}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
