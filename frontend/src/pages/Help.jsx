import { useState } from "react";
import { useAuth } from "../context/AuthContext";

// ── Constants ─────────────────────────────────────────────────────────────────

const ALL_ROLES = ["Admin", "Manager", "Submitter", "Viewer", "Support"];
const PRIV = ["Admin", "Manager"];

const ROLE_COLOR = {
  Admin:     "bg-purple-100 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 border-purple-300 dark:border-purple-800",
  Manager:   "bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-800",
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

// ── Screenshot placeholder ────────────────────────────────────────────────────

function ScreenshotPlaceholder({ label }) {
  return (
    <div className="border-2 border-dashed border-border rounded-lg flex items-center justify-center h-32 my-3 bg-surface-2 text-fg-dim text-xs">
      [ Screenshot: {label} ]
    </div>
  );
}

// ── Feature row ───────────────────────────────────────────────────────────────

// roles: array of role names, or the string "all"
function Feature({ name, roles, note }) {
  const isAll = roles === "all" ||
    (Array.isArray(roles) && ALL_ROLES.every(r => roles.includes(r)));

  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-border last:border-0">
      <div className="flex-1">
        <span className="text-sm text-fg font-medium">{name}</span>
        {note && <p className="text-xs text-fg-muted mt-0.5">{note}</p>}
      </div>
      <div className="flex gap-1 flex-shrink-0 flex-wrap justify-end items-center">
        {isAll
          ? <span className="text-xs text-fg-muted italic">All roles</span>
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
              {["Admin","Manager","Submitter","Viewer","Support"].map(r => (
                <th key={r} className="border border-border px-2 py-2 text-center font-semibold text-fg">{r}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              ["View tickets",              "✓","✓","✓ (own)","✓","✓ (grant)"],
              ["Submit tickets",            "✓","✓","✓","✗","✗"],
              ["Comment",                   "✓","✓","✓","✗","✗"],
              ["Change status",             "✓","✓","✗","✗","✗"],
              ["Assign tickets",            "✓","✓","✗","✗","✗"],
              ["Vendor contact management", "✓","✓","✗","✗","✗"],
              ["Send vendor emails",        "✓","✓","✗","✗","✗"],
              ["Manage projects",           "✓","✓","✗","✗","✗"],
              ["Admin panel",               "✓","partial","✗","✗","✗"],
              ["User management",           "✓","✗","✗","✗","✗"],
              ["Encryption settings",       "✓","✗","✗","✗","✗"],
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
          An Admin can assign a <em>role_override</em> to any user on a specific project (e.g. give a Submitter Manager-level access within one project).
          The override only applies to that project — your global role is unchanged elsewhere.
          Valid project override roles: Admin, Submitter, Viewer.
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
        The Dashboard is your home screen — a live snapshot of ticket activity relevant to your role.
      </p>
      <ScreenshotPlaceholder label="Dashboard overview" />
      <div className="space-y-0">
        <Feature name="Open ticket snapshot" roles="all" />
        <Feature name="Recent activity feed" roles="all" />
        <Feature name="Assigned to me" roles={PRIV} note="Tickets currently assigned to you." />
        <Feature name="Flagged for review" roles={PRIV} note="Tickets pending review before closing." />
        <Feature name="Priority breakdown chart" roles={PRIV} note="Distribution of open tickets by priority." />
      </div>
    </div>
  );
}

function SectionTicketList({ role }) {
  const isPriv = PRIV.includes(role);
  return (
    <div className="space-y-4">
      {isPriv
        ? <FullAccess />
        : role === "Submitter"
          ? <PartialAccess note="You can view tickets you submitted. Tickets in projects you're not a member of won't appear." />
          : <PartialAccess note="Read-only. You can view tickets you have access to but cannot take actions." />
      }
      <p className="text-sm text-fg leading-relaxed">
        The Tickets list shows all tickets you have access to. Use filters and search to narrow results.
      </p>
      <ScreenshotPlaceholder label="Ticket list with filters" />
      <div className="space-y-0">
        <Feature name="View ticket list" roles="all" />
        <Feature name="Search by title / ref" roles="all" />
        <Feature name="Filter by status, priority" roles="all" />
        <Feature name="Filter by project, assignee" roles={PRIV} />
        <Feature name="Bulk status update" roles={PRIV} note="Select multiple tickets, change status in one action." />
        <Feature name="Export CSV" roles={PRIV} />
        <Feature name="View all tickets across all projects" roles={PRIV} note="Non-privileged roles see only tickets scoped to their membership." />
      </div>
      {!isPriv && <OverrideNote />}
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
          Submit a new ticket via <strong>+ New Ticket</strong> in the nav. Title, description, impact, and urgency are the required inputs — the system computes a priority score automatically.
        </p>
        <ScreenshotPlaceholder label="New ticket form" />
        <div className="space-y-0">
          <Feature name="Submit ticket" roles={["Admin","Manager","Submitter"]} />
          <Feature name="Markdown in description" roles={["Admin","Manager","Submitter"]} note="Full GFM: bold, italic, code blocks, lists, tables." />
          <Feature name="Set impact / urgency" roles={["Admin","Manager","Submitter"]} note="Determines computed priority P1–P5." />
          <Feature name="Attach files on creation" roles={["Admin","Manager","Submitter"]} />
          <Feature name="Duplicate detection" roles={["Admin","Manager","Submitter"]} note="System warns if a similar open ticket already exists." />
          <Feature name="Select project" roles={PRIV} note="Submitters are scoped to projects they belong to." />
          <Feature name="Assign to a user" roles={PRIV} note="Submitters cannot set the assignee at creation." />
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
      <ScreenshotPlaceholder label="Ticket detail — comment area" />

      <h3 className="text-sm font-semibold text-fg">Comments</h3>
      <div className="space-y-0">
        <Feature name="Read comments" roles="all" />
        <Feature name="Post a comment" roles={["Admin","Manager","Submitter"]} note="Supports markdown and @mentions." />
        <Feature name="@mention a user" roles={["Admin","Manager","Submitter"]} note="Dropdown scoped to project members. Triggers in-app and email notification." />
        <Feature name="Attach files to comment" roles={["Admin","Manager","Submitter"]} />
        <Feature name="Mark comment vendor-visible" roles={PRIV} note="Sends comment to attached vendor contacts via email." />
        <Feature name="Post & Close / Post & Reopen" roles={PRIV} note="Change ticket status in the same action as posting." />
        <Feature name="Mute / delete comments" roles={PRIV} note="Muting hides vendor replies without deleting." />
      </div>

      <ScreenshotPlaceholder label="Ticket detail — status and metadata panel" />
      <h3 className="text-sm font-semibold text-fg">Status &amp; Fields</h3>
      <div className="space-y-0">
        <Feature name="View status and all metadata" roles="all" />
        <Feature name="Edit title and description" roles={["Admin","Manager","Submitter"]} note="Submitters can only edit tickets they submitted." />
        <Feature name="Edit impact / urgency" roles={["Admin","Manager","Submitter"]} />
        <Feature name="Change internal status" roles={PRIV} />
        <Feature name="One-click advance status" roles={PRIV} note="Advances to the next logical status in the workflow." />
        <Feature name="Change external / vendor status" roles={PRIV} />
        <Feature name="Priority override" roles={PRIV} note="Manually pin priority regardless of computed score." />
        <Feature name="Assign ticket" roles={PRIV} />
        <Feature name="Set blocker" roles={PRIV} note="Block on another ticket or flag as awaiting team input." />
        <Feature name="Schedule follow-up reminder" roles={PRIV} />
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
        <ScreenshotPlaceholder label="Project list" />
        <div className="space-y-0">
          <Feature name="View all projects" roles={PRIV} />
          <Feature name="Create / archive project" roles={PRIV} />
          <Feature name="Set project prefix and name" roles={PRIV} note="E.g. 'IT' → tickets become IT-0001, IT-0002…" />
          <Feature name="Manage project members" roles={PRIV} note="Add users; optionally assign a role override per user." />
          <Feature name="Set role override per member" roles={PRIV} note="Valid overrides: Admin, Submitter, Viewer. Elevates or restricts access within this project only." />
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
          System-wide configuration. Some sub-sections are Admin-only even for Managers.
        </p>
        <ScreenshotPlaceholder label="Admin panel navigation" />
        <div className="space-y-0">
          <Feature name="Statuses — workflow status configuration" roles={PRIV} note="Semantic tags, transitions, sort order." />
          <Feature name="Companies &amp; Contacts — vendor directory" roles={PRIV} note="Includes per-company notification preference toggles." />
          <Feature name="Email Templates — outbound vendor email content" roles={PRIV} />
          <Feature name="Email Backends — SMTP configuration" roles={PRIV} />
          <Feature name="Inbound email — parse replies into comments" roles={PRIV} />
          <Feature name="Branding — logo, site name, colors" roles={PRIV} />
          <Feature name="Export — full data export" roles={PRIV} />
          <Feature name="Users — invite, deactivate, reset passwords" roles={["Admin"]} note="Manager role cannot manage other users." />
          <Feature name="Authentication — MFA policy, SSO / Azure AD" roles={["Admin"]} />
          <Feature name="Support — issue JIT access grants" roles={["Admin"]} note="Time-limited read grants for Support role users." />
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
        The notification bell in the top nav shows in-app alerts. Email notifications run in parallel where configured.
      </p>
      <ScreenshotPlaceholder label="Notification tray" />
      <div className="space-y-0">
        <Feature name="In-app notification tray" roles="all" note="Bell icon visible to all roles." />
        <Feature name="Receive mention notifications" roles="all" note="Alert when someone @mentions you in a comment." />
        <Feature name="Follower email on new comment" roles={["Admin","Manager","Submitter"]} note="Sent to followers when a comment is posted." />
        <Feature name="Click notification → jump to comment" roles="all" note="Navigates to the ticket and flashes the relevant comment." />
        <Feature name="Mark all read" roles="all" />
        <Feature name="Email-on-mention preference" roles="all" note="Toggle in Account → Preferences." />
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
      <ScreenshotPlaceholder label="@mention autocomplete dropdown" />
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
      <ScreenshotPlaceholder label="Markdown editor toolbar" />
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
      <ScreenshotPlaceholder label="Markdown rendered output" />
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
      <ScreenshotPlaceholder label="Admin → Support grant management" />
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
      <ScreenshotPlaceholder label="Account settings tabs" />
      <div className="space-y-0">
        <Feature name="Profile — name, display name, avatar" roles="all" />
        <Feature name="Password — change password" roles="all" note="Not available if SSO is your only login method." />
        <Feature name="MFA — enroll TOTP authenticator" roles="all" note="May be required by your Admin's policy." />
        <Feature name="Preferences — behavior toggles" roles="all" note="Compact mode, Ctrl+Enter to post, auto-follow on comment, email notification preferences." />
      </div>
    </div>
  );
}

// ── Section registry ──────────────────────────────────────────────────────────

const SECTIONS = [
  { id: "overview",       label: "Overview & Roles",    icon: "🗺" },
  { id: "dashboard",      label: "Dashboard",            icon: "🏠" },
  { id: "ticket-list",    label: "Ticket List",          icon: "📋" },
  { id: "new-ticket",     label: "New Ticket",           icon: "➕" },
  { id: "ticket-detail",  label: "Ticket Detail",        icon: "🎫" },
  { id: "projects",       label: "Projects",             icon: "📁" },
  { id: "admin",          label: "Admin Panel",          icon: "⚙" },
  { id: "notifications",  label: "Notifications",        icon: "🔔" },
  { id: "mentions",       label: "@Mentions",            icon: "@" },
  { id: "markdown",       label: "Markdown Formatting",  icon: "✏" },
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
    case "projects":      return <SectionProjects role={role} />;
    case "admin":         return <SectionAdmin role={role} />;
    case "notifications": return <SectionNotifications role={role} />;
    case "mentions":      return <SectionMentions role={role} />;
    case "markdown":      return <SectionMarkdown role={role} />;
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
    <div className="space-y-4">
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
    </div>
  );
}
