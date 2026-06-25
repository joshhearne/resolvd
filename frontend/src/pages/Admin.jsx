import React, { useState, useEffect } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import PageShell from "../components/PageShell";

// Sub-nav schema. Items flagged manager:true show for both Admin + Manager;
// items without that flag are Admin-only. Groups with no manager-visible
// items hide entirely for Manager — they don't see group headers they
// can't act on. `keywords` is an optional list of search aliases — admins
// looking for a setting by its in-page label (e.g. "OOO", "reopen",
// "blocklist") get routed to the right page even when the nav label
// doesn't mention the term.
const NAV_GROUPS = [
  {
    label: "People",
    items: [
      { to: "/admin/users", label: "Users", manager: true, keywords: ["roles", "submitter", "tech", "manager", "admin role", "active inactive"] },
      { to: "/admin/companies", label: "Companies", manager: true, keywords: ["vendors", "contacts", "domain"] },
      { to: "/admin/support", label: "Support access", keywords: ["impersonate", "anthropic"] },
    ],
  },
  {
    label: "Workflow",
    items: [
      { to: "/admin/statuses", label: "Statuses", keywords: ["transitions", "mappings", "reopen", "gratitude", "auto-resolve", "OOO", "out of office", "automatic reply", "stale", "reply routing", "[ref]"] },
      { to: "/admin/sla", label: "SLA policies", manager: true, keywords: ["response", "resolution", "breach", "due", "warn"] },
      { to: "/admin/assignment", label: "Auto-assignment", manager: true, keywords: ["round robin", "load balance", "policy"] },
      { to: "/admin/escalations", label: "Escalations", manager: true, keywords: ["page", "oncall", "pager"] },
      { to: "/admin/forms", label: "Forms / Fields", manager: true, keywords: ["form", "category", "request type", "onboarding", "offboarding", "custom field", "computed", "template", "intake"] },
      { to: "/admin/custom-fields", label: "Assets / Fields", manager: true, keywords: ["dropdown", "metadata", "asset", "custom field", "inventory"] },
      { to: "/admin/canned-responses", label: "Canned responses", manager: true, keywords: ["macros", "snippets", "boilerplate"] },
      { to: "/admin/ticket-schedules", label: "Scheduled tickets", manager: true, keywords: ["recurring", "cron", "schedule"] },
      { to: "/admin/merge", label: "Merge tickets", keywords: ["dedupe", "combine"] },
      { to: "/admin/dedup-omit-rules", label: "Dedup omit rules", keywords: ["regex", "pattern", "duplicate", "inky", "phish", "report", "skip dedup", "automated"] },
    ],
  },
  {
    label: "Integrations",
    items: [
      { to: "/admin/ai-assist", label: "AI Assist", keywords: ["claude", "gpt", "openai", "rewrite", "summarize"] },
      { to: "/admin/alert-sources", label: "Integrations", keywords: ["zabbix", "alerts", "webhook", "monitor"] },
      { to: "/admin/software-aliases", label: "Software aliases", manager: true, keywords: ["asset normalization"] },
      { to: "/admin/inbound", label: "Inbound email", manager: true, keywords: ["unmatched queue", "discard", "spam"] },
      { to: "/admin/email-backends", label: "Email backends", keywords: ["smtp", "graph", "oauth", "gmail", "m365", "office 365"] },
      { to: "/admin/email-templates", label: "Email templates", keywords: ["notification body", "subject", "render"] },
      { to: "/admin/label-printer", label: "Label printer", keywords: ["consumables", "barcode", "print"] },
    ],
  },
  {
    label: "Site",
    items: [
      { to: "/admin/branding", label: "Branding", keywords: ["logo", "colors", "site name", "favicon"] },
      { to: "/admin/auth", label: "Authentication", keywords: ["sso", "saml", "login", "blocklist", "muted digest", "session", "unknown users"] },
      { to: "/admin/encryption", label: "Encryption", keywords: ["kms", "kek", "at rest", "blind index"] },
    ],
  },
  {
    label: "Data",
    items: [
      { to: "/admin/system-health", label: "System health", manager: true, keywords: ["jobs", "scheduler", "queue depth", "build", "version"] },
      { to: "/admin/export", label: "Export", manager: true, keywords: ["csv", "download", "backup"] },
    ],
  },
];

function filterBySearch(groups, term) {
  const q = term.trim().toLowerCase();
  if (!q) return groups;
  return groups
    .map((g) => {
      const groupHit = g.label.toLowerCase().includes(q);
      const items = g.items.filter((i) => {
        if (groupHit) return true;
        if (i.label.toLowerCase().includes(q)) return true;
        if (Array.isArray(i.keywords)) {
          for (const k of i.keywords) {
            if (k.toLowerCase().includes(q)) return true;
          }
        }
        return false;
      });
      return { ...g, items };
    })
    .filter((g) => g.items.length > 0);
}

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
  const [search, setSearch] = useState("");

  const groups = filterBySearch(filterForRole(user?.role), search);

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
          <div className="mb-4 relative">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search admin…"
              aria-label="Search admin sections"
              className="w-full bg-surface border border-border rounded-md pl-8 pr-7 py-1.5 text-sm placeholder:text-fg-dim focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand/60"
            />
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-dim text-sm pointer-events-none">⌕</span>
            {search && (
              <button
                onClick={() => setSearch("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-dim hover:text-fg text-sm"
              >
                ✕
              </button>
            )}
          </div>
          <nav className="space-y-5">
            {groups.length === 0 && (
              <div className="px-3 text-sm text-fg-muted italic">
                No matches for "{search}".
              </div>
            )}
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
