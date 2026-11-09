import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import PageShell from "../components/PageShell";
import HelpScreenshot from "../components/HelpScreenshot";

// ── Constants ─────────────────────────────────────────────────────────────────

const ALL_ROLES = ["Admin", "Manager", "Tech", "Submitter", "Viewer", "Support"];
const PRIV = ["Admin", "Manager"];
const HANDLER = ["Admin", "Manager", "Tech"];

const ROLE_COLOR = {
  Admin:     "bg-purple-100 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 border-purple-300 dark:border-purple-800",
  Manager:   "bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-800",
  Tech:      "bg-sky-100 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border-sky-300 dark:border-sky-800",
  Submitter: "bg-green-100 dark:bg-green-950/40 text-green-700 dark:text-green-300 border-green-300 dark:border-green-800",
  Viewer:    "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600",
  Support:   "bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-800",
};

// ── Role pill ─────────────────────────────────────────────────────────────────

function RolePill({ role }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${ROLE_COLOR[role] || "bg-surface-2 text-fg border-border"}`}>
      {role}
    </span>
  );
}

// ── Access banners ────────────────────────────────────────────────────────────

function FullAccess() {
  return (
    <div className="flex items-center gap-2 text-xs text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-900/50 rounded-md px-3 py-2 mb-4">
      <span className="text-base">✓</span>
      Your role has full access to this section.
    </div>
  );
}

function PartialAccess({ note }) {
  return (
    <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 rounded-md px-3 py-2 mb-4">
      <span className="text-base mt-0.5">⚠</span>
      <span>{note}</span>
    </div>
  );
}

function NoAccess({ note }) {
  return (
    <div className="flex items-start gap-2 text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 rounded-md px-3 py-2 mb-4">
      <span className="text-base mt-0.5">✕</span>
      <span>{note}</span>
    </div>
  );
}

function OverrideNote() {
  return (
    <p className="text-xs text-fg-muted italic mt-3 border-t border-border pt-3">
      Exception: if an Admin assigned you a role override on a specific project (e.g. Manager), you gain elevated permissions within that project only — your global role is unchanged elsewhere.
    </p>
  );
}

// ── Feature row ───────────────────────────────────────────────────────────────

// roles: array of role names, or the string "all"
function Feature({ name, roles, note }) {
  const isAll = roles === "all" ||
    (Array.isArray(roles) && ALL_ROLES.every(r => roles.includes(r)));

  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-border last:border-0">
      <div className="flex-1 min-w-0">
        <span className="text-sm text-fg font-medium">{name}</span>
        {note && <p className="text-xs text-fg-muted mt-0.5 break-words">{note}</p>}
      </div>
      <div className="flex flex-col sm:flex-row sm:flex-wrap items-end sm:items-center gap-1 flex-shrink-0 sm:justify-end">
        {isAll
          ? <span className="text-xs text-fg-muted italic whitespace-nowrap">All roles</span>
          : (Array.isArray(roles) ? roles : [roles]).map(r => <RolePill key={r} role={r} />)
        }
      </div>
    </div>
  );
}

// ── Sections ──────────────────────────────────────────────────────────────────

function SectionOverview({ role }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-fg leading-relaxed">
        Internal issue-tracking system for managing requests, vendor communications, and support workflows.
        Access and capabilities depend on your global role, which may be further adjusted per-project by an Admin.
      </p>

      <h3 className="text-sm font-semibold text-fg">Role Summary</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-surface-2">
              <th className="border border-border px-3 py-2 text-left font-semibold text-fg">Role</th>
              <th className="border border-border px-3 py-2 text-left font-semibold text-fg">Description</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["Admin",     "Full system access including user management, encryption, and all admin settings."],
              ["Manager",   "Full ticket and project access; most admin settings. Cannot manage users or encryption."],
              ["Tech",      "Handler tier (v0.7.0). Edit any ticket in their projects, manage inventory assets, edit Knowledge Base articles, post handler-only notes, receive escalation pages. No org-config access."],
              ["Submitter", "Can submit tickets, comment, and view their own submissions. No admin or status controls."],
              ["Viewer",    "Read-only access to tickets. Cannot submit, comment, or take any action."],
              ["Support",   "Read-only access gated by a time-limited grant issued by an Admin. Every access is audit-logged."],
            ].map(([r, desc]) => (
              <tr key={r} className="hover:bg-surface-2/50">
                <td className="border border-border px-3 py-2 align-top"><RolePill role={r} /></td>
                <td className="border border-border px-3 py-2 text-fg-muted">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="text-sm font-semibold text-fg pt-1">Capability Matrix</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-surface-2">
              <th className="border border-border px-3 py-2 text-left font-semibold text-fg">Capability</th>
              {["Admin","Manager","Tech","Submitter","Viewer","Support"].map(r => (
                <th key={r} className="border border-border px-2 py-2 text-center font-semibold text-fg">{r}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              ["View tickets",              "✓","✓","✓","✓ (own)","✓","✓ (grant)"],
              ["Submit tickets",            "✓","✓","✓","✓","✗","✗"],
              ["Comment",                   "✓","✓","✓","✓","✗","✗"],
              ["Internal notes (handler)",  "✓","✓","✓","✗","✗","✗"],
              ["Change status",             "✓","✓","✓","✗","✗","✗"],
              ["Assign tickets",            "✓","✓","✓","✗","✗","✗"],
              ["Edit Knowledge Base",       "✓","✓","✓","✗","✗","✗"],
              ["Manage inventory assets",   "✓","✓","✓","✗","✗","✗"],
              ["Vendor contact management", "✓","✓","✗","✗","✗","✗"],
              ["Send vendor emails",        "✓","✓","✗","✗","✗","✗"],
              ["Manage projects",           "✓","✓","✗","✗","✗","✗"],
              ["Admin panel",               "✓","partial","✗","✗","✗","✗"],
              ["User management",           "✓","✗","✗","✗","✗","✗"],
              ["Encryption settings",       "✓","✗","✗","✗","✗","✗"],
            ].map(([cap, ...vals]) => (
              <tr key={cap} className="hover:bg-surface-2/50">
                <td className="border border-border px-3 py-1.5 text-fg">{cap}</td>
                {vals.map((v, i) => (
                  <td key={i} className={`border border-border px-2 py-1.5 text-center ${
                    v.startsWith("✓") ? "text-green-600 dark:text-green-400" :
                    v === "✗" ? "text-red-500 dark:text-red-400" :
                    "text-amber-600 dark:text-amber-400"
                  }`}>{v}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-surface-2 border border-border rounded-lg p-3 text-xs text-fg-muted space-y-1">
        <p className="font-semibold text-fg">Project-level role overrides</p>
        <p>
          An Admin can assign a <em>role_override</em> to any user on a specific project (e.g. give a Submitter Tech-level access within one project).
          The override only applies to that project — your global role is unchanged elsewhere.
          Valid project override roles: Admin, Manager, Tech, Submitter, Viewer.
        </p>
        <p>
          A separate <em>Agent</em> flag on each project member controls ticket assignability and access to handler-only features
          (Notes, escalation rotation, agent-mentions). Setting the override to Tech auto-ticks Agent; you can untick it afterwards
          if a Tech-level member should not receive assignments on this project.
        </p>
      </div>

      <div className="bg-surface-2 border border-border rounded-lg p-3 text-xs text-fg-muted space-y-1">
        <p className="font-semibold text-fg">Support role &amp; JIT access</p>
        <p>
          Support users cannot access any ticket data until an Admin issues a time-limited access grant via Admin → Support.
          Every view is recorded in the audit log. Grants expire automatically; Admins can revoke them early.
        </p>
      </div>
    </div>
  );
}

function SectionDashboard({ role }) {
  return (
    <div className="space-y-4">
      {["Viewer","Support"].includes(role)
        ? <PartialAccess note="You can view the dashboard but most widgets show data you have read-only access to." />
        : <FullAccess />
      }
      <p className="text-sm text-fg leading-relaxed">
        The Dashboard is your home screen — a live grid of status tiles, priority distribution chart,
        SLA card, Active alerts widget, My tasks card, Time-in-status report, plus Recent Activity and Pending Review.
        (v0.10.0) Every number on the page is a link: status tiles, priority bars, MTD breach cards, and the SLA
        cards each open the ticket list pre-filtered to exactly that set.
      </p>
      <HelpScreenshot src="/help/dashboard-overview.png?v=2" alt="Dashboard with status tiles, priority distribution, SLA card, and active alerts widget" />

      <h3 className="text-sm font-semibold text-fg pt-1">Global filters (v0.7.0)</h3>
      <p className="text-sm text-fg leading-relaxed">
        A single <b>Filters</b> button at the top-right opens a modal that drives <em>every</em> module on the page.
        Date range (7 / 30 / 60 / 90 / 180 / 365 / all-time), projects multi-select, internal-status multi-select.
        Selection persists across reloads. Active filters render as chips above the modules with × quick-clear
        and a Reset link. Replaces the old per-module date pickers.
      </p>

      <div className="space-y-0">
        <Feature name="Status tiles (Open / In Progress / etc.)" roles="all" note="(v0.10.0) Tiles are buckets, not 1:1 statuses — In Progress also counts Acknowledged; Awaiting Input adds On Hold + External Escalation; Flagged for Review adds Reopened; Closed adds Resolved. Ticket-list presets use the same sets." />
        <Feature name="Clickable drill-downs" roles="all" note="(v0.10.0) Priority bars, MTD breach cards, and SLA cards link to the ticket list with ?active=1 / ?sla=open|breached|mtd_response|mtd_resolve so the number and the list always agree." />
        <Feature name="My tasks card" roles="all" note="(v0.10.0) Overdue / Due today / Tomorrow from your personal tasks, with an inline complete checkbox. See Schedules + Tasks." />
        <Feature name="Vendor wait — per-vendor breakdown" roles={HANDLER} note="(v0.10.0) Hover the Vendor wait stat for each vendor's share; a pulsing dot marks vendors with a ticket currently paused on them." />
        <Feature name="Priority distribution bar chart" roles="all" />
        <Feature name="SLA — Month to date card" roles="all" note="MTD breach counts, currently breached, open w/ SLA clock, per-project breakdown. (v0.10.0) Live counts exclude closed legacy tickets and no longer double-count a ticket owing both response and resolve." />
        <Feature name="Active alerts widget" roles={HANDLER} note="Top 8 firing alerts from configured monitoring sources." />
        <Feature name="Time-in-status report" roles="all" note="Total + average + entry count per status, sourced from status_change audit." />
        <Feature name="Recent activity feed" roles="all" />
        <Feature name="Pending Review tile" roles={HANDLER} note="Tickets waiting on a handler review before close. Bypasses the dashboard status filter." />
        <Feature name="Global filter modal" roles="all" note="Date range, projects, statuses — applies to every module on the page." />
        <Feature name="Filter persistence" roles="all" note="Selection survives reload via localStorage.resolvd.dashboardFilters.v1." />
      </div>
      <div className="bg-surface-2 border border-border rounded-lg p-3 text-xs text-fg-muted space-y-1">
        <p className="font-semibold text-fg">Project scope intersection</p>
        <p>
          Submitter / Viewer requested <code>project_id</code> filters are intersected with their
          <code>project_members</code> set on the server — they can never widen past their access tier.
          Admin / Manager see everything by default.
        </p>
      </div>
    </div>
  );
}

function SectionTicketList({ role }) {
  const isHandler = HANDLER.includes(role);
  return (
    <div className="space-y-4">
      {isHandler
        ? <FullAccess />
        : role === "Submitter"
          ? <PartialAccess note="You can view tickets you submitted. Tickets in projects you're not a member of won't appear." />
          : <PartialAccess note="Read-only. You can view tickets you have access to but cannot take actions." />
      }
      <p className="text-sm text-fg leading-relaxed">
        The ticket list landing page is filter-driven (v0.7.0). The sidebar is your <b>Recently opened</b>
        history; the header is your filter surface. Default view: active (not Closed) · last 60 days · sort
        priority P1 → P5.
      </p>
      <HelpScreenshot src="/help/ticket-list-filters.png" alt="Ticket list with Mine quick-toggle, Filters modal button, breadcrumb chip summary, and Recently opened rail" />

      <h3 className="text-sm font-semibold text-fg pt-1">Header surface</h3>
      <div className="space-y-0">
        <Feature name="Mine quick-toggle" roles="all" note="One-click filter to tickets assigned to you, across every project + priority. Server resolves the `me` sentinel — saved-view URLs stay user-portable." />
        <Feature name="Filters modal" roles="all" note="Date range, projects multi, statuses multi, priorities multi, plus toggles: Mine / Active only / Flagged / Has fix / No fix. Sort selector for priority / updated / created." />
        <Feature name="Breadcrumb chip summary" roles="all" note="Plain-English line above the table describing the active filter set (e.g. 'Active · last 60d · all projects · P1/P2 reset')." />
        <Feature name="Saved views dropdown" roles="all" note="Save current filter set under a name, recall + delete from the dropdown." />
        <Feature name="Search by title / ref" roles="all" />
        <Feature name="+ New Ticket" roles={["Admin","Manager","Tech","Submitter"]} />
        <Feature name="Column picker" roles="all" note="Toggle ref / title / priority / internal / external / vendor ref / alert ref / blocker / flagged / updated columns. Per-user preference." />
        <Feature name="Bulk Edit (status / assignee / project)" roles={["Admin"]} note="Select up to 500 rows, change fields in one action. Per-ticket transaction so one failure doesn't roll back the batch." />
        <Feature name="Bulk reply (same comment to many tickets)" roles={PRIV} note="Mirror of bulk-status flow. Each post goes through the regular comment pipeline — @mentions resolve, follower notifications fire." />
      </div>

      <h3 className="text-sm font-semibold text-fg pt-1">Recently opened rail</h3>
      <p className="text-sm text-fg leading-relaxed">
        The left rail is a per-user log of the last 20 tickets you opened, deduped by id. Populated on row
        click <em>and</em> on ticket-detail mount, so deep-links from email or dashboard also fill the history.
        On mobile it lives behind a hamburger drawer.
      </p>

      <h3 className="text-sm font-semibold text-fg pt-1">URL deep-link presets</h3>
      <p className="text-sm text-fg leading-relaxed">
        Dashboard tiles + email links still work — <code>?preset=open|in_progress|awaiting_mot|pending_review|flagged|closed|mine|sla_breached</code> overlays the matching filter set once, then the URL param is stripped so subsequent filter changes don't re-overlay.
      </p>

      {!isHandler && <OverrideNote />}
    </div>
  );
}

function SectionNewTicket({ role }) {
  const canSubmit = ["Admin","Manager","Submitter"].includes(role);
  return (
    <div className="space-y-4">
      {canSubmit
        ? <FullAccess />
        : <NoAccess note="Your role cannot submit tickets. Viewer and Support roles have read-only access." />
      }
      {canSubmit && <>
        <p className="text-sm text-fg leading-relaxed">
          Submit a new ticket via <strong>+ New Ticket</strong> in the nav or the global <strong>New</strong> menu in the header. Title, description, impact, and urgency are the required inputs — the system computes a priority score automatically.
          (v0.10.0) Projects with custom forms add a <strong>Category → Form</strong> picker; the form decides which custom fields appear and which are required. See the Forms + Fields section.
        </p>
        <HelpScreenshot src="/help/new-ticket-form.png?v=3" alt="New ticket form with project picker, title, description, attachment dropzone, and impact / urgency selects" />
        <div className="space-y-0">
          <Feature name="Submit ticket" roles={["Admin","Manager","Submitter"]} />
          <Feature name="Markdown in description" roles={["Admin","Manager","Submitter"]} note="Full GFM: bold, italic, code blocks, lists, tables." />
          <Feature name="Set impact / urgency" roles={["Admin","Manager","Submitter"]} note="Determines computed priority P1–P5." />
          <Feature name="Attach files on creation" roles={["Admin","Manager","Submitter"]} />
          <Feature name="Duplicate detection" roles={["Admin","Manager","Submitter"]} note="System warns if a similar open ticket already exists." />
          <Feature name="Select project" roles={PRIV} note="Submitters are scoped to projects they belong to." />
          <Feature name="Assign to a user" roles={PRIV} note="Submitters cannot set the assignee at creation." />
          <Feature name="Pick a category + form" roles={["Admin","Manager","Submitter"]} note="(v0.10.0) Only shown when the project has forms. The category's default form is pre-selected. Agent-only fields stay hidden from the submitter; sensitive fields are masked once saved." />
          <Feature name="Deep-linkable new-ticket URLs" roles={["Admin","Manager","Submitter"]} note="(v0.10.0) /tickets/new/<project-prefix>/<category-slug>/<form-slug>?<field-slug>=<value> pre-selects the form and pre-fills fields. Admin → Forms has a shareable-link builder." />
          <Feature name="Computed fields" roles="all" note="(v0.10.0) Formula fields (e.g. a UPN derived from first + last name + domain) are evaluated on create — nothing to type." />
        </div>
        <OverrideNote />
      </>}
    </div>
  );
}

function SectionTicketDetail({ role }) {
  const isPriv = PRIV.includes(role);
  const canComment = ["Admin","Manager","Submitter"].includes(role);
  return (
    <div className="space-y-4">
      {isPriv
        ? <FullAccess />
        : canComment
          ? <PartialAccess note="You can view and comment. Status changes, vendor actions, and several fields are Admin/Manager only." />
          : <PartialAccess note="Read-only access. You can view tickets and comments but cannot post or take actions." />
      }
      <HelpScreenshot src="/help/ticket-detail-comments.png?v=2" alt="Ticket detail comment area with markdown composer, attach + canned-response controls, and a thread of vendor + internal comments" />

      <h3 className="text-sm font-semibold text-fg">Tabs (v0.7.0)</h3>
      <p className="text-sm text-fg leading-relaxed">
        Ticket detail is tabbed. <b>Comments</b> + the metadata sidebar are visible to anyone with access.
        <b> Notes</b> (handler-only — see the Notes section), <b>Runbook</b> (handler-only, see Knowledge Base),
        and <b>Resolution</b> appear for handlers (Admin / Manager / Tech globally, or anyone with a handler
        role override / Agent flag on the ticket's project).
        <b> Activity</b> shows the audit log. Knowledge-base suggestions surface on the Resolution tab (local KB) and
        in the Trove KB block (when the integration is on) when an article matches the ticket title.
      </p>

      <h3 className="text-sm font-semibold text-fg">Comments</h3>
      <div className="space-y-0">
        <Feature name="Read comments" roles="all" />
        <Feature name="Post a comment" roles={["Admin","Manager","Tech","Submitter"]} note="Supports markdown and @mentions." />
        <Feature name="@mention a user" roles={["Admin","Manager","Tech","Submitter"]} note="Dropdown scoped to project members. Triggers in-app and email notification." />
        <Feature name="Attach files to comment" roles={["Admin","Manager","Tech","Submitter"]} />
        <Feature name="Preview image attachments inline" roles="all" note="Image attachments render as thumbnails on the comment and Attachments tab. Click to open a fullscreen lightbox (Esc / click outside / × to close, Download button bottom-right)." />
        <Feature name="Vendor reply attachments" roles="all" note="Files attached to inbound vendor replies (subject [PREFIX-N]) are persisted to the ticket and linked to the reply comment, same as user-uploaded files. Vendor-attached files inherit the per-vendor pill color: image thumbs get a colored border, file pills get the full vendor color, and the Attachments tab shows a 'from VendorName' tag matching the comment header. Submitter-only inbound replies (matched via the admin queue) follow the same path." />
        <Feature name="Comment signature" roles="all" note="Optional sign-off appended to your comments, configured at Account Settings → Preferences → Comment signature. Markdown supported, 2000 char cap. Scope: vendor-visible comments only (default — keeps internal threads clean) or all comments. Separated from the body by a single blank line. Empty signature is a no-op even if the toggle is on." />
      </div>

      <HelpScreenshot src="/help/ticket-detail-image-lightbox.png" alt="Fullscreen image lightbox over a ticket — filename label top-left, Download button bottom-right, close × top-right" caption="Click any image attachment to open it fullscreen." />

      <HelpScreenshot src="/help/ticket-detail-edit-comment.png" alt="A comment in edit mode — textarea with the existing body, Save / Cancel buttons, hint text explaining AI provenance is cleared and vendor outbound is not re-sent" caption="Author / handler can edit a posted comment in-place." />

      <div className="space-y-0">
        <Feature name="Mark comment vendor-visible" roles={HANDLER} note="(v0.9.0) Any project handler can share a comment with the attached vendor contacts — same gate as Notes. Previously Admin / Manager only." />
        <Feature name="Insert canned response" roles={["Admin","Manager","Tech","Submitter"]} note="📋 popover next to the composer. Tags like {ticket.ref}, {submitter.firstName} render server-side at insert time." />
        <Feature name="Post & <any status>" roles={HANDLER} note="(v0.10.0) The Post & menu lists every internal status the ticket can transition to, including custom ones, and falls back to the full list when no transitions are configured. Admins curate it per status via the Post & menu toggle in Admin → Statuses." />
        <Feature name="Scope with knowledge (brief)" roles={HANDLER} note="(v0.10.0) Button on the composer assembles what the user reported, what the team said, your draft, project context, and matched Trove KB articles into a reviewable brief. Builds without AI by default; rewrite with AI when AI Assist allows it. Admin-managed noise rules keep SLA notices, moves, merges, and auto-replies out." />
        <Feature name="Show original email" roles={HANDLER} note="(v0.10.0) Inbound descriptions and comments keep the stripped source (signature, quoted history, M365 banners) behind a lazy-fetched toggle." />
        <Feature name="Edit a posted comment" roles={["Admin","Manager","Tech","Submitter"]} note="Author can edit own; Admin / Manager can edit anyone's. System comments and inbound vendor replies are locked. The Edit action only appears on the most recent non-system comment — once anyone posts a reply, the prior comment is frozen (post a follow-up correction instead). Editing clears AI provenance and is audited as comment_edited. The '(edited)' indicator only appears once a non-author has either viewed the original in the UI or been fanned out to via email — quick edits before anyone sees the comment stay silent. Vendor outbound is not re-sent." />
        <Feature name="Mute / delete comments" roles={PRIV} note="Muting hides vendor replies without deleting." />
      </div>

      <HelpScreenshot src="/help/ticket-detail-meta.png?v=2" alt="Ticket detail metadata panel — internal + external status, priority, assignee, followers, vendor contacts, blockers, and follow-up reminders" />
      <h3 className="text-sm font-semibold text-fg">Status &amp; Fields</h3>
      <div className="space-y-0">
        <Feature name="View status and all metadata" roles="all" />
        <Feature name="Edit title and description" roles={["Admin","Manager","Tech","Submitter"]} note="Submitters can only edit tickets they submitted." />
        <Feature name="Edit impact / urgency" roles={["Admin","Manager","Tech","Submitter"]} />
        <Feature name="Change internal status" roles={HANDLER} />
        <Feature name="One-click advance status" roles={HANDLER} note="Advances to the next logical status in the workflow." />
        <Feature name="Change external / vendor status" roles={PRIV} />
        <Feature name="Priority override" roles={HANDLER} note="Manually pin priority regardless of computed score." />
        <Feature name="Assign ticket" roles={HANDLER} note="(v0.10.0) Inline picker on the ticket header: assign to me, change, clear. Pool matches the project's assignment-policy pool." />
        <Feature name="Custom Fields card" roles={HANDLER} note="(v0.10.0) Form fields captured at create plus agent-only fields handlers fill in. Per-field or save-all. Sensitive values are revealed only to the handler editing them." />
        <Feature name="Trove KB block (when enabled)" roles="all" note="(v0.10.0) Linked articles (title + collection snapshotted), title-based suggestions from the project's mapped collection, search-to-link, and a Resolution draft built from matched passages + runbook steps. Internal articles are visible to project handlers only." />
        <Feature name="Vendor-reply auto-status" roles="all" note="(v0.10.0) On externally-engaged tickets an inbound vendor ack moves the external status to In Progress; a 'completed / resolved' reply moves external to Resolved and internal to Pending Review. Internal status is otherwise untouched so the ticket stays on your queue." />
        <Feature name="Print consumable delivery label" roles={HANDLER} note="(v0.10.0) Pick a consumable from the ticket (auto-matched from the alert tag or ticket text; ↻ Rescan re-runs the match). First print allocates one unit and logs the movement; reprints don't decrement. Refused at zero stock with a restock prompt." />
        <Feature name="Set blocker" roles={HANDLER} note="Block on another ticket or flag as awaiting team input." />
        <Feature name="Auto-resume on inbound reply" roles="all" note="A ticket in an `awaiting_input` status automatically transitions to `in_progress` when any inbound email reply lands on it (vendor reply or matched inbound queue entry). Audited as status_change_auto. (v0.10.0) Out-of-office auto-replies are excluded: they land as muted comments with no status change or fanout." />
        <Feature name="[REF] reply routing" roles="all" note="(v0.10.0) Any inbound mail carrying the ticket reference ([ACME-0042]) — vendor contact or internal participant — is appended to that ticket. An admin-set staleness threshold decides when an old ref falls through to a new ticket instead. Settings under Admin → Statuses." />
        <Feature name="Schedule follow-up reminder" roles={HANDLER} />
        <Feature name="Link asset (Inventory)" roles={HANDLER} note="Surfaces the asset hostname in place of an opaque id and feeds cross-project history on the asset detail page." />
        <Feature name="Resolution summary" roles={HANDLER} note="One-line summary captured at close time. Drives the 'Fix applied' ticket-list filter together with linked KB articles." />
      </div>

      <h3 className="text-sm font-semibold text-fg">Vendor &amp; Contacts</h3>
      <div className="space-y-0">
        <Feature name="View attached vendor contacts" roles={PRIV} />
        <Feature name="Attach / detach contacts" roles={PRIV} />
        <Feature name="Notify vendor manually" roles={PRIV} note="Sends a new-ticket or status email to all attached contacts." />
        <Feature name="Auto-mute vendor replies toggle" roles={PRIV} />
      </div>

      <h3 className="text-sm font-semibold text-fg">Followers, Merge &amp; Move</h3>
      <div className="space-y-0">
        <Feature name="Follow / unfollow ticket" roles={["Admin","Manager","Submitter"]} note="Followers receive email on new comments." />
        <Feature name="Manage followers (add/remove others)" roles={PRIV} />
        <Feature name="Move ticket to another project" roles={["Admin","Manager","Submitter"]} note="Re-issues a new ref from the target project." />
        <Feature name="Merge ticket into another" roles={PRIV} note="Reassigns all comments and history then closes this ticket." />
        <Feature name="Delete ticket" roles={["Admin"]} />
      </div>

      {!isPriv && <OverrideNote />}
    </div>
  );
}

function SectionProjects({ role }) {
  const isPriv = PRIV.includes(role);
  return (
    <div className="space-y-4">
      {isPriv
        ? <FullAccess />
        : <NoAccess note="The Projects section is not accessible with your current global role. Project membership controls which tickets you can see and submit — ask an Admin if you need to be added." />
      }
      {isPriv && <>
        <p className="text-sm text-fg leading-relaxed">
          Projects group tickets into logical workstreams. Each has its own reference prefix, member list, and optionally an external vendor workflow.
        </p>
        <HelpScreenshot src="/help/project-list.png" alt="Projects page with member counts, ticket counts, and the New project action" />
        <div className="space-y-0">
          <Feature name="View all projects" roles={PRIV} />
          <Feature name="Create / archive project" roles={PRIV} />
          <Feature name="Set project prefix and name" roles={PRIV} note="E.g. 'IT' → tickets become IT-0001, IT-0002…" />
          <Feature name="Manage project members" roles={PRIV} note="Add users; optionally assign a role override and/or Agent flag per user." />
          <Feature name="Set role override per member" roles={PRIV} note="Valid overrides: Admin, Manager, Tech, Submitter, Viewer. Elevates or restricts access within this project only." />
          <Feature name="Mark member as Agent" roles={PRIV} note="Eligible for ticket assignment, agent-mentions, escalation rotation, and handler-only features (e.g. Notes) on this project. Tech overrides auto-tick this." />
          <Feature name="Enable external vendor workflow" roles={PRIV} note="Unlocks external status field and vendor email features on all tickets in this project." />
        </div>
      </>}
    </div>
  );
}

function SectionAdmin({ role }) {
  const isAdmin = role === "Admin";
  const isManager = role === "Manager";
  return (
    <div className="space-y-4">
      {isAdmin
        ? <FullAccess />
        : isManager
          ? <PartialAccess note="Managers can access most Admin sections. User management, authentication settings, encryption, and support grants are Admin-only." />
          : <NoAccess note="The Admin panel requires Admin or Manager role." />
      }
      {(isAdmin || isManager) && <>
        <p className="text-sm text-fg leading-relaxed">
          System-wide configuration. The left-rail nav groups sections by area
          — <strong>People</strong>, <strong>Workflow</strong>, <strong>Integrations</strong>,
          <strong>Site</strong>, <strong>Data</strong> — and collapses into a hamburger
          drawer on mobile. Some sub-sections are Admin-only even for Managers. (v0.10.0) A search box above
          the nav filters pages by label, group, or keyword alias (try <code>OOO</code>, <code>blocklist</code>,
          <code>oauth</code>, <code>recurring</code>).
        </p>
        <HelpScreenshot src="/help/admin-left-rail-nav.png?v=2" alt="Admin panel left-rail navigation grouped into People, Workflow, Integrations, Site, and Data" />
        <div className="space-y-0">
          <Feature name="Users — invite, deactivate, reset passwords" roles={["Admin"]} note="Manager role cannot manage other users. (v0.10.0) Bulk select bar (refresh from directory, enable, disable), bulk Entra import, and auto-provision via Graph then Google Directory. auth_settings.allow_email_unknown_users gates the local fallback." />
          <Feature name="Forms / Fields — categories, forms, custom fields" roles={["Admin"]} note="(v0.10.0) Project-scoped category → form → field model. Per-form required flags, agent-only + sensitive fields, multiselect, computed (formula) fields, {field.<slug>} tags, deep-link builder. See the Forms + Fields section." />
          <Feature name="Schedules — recurring ticket templates" roles={["Admin"]} note="(v0.10.0) Daily / weekly / monthly / yearly presets or raw cron, timezone-aware, with an end condition. Each fire creates a real ticket; optionally starts a runbook run. See Schedules + Tasks." />
          <Feature name="Trove KB — knowledge base integration" roles={["Admin"]} note="(v0.10.0) Optional. Base URL, public URL, API key, per-collection Internal / Public / Hidden, webhook secret, hourly collection sync, Check for changes now, noise rules for briefs. Replace local KB is a separate, optional step — the built-in KB keeps working beside it. See Knowledge Base." />
          <Feature name="Dedup-omit rules — drop noisy inbound" roles={PRIV} note="(v0.10.0) Regex / literal rules that keep known-noise inbound mail from creating or touching tickets." />
          <Feature name="Companies — vendor / customer / internal directories" roles={PRIV} note="Three kinds: vendors keep project-scoped contacts; customers link to projects via a join table; internal companies model your org with members + auto-add domains for SSO first-login." />
          <Feature name="Statuses — workflow status configuration" roles={PRIV} note="Semantic tags, transitions, sort order. (v0.10.0) Per-status Post & menu toggle, [REF] reply-routing staleness threshold, and OOO suppression live here too." />
          <Feature name="Canned responses — reusable comment templates" roles={PRIV} note="Tag substitution ({ticket.ref}, {submitter.name}, etc) rendered server-side; project-scoped picker. (v0.9.0) Body editor is the same MarkdownEditor as the comment composer — write/preview tabs, formatting toolbar, AI rewrite. Hyperlinks via [label](url) render at display time." />
          <Feature name="Email Templates render markdown" roles={PRIV} note="(v0.9.0) Vendor outbound runs the template body through marked with a paragraph/list/heading/anchor allowlist; anchors get target=_blank + rel=noopener noreferrer. Raw HTML is sanitized out." />
          <Feature name="Merge tickets — search-driven duplicate consolidation" roles={PRIV} note="Two-slot picker by ref/title/description, swap-winner toggle, project locks to first pick." />
          <Feature name="Email Templates — outbound vendor email content" roles={PRIV} />
          <Feature name="Email Backends — SMTP / Graph / Gmail with project scope" roles={PRIV} note="Many-to-many account-to-project scoping for helpdesk routing." />
          <Feature name="Inbound email — parse replies into comments" roles={PRIV} />
          <Feature name="Inbound — agent-forwarded submissions" roles={PRIV} note="When an internal agent forwards an external email into a scoped inbox, Resolvd unwraps the forwarded headers and treats the inner sender as the submitter — not the forwarding agent. The agent becomes the auto-assignee and an audit entry records who forwarded on whose behalf. Standard `Begin forwarded message:` / `Forwarded message` / `Original Message` markers are detected. Inner sender must already be an active internal user; #PREFIX in the outer subject still routes the project." />
          <Feature name="Inbound — default landing project on multi-scope inboxes" roles={["Admin"]} note="Pick a fallback project for prefix-less mail when an inbox serves several projects. Auto-routes there instead of dropping to the manual queue. Single-scope inboxes already auto-route; the picker only appears when an inbox has 2+ approved + recv-enabled scopes." />
          <Feature name="Inbound — match by ticket ref" roles={PRIV} note="(v0.9.0) Admin → Inbound queue match flow accepts either a numeric id or a ticket reference (ACME-0042). Case-insensitive, ignores leading #." />
          <Feature name="Auto-provision Submitter accounts" roles={PRIV} note="(v0.9.0) Unknown senders arriving via inbound email or alert integrations mint a default Submitter user instead of falling to the manual queue. When Entra is configured, Graph /users/{email} populates display_name + entra_oid + upn so SSO works immediately. Vendor-domain senders are declined and land as contacts." />
          <Feature name="Label printer — Zebra :9100" roles={["Admin"]} note="(v0.9.0) Admin → Site → Label printer. Single-row config (host / port / dpi / media / top-offset / property-line). Print test button. Drives the Print label actions on asset + consumable detail pages. Raw TCP open with 800ms post-write hold." />
          <Feature name="Alert sources — Zabbix / Action1 / generic webhook" roles={PRIV} note="Registry-driven add form. Capabilities picker per source: alerts / inventory / software / vulnerabilities / companies. Tabular field-map editor for generic intake." />
          <Feature name="SLA policies — response + resolve targets" roles={PRIV} note="Per-priority defaults; per-project overrides. Default targets seeded P1 30m/4h … P5 1d/7d." />
          <Feature name="Business-hours policies" roles={PRIV} note="Per-project work windows (tz / days / start / end). SLA pauses outside business hours." />
          <Feature name="Escalation policies" roles={PRIV} note="Per-priority + per-project step chains on SLA triggers. Multi-action steps (notify_role / notify_assignee / reassign_role / reassign_agent / bump_priority). See the Escalation chains section." />
          <Feature name="Assignment policies" roles={PRIV} note="Per-project auto-assign on ticket create + on escalation reassign_agent. Round-robin / least-open-tickets / fixed." />
          <Feature name="Asset types" roles={PRIV} note="Per-type field schemas for Inventory (laptop / server / printer / generic). Sensitive fields land in the encrypted column." />
          <Feature name="Software aliases — canonical product names" roles={PRIV} note="Maps 'M365 Apps' / 'Office 365' / 'Microsoft 365 Apps for Enterprise' to one canonical product so reports don't fragment." />
          <Feature name="Custom fields" roles={PRIV} note="Per-entity (ticket / asset / consumable) custom fields: text / number / select / multiselect / date / boolean. Values stored separately keyed by entity id. (v0.10.0) Ticket fields moved under Forms / Fields; Assets / Fields and consumable defs stay here." />
          <Feature name="AI Assist — provider, model, project context" roles={PRIV} note="BYO-AI org config + per-user keys; rewrite surfaces on comments, descriptions, canned responses." />
          <Feature name="Authentication — MFA policy, SSO / Azure AD" roles={["Admin"]} />
          <Feature name="Branding — logo, site name, colors, locale defaults" roles={PRIV} />
          <Feature name="System health — scheduler heartbeats + DB / queue stats" roles={PRIV} note="Auto-refreshes every 30s; shows ok / stale / error / never_ran per scheduled job. Build info card at the top displays the running version / commit / built-at with a manual 'Check for updates' button that polls GitHub releases for the latest published tag (admin-triggered only — no background phone-home)." />
          <Feature name="Login security — failed-login forensics" roles={["Admin"]} note="Raw + per-IP / per-email aggregates. Backed by the per-IP block + dwell timer + honeypot pipeline." />
          <Feature name="Support — issue JIT access grants" roles={["Admin"]} note="Time-limited read grants for Support role users." />
          <Feature name="Export — full data export" roles={PRIV} />
          <Feature name="Encryption — field-level encryption keys" roles={["Admin"]} />
        </div>
      </>}
    </div>
  );
}

function SectionNotifications({ role }) {
  const canAct = ["Admin","Manager","Submitter"].includes(role);
  return (
    <div className="space-y-4">
      {canAct
        ? <FullAccess />
        : <PartialAccess note="You will receive in-app notifications if mentioned, but cannot post comments that would generate them for others." />
      }
      <p className="text-sm text-fg leading-relaxed">
        Notifications fan out across three channels — in-app (the bell tray), email, and browser push — for six event types: assignment, mention, comment, status change, pending review, follow-up reminder. A 6×3 matrix in <strong>Account → Preferences → Notifications</strong> lets you toggle each channel per event independently.
      </p>
      <HelpScreenshot src="/help/notifications-matrix.png?v=2" alt="Account → Preferences → Notifications — 6 event rows × 3 channel columns (in-app, email, push). Pending review and follow-up rows are greyed (always on)." />
      <p className="text-sm text-fg leading-relaxed">
        <strong>Pending review</strong> and <strong>follow-up reminder</strong> rows are locked-on: in-app + email always fire and bypass the digest cadence below. They're action-required events that shouldn't be silently batched.
      </p>
      <h3 className="text-sm font-semibold text-fg mt-3">Email digest cadence</h3>
      <p className="text-sm text-fg leading-relaxed">
        A dropdown next to the matrix picks how email notifications get delivered:
      </p>
      <ul className="text-sm text-fg leading-relaxed list-disc ml-5 space-y-0.5">
        <li><strong>Instant</strong> (default) — each event sends immediately.</li>
        <li><strong>Hourly</strong> — buffered, flushed at the next top-of-hour as one digest grouped by ticket.</li>
        <li><strong>12 hours</strong> — buffered, flushed at the next 00:00 / 12:00 in your local timezone.</li>
        <li><strong>Daily</strong> — buffered, flushed at 09:00 user-local.</li>
        <li><strong>Off</strong> — notification emails suppressed entirely; in-app + push still fire if those cells are on.</li>
      </ul>
      <p className="text-sm text-fg leading-relaxed">
        Empty buckets are skipped — no email at the boundary if nothing happened. Pending-review and follow-up bypass the cadence and always email instantly.
      </p>
      <HelpScreenshot src="/help/notification-tray.png" alt="Notification tray dropdown showing rows for all 6 event types" />

      <h3 className="text-sm font-semibold text-fg">Digest cadence + delivery hour</h3>
      <div className="space-y-0">
        <Feature name="Email digest cadence" roles="all" note="Instant / Hourly / 12h / Daily / Off. Daily groups events by ticket into a single email at your preferred local hour." />
        <Feature name="Daily digest delivery hour" roles="all" note="Pick the 24-hour local hour the daily digest fires (defaults to 09:00). Honors your timezone override if set." />
      </div>
      <div className="space-y-0">
        <Feature name="6×3 channel matrix" roles="all" note="Per-event toggles for in-app / email / push. Account → Preferences → Notifications." />
        <Feature name="Email digest cadence" roles="all" note="Instant / hourly / 12h / daily / off. Pending review + follow-up bypass." />
        <Feature name="In-app tray with all 6 event types" roles="all" note="Bell icon. Mention rows scroll-and-flash to the specific comment. (v0.10.0) Mention emails deep-link to the response too." />
        <Feature name="New-ticket fanout to Admins / Managers" roles={PRIV} note="(v0.10.0) Every create path — form, inbound email, alert promotion — notifies active Admins and Managers. In-app on, email off by default." />
        <Feature name="Browser push (opt-in)" roles="all" note="Requires permission per device. Mention defaults on; other events default off." />
        <Feature name="Mark all read" roles="all" />
        <Feature name="Auto-follow on comment + mention" roles={["Admin","Manager","Submitter"]} note="Posting a comment subscribes you to the ticket; being mentioned subscribes you." />
      </div>
    </div>
  );
}

function SectionSla({ role }) {
  const canManage = role === "Admin";
  return (
    <div className="space-y-4">
      {canManage ? <FullAccess /> : <PartialAccess note="You can see the SLA dashboard scoped to your projects. Tuning policies and managing breaches is Admin-only." />}
      <p className="text-sm text-fg leading-relaxed">
        Two clocks run on every ticket: <strong>response</strong> (closes when someone other than the submitter posts a non-system comment) and <strong>resolve</strong> (closes when the ticket reaches a resolved state). Targets come from the <code className="bg-surface px-1 rounded text-xs">sla_policies</code> table — an org-default per priority, with optional project-specific overrides.
      </p>
      <h3 className="text-sm font-semibold text-fg mt-3">Default targets</h3>
      <table className="text-sm border border-border rounded overflow-hidden">
        <thead className="bg-surface-2 text-xs text-fg-muted">
          <tr><th className="px-3 py-1 text-left">Priority</th><th className="px-3 py-1 text-left">Response</th><th className="px-3 py-1 text-left">Resolve</th></tr>
        </thead>
        <tbody className="divide-y divide-border">
          <tr><td className="px-3 py-1">P1</td><td className="px-3 py-1">30 min</td><td className="px-3 py-1">4 hrs</td></tr>
          <tr><td className="px-3 py-1">P2</td><td className="px-3 py-1">1 hr</td><td className="px-3 py-1">8 hrs</td></tr>
          <tr><td className="px-3 py-1">P3</td><td className="px-3 py-1">4 hrs</td><td className="px-3 py-1">24 hrs</td></tr>
          <tr><td className="px-3 py-1">P4</td><td className="px-3 py-1">8 hrs</td><td className="px-3 py-1">72 hrs</td></tr>
          <tr><td className="px-3 py-1">P5</td><td className="px-3 py-1">1 day</td><td className="px-3 py-1">7 days</td></tr>
        </tbody>
      </table>
      <p className="text-sm text-fg leading-relaxed">
        Tune them at <strong>Admin → SLA policies</strong>. A project override beats the org default for that priority.
      </p>
      <h3 className="text-sm font-semibold text-fg mt-3">Pause on blocker</h3>
      <p className="text-sm text-fg leading-relaxed">
        Both clocks pause when the ticket transitions into a status tagged <code className="bg-surface px-1 rounded text-xs">awaiting_input</code> or <code className="bg-surface px-1 rounded text-xs">on_hold</code> — vendor / customer wait time doesn't count against you. Resume on transition out shifts due-ats forward by the paused duration.
      </p>
      <h3 className="text-sm font-semibold text-fg mt-3">Breach + dashboard card</h3>
      <p className="text-sm text-fg leading-relaxed">
        A 5-minute scheduler flips the breached flag, stamps the breach timestamp, and fans out a notification (in-app + immediate email; bypasses digest cadence) to the assignee, followers, and submitter. The Dashboard <strong>SLA — Month to date</strong> card shows MTD response/resolve breach counts, current breaches, open clocks, plus a per-project breakdown. Admin/Manager see all projects; Submitter/Viewer see only their member projects.
      </p>
      <HelpScreenshot src="/help/sla-breach-card.png?v=2" alt="Dashboard SLA card — MTD breach stats and per-project breakdown table" />
      <div className="space-y-0">
        <Feature name="View SLA dashboard card" roles="all" note="Scoped to projects you can access." />
        <Feature name="Configure SLA policies" roles={["Admin"]} note="Admin → SLA policies. Per-priority defaults + project overrides." />
        <Feature name="Breach notifications" roles="all" note="Assignee, followers, and submitter receive in-app + immediate email on breach." />
        <Feature name="Pause-on-blocker" roles="all" note="Vendor / customer wait time excluded from the clock automatically." />
        <Feature name="Handler self-reply counts as first response" roles="all" note="(v0.10.0) When the submitter is also a handler (alert-promoted tickets), their reply still closes the response clock." />
        <Feature name="No response breach during Resolved grace" roles="all" note="(v0.10.0) Tickets that resolved before a manual reply no longer trip the response breach every tick." />
        <Feature name="Submitter breach notifications are opt-in" roles={["Admin"]} note="(v0.10.0) auth_settings.sla_notify_submitter_default is off by default; per-priority chains can opt in with a notify_submitter action." />
        <Feature name="Inbound + alert tickets stamp SLA on create" roles="all" note="(v0.10.0) Email- and alert-created tickets get their SLA policy and assignment inside the create transaction, honoring business hours." />
      </div>
    </div>
  );
}

function SectionAiAssist({ role }) {
  const isAdmin = role === "Admin";
  const eligibleForEli5 = ["Admin", "Manager"].includes(role);
  return (
    <div className="space-y-4">
      <FullAccess />
      <p className="text-sm text-fg leading-relaxed">
        Resolvd ships an integration surface for AI text rewriting. You bring the API key — your org's, or your personal one. A ✨ AI button shows up on every composer: internal comment, vendor comment, ticket title, ticket description, canned response body, project description, admin email templates.
      </p>
      <h3 className="text-sm font-semibold text-fg mt-3">Per-user setup</h3>
      <p className="text-sm text-fg leading-relaxed">
        Go to <strong>Account → Preferences → AI Assist</strong>. Pick a provider (OpenAI, Anthropic, Ollama), follow the helper banner's link to the provider's key console, paste the key, pick a model (or hit <strong>Refresh from provider</strong> to fetch the live model list), and toggle <strong>Enable AI Assist</strong>. Test connection verifies everything works.
      </p>
      <HelpScreenshot src="/help/ai-prefs-card.png?v=2" alt="Account → Preferences → AI Assist card — provider dropdown, helper banner with provider console link, endpoint + model + masked API key, default tone/verbosity, Test connection button" />
      <h3 className="text-sm font-semibold text-fg mt-3">Using the rewrite button</h3>
      <p className="text-sm text-fg leading-relaxed">
        Type a draft, click ✨ AI, pick tone (neutral / formal / friendly / polite / apologetic / terse / funny) and verbosity (short / functional / verbose), hit <strong>Rewrite</strong>. Preview shows side-by-side with the original; <strong>Apply</strong> commits, <strong>Re-roll</strong> generates a new variant, <strong>Cancel</strong> discards.
      </p>
      <HelpScreenshot src="/help/ai-rewrite-modal.png?v=2" alt="AI rewrite modal — provider/model/token badge in the header, tone + verbosity selectors, side-by-side original / rewritten panes, Apply / Re-roll / Cancel" />
      {eligibleForEli5 && (
        <p className="text-sm text-fg leading-relaxed">
          <strong>ELI5 mode</strong> (Admin/Manager only) — rewrites for a non-technical reader: replaces jargon, expands acronyms on first use, explains technical concepts in plain terms.
        </p>
      )}
      <h3 className="text-sm font-semibold text-fg mt-3">Usage badge + clipboard</h3>
      <p className="text-sm text-fg leading-relaxed">
        After posting a comment or ticket description with an AI rewrite applied, a compact ✨ AI pill renders inline next to the timestamp. Hover for the full readout — provider, model, tokens, tone, verbosity, project context flag. Click to copy the metadata block to your clipboard.
      </p>
      <HelpScreenshot src="/help/ai-badge-popover.png?v=2" alt="Compact AI badge in comment header showing a popover with provider/model/tokens/tone/verbosity readout" />
      {isAdmin && (
        <>
          <h3 className="text-sm font-semibold text-fg mt-3">Admin org-managed AI</h3>
          <p className="text-sm text-fg leading-relaxed">
            <strong>Admin → Integrations → AI Assist</strong> is a three-section page:
          </p>
          <ul className="text-sm text-fg leading-relaxed list-disc ml-5 space-y-1">
            <li><strong>Integration</strong> — set an org provider/endpoint/model + encrypted org API key. Test connection.</li>
            <li><strong>Permissions</strong> — enable feature org-wide, lock users to org config (forces every user onto the same provider), or allow user BYOK (personal credentials override the org config). Picks the usage badge disclosure tier (author + Admin / Admin only / all internal users — vendors never see).</li>
            <li><strong>Project contexts</strong> — pick a project, paste a markdown glossary (sites, integrations, lingo). Up to 8000 chars. Gets prepended to every AI rewrite fired from a ticket in that project so the model knows your project's terms verbatim.</li>
          </ul>
          <HelpScreenshot src="/help/admin-ai-integration.png?v=2" alt="Admin → AI Assist → Integration pane — provider dropdown, console deep link, endpoint + model picker, masked API key, Lock + BYOK toggles, Test connection" />
          <HelpScreenshot src="/help/admin-ai-permissions.png?v=2" alt="Admin → AI Assist → Permissions pane — enabled, lock-to-org, allow BYOK, project context toggle, disclosure audience dropdown" />
          <HelpScreenshot src="/help/admin-ai-project-contexts.png?v=2" alt="Admin → AI Assist → Project contexts — master-detail view with project list on left, markdown context editor on right" />
        </>
      )}
      <div className="space-y-0">
        <Feature name="AI rewrite on any composer" roles="all" note="✨ AI button on comments, ticket title/description, canned responses, project description, admin email templates." />
        <Feature name="Tone + verbosity selectors" roles="all" note="7 tones × 3 verbosities. Default values configurable in Account Preferences." />
        <Feature name="ELI5 mode" roles={["Admin","Manager"]} note="Rewrites for non-technical readers. Restricted to Admin/Manager." />
        <Feature name="Project context glossary" roles="all" note="Admin-authored per-project markdown blob ships with rewrites in that project's tickets." />
        <Feature name="Usage disclosure badge" roles="all" note="Inline ✨ AI pill on AI-rewritten posts. Hover for details, click to copy." />
        <Feature name="Publish my AI usage" roles="all" note="Per-user opt-in to make own AI badge org-wide visible — for cost transparency when on personal keys." />
        <Feature name="Lifetime AI token ledger" roles="all" note="Small 3-cell card on Account → Preferences → AI Assist showing total calls, input tokens, output tokens across your comments + tickets. Snapshot at apply time — edits / deletes don't subtract." />
        <Feature name="Admin org AI integration" roles={["Admin"]} note="Admin → Integrations → AI Assist. Configure org provider + lock + audience tier." />
      </div>
    </div>
  );
}

function SectionSecurity({ role }) {
  const isAdmin = role === "Admin";
  return (
    <div className="space-y-4">
      {isAdmin ? <FullAccess /> : <PartialAccess note="Login protections apply to everyone. Forensics views are Admin-only." />}
      <p className="text-sm text-fg leading-relaxed">
        Login protections layer in front of the password check:
      </p>
      <ul className="text-sm text-fg leading-relaxed list-disc ml-5 space-y-1">
        <li><strong>Argon2id</strong> hashing on every stored password.</li>
        <li><strong>Per-user lockout</strong> — 8 failed attempts locks the account for 15 minutes.</li>
        <li><strong>IP rate limit</strong> — 8 login attempts per 15-minute window per IP. Successful logins don't count against the budget.</li>
        <li><strong>Persistent IP blocking</strong> — an IP with 20+ failures in 24 hours is refused for 1 hour past its most recent failure. Catches credential stuffing that rotates across rate-limit windows.</li>
        <li><strong>Bot detection</strong> — invisible honeypot field on the login form + sub-800ms form-dwell timer. Either trip refuses with the same 429 a rate limit would return (no bot-distinguishable feedback).</li>
        <li><strong>Session regeneration</strong> on every successful login — closes the session fixation gap.</li>
        <li><strong>Response security headers</strong> — Content-Security-Policy, HSTS (when behind HTTPS), X-Frame-Options DENY, Referrer-Policy, Permissions-Policy.</li>
      </ul>
      {isAdmin && (
        <>
          <h3 className="text-sm font-semibold text-fg mt-3">Forensics endpoints</h3>
          <p className="text-sm text-fg leading-relaxed">
            Two admin-only endpoints expose the <code className="bg-surface px-1 rounded text-xs">login_attempts</code> audit trail:
          </p>
          <ul className="text-sm text-fg leading-relaxed list-disc ml-5 space-y-0.5">
            <li><code className="bg-surface px-1 rounded text-xs">GET /api/security/login-attempts?since=&amp;limit=</code> — raw recent log</li>
            <li><code className="bg-surface px-1 rounded text-xs">GET /api/security/login-attempts/summary</code> — per-IP + per-email aggregates, sorted by failures DESC</li>
          </ul>
          <p className="text-sm text-fg leading-relaxed">
            A dedicated Admin → Security page is coming next — for now, hit the endpoints directly when investigating an incident.
          </p>
        </>
      )}
      <div className="space-y-0">
        <Feature name="Argon2id password hashing" roles="all" />
        <Feature name="8-failure lockout per account" roles="all" note="15-minute auto-unlock." />
        <Feature name="IP rate limit + persistent block" roles="all" note="8/15min window + 20-failures/24h block." />
        <Feature name="Honeypot + form dwell bot detection" roles="all" />
        <Feature name="Login attempt forensics" roles={["Admin"]} note="GET /api/security/login-attempts and /summary." />
      </div>
    </div>
  );
}

function SectionMentions({ role }) {
  const canComment = ["Admin","Manager","Submitter"].includes(role);
  return (
    <div className="space-y-4">
      {canComment
        ? <FullAccess />
        : <PartialAccess note="You can receive mention notifications but cannot post comments to trigger mentions for others." />
      }
      <p className="text-sm text-fg leading-relaxed">
        Type <code className="bg-surface px-1 rounded text-brand text-xs">@</code> in any comment box to trigger the mention autocomplete.
        Results are scoped to members of the ticket's project.
      </p>
      <HelpScreenshot src="/help/mentions-autocomplete.png" alt="Comment composer with @mention autocomplete dropdown filtered to project members" />
      <div className="space-y-0">
        <Feature name="Trigger @mention autocomplete" roles={["Admin","Manager","Submitter"]} note="Scoped to current project's members." />
        <Feature name="Arrow keys / Enter / Right arrow to select" roles={["Admin","Manager","Submitter"]} />
        <Feature name="Receive mention notification" roles="all" />
        <Feature name="Auto-follow on mention" roles={["Admin","Manager","Submitter"]} note="Mentioned user is automatically added as a ticket follower." />
      </div>
    </div>
  );
}

function SectionMarkdown({ role }) {
  const canEdit = ["Admin","Manager","Submitter"].includes(role);
  return (
    <div className="space-y-4">
      {canEdit
        ? <FullAccess />
        : <PartialAccess note="Markdown is rendered when you view comments and descriptions, but you cannot post or edit." />
      }
      <p className="text-sm text-fg leading-relaxed">
        Comments and descriptions support GitHub Flavored Markdown. The editor has Write and Preview tabs plus a formatting toolbar with keyboard shortcuts.
      </p>
      <HelpScreenshot src="/help/markdown-toolbar.png?v=2" alt="Markdown comment composer with formatting toolbar (bold, italic, code, list, link, attach)" />
      <h3 className="text-sm font-semibold text-fg pt-1">Keyboard shortcuts</h3>
      <div className="grid grid-cols-2 gap-x-6 gap-y-0 text-xs">
        {[
          ["Bold","Ctrl+B"],
          ["Italic","Ctrl+I"],
          ["Inline code","Ctrl+`"],
          ["Post comment","Ctrl+Enter"],
        ].map(([label, shortcut]) => (
          <div key={label} className="flex justify-between border-b border-border py-1.5">
            <span className="text-fg">{label}</span>
            <code className="text-fg-muted font-mono">{shortcut}</code>
          </div>
        ))}
      </div>
      <h3 className="text-sm font-semibold text-fg pt-2">Toolbar-only tools</h3>
      <p className="text-xs text-fg-muted">Code block, Heading, Bullet list, Numbered list, Blockquote, Link.</p>
      <p className="text-xs text-fg-muted mt-1">
        On mobile the toolbar shows Bold, Italic, Code, Code Block, and Bullet List only. Full toolbar at <code className="font-mono">sm:</code> breakpoint and wider.
      </p>
      <HelpScreenshot src="/help/markdown-rendered.png" alt="Comment rendered after submission — bold, italic, code, lists, links, and embedded attachments" />
      <p className="text-xs text-fg-muted">
        Supported: <strong className="text-fg">**bold**</strong>, <em className="text-fg">_italic_</em>,{" "}
        <code className="bg-surface px-1 rounded text-brand">`code`</code>, fenced code blocks, #&nbsp;headings, lists, &gt;&nbsp;blockquotes, tables, [links](url).
      </p>
    </div>
  );
}

function SectionSupport({ role }) {
  const isAdmin = role === "Admin";
  return (
    <div className="space-y-4">
      {isAdmin
        ? <FullAccess />
        : role === "Support"
          ? <PartialAccess note="Your access is read-only and requires an active time-limited grant. Every view is audit-logged." />
          : <NoAccess note="Support grant management is Admin-only. If you have the Support role, ask an Admin to issue a grant." />
      }
      <p className="text-sm text-fg leading-relaxed">
        The Support role provides tightly controlled read-only access for external support personnel. Access is granted just-in-time by an Admin, expires automatically, and every ticket view is recorded.
      </p>
      <HelpScreenshot src="/help/admin-support-grants.png" alt="Admin Support grants page — pending requests, active grants with expiry timers, and the issue-grant action" />
      <div className="space-y-0">
        <Feature name="Issue support grant (set duration + scope)" roles={["Admin"]} />
        <Feature name="Revoke active grant early" roles={["Admin"]} />
        <Feature name="View audit log of support reads" roles={["Admin"]} />
        <Feature name="Read tickets within grant scope" roles={["Support"]} note="Requires an active, non-expired grant. Revoked grants block access immediately." />
      </div>
    </div>
  );
}

function SectionAccount({ role }) {
  return (
    <div className="space-y-4">
      <FullAccess />
      <p className="text-sm text-fg leading-relaxed">
        Access via your avatar menu (top right) → Account Settings.
      </p>
      <HelpScreenshot src="/help/account-settings.png" alt="Account settings with Profile, Password, MFA, and Preferences tabs" />
      <div className="space-y-0">
        <Feature name="Profile — name, display name, avatar" roles="all" />
        <Feature name="Password — change password" roles="all" note="Not available if SSO is your only login method." />
        <Feature name="MFA — enroll TOTP authenticator" roles="all" note="May be required by your Admin's policy." />
        <Feature name="Preferences — behavior toggles" roles="all" note="Compact mode, Ctrl+Enter to post, auto-follow on comment, email notification preferences." />
        <Feature name="Preferences — comment signature" roles="all" note="Markdown sign-off appended to your comments; scope vendor-only (default) or all. 2000-char cap with a live counter." />
        <Feature name="Sessions + SSO return" roles="all" note="(v0.10.0) Sessions are a 30-day rolling window instead of a fixed 8 hours. After a Microsoft login you land on the page you asked for, not the dashboard." />
      </div>
    </div>
  );
}

// ── Section registry ──────────────────────────────────────────────────────────

function SectionNotes({ role }) {
  const isHandler = HANDLER.includes(role);
  return (
    <div className="space-y-4">
      {isHandler
        ? <FullAccess />
        : <PartialAccess note="Notes are handler-tier. You'll see the Notes tab on tickets in projects where an Admin has given you a Tech / Manager / Admin role override OR ticked the Agent flag for you. Otherwise the tab is hidden." />}
      <p className="text-sm text-fg leading-relaxed">
        Every ticket carries a <b>Notes</b> tab visible only to handlers — global Admin / Manager / Tech, or any user
        elevated on the ticket's project (role override of Admin / Manager / Tech, or the Agent flag).
        Notes never reach the submitter or vendor — they're a triage / shift-handoff scratchpad separate from the
        comment thread.
      </p>
      <div className="space-y-0">
        <Feature name="Post handler-only note" roles={HANDLER} note="Also available to lower-tier users with a project-level handler override or Agent flag on the ticket's project." />
        <Feature name="@mention project agents" roles={HANDLER} note="Mentions resolve only against active agents on the ticket's project." />
        <Feature name="Read notes" roles={HANDLER} note="Plus per-project handler overrides + Agent-flagged members on the ticket's project." />
        <Feature name="Edit a posted note" roles={HANDLER} note="Author edits own; Admin / Manager can edit anyone's. Always shows an '(edited)' indicator on change — no distribution gating because notes are handler-only by definition. Audited as note_edited." />
        <Feature name="Notes visible to submitter / vendor" roles={[]} note="Never. By design — notes don't fan out via email or push to non-handlers." />
      </div>
    </div>
  );
}

function SectionConsumables({ role }) {
  const isHandler = HANDLER.includes(role);
  return (
    <div className="space-y-4">
      {isHandler ? <FullAccess /> : <NoAccess note="Consumables is handler-only — same as Inventory." />}
      <p className="text-sm text-fg leading-relaxed">
        <b>Consumables</b> tracks supply inventory — toner, drums, batteries, spare keyboards, anything
        interchangeable that Inventory shouldn't store per-serial. Stock changes always run UPDATE + ledger INSERT in
        the same transaction so every adjustment carries actor + reason + timestamp.
      </p>
      <HelpScreenshot src="/help/consumables-list.png?v=2" alt="Consumables list with low-stock chips and archive toggle" />
      <div className="space-y-0">
        <Feature name="View consumables list" roles={HANDLER} note="Search box, low-stock chip, archive toggle, per-vendor counts." />
        <Feature name="Create / edit / archive a consumable" roles={HANDLER} note="part_no unique. vendor_company_id links to a vendor for reorder context." />
        <Feature name="Adjust stock with reason + note" roles={HANDLER} note="POST /:id/move atomic; reasons: received / issued / returned / disposed / count_correction / loss. ticket_id optional — link an issuance back to the ticket that consumed it." />
        <Feature name="Per-item ledger" roles={HANDLER} note="Newest-first list of every movement. Append-only — corrections happen via a new count_correction row, not by editing history." />
        <Feature name="Low-stock badge + comment" roles={HANDLER} note="Red chip when current_stock <= low_stock_threshold. (v0.10.0) Crossing the line during a ticket dispatch posts a 🟡 system comment on that ticket." />
        <Feature name="Print consumable label" roles={HANDLER} note="Zebra :9100. Lead line = part_no, vendor on the property line, QR encodes /consumables/<id> deep-link. (v0.10.0) A standalone shelf label prints the location line for bin / shelf marking." />
        <Feature name="Allocation on delivery-label print" roles={HANDLER} note="(v0.10.0) Printing a delivery label from a ticket locks the row, decrements by 1, and logs a movement with host + date. Reprints log a zero-delta movement. At zero stock the print is refused (409), a system comment lands on the ticket, and Admins get a restock notification." />
        <Feature name="Restock workflow" roles={HANDLER} note="(v0.10.0) purchase_url, vendor_part_no, is_metered, reorder_qty, and location per consumable. The restock notification carries the right CTA — purchase link for self-serve, vendor contact copy for metered. Two canned responses are seeded under consumable_restock with {consumable.*} / {vendor.*} tags." />
        <Feature name="Alert-time stock match" roles={HANDLER} note="(v0.10.0) Alert ingest matches a part.number tag against consumables at promotion time and posts a system comment for unmatched / out-of-stock / low cases before anyone tries to print." />
      </div>
    </div>
  );
}

function SectionInventory({ role }) {
  const isHandler = HANDLER.includes(role);
  return (
    <div className="space-y-4">
      {isHandler ? <FullAccess /> : <NoAccess note="Inventory is handler-only (v0.9.0). Ask an Admin to grant you Tech or a project-level role override / Agent flag if you need access." />}
      <p className="text-sm text-fg leading-relaxed">
        <b>Inventory</b> is Resolvd's CMDB-lite — every managed endpoint (laptop, server, printer, network device)
        appears as an <b>asset</b> with per-type fields. Tickets can link to an asset so its hostname appears in
        place of an opaque ID and so cross-project history per endpoint shows up on the asset detail page.
      </p>
      <HelpScreenshot src="/help/inventory-list.png" alt="Inventory list with asset types, last-seen badges, and the offline filter" />
      <div className="space-y-0">
        <Feature name="View inventory list" roles={HANDLER} />
        <Feature name="Filter offline (>14 days no check-in)" roles={HANDLER} />
        <Feature name="Create / edit / archive assets" roles={HANDLER} />
        <Feature name="Per-type field schemas" roles={HANDLER} note="Admin → Asset types defines which fields each type carries (laptop, server, printer, generic)." />
        <Feature name="On-demand software sync" roles={HANDLER} note="Computer-type assets sourced from Action1 expose a 'Pull software inventory now' button on the asset detail page." />
        <Feature name="Asset tag" roles={HANDLER} note="Operator-facing inventory ID (v0.9.0) distinct from the OS hostname. Admin-owned, survives RMM syncs (COALESCE on update). Printed as the lead line on asset labels." />
        <Feature name="Custody log — check-out / check-in" roles={HANDLER} note="Per-asset possession trail (v0.9.0). One row per check-out / check-in pair with separate holder + actor + free-text notes. Partial unique index enforces one active checkout per asset. linked_user_id auto-tracks the active holder." />
        <Feature name="Print asset label" roles={HANDLER} note="Zebra :9100 raw TCP. Lead line = asset_tag, hostname only if distinct, then property-line. QR encodes the inventory deep-link so an iPhone scan opens the right row. Configure via Admin → Site → Label printer." />
        <Feature name="Cross-project ticket history" roles={HANDLER} note="Asset detail lists every ticket that linked this asset, across every project the viewer has access to." />
        <Feature name="Vulnerability + patch counts" roles={HANDLER} note="Pulled from the source's reports endpoint when the source has the 'vulnerabilities' capability enabled." />
        <Feature name="CSV export" roles={HANDLER} />
      </div>
      <div className="bg-surface-2 border border-border rounded-lg p-3 text-xs text-fg-muted space-y-1">
        <p className="font-semibold text-fg">Action1 / generic RMM sync</p>
        <p>
          Action1 sources with the <em>Feed inventory module</em> capability turned on poll their REST API for endpoint
          inventory. Hudu-style org→company mapping handles the MSP silo case where one Action1 tenant feeds multiple
          Resolvd companies. <em>Software-name normalization</em> via Admin → Software aliases keeps reports from
          fragmenting across "Microsoft 365 Apps for Enterprise" / "M365" / "Office 365".
        </p>
      </div>
    </div>
  );
}

function SectionKb({ role }) {
  const isHandler = HANDLER.includes(role);
  return (
    <div className="space-y-4">
      {isHandler ? <FullAccess /> : <PartialAccess note="You can read published local articles in projects you're a member of, and public Trove KB collections if the integration is on. Authoring, internal collections, briefs, and the Trove KB staff UI are handler / Admin only." />}
      <p className="text-sm text-fg leading-relaxed">
        Resolvd ships a <b>built-in Knowledge Base</b>: per-project rich-text articles on the BlockNote editor with
        version history, tags, agent-only visibility, and runbook checklists. (v0.10.0) It can also read
        <a href="https://trove-kb.com/" target="_blank" rel="noopener noreferrer" className="text-brand underline"> Trove KB</a>,
        our documentation platform, as an optional integration. Three ways to run it: local only (the default — nothing
        changes on upgrade), local and Trove KB <em>side by side</em>, or Trove KB only after an Admin runs
        <b> Replace local KB</b>. Either way, Resolvd keeps the ticket-side state: links, runbook step progress,
        resolution drafts, briefs.
      </p>
      <HelpScreenshot src="/help/kb-index.png?v=3" alt="Knowledge Base landing page listing local project KBs, with Trove KB collections above when the integration is on" />

      <h3 className="text-sm font-semibold text-fg">Built-in KB</h3>
      <div className="space-y-0">
        <Feature name="Browse project articles" roles="all" />
        <Feature name="Tag filter chips (AND across tags)" roles="all" />
        <Feature name="Create / edit / archive articles" roles={HANDLER} />
        <Feature name="Agent-only article visibility" roles={HANDLER} note="Toggle on an article to restrict both read AND write to project handlers — same gate as Notes. Non-handlers don't see the article in lists, suggestions, or ticket links. Only a global Admin can delete an agent-only article." />
        <Feature name="Runbook kind (checklist articles)" roles={HANDLER} note="Set Kind=Runbook to mark an article as a step-by-step checklist. Any @canned:<title> token inside a step becomes a clickable pill on the ticket Runbook tab. Boxes persist per ticket so handoffs resume where the last handler left off." />
        <Feature name="Version history + restore" roles={HANDLER} note="Every save snapshots a version with optional change_summary; restore writes a fresh version marked 'Restored from vN'." />
        <Feature name="Promote ticket to KB" roles={PRIV} note="Drafts a new article seeded from the ticket title + description + resolution_summary. Lands in the local KB, or in Trove KB as an internal-only draft when the project is mapped to a collection." />
        <Feature name="Suggested article on ticket open" roles="all" note="pg_trgm ranker over title + tags + keywords. Auto-surfaces high-confidence matches; manual picker for the long tail." />
      </div>

      <h3 className="text-sm font-semibold text-fg">Trove KB integration (v0.10.0, optional)</h3>
      <p className="text-sm text-fg leading-relaxed">
        Configure at <b>Admin → Integrations → Trove KB</b>: base URL, API key, per-collection Internal / Public / Hidden.
        Trove KB owns that content; Resolvd reads it over REST and decides who sees what. Project ↔ collection mapping
        lives in <b>Admin → AI Assist → Project contexts</b>.
      </p>
      <div className="space-y-0">
        <Feature name="Browse collections" roles="all" note="Collections appear on /kb above the local project cards. A collection opens to a category / subcategory rail with counts, an Articles / Runbooks type filter, cards-or-list view remembered per browser, sort, and a scoped search. Articles render as Markdown at /kb/article/<id>." />
        <Feature name="Favorites + helpful votes" roles="all" note="Stored under your email in Trove KB, so a star here is the same star on the public Trove KB site. /kb lists My favorites." />
        <Feature name="Link Trove KB articles to a ticket" roles="all" note="Trove KB block on the ticket: title-based suggestions from the project's mapped collection, search-to-link. Title + collection are snapshotted so the ticket still reads right if Trove KB is down." />
        <Feature name="Resolution draft" roles={HANDLER} note="Extractive digest per linked article — matched passage, link, runbook steps — with an AI summary on top when you may use AI Assist." />
        <Feature name="Knowledge briefs" roles={HANDLER} note="Scope with knowledge on the comment composer. Every run is stored with its inputs + output. Internal articles never leak into a vendor-visible reply. Admin-managed noise rules keep SLA notices, moves, merges, and auto-replies out." />
        <Feature name="Runbooks from Trove KB" roles={HANDLER} note="kind: runbook articles carry steps with stable ids; step state is per ticket. A step's canned field becomes the 📋 pill. Schedules can start a run on every fire." />
        <Feature name="Replace local KB (optional)" roles={["Admin"]} note="Shows a plan first — each local article's twin in Trove KB, links, runs, step coverage — then moves links and runbook progress, archives local articles, and hides the local KB. Local tables stay one release for rollback. Skip it to keep both." />
        <Feature name="Links into the Trove KB staff UI" roles={["Admin"]} note="Edit / manage buttons open Trove KB directly. Everyone else stays inside Resolvd." />
      </div>
      <div className="bg-surface-2 border border-border rounded-lg p-3 text-xs text-fg-muted space-y-1">
        <p className="font-semibold text-fg">Who sees what (Trove KB)</p>
        <p>
          Project handlers see <em>Internal</em> + <em>Public</em> collections; everyone else sees Public collections
          only, and only articles Trove KB confirms are public. Strict mode (default on) hides a collection from
          non-handlers until Trove KB says it's public. New public collections auto-map Public when the toggle is on;
          a Hidden choice is never undone. Trove KB posts signed webhooks that drop Resolvd's 60-second cache;
          collections sync hourly and on demand.
        </p>
      </div>
      <div className="bg-surface-2 border border-border rounded-lg p-3 text-xs text-fg-muted space-y-1">
        <p className="font-semibold text-fg">Tags vs. keywords (built-in KB)</p>
        <p>
          <em>Tags</em> surface as filter chips on the KB index and are meant for human navigation
          ("network", "printer", "VPN"). <em>Keywords</em> don't show as chips but boost the
          suggestion ranker's similarity score — use them for SKU codes, model numbers, error
          strings that shouldn't clutter the chip row but are searchable signal.
        </p>
      </div>
    </div>
  );
}

function SectionForms({ role }) {
  const isAdmin = role === "Admin";
  const isHandler = HANDLER.includes(role);
  return (
    <div className="space-y-4">
      {isAdmin
        ? <FullAccess />
        : isHandler
          ? <PartialAccess note="Handlers fill agent-only fields on tickets and use {field.*} tags in canned responses. Designing categories, forms, and fields is Admin-only." />
          : <PartialAccess note="You'll see a Category → Form picker on New Ticket when your project has forms. Admins design them." />}
      <p className="text-sm text-fg leading-relaxed">
        (v0.10.0) <b>Forms</b> let a project ask different questions for different kinds of request.
        The model is <b>Category → Form → Field</b>, scoped per project: a field is required only on the forms
        that opt in, so a mandatory HR field never bleeds into a DevOps ticket. Configure at
        <b> Admin → Forms / Fields</b>.
      </p>
      <HelpScreenshot src="/help/admin-forms.png" alt="Admin → Forms with a category, its forms, and the field list including a computed field" />
      <div className="space-y-0">
        <Feature name="Categories + forms per project" roles={["Admin"]} note="Each category can name a default form, auto-selected on New Ticket. Forms carry a default title / description." />
        <Feature name="Field definitions" roles={["Admin"]} note="Project-local with tag-prefixed slugs (hr-username) and a collision guard. Soft-archive only. Types: text / number / date / bool / select / multiselect." />
        <Feature name="Agent-only fields" roles={HANDLER} note="Hidden from the submitter's form; handlers fill them on the ticket's Custom Fields card, per field or save-all." />
        <Feature name="Sensitive fields" roles={HANDLER} note="Masked after save; revealed only to the handler editing or composing with them." />
        <Feature name="{field.<slug>} tags" roles={HANDLER} note="Resolve in canned responses and vendor email templates (hyphen-tolerant, HTML-escaped in HTML templates). Tag pickers insert at the caret and expose a project-scoped Custom fields chip group." />
        <Feature name="Deep links" roles="all" note="/tickets/new/<prefix>/<category>/<form>?<field>=<value> — resolves left to right; selects pre-fill by 1-based option number. Shareable-link builder on the admin page." />
        <Feature name="Computed fields" roles={["Admin"]} note="A safe formula over {field.*}, {ticket.*}, {submitter.*}, {assignee.*}, {actor.*}. Functions: slice left right upper lower cap pad trim len digits replace match concat default if datepart; ~ concatenates. No eval, no globals. Evaluated on create and via Recompute. Live preview in the editor." />
      </div>
      <div className="bg-surface-2 border border-border rounded-lg p-3 text-xs text-fg-muted space-y-1">
        <p className="font-semibold text-fg">Example — derive a UPN for HR onboarding</p>
        <pre className="whitespace-pre-wrap font-mono text-[11px] text-fg">{'lower(left({field.hr-first-name}, 1) ~ {field.hr-last-name}) ~ "@" ~ {field.hr-domain}'}</pre>
      </div>
    </div>
  );
}

function SectionSchedules({ role }) {
  const isAdmin = role === "Admin";
  return (
    <div className="space-y-4">
      {isAdmin ? <FullAccess /> : <PartialAccess note="Personal tasks are available to everyone. Recurring ticket schedules are configured by Admins." />}
      <p className="text-sm text-fg leading-relaxed">
        (v0.10.0) Two kinds of recurring work. <b>Schedules</b> create real tickets on a cadence — monthly patch
        windows, quarterly access reviews, weekly backup checks. <b>Tasks</b> are your own to-do list: no fanout,
        no SLA, optionally pinned to a ticket.
      </p>
      <h3 className="text-sm font-semibold text-fg">Recurring ticket schedules</h3>
      <HelpScreenshot src="/help/admin-ticket-schedules.png" alt="Admin → Schedules listing recurring ticket templates with cadence, next fire, and last run" />
      <div className="space-y-0">
        <Feature name="Create a schedule" roles={["Admin"]} note="Admin → Schedules. Presets: daily / weekly / monthly by day / monthly nth weekday / yearly, or a raw cron expression. Timezone-aware. End: indefinite, after N fires, or until a date." />
        <Feature name="Template" roles={["Admin"]} note="Project, title, description, impact, urgency, optional assignee + requestor, contacts, followers (auto-added every fire), and a Trove KB runbook that starts a run on every fire." />
        <Feature name="Every fire is a first-class ticket" roles="all" note="Ref, SLA policy, contacts, deduped followers, audit. ticket_schedule_runs is the ledger (ok / error). A failed fire still advances next_fire_at so a broken template never busy-loops." />
        <Feature name="Fire now" roles={["Admin"]} note="Materialize a ticket immediately to test the template." />
      </div>
      <h3 className="text-sm font-semibold text-fg">Personal tasks</h3>
      <HelpScreenshot src="/help/tasks-page.png" alt="Tasks page with pending / completed / cancelled chips and a recurring task" />
      <div className="space-y-0">
        <Feature name="Create a task" roles="all" note="/tasks, or the global New menu in the header, or from a ticket page (the task carries the ticket ref). Title + body are encrypted at rest." />
        <Feature name="One-off or recurring" roles="all" note="A single due date, or the same presets as schedules. Reschedule and skip from the row." />
        <Feature name="Dashboard My tasks card" roles="all" note="Overdue / Due today / Tomorrow with an inline complete checkbox." />
        <Feature name="Private by design" roles="all" note="Owner-scoped. Nobody is notified; tasks never appear on tickets or in audit." />
      </div>
    </div>
  );
}

function SectionAlerts({ role }) {
  const isHandler = HANDLER.includes(role);
  return (
    <div className="space-y-4">
      {isHandler ? <FullAccess /> : <PartialAccess note="You can view the Alerts page if it appears in your nav, but cannot manage rules or sources." />}
      <p className="text-sm text-fg leading-relaxed">
        The <b>Alerts</b> page is the deduped state-machined view of every alert ingested from a configured
        monitoring source. Distinct from the immutable per-event audit log — one row per
        <code>(source, external_event_id)</code> pair, transitioning <code>firing</code> → <code>recovered</code> as
        the vendor fires + clears. (v0.10.0) A fourth state, <code>acknowledged</code>, means a human has the alert's
        ticket in hand — it drops off the default Problems board without rewriting the ticket.
      </p>
      <div className="space-y-0">
        <Feature name="View alerts list + state" roles={HANDLER} />
        <Feature name="Drill into alert detail" roles={HANDLER} note="Linked ticket (if promoted), source-mapped asset, raw payload." />
        <Feature name="Promote alert → ticket manually" roles={HANDLER} />
        <Feature name="Acknowledge / unacknowledge" roles={HANDLER} note="(v0.10.0) Flips automatically when the alert's ticket leaves Open (single or bulk). A refire of the same event_id flips it back to firing. State dropdown → chip toggles on the Alerts page, plus bulk Acknowledge / Unacknowledge." />
        <Feature name="Promotion delay per source" roles={PRIV} note="(v0.10.0) Integration-wide delay before a firing alert becomes a ticket, so flapping alerts that recover inside the window never open one." />
        <Feature name="Dedup note on new pairs" roles={HANDLER} note="(v0.10.0) A new (source, event) pair lists recent tickets from the same submitter and flags rows where the same consumable was already dispatched." />
        <Feature name="Auto-promotion via alert rules" roles={PRIV} note="Admin / Manager configure rules per source: severity threshold + optional title regex → promote_ticket / notify_only / ignore." />
        <Feature name="Dashboard 'Active alerts' widget" roles={HANDLER} note="Top 8 firing alerts on the dashboard for quick triage." />
      </div>
      <div className="bg-surface-2 border border-border rounded-lg p-3 text-xs text-fg-muted space-y-1">
        <p className="font-semibold text-fg">Integration registry</p>
        <p>
          Built-in adapters: Zabbix (webhook + optional REST backfill), Action1 (REST poll + 429 retry + token bucket).
          Anything else uses the generic webhook intake with a tabular field-map editor — map inbound JSON paths
          to Resolvd ticket fields with optional value-map lookups. No code change required to onboard a new vendor.
        </p>
      </div>
    </div>
  );
}

function SectionEscalations({ role }) {
  const isPriv = PRIV.includes(role);
  return (
    <div className="space-y-4">
      {isPriv
        ? <FullAccess />
        : <PartialAccess note="You may receive escalation pages (notify_role / reassign_role / reassign_agent) but only Admin / Manager configure the chains." />
      }
      <p className="text-sm text-fg leading-relaxed">
        <b>Escalation chains</b> fire on the four SLA triggers — <code>warning_response</code>, <code>warning_resolve</code>,
        <code>breach_response</code>, <code>breach_resolve</code> — and run per-priority + per-project step
        chains with multi-action steps. Configure at <b>Admin → Escalation policies</b>.
      </p>
      <div className="space-y-0">
        <Feature name="Configure escalation policies" roles={PRIV} />
        <Feature name="notify_role / notify_assignee / notify_user" roles="all" note="DMs the targeted user(s). notify_role is scoped to the ticket's project so Org-Wide steps don't broadcast across every project." />
        <Feature name="reassign_role / reassign_user" roles={PRIV} note="Sets assigned_to to a role's first active agent on the project, or a specific user." />
        <Feature name="reassign_agent (assignment policy)" roles={PRIV} note="Defers to the project's assignment policy — round-robin / lowest-case-load — excluding the current assignee. Falls back to any other active agent if no policy or pool is empty." />
        <Feature name="bump_priority (cascade-safe)" roles={PRIV} note="Raises urgency by N tiers (clamped to a floor). Snapshots original priority into escalation_priority_snapshot so a bumped P3 → P2 still matches P3 chain rows on the next tick — no cascade into the new tier's chain." />
      </div>
      <div className="bg-surface-2 border border-border rounded-lg p-3 text-xs text-fg-muted space-y-1">
        <p className="font-semibold text-fg">Additive matching</p>
        <p>
          Org-Wide (project_id NULL) steps and project-scoped steps both apply if both exist — different from
          <em> sla_policies</em> / <em> assignment_policies</em> which pick one or the other. Use <code>priority_op</code>
          (`=`, `&lt;`, `&gt;`, `&lt;=`, `&gt;=`) to cover priority ranges with a single row.
          <code>delay_minutes</code> is the grace after the trigger before the step fires. (v0.10.0) When the
          policy pins business hours, the delay walks through the window — a 30-minute step on a 4:55 PM breach
          fires the next business morning, not at 5:25 PM.
        </p>
      </div>
    </div>
  );
}

const SECTIONS = [
  { id: "overview",       label: "Overview & Roles",    icon: "🗺" },
  { id: "dashboard",      label: "Dashboard",            icon: "🏠" },
  { id: "ticket-list",    label: "Ticket List",          icon: "📋" },
  { id: "new-ticket",     label: "New Ticket",           icon: "➕" },
  { id: "ticket-detail",  label: "Ticket Detail",        icon: "🎫" },
  { id: "notes",          label: "Notes (handler-only)", icon: "📝" },
  { id: "projects",       label: "Projects",             icon: "📁" },
  { id: "inventory",      label: "Inventory + Assets",   icon: "🖥" },
  { id: "consumables",    label: "Consumables",          icon: "🧰" },
  { id: "kb",             label: "Knowledge Base",       icon: "📚" },
  { id: "forms",          label: "Forms + Fields",       icon: "🧾" },
  { id: "schedules",      label: "Schedules + Tasks",    icon: "🔁" },
  { id: "alerts",         label: "Alerts",               icon: "🚨" },
  { id: "admin",          label: "Admin Panel",          icon: "⚙" },
  { id: "notifications",  label: "Notifications",        icon: "🔔" },
  { id: "sla",            label: "SLA tracker",          icon: "⏱" },
  { id: "escalations",    label: "Escalation chains",    icon: "⛓" },
  { id: "ai-assist",      label: "AI Assist",            icon: "✨" },
  { id: "mentions",       label: "@Mentions",            icon: "@" },
  { id: "markdown",       label: "Markdown Formatting",  icon: "✏" },
  { id: "security",       label: "Login security",       icon: "🛡" },
  { id: "support-role",   label: "Support Access",       icon: "🔐" },
  { id: "account",        label: "Account Settings",     icon: "👤" },
];

function renderSection(id, role) {
  switch (id) {
    case "overview":      return <SectionOverview role={role} />;
    case "dashboard":     return <SectionDashboard role={role} />;
    case "ticket-list":   return <SectionTicketList role={role} />;
    case "new-ticket":    return <SectionNewTicket role={role} />;
    case "ticket-detail": return <SectionTicketDetail role={role} />;
    case "notes":         return <SectionNotes role={role} />;
    case "projects":      return <SectionProjects role={role} />;
    case "inventory":     return <SectionInventory role={role} />;
    case "consumables":   return <SectionConsumables role={role} />;
    case "kb":            return <SectionKb role={role} />;
    case "forms":         return <SectionForms role={role} />;
    case "schedules":     return <SectionSchedules role={role} />;
    case "alerts":        return <SectionAlerts role={role} />;
    case "admin":         return <SectionAdmin role={role} />;
    case "notifications": return <SectionNotifications role={role} />;
    case "sla":           return <SectionSla role={role} />;
    case "escalations":   return <SectionEscalations role={role} />;
    case "ai-assist":     return <SectionAiAssist role={role} />;
    case "mentions":      return <SectionMentions role={role} />;
    case "markdown":      return <SectionMarkdown role={role} />;
    case "security":      return <SectionSecurity role={role} />;
    case "support-role":  return <SectionSupport role={role} />;
    case "account":       return <SectionAccount role={role} />;
    default:              return null;
  }
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Help() {
  const { user } = useAuth();
  const role = user?.role || "Submitter";
  const [active, setActive] = useState("overview");

  const activeSection = SECTIONS.find(s => s.id === active);

  return (
    <PageShell variant="standard" className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-fg">Help &amp; Documentation</h1>
        <p className="text-xs text-fg-muted mt-0.5">
          Content shown for your role: <RolePill role={role} />
        </p>
      </div>

      <div className="flex flex-col md:flex-row gap-4 items-start">
        {/* Sidebar */}
        <nav className="w-full md:w-48 flex-shrink-0 bg-surface border border-border rounded-lg overflow-hidden">
          {SECTIONS.map(s => (
            <button
              key={s.id}
              onClick={() => setActive(s.id)}
              className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left transition-colors border-b border-border last:border-0 ${
                active === s.id
                  ? "bg-brand/10 text-brand font-medium"
                  : "text-fg-muted hover:bg-surface-2 hover:text-fg"
              }`}
            >
              <span className="text-base w-5 text-center">{s.icon}</span>
              {s.label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <div className="flex-1 min-w-0 bg-surface border border-border rounded-lg p-5">
          <h2 className="text-base font-bold text-fg mb-4 flex items-center gap-2">
            <span>{activeSection?.icon}</span>
            {activeSection?.label}
          </h2>
          {renderSection(active, role)}
        </div>
      </div>
    </PageShell>
  );
}
