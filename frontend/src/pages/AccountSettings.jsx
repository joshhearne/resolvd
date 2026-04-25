import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function AccountSettings() {
  const { user } = useAuth();
  const isLocal = user?.authProvider === 'local';

  const tabClass = ({ isActive }) =>
    `px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
      isActive
        ? 'border-blue-600 text-blue-700'
        : 'border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300'
    }`;

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Account settings</h1>
      <p className="text-sm text-gray-500 mb-4">Manage your profile, sign-in, and security.</p>
      <div className="border-b border-gray-200 mb-6 flex gap-1 overflow-x-auto">
        <NavLink to="/account/settings/profile" className={tabClass}>Profile</NavLink>
        {isLocal && <NavLink to="/account/settings/password" className={tabClass}>Password</NavLink>}
        <NavLink to="/account/settings/mfa" className={tabClass}>Two-factor</NavLink>
      </div>
      <Outlet />
    </div>
  );
}
