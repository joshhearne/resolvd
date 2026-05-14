import React, { useState, useRef, useEffect } from "react";
import { Outlet, NavLink, Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useBranding } from "../context/BrandingContext";
import { useTheme } from "../context/ThemeContext";
import { brandingLogoFilter } from "../utils/helpers";
import Avatar from "./Avatar";
import NotificationTray from "./NotificationTray";

// Icon set — inline SVGs in the lucide-react visual style (stroke=2,
// stroke-linecap/linejoin=round, 24x24 viewBox). Keeps bundle small and
// matches the existing notification / theme icons.
const Icon = {
  PanelLeftOpen: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
      <path d="m14 9 3 3-3 3" />
    </svg>
  ),
  PanelLeftClose: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
      <path d="m16 15-3-3 3-3" />
    </svg>
  ),
  Plus: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  Search: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  ),
  LayoutDashboard: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  ),
  Ticket: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
      <path d="M13 5v2M13 17v2M13 11v2" />
    </svg>
  ),
  Folder: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M6 3h2l2 3h8a2 2 0 0 1 2 2v3" />
      <path d="M2 6v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2H2Z" />
      <path d="M6 13h2M11 13h2M15 13h2" />
    </svg>
  ),
  Boxes: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5l-5-3-4.03 1.92Z" />
      <path d="m7 16.5-4.74-2.85" />
      <path d="m7 16.5 5-3" />
      <path d="M7 16.5v5.17" />
      <path d="M12 13.94a2 2 0 0 0 .97-1.71V8.99a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8A2 2 0 0 0 3 8.99v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0Z" />
      <path d="m12 8-5 3" />
      <path d="M21.03 12.92A2 2 0 0 1 22 14.63v3.24a2 2 0 0 1-.97 1.71l-3 1.8a2 2 0 0 1-2.06 0L12 19v-5l5-3 4.03 1.92Z" />
      <path d="m17 16.5 4.74-2.85" />
      <path d="m17 16.5-5-3" />
      <path d="M17 16.5v5.17" />
    </svg>
  ),
  Settings: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  HelpCircle: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" />
    </svg>
  ),
  Book: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
    </svg>
  ),
  Sun: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  ),
  Moon: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  ),
  Monitor: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  ),
  ChevronDown: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  ),
  User: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  ),
  Shield: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z" />
    </svg>
  ),
  LogOut: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
    </svg>
  ),
};

function SearchBar() {
  const [q, setQ] = useState("");
  const navigate = useNavigate();
  function handleSubmit(e) {
    e.preventDefault();
    if (!q.trim()) return;
    navigate(`/tickets?q=${encodeURIComponent(q.trim())}`);
    setQ("");
  }
  return (
    <form onSubmit={handleSubmit} className="flex items-center">
      <div className="relative">
        <Icon.Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-dim pointer-events-none" />
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search tickets…"
          className="bg-surface-2 text-fg placeholder:text-fg-dim text-sm rounded-md border border-border pl-8 pr-3 py-1.5 w-56 focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-border-strong"
        />
      </div>
    </form>
  );
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const order = ["light", "dark", "system"];
  const next = order[(order.indexOf(theme) + 1) % order.length];
  const labels = {
    light: "Light mode (click for dark)",
    dark: "Dark mode (click for system)",
    system: "System mode (click for light)",
  };
  return (
    <button
      onClick={() => setTheme(next)}
      aria-label={labels[theme]}
      title={labels[theme]}
      className="p-2 rounded-md text-fg-muted hover:text-fg hover:bg-surface-2 transition-colors"
    >
      {theme === "light" && <Icon.Sun className="w-4 h-4" />}
      {theme === "dark" && <Icon.Moon className="w-4 h-4" />}
      {theme === "system" && <Icon.Monitor className="w-4 h-4" />}
    </button>
  );
}

function UserMenu({ user, logout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-surface-2 transition-colors"
      >
        <Avatar user={user} size="sm" />
        <span className="hidden sm:block text-sm text-fg">{user?.displayName}</span>
        <Icon.ChevronDown className="hidden sm:block w-3 h-3 text-fg-muted" />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-64 bg-surface border border-border rounded-lg shadow-lg text-fg z-30 overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-3">
            <Avatar user={user} size="md" />
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate">{user?.displayName}</div>
              <div className="text-xs text-fg-muted truncate">{user?.email}</div>
              <span className="inline-block mt-1 text-[10px] uppercase tracking-wide font-medium px-2 py-0.5 rounded bg-surface-2 text-fg-muted">
                {user?.role}
              </span>
            </div>
          </div>
          <Link
            to="/account/settings"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-surface-2"
          >
            <Icon.User className="w-4 h-4 text-fg-muted" />
            Account settings
          </Link>
          <Link
            to="/account/settings/mfa"
            onClick={() => setOpen(false)}
            className="flex items-center justify-between gap-2 px-4 py-2 text-sm hover:bg-surface-2"
          >
            <span className="flex items-center gap-2">
              <Icon.Shield className="w-4 h-4 text-fg-muted" />
              Two-factor auth
            </span>
            <span
              className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${user?.mfaEnabled ? "bg-brand/15 text-brand" : "bg-surface-2 text-fg-dim"}`}
            >
              {user?.mfaEnabled ? "On" : "Off"}
            </span>
          </Link>
          <button
            onClick={logout}
            className="w-full flex items-center gap-2 px-4 py-2 text-sm hover:bg-surface-2 border-t border-border text-fg"
          >
            <Icon.LogOut className="w-4 h-4 text-fg-muted" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

// Persisted between sessions so the user doesn't get reset on every reload.
const SIDEBAR_STORAGE_KEY = "resolvd.sidebarCollapsed";

function Sidebar({ collapsed, onToggle, user, onItemClick }) {
  const items = [
    { to: "/dashboard", label: "Dashboard", icon: Icon.LayoutDashboard, show: true },
    { to: "/tickets", label: "Tickets", icon: Icon.Ticket, show: true },
    {
      to: "/projects",
      label: "Projects",
      icon: Icon.Folder,
      show: ["Admin", "Manager"].includes(user?.role),
    },
    { to: "/inventory", label: "Inventory", icon: Icon.Boxes, show: true },
    { to: "/kb", label: "Knowledge Base", icon: Icon.Book, show: true },
    {
      to: "/admin",
      label: "Admin",
      icon: Icon.Settings,
      show: ["Admin", "Manager"].includes(user?.role),
    },
    { to: "/help", label: "Help", icon: Icon.HelpCircle, show: true },
  ];

  const linkClass = ({ isActive }) =>
    `relative flex items-center gap-3 ${collapsed ? "px-2.5 justify-center" : "px-3"} py-2 rounded-md text-sm font-medium transition-colors ${
      isActive
        ? "bg-surface-2 text-fg"
        : "text-fg-muted hover:bg-surface-2 hover:text-fg"
    }`;

  return (
    <aside
      className={`bg-surface border-r border-border fixed left-0 top-14 bottom-0 z-20 transition-[width] duration-150 ${
        collapsed ? "w-14" : "w-56"
      }`}
    >
      <nav className="flex flex-col gap-0.5 p-2">
        {items.filter((i) => i.show).map((item) => {
          const Ico = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={linkClass}
              onClick={onItemClick}
              title={collapsed ? item.label : undefined}
            >
              <Ico className="w-4 h-4 flex-shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </NavLink>
          );
        })}
      </nav>
    </aside>
  );
}

export default function Layout() {
  const { user, logout } = useAuth();
  const { branding } = useBranding();
  const { resolved } = useTheme();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const logoFilter = brandingLogoFilter(branding, resolved);

  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? "1" : "0"); } catch {}
      return next;
    });
  }

  useEffect(() => {
    if (user?.preferences?.compact_mode) {
      document.documentElement.classList.add("compact");
    } else {
      document.documentElement.classList.remove("compact");
    }
  }, [user?.preferences?.compact_mode]);

  const canCreateTicket =
    ["Admin", "Manager"].includes(user?.role) || user?.role === "Submitter";

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-surface/80 backdrop-blur-md border-b border-border sticky top-0 z-30 h-14 flex items-center">
        <div className="flex-1 flex items-center justify-between gap-3 px-3 sm:px-4">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <button
              onClick={() => {
                toggleCollapsed();
                setMobileOpen((m) => !m);
              }}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="p-2 rounded-md text-fg-muted hover:text-fg hover:bg-surface-2 transition-colors"
            >
              {collapsed ? (
                <Icon.PanelLeftOpen className="w-5 h-5" />
              ) : (
                <Icon.PanelLeftClose className="w-5 h-5" />
              )}
            </button>
            <Link
              to="/dashboard"
              className="flex items-center gap-2 hover:opacity-90 transition-opacity min-w-0"
            >
              <img
                src={branding.logo_url || "/icon.svg"}
                alt="Logo"
                className="h-7 w-auto object-contain flex-shrink-0"
                style={branding.logo_url && logoFilter ? { filter: logoFilter } : undefined}
              />
              <span className="font-bold text-lg tracking-tight text-fg truncate hidden sm:block">
                {branding.site_name || "Resolvd"}
              </span>
            </Link>
            {canCreateTicket && (
              <Link
                to="/tickets/new"
                className="ml-1 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-brand text-brand-fg text-sm font-medium hover:bg-brand-hover transition-colors"
              >
                <Icon.Plus className="w-4 h-4" />
                <span className="hidden sm:inline">New ticket</span>
              </Link>
            )}
            <div className="hidden md:block ml-2">
              <SearchBar />
            </div>
          </div>
          <div className="flex items-center gap-1">
            {user && <NotificationTray />}
            <ThemeToggle />
            <UserMenu user={user} logout={logout} />
          </div>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <div className="hidden md:block">
          <Sidebar collapsed={collapsed} onToggle={toggleCollapsed} user={user} />
        </div>

        {mobileOpen && (
          <>
            <div
              className="md:hidden fixed inset-0 top-14 bg-black/40 z-20"
              onClick={() => setMobileOpen(false)}
            />
            <div className="md:hidden fixed top-14 left-0 bottom-0 z-30">
              <Sidebar
                collapsed={false}
                user={user}
                onItemClick={() => setMobileOpen(false)}
              />
            </div>
          </>
        )}

        <main
          className={`flex-1 min-w-0 px-4 sm:px-6 py-6 transition-[margin] duration-150 ${
            collapsed ? "md:ml-14" : "md:ml-56"
          }`}
        >
          <Outlet />
        </main>
      </div>

      {branding.show_powered_by && (
        <footer className="border-t border-border py-3 flex items-center justify-center gap-2 text-xs text-fg-dim">
          <span>Powered by</span>
          <a href="https://hearnetech.com/apps" target="_blank" rel="noopener noreferrer">
            <img
              src="/hearne-logo.png"
              alt="Hearne Technologies"
              className="h-4 w-auto object-contain opacity-70 hover:opacity-100 transition-opacity dark:brightness-0 dark:invert"
            />
          </a>
        </footer>
      )}
    </div>
  );
}
