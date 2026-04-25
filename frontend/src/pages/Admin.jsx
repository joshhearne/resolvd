import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';

const TABS = [
  { to: '/admin/users', label: 'Users' },
  { to: '/admin/auth', label: 'Authentication' },
  { to: '/admin/statuses', label: 'Statuses' },
  { to: '/admin/branding', label: 'Branding' },
  { to: '/admin/export', label: 'Export' },
];

export default function Admin() {
  const tabClass = ({ isActive }) =>
    `px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
      isActive
        ? 'border-blue-600 text-blue-700'
        : 'border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300'
    }`;

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Admin</h1>
      <p className="text-sm text-gray-500 mb-4">Manage users, authentication, branding, and exports.</p>
      <div className="border-b border-gray-200 mb-6 flex gap-1 overflow-x-auto">
        {TABS.map(t => (
          <NavLink key={t.to} to={t.to} className={tabClass} end>
            {t.label}
          </NavLink>
        ))}
      </div>
      <Outlet />
    </div>
  );
}
