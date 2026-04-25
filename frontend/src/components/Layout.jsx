import React, { useState, useRef, useEffect } from 'react';
import { Outlet, NavLink, Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useBranding } from '../context/BrandingContext';
import Avatar from './Avatar';

function SearchBar() {
  const [q, setQ] = useState('');
  const navigate = useNavigate();
  function handleSubmit(e) {
    e.preventDefault();
    if (!q.trim()) return;
    navigate(`/tickets?q=${encodeURIComponent(q.trim())}`);
    setQ('');
  }
  return (
    <form onSubmit={handleSubmit} className="flex items-center">
      <div className="relative">
        <input
          type="text"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search tickets…"
          className="bg-white/10 text-white placeholder-white/50 text-sm rounded-md px-3 py-1.5 pr-8 w-48 focus:outline-none focus:ring-2 focus:ring-white/40"
        />
        <button type="submit" className="absolute right-2 top-1/2 -translate-y-1/2 text-white/60 hover:text-white">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
        </button>
      </div>
    </form>
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
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-white/15 transition-colors"
      >
        <Avatar user={user} size="sm" />
        <span className="hidden sm:block text-sm text-white">{user?.displayName}</span>
        <svg className="hidden sm:block w-3 h-3 text-white/70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-64 bg-white rounded-lg shadow-lg ring-1 ring-black/5 text-gray-800 z-30 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3">
            <Avatar user={user} size="md" className="!bg-gray-200 !text-gray-700" />
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate">{user?.displayName}</div>
              <div className="text-xs text-gray-500 truncate">{user?.email}</div>
              <span className="inline-block mt-1 text-[10px] uppercase tracking-wide font-medium px-2 py-0.5 rounded bg-gray-100 text-gray-600">
                {user?.role}
              </span>
            </div>
          </div>
          <Link
            to="/account/settings"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-gray-50"
          >
            <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317a1 1 0 011.35 0l1.214 1.106a1 1 0 00.764.262l1.638-.183a1 1 0 011.05.717l.473 1.575a1 1 0 00.561.622l1.514.682a1 1 0 01.582.95l-.052 1.638a1 1 0 00.262.764l1.106 1.214a1 1 0 010 1.35l-1.106 1.214a1 1 0 00-.262.764l.052 1.638a1 1 0 01-.582.95l-1.514.682a1 1 0 00-.561.622l-.473 1.575a1 1 0 01-1.05.717l-1.638-.183a1 1 0 00-.764.262l-1.214 1.106a1 1 0 01-1.35 0L9.11 19.7a1 1 0 00-.764-.262l-1.638.183a1 1 0 01-1.05-.717l-.473-1.575a1 1 0 00-.561-.622l-1.514-.682a1 1 0 01-.582-.95l.052-1.638a1 1 0 00-.262-.764L1.212 11.46a1 1 0 010-1.35l1.106-1.214a1 1 0 00.262-.764l-.052-1.638a1 1 0 01.582-.95l1.514-.682a1 1 0 00.561-.622l.473-1.575a1 1 0 011.05-.717l1.638.183a1 1 0 00.764-.262l1.215-1.106z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Account settings
          </Link>
          <Link
            to="/account/settings/mfa"
            onClick={() => setOpen(false)}
            className="flex items-center justify-between gap-2 px-4 py-2 text-sm hover:bg-gray-50"
          >
            <span className="flex items-center gap-2">
              <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              Two-factor auth
            </span>
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${user?.mfaEnabled ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
              {user?.mfaEnabled ? 'On' : 'Off'}
            </span>
          </Link>
          <button
            onClick={logout}
            className="w-full flex items-center gap-2 px-4 py-2 text-sm hover:bg-gray-50 border-t border-gray-100 text-gray-700"
          >
            <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
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
  const [mobileOpen, setMobileOpen] = useState(false);

  const navBg = branding.primary_color || '#1e40af';

  const navLinkClass = ({ isActive }) =>
    `flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
      isActive ? 'bg-white/20 text-white' : 'text-white/80 hover:bg-white/15 hover:text-white'
    }`;

  return (
    <div className="min-h-screen flex flex-col">
      {/* Top nav */}
      <nav style={{ backgroundColor: navBg }} className="text-white shadow-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            <div className="flex items-center gap-6">
              <Link to="/dashboard" className="flex items-center gap-2 hover:opacity-90 transition-opacity">
                {branding.logo_url ? (
                  <img src={branding.logo_url} alt="Logo" className="h-7 w-auto object-contain" />
                ) : (
                  <svg className="h-7 w-7" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <circle cx="16" cy="16" r="13" fill="none" stroke="#ffffff" strokeWidth="2.5" strokeDasharray="4 3" strokeLinecap="round" />
                  </svg>
                )}
                <span className="font-bold text-lg tracking-tight">{branding.site_name || 'Resolvd'}</span>
              </Link>
              <div className="hidden md:flex items-center gap-1">
                <NavLink to="/dashboard" className={navLinkClass}>Dashboard</NavLink>
                <NavLink to="/tickets" className={navLinkClass}>Tickets</NavLink>
                {(['Admin','Manager'].includes(user?.role) || user?.role === 'Submitter') && (
                  <NavLink to="/tickets/new" className={navLinkClass}>+ New Ticket</NavLink>
                )}
                {['Admin','Manager'].includes(user?.role) && (
                  <>
                    <NavLink to="/projects" className={navLinkClass}>Projects</NavLink>
                    <NavLink to="/admin" className={navLinkClass}>Admin</NavLink>
                  </>
                )}
              </div>
            </div>
            <div className="hidden md:block">
              <SearchBar />
            </div>
            <div className="flex items-center gap-2">
              <UserMenu user={user} logout={logout} />
              <button className="md:hidden p-1 rounded hover:bg-white/15" onClick={() => setMobileOpen(!mobileOpen)}>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
            </div>
          </div>
        </div>
        {/* Mobile menu */}
        {mobileOpen && (
          <div className="md:hidden border-t border-white/20 px-4 py-2 flex flex-col gap-1">
            <NavLink to="/dashboard" className={navLinkClass} onClick={() => setMobileOpen(false)}>Dashboard</NavLink>
            <NavLink to="/tickets" className={navLinkClass} onClick={() => setMobileOpen(false)}>Tickets</NavLink>
            {(['Admin','Manager'].includes(user?.role) || user?.role === 'Submitter') && (
              <NavLink to="/tickets/new" className={navLinkClass} onClick={() => setMobileOpen(false)}>+ New Ticket</NavLink>
            )}
            {['Admin','Manager'].includes(user?.role) && (
              <>
                <NavLink to="/projects" className={navLinkClass} onClick={() => setMobileOpen(false)}>Projects</NavLink>
                <NavLink to="/admin" className={navLinkClass} onClick={() => setMobileOpen(false)}>Admin</NavLink>
              </>
            )}
          </div>
        )}
      </nav>

      {/* Page content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <Outlet />
      </main>

      {/* Footer */}
      {branding.show_powered_by && (
        <footer className="border-t border-gray-200 py-3 flex items-center justify-center gap-2 text-xs text-gray-400">
          <span>Powered by</span>
          <a href="https://hearnetech.com/apps" target="_blank" rel="noopener noreferrer">
            <img
              src="/hearne-logo.png"
              alt="Hearne Technologies"
              className="h-4 w-auto object-contain"
            />
          </a>
        </footer>
      )}
    </div>
  );
}
