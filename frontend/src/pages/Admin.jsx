import React from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const MANAGER_TABS = [
  { to: "/admin/users", label: "Users" },
  { to: "/admin/export", label: "Export" },
];

const ADMIN_ONLY_TABS = [
  { to: "/admin/auth", label: "Authentication" },
  { to: "/admin/statuses", label: "Statuses" },
  { to: "/admin/branding", label: "Branding" },
];

export default function Admin() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "Admin";
  const tabs = isSuperAdmin
    ? [...MANAGER_TABS, ...ADMIN_ONLY_TABS]
    : MANAGER_TABS;

  const tabClass = ({ isActive }) =>
    `px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
      isActive
        ? "border-brand text-brand"
        : "border-transparent text-fg-muted hover:text-fg hover:border-border-strong"
    }`;

  return (
    <div>
      <h1 className="text-2xl font-bold text-fg mb-1">Admin</h1>
      <p className="text-sm text-fg-muted mb-4">
        {isSuperAdmin
          ? "Manage users, authentication, branding, statuses, and exports."
          : "Manage users and exports."}
      </p>
      <div className="border-b border-border mb-6 flex gap-1 overflow-x-auto">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} className={tabClass} end>
            {t.label}
          </NavLink>
        ))}
      </div>
      <Outlet />
    </div>
  );
}
