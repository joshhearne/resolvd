import React, { useState, useEffect } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import PageShell from "../components/PageShell";

// Sub-nav schema. Items flagged manager:true show for both Admin + Manager;
// items without that flag are Admin-only. Groups with no manager-visible
// items hide entirely for Manager — they don't see group headers they
// can't act on.
const NAV_GROUPS = [
  {
    label: "People",
    items: [
      { to: "/admin/users", label: "Users", manager: true },
      { to: "/admin/companies", label: "Companies", manager: true },
      { to: "/admin/support", label: "Support access" },
    ],
  },
  {
    label: "Workflow",
    items: [
      { to: "/admin/statuses", label: "Statuses" },
      { to: "/admin/sla", label: "SLA policies", manager: true },
      { to: "/admin/canned-responses", label: "Canned responses", manager: true },
      { to: "/admin/merge", label: "Merge tickets" },
    ],
  },
  {
    label: "Integrations",
    items: [
      { to: "/admin/ai-assist", label: "AI Assist" },
      { to: "/admin/alert-sources", label: "Alert sources" },
      { to: "/admin/inbound", label: "Inbound email", manager: true },
      { to: "/admin/email-backends", label: "Email backends" },
      { to: "/admin/email-templates", label: "Email templates" },
    ],
  },
  {
    label: "Site",
    items: [
      { to: "/admin/branding", label: "Branding" },
      { to: "/admin/auth", label: "Authentication" },
      { to: "/admin/encryption", label: "Encryption" },
    ],
  },
  {
    label: "Data",
    items: [
      { to: "/admin/system-health", label: "System health", manager: true },
      { to: "/admin/export", label: "Export", manager: true },
    ],
  },
];

function filterForRole(role) {
  const isAdmin = role === "Admin";
  return NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => isAdmin || i.manager),
  })).filter((g) => g.items.length > 0);
}

export default function Admin() {
  const { user } = useAuth();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const groups = filterForRole(user?.role);

  // Mobile: auto-close sidebar after route change.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const linkClass = ({ isActive }) =>
    `block px-3 py-2 text-sm rounded-md transition-colors ${
      isActive
        ? "bg-brand/10 text-brand font-medium"
        : "text-fg-muted hover:bg-surface-2 hover:text-fg"
    }`;

  const activeLabel = (() => {
    for (const g of groups) {
      const hit = g.items.find((i) => location.pathname.startsWith(i.to));
      if (hit) return hit.label;
    }
    return "Admin";
  })();

  return (
    <PageShell variant="wide">
      {/* Mobile header w/ hamburger. Sticky so the toggle stays reachable
          while scrolling a long admin page. */}
      <div className="md:hidden flex items-center justify-between mb-4">
        <button
          onClick={() => setMobileOpen((s) => !s)}
          className="btn btn-secondary btn-sm"
          aria-expanded={mobileOpen}
          aria-label="Toggle admin navigation"
        >
          ☰ {activeLabel}
        </button>
      </div>

      <div className="flex gap-6 items-start">
        {/* ── Sidebar ── */}
        {mobileOpen && (
          <div
            className="fixed inset-0 bg-black/40 z-40 md:hidden"
            onClick={() => setMobileOpen(false)}
          />
        )}
        <aside
          className={`
            ${mobileOpen ? "fixed inset-y-0 left-0 z-50 w-64 bg-surface border-r border-border p-4 overflow-y-auto" : "hidden"}
            md:block md:relative md:w-56 md:flex-shrink-0 md:bg-transparent md:border-0 md:p-0 md:sticky md:top-4
          `}
        >
          <div className="md:hidden flex items-center justify-between mb-3">
            <span className="font-semibold text-fg">Admin</span>
            <button
              onClick={() => setMobileOpen(false)}
              className="text-fg-muted hover:text-fg"
              aria-label="Close navigation"
            >
              ✕
            </button>
          </div>
          <nav className="space-y-5">
            {groups.map((g) => (
              <div key={g.label}>
                <div className="px-3 mb-1.5 text-[11px] uppercase tracking-wider font-semibold text-fg-dim">
                  {g.label}
                </div>
                <div className="space-y-0.5">
                  {g.items.map((i) => (
                    <NavLink
                      key={i.to}
                      to={i.to}
                      className={linkClass}
                      onClick={() => setMobileOpen(false)}
                    >
                      {i.label}
                    </NavLink>
                  ))}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        {/* ── Content pane ── */}
        <div className="flex-1 min-w-0">
          <Outlet />
        </div>
      </div>
    </PageShell>
  );
}
