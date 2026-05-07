# Roadmap

Living doc. Edit as priorities shift. Recent commits are authoritative for "what shipped" — this just keeps the next-step thread visible.

## Recently shipped

- **Bulk-add project members + auto-add new users** — `POST /api/projects/:id/members/bulk` (capped 500/call) with idempotent ON CONFLICT. New `projects.auto_add_new_users` flag fires `services/projectAutoAdd.autoAddUserToFlaggedProjects(userId)` on SSO first login (auth/session.js INSERT branch + invited→active flip) and on invite-token acceptance (routes/invites.js). Frontend ProjectDetail member-add panel rewritten as multi-select with search and "Select all" (scoped to filtered list); settings form gains the auto-add toggle. Use case: INC/helpdesk project where every employee should be a member without per-user clicks.
- **Email account ↔ project scope (helpdesk routing)** — new `email_account_project_scopes` join table (account, project, send_enabled, recv_enabled, approved_by, approved_at). Many-to-many; admins/managers add scopes via `POST /api/email-backends/:id/scopes`. When an account ends up scoped to exactly one project AND that scope is approved, inbound mail without a `#PREFIX` auto-routes to that project (helpdesk pattern). Manager-created single-scope fires an Admin approval notification (new `notifyAdmins` helper, distinct from `notifyManagersAndAdmins`). Outbound resolution: `sendMail({ projectId })` prefers a scoped send-enabled account before falling through to the global active. graphInbox/gmailInbox emit `email_backend_account_id` in their payload so ingestion knows which mailbox the message landed in. UI lives in **Admin → Email backends → {account} → Project scope** (collapsible per-account section with pending-approval badges).
- **Vendor reply attribution + per-vendor pill colors** — `tryAutoReply` now stamps `comments.vendor_contact_id` on the appended comment (was missing — caused vendor replies to render as "to vendor" instead of "from vendor"). Comments GET joins `contacts`/`companies` to surface `vendor_company_id`/`vendor_company_name`. New `frontend/src/utils/vendorColor.js` hashes company id to an HSL hue (skipping a sickly yellow-green band) with light/dark theme variants. Same vendor, same color across users + sessions; multiple vendors on one ticket stay distinct + readable. The "TO VENDOR" pill stays brand-colored.
- **Merge tickets — search-driven picker + standalone admin tool** — `<MergePicker>` extracted to `frontend/src/components/MergePicker.jsx`. Two slots A/B with typeahead by ref/title/description hitting existing GET `/api/tickets`. Project locks to the first picked ticket; second slot's results filter to that project. "Swap winner ⇄" toggle picks direction post-selection — admin no longer has to open the loser ticket to start the flow. Inline from `TicketDetail` (anchor pre-filled) or standalone at **Admin → Merge tickets**. Old numeric-ID `MergeDialog` deleted.
- **Reply-above-this-line marker + generic inbound parser hardening** — vendor outbound prepends `--- Type your reply above this line — ticket {ref} ---` so quoted history, mail-client headers, and signatures cut cleanly. New `extractFreshReply()` in `inboundProcessor` takes the earliest cut among marker, signature boundaries, `On X wrote:`, `From: …` quoted-headers (broadened for Outlook's flattened single-line form), mobile sigs, separator runs, and `>`-quoted tail; final `dedupeParagraphs()` collapses consecutive identical paragraphs (handles plaintext/HTML alt-part echoes and gateway content repeats). `stripHtml` in graphInbox/gmailInbox now newlines `</div></li></h*>...</pre>` so line-anchored regex actually fires; ZWNJ runs from gateway banners are squashed.
- **Per-account banner-strip patterns** — `email_backend_accounts.inbound_banner_strip_patterns TEXT[]`. New `POST /api/email-backends/:id/banner-patterns` validates each entry compiles as RegExp. graphInbox + gmailInbox apply patterns to body before forwarding to ingestion. Admin UI at **Admin → Email backends → {account}** with collapsible section, preset buttons (Inky, Mimecast, Proofpoint, Avanan), and an upfront blue advisory recommending gateway-side suppression first when the inbox is a licensed resource mailbox.
- **Stop spoofing From on vendor outbound** — `From` is always the connected mailbox (`account.from_address`); actor identity rides as the display name in the `Actor via SiteName` convention. `useSubmitter`/`submitterEmail` substitution path removed. Reply-To defaults to `account.from_address`. No Exchange Send-As permission required. Anti-spoof filters (Inky VIP, Mimecast Impersonation Protect) recognize `via` as legitimate proxied mail.
- **Cross-project visibility controls** — per-project tri-state (Inherit / Restrict / Open) on @mention resolution + follower picker, with org-wide defaults in **Admin → Branding**. Backend resolves effective flag (project override falls back to branding default), enforced in `routes/followers.js` POST, `routes/users.js` /search, and `services/mentions.js` `resolveMentions` (now project-scoped — closes the leak where typed @mentions resolved system-wide). Admins bypass. Schema: `branding.default_restrict_followers`, `branding.default_restrict_mentions`, `projects.restrict_{followers,mentions}_to_members` (nullable, NULL = inherit). Helper module: `backend/services/restrictions.js`.
- **Send As — no-submitter variant** — when Admin/Manager comments or notifies vendor on a ticket with no `submitted_by` (e.g. imported tickets), modal offers **Send as** (pick any project member as one-off identity) or **Submit as** (backfill `ticket.submitted_by`, then send under that name). Backend `send_as` accepts numeric user id alongside `'self'/'submitter'`. Reduces vendor mail going out under the `MAIL_FROM` fallback.
- **NATO phonetic readback popover** — hover/focus a ticket ref (e.g. `WEB-0079`) shows "Whiskey Echo Bravo - 0 0 7 9" for verbal readback to vendors on phone calls. Letters → NATO words; digits + dash kept as-is. Gated by org toggle `branding.phonetic_readback_enabled` (default ON) + per-user pref `phonetic_readback` (default ON); either OFF renders ref verbatim. Wired on `TicketDetail` header ref + `TicketList` ref column. Parser/util in `frontend/src/utils/phonetic.js`, popover in `frontend/src/components/PhoneticPopover.jsx`.
- **Bulk ticket actions** — admin-only "Bulk Edit" toggle on the ticket list adds checkboxes per row (plus select-all-on-page) and replaces the search bar + New Ticket button with a status / assignee / project action bar. `POST /api/tickets/bulk` (Admin only) accepts `{ ids, status?, assigned_to?, project_id? }`, applies updates per-ticket in independent transactions, audits each change, and fires `notifyStatusChange` + `notifyAssignment` fan-out (gated by recipient prefs). Vendor outbound is intentionally skipped to avoid bulk noise. Project move re-issues `internal_ref` and detaches vendor contacts (mirrors single-move semantics). Capped at 500 tickets per call.
- **Hybrid timestamp tooltips** — `<HybridTime>` component wraps `formatHybrid` with a `title=` carrying the absolute value in the user's chosen style. Migrated all `formatDateTime` call sites (TicketDetail, TicketList, Dashboard, AdminUsers).
- **Per-user locale overrides** — new prefs `date_style_override` / `time_style_override` / `timezone_override`. Empty string inherits the org branding default; non-empty overrides it via `BrandingProvider`. UI in Account Preferences → Localization. BrandingProvider now nested inside AuthProvider so it can read user prefs.
- **Browser push notifications (assignment + mention)** — Web Push fan-out via VAPID + service worker (`frontend/public/sw.js`). Per-user prefs `push_on_assignment` / `push_on_mention` (default off). Subscriptions in `push_subscriptions` table, multi-device, stale endpoints (404/410) auto-pruned. Requires `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` env. First-pass UI in Account Preferences → Browser notifications. Email-or-digest cadence + in-app toggle matrix is the next chunk.
- **Mobile ticket header** — title block stacks above toolbar on `<sm`, gets full row width. Secondary actions (Notify Vendor / Move / Merge / Delete) collapse into a kebab popover; Follow + admin Manage Followers stay inline.
- **Resolved-state workflow** — `resolved_pending_close` semantic tag, configurable auto-close grace (default 3 days, edited per status), inbound auto-reopen unless body matches editable gratitude phrase list.
- **Pending Review follow-ups** — admin-set reminder (1–90 days, default 3) on `pending_review` status. Fires in-app notification + email. Blocks status advancement until cancelled or fired.
- **Status admin** — new On Hold (`on_hold`, internal block) and Awaiting Input now tagged `awaiting_input` (external block). Single "Advance to {next}" button walks the chain.
- **Ticket admin** — submit-on-behalf, change submitter, manage followers (admin/manager popover), move ticket between projects (re-issues `internal_ref`, detaches vendor contacts), inline title edit.
- **Comments** — Ctrl+Enter posts (per-user pref), auto-follow on comment (per-user pref), Post & Close optional confirm.
- **User preferences** — `users.preferences` JSONB + `/api/users/me/prefs`. Toggle page at Account Settings → Preferences. Switches: scope_follows_filter, ctrl_enter_to_post, auto_follow_on_comment, confirm_before_close, default_ticket_sort, email_on_comment, email_on_status_change, email_on_assignment, push_on_assignment, push_on_mention, compact_mode. Slated for restructure into a channel × event matrix (see Notifications open work).
- **Email-on-assignment** — fires on PATCH when assigned_to changes; gated by recipient pref.
- **Localization** — Branding admin → date/time style + IANA timezone. UI uses hybrid (relative <7d, absolute after). Reports always absolute. Helpers picked up via `setActiveLocale` from BrandingProvider.
- **Vendor outbound** — image attachments only on `new_ticket` and `new_comment`; `status_change` and `ticket_resolved` send body only.
- **Naming cleanup** — `mot_*` → `internal_*`, `coastal_*` → `external_*`, `punchlist` → `resolvd` (DB columns + code).
- **@mentions** — comment body parser (`@email`, `@local-part`, `@first.last`). Resolves to active users; mentioned users auto-follow, get an in-app notification + email (gated by `email_on_comment`). Unmatched tokens ignored silently. No autocomplete UI yet.
- **CSV import stub removed** — dangling `uploadCsv` in `frontend/src/utils/api.js` deleted (zero callers, backend route never built).

## Gaps vs marketing site (resolvd.dev)

The marketing repo (`~/dev/resolvd-dev`) advertises features that aren't fully built. Triaged into "real gaps" (claimed as current) and "aspirational" (hosted-tier, explicitly future):

### Real gaps — advertised as current, not built
- **CSV import** — needs a real path eventually. Stub yanked for now; build the importer (parse, validate, dedupe, project assignment, mapping UI) when the use case lands.
- **Per-project role overrides** — "Per-project overrides for vendors and external collaborators" implies role-per-project. Only flat `project_members` exists today; investigate scope before building.

### Aspirational — Hosted/Pro plan, intentionally future
Site explicitly tags these as "launching soon" or part of paid hosted tiers. Build only when hosting goes live.
- **API tokens & outbound webhooks** (Team plan)
- **SAML / OIDC SSO** (Pro add-on; Entra/Google OAuth already cover most cases but not generic SAML)
- **SCIM user provisioning** (Pro)
- **IP allowlists** (Pro)
- **Daily Postgres + uploads snapshot, S3 destination, point-in-time retention** (hosted backups)
- **One-click export bundle (SQL + tarball)** — partial: pg_dump documented for self-hosted
- **Migration assistance / onboarding session / quarterly restore drill** — services, not features

### Marketing-side TODOs noted in resolvd-dev
- Live demo instance that resets every 4 hours
- Screenshots / product gallery
- "First release coming soon" (changelog has no entries)

## Open / candidate work

### Status / workflow
- Auto-resume `awaiting_input` → `in_progress` on inbound vendor reply (mirror the gratitude reopen path on the resolved state).
- Inbound queue match flow could detect `awaiting_input` status and surface "this likely unblocks ticket X" hint to admin reviewer.

### Reporting
- SLA tracker / time-in-status histogram (would lean on the new blocker tags).
- "Time blocked by vendor vs internal" breakdown using `awaiting_input` / `on_hold`.

### Notifications
- **Channel × event matrix** — replace flat `email_on_*` / `push_on_*` keys with a structured `notification_prefs` blob: per event-type (`assignment`, `mention`, `comment`, `status_change`, `pending_review`, `follow_up_due`) toggles for `push` / `in_app` / `email`. Silently fold legacy keys on read.
- **Email digest cadence** — per-user `email_digest`: `instant | hourly | 12h | daily | off`. Outbox table buffers events; cron flushes per-user batches at cadence boundary, groups by ticket, skips empty buckets.
- **In-app fan-out for all event types** — `createNotification` already covers mention + a few system events; extend to assignment, comment, status_change so the bell tray reflects the same channel toggles.

### UX small wins
- (none currently queued — see "Recently shipped" for bulk actions, hybrid tooltips, and per-user locale overrides.)

### Plumbing / debt
- `ROADMAP.md` (this file) — keep current.

## Conventions worth remembering

- **Semantic tags** drive workflow logic, names are admin-renamable. Always branch on `semantic_tag`, not `name`.
- **Side-state tags** (skipped from "Advance to next" button): `reopened`, `on_hold`, `awaiting_input`. From any of these the button resumes to the `in_progress`-tagged status.
- **Auto-close** uses `resolved_pending_close` + `auto_close_after_days`. Cleared on status leave.
- **Follow-up reminders** are scoped to `pending_review` only. Block status advancement while pending. Cleared on status leave or when the cron fires.
- **Reports always render absolute timestamps**; UI uses hybrid (relative <7 days, absolute after) — see `formatHybrid` / `formatAbsolute` in `frontend/src/utils/helpers.js`.
- **Vendor outbound** drops attachments on status-change events; only `new_ticket` and `new_comment` carry images.
