# Roadmap

Living doc. Edit as priorities shift. Recent commits are authoritative for "what shipped" — this just keeps the next-step thread visible.

## Recently shipped

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
- **@mentions autocomplete UI** — text-only mentions ship today; comment textarea could add a `@` typeahead pulling active users.

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
- `INTERNAL_STATUSES` fallback list in `frontend/src/utils/helpers.js` is hardcoded; consider sourcing from StatusesContext defaults.
- `/api/users/me/preferences` (legacy default_project_id endpoint) lives alongside `/api/users/me/prefs` — consider folding the former into the latter and dropping the duplicate route.

## Conventions worth remembering

- **Semantic tags** drive workflow logic, names are admin-renamable. Always branch on `semantic_tag`, not `name`.
- **Side-state tags** (skipped from "Advance to next" button): `reopened`, `on_hold`, `awaiting_input`. From any of these the button resumes to the `in_progress`-tagged status.
- **Auto-close** uses `resolved_pending_close` + `auto_close_after_days`. Cleared on status leave.
- **Follow-up reminders** are scoped to `pending_review` only. Block status advancement while pending. Cleared on status leave or when the cron fires.
- **Reports always render absolute timestamps**; UI uses hybrid (relative <7 days, absolute after) — see `formatHybrid` / `formatAbsolute` in `frontend/src/utils/helpers.js`.
- **Vendor outbound** drops attachments on status-change events; only `new_ticket` and `new_comment` carry images.
