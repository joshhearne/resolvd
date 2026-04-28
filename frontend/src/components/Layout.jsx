import React, { useState, useRef, useEffect } from "react";
import { Outlet, NavLink, Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useBranding } from "../context/BrandingContext";
import { useTheme } from "../context/ThemeContext";
import { brandingLogoFilter } from "../utils/helpers";
import Avatar from "./Avatar";
import NotificationTray from "./NotificationTray";

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
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search tickets…"
          className="bg-surface-2 text-fg placeholder:text-fg-dim text-sm rounded-md border border-border px-3 py-1.5 pr-8 w-48 focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-border-strong"
        />
        <button
          type="submit"
          aria-label="Search"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-dim hover:text-fg"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"
            />
          </svg>
        </button>
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
      {theme === "light" && (
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <circle cx="12" cy="12" r="4" strokeWidth={2} />
          <path
            strokeLinecap="round"
            strokeWidth={2}
            d="M12 2v2m0 16v2m10-10h-2M4 12H2m15.07-7.07l-1.41 1.41M6.34 17.66l-1.41 1.41M17.66 17.66l1.41 1.41M4.93 4.93l1.41 1.41"
          />
        </svg>
      )}
      {theme === "dark" && (
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 12.79A9 9 0 1111.21 3a7 7 0 109.79 9.79z"
          />
        </svg>
      )}
      {theme === "system" && (
        <svg className="w-4 h-4" viewBox="0 0 24 24">
          <circle
            cx="12"
            cy="12"
            r="9"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          />
          <path d="M12 3a9 9 0 010 18z" fill="currentColor" />
        </svg>
      )}
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
        <span className="hidden sm:block text-sm text-fg">
          {user?.displayName}
        </span>
        <svg
          className="hidden sm:block w-3 h-3 text-fg-muted"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-64 bg-surface border border-border rounded-lg shadow-lg text-fg z-30 overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-3">
            <Avatar user={user} size="md" />
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate">
                {user?.displayName}
              </div>
              <div className="text-xs text-fg-muted truncate">
                {user?.email}
              </div>
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
            <svg
              className="w-4 h-4 text-fg-muted"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10.325 4.317a1 1 0 011.35 0l1.214 1.106a1 1 0 00.764.262l1.638-.183a1 1 0 011.05.717l.473 1.575a1 1 0 00.561.622l1.514.682a1 1 0 01.582.95l-.052 1.638a1 1 0 00.262.764l1.106 1.214a1 1 0 010 1.35l-1.106 1.214a1 1 0 00-.262.764l.052 1.638a1 1 0 01-.582.95l-1.514.682a1 1 0 00-.561.622l-.473 1.575a1 1 0 01-1.05.717l-1.638-.183a1 1 0 00-.764.262l-1.214 1.106a1 1 0 01-1.35 0L9.11 19.7a1 1 0 00-.764-.262l-1.638.183a1 1 0 01-1.05-.717l-.473-1.575a1 1 0 00-.561-.622l-1.514-.682a1 1 0 01-.582-.95l.052-1.638a1 1 0 00-.262-.764L1.212 11.46a1 1 0 010-1.35l1.106-1.214a1 1 0 00.262-.764l-.052-1.638a1 1 0 01.582-.95l1.514-.682a1 1 0 00.561-.622l.473-1.575a1 1 0 011.05-.717l1.638.183a1 1 0 00.764-.262l1.215-1.106z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            Account settings
          </Link>
          <Link
            to="/account/settings/mfa"
            onClick={() => setOpen(false)}
            className="flex items-center justify-between gap-2 px-4 py-2 text-sm hover:bg-surface-2"
          >
            <span className="flex items-center gap-2">
              <svg
                className="w-4 h-4 text-fg-muted"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
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
            <svg
              className="w-4 h-4 text-fg-muted"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
              />
            </svg>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const { user, logout } = useAuth();
  const { branding } = useBranding();
  const { resolved } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const logoFilter = brandingLogoFilter(branding, resolved);

  const navLinkClass = ({ isActive }) =>
    `flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
      isActive
        ? "bg-surface-2 text-fg"
        : "text-fg-muted hover:bg-surface-2 hover:text-fg"
    }`;

  // Compact mode applies a body-level class so any ad-hoc CSS can opt in.
  // Cheap effect (runs whenever the pref flips) — no need for memoization.
  useEffect(() => {
    if (user?.preferences?.compact_mode) {
      document.documentElement.classList.add("compact");
    } else {
      document.documentElement.classList.remove("compact");
    }
  }, [user?.preferences?.compact_mode]);

  return (
    <div className="min-h-screen flex flex-col">
      <nav className="bg-surface/80 backdrop-blur-md border-b border-border sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            <div className="flex items-center gap-6">
              <Link
                to="/dashboard"
                className="flex items-center gap-2 hover:opacity-90 transition-opacity"
              >
                <img
                  src={branding.logo_url || "/icon.svg"}
                  alt="Logo"
                  className="h-7 w-auto object-contain"
                  style={
                    branding.logo_url && logoFilter
                      ? { filter: logoFilter }
                      : undefined
                  }
                />
                <span className="font-bold text-lg tracking-tight text-fg">
                  {branding.site_name || "Resolvd"}
                </span>
              </Link>
              <div className="hidden md:flex items-center gap-1">
                <NavLink to="/dashboard" className={navLinkClass}>
                  Dashboard
                </NavLink>
                <NavLink to="/tickets" className={navLinkClass}>
                  Tickets
                </NavLink>
                {(["Admin", "Manager"].includes(user?.role) ||
                  user?.role === "Submitter") && (
                  <NavLink to="/tickets/new" className={navLinkClass}>
                    + New Ticket
                  </NavLink>
                )}
                {["Admin", "Manager"].includes(user?.role) && (
                  <>
                    <NavLink to="/projects" className={navLinkClass}>
                      Projects
                    </NavLink>
                    <NavLink to="/admin" className={navLinkClass}>
                      Admin
                    </NavLink>
                  </>
                )}
              </div>
            </div>
            <div className="hidden md:block">
              <SearchBar />
            </div>
            <div className="flex items-center gap-1">
              {["Admin", "Manager"].includes(user?.role) && <NotificationTray />}
              <ThemeToggle />
              <UserMenu user={user} logout={logout} />
              <button
                aria-label="Toggle menu"
                className="md:hidden p-2 rounded-md text-fg-muted hover:text-fg hover:bg-surface-2"
                onClick={() => setMobileOpen(!mobileOpen)}
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 6h16M4 12h16M4 18h16"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>
        {mobileOpen && (
          <div className="md:hidden border-t border-border px-4 py-2 flex flex-col gap-1">
            <NavLink
              to="/dashboard"
              className={navLinkClass}
              onClick={() => setMobileOpen(false)}
            >
              Dashboard
            </NavLink>
            <NavLink
              to="/tickets"
              className={navLinkClass}
              onClick={() => setMobileOpen(false)}
            >
              Tickets
            </NavLink>
            {(["Admin", "Manager"].includes(user?.role) ||
              user?.role === "Submitter") && (
              <NavLink
                to="/tickets/new"
                className={navLinkClass}
                onClick={() => setMobileOpen(false)}
              >
                + New Ticket
              </NavLink>
            )}
            {["Admin", "Manager"].includes(user?.role) && (
              <>
                <NavLink
                  to="/projects"
                  className={navLinkClass}
                  onClick={() => setMobileOpen(false)}
                >
                  Projects
                </NavLink>
                <NavLink
                  to="/admin"
                  className={navLinkClass}
                  onClick={() => setMobileOpen(false)}
                >
                  Admin
                </NavLink>
              </>
            )}
          </div>
        )}
      </nav>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <Outlet />
      </main>

      {branding.show_powered_by && (
        <footer className="border-t border-border py-3 flex items-center justify-center gap-2 text-xs text-fg-dim">
          <span>Powered by</span>
          <a
            href="https://hearnetech.com/apps"
            target="_blank"
            rel="noopener noreferrer"
          >
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
