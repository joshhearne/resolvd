import React from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export default function AccountSettings() {
  const { user } = useAuth();
  const isLocal = user?.authProvider === "local";

  const tabClass = ({ isActive }) =>
    `px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
      isActive
        ? "border-brand text-brand"
        : "border-transparent text-fg-muted hover:text-fg hover:border-border-strong"
    }`;

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold text-fg mb-1">Account settings</h1>
      <p className="text-sm text-fg-muted mb-4">
        Manage your profile, sign-in, security, and personal preferences.
      </p>
      <div className="border-b border-border mb-6 flex gap-1 overflow-x-auto">
        <NavLink to="/account/settings/profile" className={tabClass}>
          Profile
        </NavLink>
        {isLocal && (
          <NavLink to="/account/settings/password" className={tabClass}>
            Password
          </NavLink>
        )}
        <NavLink to="/account/settings/mfa" className={tabClass}>
          Two-factor
        </NavLink>
        <NavLink to="/account/settings/preferences" className={tabClass}>
          Preferences
        </NavLink>
      </div>
      <Outlet />
    </div>
  );
}
