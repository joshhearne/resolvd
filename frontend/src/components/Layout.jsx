import React, { useState } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useBranding } from '../context/BrandingContext';

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
              <div className="flex items-center gap-2">
                {branding.logo_url && (
                  <img src={branding.logo_url} alt="Logo" className="h-7 w-auto object-contain" />
                )}
                <span className="font-bold text-lg tracking-tight">{branding.site_name || 'MOT Operations'}</span>
              </div>
              <div className="hidden md:flex items-center gap-1">
                <NavLink to="/dashboard" className={navLinkClass}>Dashboard</NavLink>
                <NavLink to="/tickets" className={navLinkClass}>Tickets</NavLink>
                {(user?.role === 'Admin' || user?.role === 'Submitter') && (
                  <NavLink to="/tickets/new" className={navLinkClass}>+ New Ticket</NavLink>
                )}
                {user?.role === 'Admin' && (
                  <>
                    <NavLink to="/projects" className={navLinkClass}>Projects</NavLink>
                    <NavLink to="/admin/users" className={navLinkClass}>Users</NavLink>
                    <NavLink to="/admin/branding" className={navLinkClass}>Branding</NavLink>
                    <NavLink to="/admin/export" className={navLinkClass}>Export</NavLink>
                  </>
                )}
              </div>
            </div>
            <div className="hidden md:block">
              <SearchBar />
            </div>
            <div className="flex items-center gap-3">
              <span className="hidden sm:block text-sm text-white/80">{user?.displayName}</span>
              <span className="hidden sm:block text-xs px-2 py-0.5 rounded bg-white/15 text-white/80">{user?.role}</span>
              <button onClick={logout} className="text-xs text-white/70 hover:text-white px-2 py-1 rounded hover:bg-white/15 transition-colors">
                Sign out
              </button>
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
            {(user?.role === 'Admin' || user?.role === 'Submitter') && (
              <NavLink to="/tickets/new" className={navLinkClass} onClick={() => setMobileOpen(false)}>+ New Ticket</NavLink>
            )}
            {user?.role === 'Admin' && (
              <>
                <NavLink to="/projects" className={navLinkClass} onClick={() => setMobileOpen(false)}>Projects</NavLink>
                <NavLink to="/admin/users" className={navLinkClass} onClick={() => setMobileOpen(false)}>Users</NavLink>
                <NavLink to="/admin/branding" className={navLinkClass} onClick={() => setMobileOpen(false)}>Branding</NavLink>
                <NavLink to="/admin/export" className={navLinkClass} onClick={() => setMobileOpen(false)}>Export</NavLink>
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
        <footer className="border-t border-gray-200 py-3 text-center text-xs text-gray-400">
          Powered by{' '}
          <span className="font-medium text-gray-500">Hearne Technologies</span>
        </footer>
      )}
    </div>
  );
}
