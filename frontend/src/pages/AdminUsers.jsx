import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { formatDateTime } from '../utils/helpers';

const ROLES = ['Admin', 'Submitter', 'Viewer'];

export default function AdminUsers() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);

  useEffect(() => {
    api.get('/api/users')
      .then(data => { setUsers(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  async function changeRole(userId, role) {
    setSaving(userId);
    try {
      const updated = await api.patch(`/api/users/${userId}/role`, { role });
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, role: updated.role } : u));
      toast.success('Role updated');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(null);
    }
  }

  if (loading) return <div className="text-gray-400 py-12 text-center">Loading...</div>;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-gray-900">User Management</h1>
      <p className="text-sm text-gray-500">Users are created automatically on first M365 login. Default role: Viewer.</p>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Name</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Email</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">UPN</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Role</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Last Login</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.map(u => {
              const isSelf = u.id === currentUser?.id;
              return (
                <tr key={u.id} className={`hover:bg-gray-50 ${isSelf ? 'bg-blue-50' : ''}`}>
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">
                    {u.display_name}
                    {isSelf && <span className="ml-2 text-xs text-blue-500">(you)</span>}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">{u.email}</td>
                  <td className="px-4 py-3 text-sm text-gray-500 font-mono text-xs">{u.upn}</td>
                  <td className="px-4 py-3">
                    {isSelf ? (
                      <span className="text-sm text-gray-500 italic">{u.role} (cannot change own role)</span>
                    ) : (
                      <select
                        value={u.role}
                        onChange={e => changeRole(u.id, e.target.value)}
                        disabled={saving === u.id}
                        className="border border-gray-300 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-60"
                      >
                        {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400">{formatDateTime(u.last_login)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {users.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-8">No users yet</p>
        )}
      </div>
    </div>
  );
}
