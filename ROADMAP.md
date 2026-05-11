# Roadmap

Living doc. Edit as priorities shift. Recent commits are authoritative for "what shipped" — this just keeps the next-step thread visible.

## Recently shipped

- **v0.6.1 — AI Assist gated on `RESOLVD_MASTER_KEY` + in-app master key generator** — AI module now stays disabled org-wide until the master key is present; `aiSettings.getSettings()` derives `enabled` from both the admin toggle AND `kms.isAvailable()`, so missing-key deployments no longer 500 when a user or admin tries to save an API key. New non-throwing `kms.isAvailable()` + `kms.generateMasterKeyBase64()` helpers. New Admin-only endpoint `POST /api/ai-settings/generate-master-key` returns a fresh base64 key with copy-paste instructions (server never persists it). Admin → AI Assist → Integration shows an amber banner with **Generate master key** button → modal displaying the key once, copy-to-clipboard, acknowledgement checkbox, and ordered instructions (paste to `.env`, back up separately, restart backend). API key save buttons stay disabled until KMS is configured. User-facing copy at AccountPreferences → AI Assist and the AiRewriteModal now distinguishes "admin hasn't enabled yet" from "admin has disabled it". README admin setup section + `RESOLVD_MASTER_KEY` env var doc updated to call out the AI prerequisite. `resolveEffectiveConfig` adds `kms_unavailable` reason ahead of `org_disabled`.
- **Login hardening — IP block, honeypot, dwell timer, session regen, security headers, admin forensics** — `login_attempts` audit table records every successful + failed local-login / bootstrap with email, IP, UA, reason, honeypot flag, form_dwell_ms. Indexed by IP+time, email+time, failures-only. New `services/loginSecurity.js` adds per-IP persistent block (20+ failures in 24h → 429 + Retry-After for 1h past last failure — catches credential stuffing that rotates across rate-limit windows), bot signal helpers (honeypot field on login form, sub-800ms dwell rejection). Express rate-limit tightened 20 → 8 per 15-min window, `skipSuccessfulRequests` so fast legit logins don't burn the budget. `loginUser()` in `auth/session.js` now calls `req.session.regenerate()` before storing the user (session fixation). New `middleware/securityHeaders.js`: X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy locking camera/mic/geo/payment, CSP with explicit AI provider connect-src whitelist, HSTS when `COOKIE_SECURE=true`. Admin-only `/api/security/login-attempts` + `/summary` endpoints — raw + aggregate-by-IP-and-email forensics views. Login form gains hidden honeypot field + form-mount timestamp; loginLocal passes both up. Dedicated `Admin → Security` UI rendering the summary deferred to v0.6.1.
- **Admin org-managed AI integration page (3-section master-detail)** — new singleton `ai_settings` table consolidates BYO-AI / org-managed configuration. Three-section admin page at `Admin → Integrations → AI Assist`: **Integration** (org provider/endpoint/model + encrypted org API key + Lock-to-org toggle + Test connection), **Permissions** (enabled, allow user BYOK, project context allowed, disclosure audience tier), **Project contexts** (master-detail picker: project list on the left with context-length badge + disabled flag, right pane edits the 8000-char markdown blob inline). Resolution logic in `services/aiSettings.resolveEffectiveConfig`: org disabled → reject; org locked → use org (ignore user); allow_user_byok + user has personal → user wins; else org fallback. `ai_rewrite_logs.config_source` records 'user' vs 'org' for usage attribution. User-side `/api/ai/config` surfaces `org_enabled` / `org_locked` / `org_has_config` / `allow_user_byok` so the personal AI Assist card adjusts UX accordingly.
- **AI usage disclosure badge + per-user publish opt-in** — compact `✨ AI` pill inline in comment + ticket-description header next to action buttons. Hover or focus opens a popover with the full readout (provider, model, tokens, tone, verbosity, ELI5, project context applied). Click copies the multi-line metadata to clipboard. Mobile: parent flex-wraps so the badge breaks under timestamp instead of overflowing. Apply-time snapshot: every successful rewrite writes a row to `ai_rewrite_logs`; the consuming comment POST / ticket POST/PATCH accepts `ai_rewrite_log_id`, validates ownership + un-applied state, copies provider/model/tokens onto the saved row, snapshots the author's `publish_usage` pref into `ai_publish_consent` so future pref changes don't retroactively widen visibility. Org-level disclosure audience (`self_and_admin` / `admin_only` / `all_users`) + per-user "Publish my AI usage to teammates" override that exposes own badge org-wide regardless of org tier. New `AiUsageBadge` component; visibility stripped server-side in tickets + comments GET per viewer.
- **BYO-AI text rewrite — provider adapters, project context, model picker, friendly errors, wired into seven surfaces** — pluggable adapters under `backend/services/aiProviders/` ship `openai` (compat with Azure / OpenRouter / vLLM / LM Studio), `anthropic` (Claude Messages API), `ollama` (self-hosted). Each carries curated `recommendedModels` (cheap/balanced/heavy tiers) + a `listLiveModels` that hits the provider's `/v1/models` (or `/api/tags` for Ollama). Per-provider `consoleUrl` + `setupHint` surface as a helper banner with deep link to the provider's key console. Top-level `services/aiRewrite.js` builds tone × verbosity × ELI5 × surface-aware system prompts. Preserves `{tag.path}` placeholders verbatim (admin email templates). **Project context glossary** at `projects.ai_context_md` (8KB cap) — admin-authored markdown prepended to the prompt when a rewrite fires from a ticket in that project; three layers of opt-in (org admin / project admin / per-user) all must be ON. **Per-user encrypted key** at rest via the standard envelope wrapper (`users.ai_api_key_enc`); never returned from any GET — only a `has_key` boolean. **Friendly provider errors** — adapters wrap non-ok responses + fetch errors in a `ProviderError` carrying `{kind, friendly, providerMessage}`; kind one of auth / billing / rate_limit / model_not_found / bad_request / server_error / network; rendered inline with an expandable "Provider details" disclosure. AccountPreferences → AI Assist card (provider, endpoint, grouped model dropdown with Refresh button, API key with masked display + Replace/Remove, default tone/verbosity, publish-usage + use-project-context toggles, Test connection). `<AiRewriteModal>` preview-before-send modal. `<AiRewriteButton>` for plain inputs. `MarkdownEditor` gains an `aiSurface` prop. **Wired surfaces:** internal + vendor comment composer (auto-flips on Share-with-vendor), ticket title (NewTicket + TicketDetail inline edit), ticket description (NewTicket + TicketDetail), canned response body, project description, admin email templates (Subject + Body).
- **SLA tracker — per-priority + per-project targets, pause-on-blocker, breach detection, MTD dashboard** — new `sla_policies` table (priority × project — org default keyed on priority alone, project overrides keyed on priority+project). Tickets gain `sla_response_due_at`, `sla_resolve_due_at`, `sla_first_response_at`, `sla_paused_seconds`, `sla_paused_at`, `sla_response_breached` + `sla_resolve_breached` flags, plus `sla_response_breached_at` + `sla_resolve_breached_at` timestamps for MTD reporting. Lifecycle: ticket create stamps both due-ats from the resolved policy; status transitions into `awaiting_input` / `on_hold` pause both clocks (vendor / customer wait time doesn't count); transitions out resume + shift due-ats forward by the pause duration; first non-system non-submitter comment closes the response clock; existing `resolved_at` closes the resolve clock. 5-minute breach scheduler flips the breached flag + stamps the timestamp + fans out via `fanoutSlaBreach` (in-app + immediate email — bypasses digest cadence since breaches are action-required) to assignee + followers + submitter, deduped. Endpoints under `/api/sla`: `GET /policies` (Admin/Manager), `POST` / `PATCH` / `DELETE /policies` (Admin), `GET /dashboard` (any authenticated user — project-scoped via `getAccessibleProjectIds`). Default policies seeded P1 30m/4h, P2 1h/8h, P3 4h/24h, P4 8h/72h, P5 1d/7d. Dashboard.jsx gets a new `SlaBreachCard`: stat tiles for MTD response/resolve breaches, currently breached count (clickable to filtered ticket list), open w/ SLA clock, plus a per-project MTD breakdown table when breaches exist. All-clear state collapses to one line. Admin/Manager see "All projects"; Submitter/Viewer see "Your projects" filtered by `project_members`.
- **Notifications matrix — channel × event prefs + email digest cadence + outbox flusher** — replaced the flat `email_on_*` / `push_on_*` user prefs with a structured `notification_prefs` blob (per-event `{in_app, email, push}` cells across 6 event types: assignment, mention, comment, status_change, pending_review, follow_up) plus `email_digest` cadence (`instant`/`hourly`/`12h`/`daily`/`off`) backed by a new `notification_outbox` table that buffers buffered events and flushes via a 5-minute scheduler tick into a single grouped digest email per user. Single `services/notificationFanout.js` is now the only path for all 6 event types — each computes recipients, applies the matrix per recipient, dispatches in-app + push, and routes email through the digest cadence chokepoint (`routeEmail`). `pending_review` and `follow_up` are server-side LOCKED_ON: in-app + email always fire and bypass digest cadence (action-required events shouldn't be batched). Mention dedup excludes mentioned users from the comment fanout so they get one louder mention notification instead of two. Schema migration adds the outbox table + system_jobs row, backfills the matrix into existing user prefs, and strips the 5 legacy keys. AccountPreferences → Notifications card: browser permission toggle, digest dropdown, 6×3 matrix grid (locked rows greyed with "(always on)"). NotificationTray panel goes `fixed top-14` centered on `<sm`, keeps `absolute right-0` anchor on `sm+`. Bell tray now renders all 6 event types via the existing generic UI — no per-type frontend changes needed.
- **In-app help page — real screenshots + v0.5.0 content catch-up** — new `<HelpScreenshot>` wrapper component (`frontend/src/components/HelpScreenshot.jsx`) lazy-loads PNGs from `frontend/public/help/<slug>.png` and falls back to a dashed placeholder when missing. All 13 `ScreenshotPlaceholder` usages in `frontend/src/pages/Help.jsx` swapped to real screenshots (dashboard, ticket list, new-ticket, ticket detail comments + meta, project list, admin left-rail nav, notification tray, mentions autocomplete, markdown toolbar + rendered, support grants, account settings). `SectionAdmin` text + Feature list refreshed for v0.5.0 — mentions left-rail nav grouping (People · Workflow · Integrations · Site · Data), Companies entry rewritten for the kind axis, four new Feature entries added (Alert sources, Canned responses, System health, Merge tickets). `SectionTicketDetail` Comments list now mentions the canned-response 📋 popover. Screenshots authored via a generic Playwright runner driven by `scripts/screenshots-help.json` (both gitignored — local tooling). A post-commit hook (`.githooks/post-commit`, gitignored) prints a terminal reminder when frontend pages change but `Help.jsx` doesn't, prompting an `/update-help-page` pass. Activated per-clone via `git config core.hooksPath .githooks`.
- **CRM rebuild — kind axis (vendor / customer / internal), locations, members, master-detail UI** — `companies.kind` ∈ {vendor, customer, internal}; `project_id` now nullable. New `locations` table (name, location_code, address, timezone, phone, `use_extensions`, `is_primary`, soft-archive). New `company_members` (user + optional location + role label) for internal kind. New `company_projects` join for customer-kind multi-project linkage. `contacts.location_id` + `contacts.extension`; contact-create UX pre-fills phone from location when `use_extensions=true`. **Auto-join by domain** — `companies.auto_add_domains TEXT[]` on internal kind; SSO first-login + invite-acceptance hooks fire `services/companyAutoJoin.autoJoinInternalCompanies(userId)`; saving an updated domain list retroactively syncs existing matching active users. Branding gains three feature toggles (Vendor/Customer/Internal) — Vendor + Internal default ON, Customer (MSP) default OFF. AdminCompanies rewritten as master-detail with kind-aware tabs (Vendor: Contacts/Locations/Notifications · Customer: Contacts/Locations/Projects · Internal: Members/Locations).
- **Canned responses with tag substitution + project scope** — `canned_responses` table (scope=global|user, category, body, use_count, project_ids[]). Admin/Manager-managed globals + personal-only entries. `{ticket.ref}`, `{ticket.title}`, `{ticket.priority}`, `{ticket.url}`, `{ticket.vendor_ref}`, `{submitter.firstName/name/email}`, `{assignee.firstName/name/email}`, `{actor.firstName/name/email}`, `{ticket.submitter}` alias, `{site.name}`, `{site.url}` — all resolved server-side via `services/cannedRender.js`. Unknown tags pass through. Project scope filters the picker so only relevant responses surface. Inserted via 📋 Canned popover next to the ticket comment composer; insert increments `use_count` so frequents float up. Admin manage page at **Admin → Workflow → Canned responses**.
- **System health page (Admin + Manager)** — `GET /api/system-health` returns scheduler heartbeats, DB stats (size, uptime), ticket counters by status/priority, inbound queue counts, alert-source last-seen + event count, email-backend statuses. Auto-refreshes every 30s. Health dot per scheduled job (ok / stale / error / never_ran) — "stale" = heartbeat older than 2× cadence. `auto_close` heartbeat write added (was missing). Job ledger registered for `auto_close` to live alongside `muted_digest` and `inbox_subscription_renewal`.
- **Zabbix alert sources + webhook receiver + backfill (Phase 5 first preset)** — `external_alert_source` (token-hashed at rest, default project, severity_map JSONB, auto_resolve_on_recovery, optional API URL + encrypted api_token, last_seen_at, api_last_ok_at/error). `external_alert_event` (UNIQUE source+event_id+event_type — Zabbix retries can't dup-create). Tickets gain `external_ref` ('zabbix:<event_id>'), `external_source`, `external_alert_source_id`. New `services/alertMappers.js` (Zabbix preset; mapper output includes `user_email` from `{INVENTORY.POC.PRIMARY.EMAIL}`), `services/alertIngest.js` (shared transactional pipeline used by both live webhook and backfill). Live ingest at `POST /api/webhooks/zabbix/<token>` (mounted before JIT support guard). Admin CRUD at `/api/alert-sources` w/ rotate-token + `/_meta/presets`. Resolvd-side **user attribution**: when `event.user_email` matches an active user, both `submitted_by` and `assigned_to` populate to that user (auto-followed); unmatched emails get an `alert_unmatched_contact` audit row + surface in description. **Backfill button** on source detail calls Zabbix `problem.get` → `event.get` (selectHosts) → `host.get` (selectInventory: poc_1_email), normalizes to synthetic webhook payloads, runs through the same ingest. Bearer auth tried first; falls back to legacy `auth` field. AdminAlertSources page is master-detail with token banner (shown once), severity map editor with "Reset to defaults", recent-events table, copy-able Zabbix media-type script. Two new togglable ticket-list columns: **Vendor ref** (`external_ticket_ref`) and **Alert ref** (`external_ref`), both with NATO phonetic popover.
- **Layout sweep — left-rail admin, PageShell, master-detail patterns, column visibility** — `<PageShell variant="wide|standard|narrow">` primitive; dropped global `max-w-7xl` from `Layout.jsx`. Pages opt into width: lists/dashboards = wide, ticket/project detail = standard, settings forms = narrow. **Admin** rebuilt as left-rail (sticky on desktop, hamburger drawer on mobile that auto-closes on route change), grouped (People · Workflow · Integrations · Site · Data); Manager sees a subset. **Master-detail refactor** for `AdminEmailBackends` + `AdminInbound` (proof of pattern) — list left + selected-item right pane, replaces nested collapsibles. Same pattern carried into the new `AdminAlertSources` and `AdminCompanies`. **Column visibility** prefs: reusable `<ColumnPicker>` + `useColumnPrefs(tableKey)` hook backed by `users.preferences.hidden_columns`; first wired on TicketList (Ref + Title alwaysOn, the rest togglable). All admin form pages left-aligned (dropped `mx-auto`).
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
- Time-in-status histogram (extend the just-shipped SLA tracker — group time spent per status, not just first-response / resolve timers).
- "Time blocked by vendor vs internal" breakdown using `awaiting_input` / `on_hold`.

### Notifications (post-matrix follow-ups)
- **Daily digest hour configurability** — currently hardcoded 09:00 user-local. Surface as a per-user pref or org-wide `auth_settings.notification_digest_local_hour`.
- **Outbox cleanup sweep** — rows with `email_digest=off` set after buffering sit forever. Add a once-a-day `DELETE FROM notification_outbox WHERE created_at < NOW() - INTERVAL '30 days' AND sent_at IS NULL`.
- **Audit log entry on AI-assisted comment** (open from BYO-AI shipment) — record provider + model name on the comment row when it was rewritten via AI Assist before posting. Not the raw prompt/response.
- **AI rewrite token cost display** — surface estimated tokens per call so the user knows what their key is burning. Cumulative per-user counter optional.
- **AI rewrite streaming** — current adapter calls are full-shot; streaming would feel snappier but multiplies provider-quirk surface area. Defer until a complaint surfaces.

### UX small wins
- (none currently queued — see "Recently shipped" for bulk actions, hybrid tooltips, and per-user locale overrides.)

### Plumbing / debt
- `ROADMAP.md` (this file) — keep current.

## Platform direction — multi-tenant + modular

Long-arc goal: Resolvd is a **natively multi-tenant, plugin-extensible platform**, not just a helpdesk. Self-hosters with one team and MSPs serving 20 client orgs run the same code. SaaS infra (billing, provisioning, ops console) lives in a separate private repo on top.

### Phase 1 — Multi-tenant retrofit (~3 weeks)
Make every table tenant-aware without changing UX for single-tenant users.

- Add `tenant_id` column to every existing table (tickets, comments, projects, users, statuses, branding, email_backend_accounts, etc.)
- Postgres Row-Level Security (RLS) policies: `USING (tenant_id = current_setting('app.tenant_id')::int)`
- Backend middleware resolves tenant from subdomain (`acme.resolvd.app`) → sets `SET LOCAL app.tenant_id` per request
- Default tenant auto-created on `db:init`; existing data backfills to it. Single-tenant installs never see tenant UI
- Env flag `MULTI_TENANT_UI=true` exposes tenant signup, switcher, admin → tenants page
- Tenant resolver fallback: header (`X-Tenant`) for API clients, path prefix for dev (`/t/<slug>/...`)

**Risk:** RLS bug = cross-tenant leak. Mitigation: integration test suite running every endpoint as tenant A, asserting zero rows of tenant B's data leak. Run on every PR.

### Phase 2 — Extract `tickets` to a module (~1 week)
Refactor existing ticket code into `modules/tickets/` to prove plugin pattern with real code.

- New layout:
  ```
  core/                   # auth, users, RBAC, tenants, notifications, settings, branding
  modules/tickets/        # routes, models, migrations, ui — current ticket system
  shared/tenant-context/  # RLS middleware
  shared/audit-log/       # generic audit trail used by all modules
  ```
- `modules/tickets/module.json`: `{ name, version, requires, permissions, navItem, settings }`
- Boot loader globs `modules/*/routes/*.js`, registers under namespace
- Frontend lazy-loads `modules/*/ui` for tenant's enabled modules
- No behavior change for end users — pure refactor

### Phase 3 — `resolvd-assets` module v0 (~3-4 weeks)
First real plugin. Fixes Snipe-IT's consumable inventory gap as the headline draw.

**Schema:**
- `consumable` — sku, name, category, reorder_point, current_qty (computed)
- `consumable_lot` — purchase batch: cost, vendor, received_date, lot_qty, expiration
- `issuance_record` — to_user_id, qty, lot_id, ticket_id (FK to tickets module), issued_by, returned_qty, returned_at, notes
- `adjustment_record` — qty_delta, reason (received|disposed|count_correction|loss), notes, adjusted_by, at
- `asset` — serialized items (separate from consumables): asset_tag, model, status, assigned_to, location

**Wins over Snipe-IT consumables:**
- Returnable issuances (partial returns supported)
- Every quantity change has actor + reason + timestamp (full audit trail)
- Lot-aware: cost basis, expiration tracking
- First-class ticket FK: "issued 3 cables to ticket #4521" links cleanly
- Reorder alerts via existing notification system

**MVP UI:** consumables list + per-item history, asset list + check-in/check-out, issuance flow callable from a ticket detail page.

### Phase 4 — Plugin polish (~2 weeks)
- Module enable/disable per tenant in admin UI
- Permission system honors module-declared `permissions[]`
- Cross-module integrations: ticket detail shows linked assets/issuances; asset shows ticket history
- `module.json` becomes the contract for future third-party modules

### Phase 5 — Generic alert webhook ingestion (~2 weeks)
Direct receiver for monitoring tools. No Zapier middleman. First real "Resolvd as alert hub" capability.

**Status:** Zabbix preset shipped (live webhook + bidirectional API for backfill, full mapper + ingest pipeline + admin UI). Alertmanager + generic JSONPath mapper still pending.

**Endpoint:** `POST /api/webhooks/<preset>/<token>` — preset routes to payload mapper, token auths the source. Optional `X-Resolvd-Signature: sha256=...` HMAC deferred to v1.1.

**Tier 1 — ship at v1 (covers ~70% of installs):**
- ✅ `zabbix` — official Webhook media type (one-paste script template in admin UI), w/ optional API connection for backfill of currently-open problems
- `alertmanager` — Prometheus AlertManager v4 payload
- `generic` — schema-flexible mapper, JSONPath field selectors configurable in admin (covers anything with a JSON POST)

**Tier 2 — fast-follow (cover most remaining IT shops):**
- `grafana` — Grafana unified alerting (v9+) webhook contact point
- `uptime-kuma` — popular self-hosted uptime monitor
- `healthchecks` — healthchecks.io cron heartbeats
- `sentry` — error tracking webhooks
- `datadog` — Datadog webhook integration
- `github` — issue/PR/workflow run events (treat failed builds as alerts)
- `gitlab` — pipeline/issue events

**Tier 3 — community-contributable (long tail):**
- **Network monitoring:** `nagios`, `icinga2`, `checkmk`, `prtg`, `librenms`, `solarwinds`
- **APM / errors:** `newrelic`, `dynatrace`, `appdynamics`, `rollbar`, `bugsnag`, `raygun`, `honeybadger`
- **Uptime:** `uptimerobot`, `statuscake`, `pingdom`, `better-stack`
- **Security / SIEM:** `wazuh`, `crowdstrike`, `defender`, `elastic-security`
- **Cloud-native alerts:** `cloudwatch` (via SNS), `azure-monitor`, `gcp-monitoring`
- **Forward from on-call:** `pagerduty`, `opsgenie`, `victorops` (less common — usually Resolvd is *upstream* of these, but bidirectional sync requested)
- **Backup / infra:** `veeam`, `proxmox`, `vmware-vcenter`, `truenas`, `synology`, `unraid`
- **Network appliance:** `pfsense`, `opnsense`, `mikrotik`, `unifi`
- **CI/CD:** `jenkins`, `circleci`, `argocd`, `flux`

**Preset SDK:** Each preset = a single file under `modules/alerts-ingest/presets/<name>/index.js` exporting `{ matches(req), parse(payload) → NormalizedAlert, configHelp: string }`. Community PRs add presets without touching core. Each preset ships:
- Identifier (URL slug + display name)
- Payload mapper → normalized internal shape (`event_id`, `severity`, `summary`, `host`, `link`, `tags`, `status: firing|resolved`)
- Admin-UI config snippet (paste-ready into the source tool)
- Optional signature verifier (HMAC schemes vary per vendor)
- Test fixtures (sample real payload for round-trip testing)

**Normalized internal shape:** all presets emit the same struct so downstream logic (ticket creation, dedup, severity mapping) is preset-agnostic. Adding a preset = writing a parser, not touching the core ingestion path.

**Marketplace later:** once SDK is stable, third-party presets can ship as npm packages or repo-installed plugins. Same `module.json` contract from the modular plugin work.

**Mapper logic (Zabbix as reference):**
- `status=problem` → look up open ticket by `external_ref = zabbix:<event_id>`. Create new ticket if none, append severity-update comment if exists. `severity → priority` map admin-configurable.
- `status=recovery` → find ticket by external_ref, append recovery comment, optionally auto-resolve based on org pref.

**New tables:**
- `external_alert_source` — tenant_id, preset, token, secret, default_project_id, severity_map JSONB, auto_resolve_on_recovery, last_seen_at, enabled
- `external_alert_event` — source_id, external_event_id, ticket_id, raw_payload JSONB, received_at (dedup key + audit log)

**Tickets extension:** `external_ref TEXT`, `external_source TEXT`, indexed `(tenant_id, external_ref)` for dedup lookups.

**Admin UI:** Admin → Integrations → Alert sources. Add source, generate token (shown once, rotatable), copy webhook URL, paste-ready config snippets per preset. "Test fire" button sends synthetic event end-to-end. Recent 50 events shown for debugging.

**Why generic, not Zabbix-only:** same plumbing handles every other monitoring tool. Customers without Zabbix get value day one.

### Phase 6 — Scheduled ticketing (~2 weeks)
Recurring + deferred tickets. Two related capabilities, shared scheduler infrastructure.

**A. Recurring tickets (templates + cron):**
- `ticket_template` table — title, description, project_id, default_assignee, default_status, tags, severity, attachments
- `ticket_schedule` table — template_id, cron_expr (e.g. `0 9 1 * *` = first of month 9am), timezone, next_run_at, last_run_at, active, end_date (optional)
- Cron worker fires per tenant: when `next_run_at <= now()`, spawn ticket from template, advance `next_run_at` to next slot
- Common presets in admin UI: Daily, Weekly (pick day), Monthly (pick day-of-month), Quarterly, Annually, Custom cron
- Use cases: monthly server patching, quarterly access reviews, annual compliance checks, weekly site walks, daily startup checks

**B. Scheduled / snoozed tickets:**
- New ticket field: `scheduled_for TIMESTAMPTZ NULL`
- New semantic_tag: `scheduled` — ticket exists but is hidden from default queue + dashboard until `scheduled_for` arrives
- Cron worker fires per tenant: when `scheduled_for <= now()`, transitions ticket to `in_progress` (or admin-configured status), notifies assignee + followers, removes `scheduled` tag
- UI: "Schedule for…" action on ticket detail (datepicker + time + timezone). "Snooze" alias for personal scheduling. Bulk action support.
- Visibility: scheduled tickets surface in their own filter ("Scheduled") + on the assignee's calendar view (future).
- Use cases: defer non-urgent work, snooze waiting-on-vendor tickets to a follow-up date, create tickets in advance for known future events (project kickoffs, scheduled changes).

**Shared infrastructure:**
- Generalize the existing follow-up reminder cron (`pending_review`) into a unified `scheduled_jobs` table that all time-based features (recurring spawn, snooze wake, follow-up due, auto-close grace, alert recovery delay) flow through
- Single tenant-aware worker drains the table — easier to reason about than N separate cron paths

**Module placement:** core scheduler infrastructure in `shared/scheduler/`, recurring template UI + spawning in `modules/tickets/` (ticket-specific). Other modules (assets reorder reminders, alerts dedup windows) reuse the scheduler.

### Phase 7 — Mobile applications (long-arc)
Three-stage path. Each stage shippable, each builds on the prior.

**Stage 7a — PWA hardening (~1 week, low effort, high leverage)**
Already shipped: favicon doubles as PWA / iOS home-screen icon, web push via VAPID, service worker.
Remaining:
- Offline-first caching strategy (SWR for ticket lists, optimistic updates for comments)
- "Install app" prompt + onboarding for users who hit `resolvd.app` on mobile
- Background sync for queued comments when offline → online
- Push notification UX polish (deep-link from notification → specific ticket)
- iOS PWA quirks: status-bar styling, safe-area insets, scroll behavior

**Stage 7b — Capacitor wrapper (~2-3 weeks)**
Wrap existing PWA in a native shell. Ship to App Store + Play Store as `Resolvd` app.
- Capacitor.js wraps the React frontend, builds native iOS + Android binaries from same codebase
- **Native push:** APNs (iOS) + FCM (Android) replace web push on mobile (iOS web push is limited even in 2026). Backend gains `mobile_push_subscriptions` table alongside existing `push_subscriptions`.
- **Biometric unlock:** FaceID / TouchID / Android biometric for app re-entry
- **Native camera + photo library** access for attachment uploads (already works in browser, faster + better UX native)
- **Deep linking:** `resolvd://ticket/WEB-0079` schemes + universal/app links so notifications open the right view
- App Store + Play Store listings, screenshots, marketing copy, $99/yr Apple Dev + $25 once Google Play
- Auto-update via PWA refresh under the hood — no App Store re-review for non-native changes

**Stage 7c — React Native rewrite (3-6 months, when justified by usage)**
Only if Capacitor UX hits a ceiling. Indicators: users complain about scroll lag, gesture handling, list virtualization, native feel.
- Share business logic via an extracted `@resolvd/api-client` package (TypeScript) — used by web React, Capacitor, and React Native
- Rewrite UI in React Native components — `View`/`Text`/`FlatList` instead of HTML
- Native navigation (React Navigation) replaces react-router-dom on mobile
- Same backend API — zero server changes
- Web app stays React; only mobile gets RN. Two codebases, one shared client lib.

### What stays cross-platform from day one
Plan API surface assuming mobile clients exist:
- All endpoints REST + JSON (already true)
- Token auth path (not just session cookies) — API tokens roadmap item already noted
- Pagination + cursor support for list endpoints (mobile bandwidth)
- Compact response shapes — opt-in field selection / sparse fieldsets for mobile views

### Push architecture sketch
- Web: VAPID web push (already shipped)
- iOS Capacitor: APNs via Apple Push Notification service
- Android Capacitor: FCM
- Future RN: same APNs + FCM
- Backend `notifyPush(userId, payload)` fans out to whichever channels the user has registered devices for. Per-device record with `platform: 'web' | 'ios' | 'android'`, `endpoint`, `last_seen`. Stale endpoints auto-pruned (already pattern in place for web).

### Future modules (no timeline)
- `knowledge-base` — internal docs, customer-facing FAQ
- `change-management` — ITIL-style change requests with approval chains
- `time-tracking` — billable hours per ticket / asset
- `customer-portal` — external-facing ticket submission for end users

### Tenant resolution decision (to confirm)
- **Subdomain** (`acme.resolvd.app`) — preferred. Cleanest for SaaS, requires wildcard cert.
- Path prefix (`/t/acme/...`) — fallback for dev / cert-less deployments.
- Header (`X-Tenant`) — API clients only.

### What stays in core, what becomes module
**Core (always loaded):** auth, users, RBAC, tenants, branding, notifications, audit log, settings, email backend infrastructure.
**Module (toggleable):** tickets, assets, knowledge-base, change-management, time-tracking, customer-portal.

Notifications are core because every module fans events through it. Email backends are core because tenant-level (one Office 365 hookup serves tickets + asset reorder alerts).

### Out of scope for the public repo
SaaS-only concerns live in private `resolvd-cloud` repo, layered on top:
- Stripe billing / subscription model
- Tenant signup / provisioning automation
- Operator console (admin-of-admins)
- Hosted-tier feature gates
- Per-tenant rate limiting / abuse controls

## Conventions worth remembering

- **Semantic tags** drive workflow logic, names are admin-renamable. Always branch on `semantic_tag`, not `name`.
- **Side-state tags** (skipped from "Advance to next" button): `reopened`, `on_hold`, `awaiting_input`. From any of these the button resumes to the `in_progress`-tagged status.
- **Auto-close** uses `resolved_pending_close` + `auto_close_after_days`. Cleared on status leave.
- **Follow-up reminders** are scoped to `pending_review` only. Block status advancement while pending. Cleared on status leave or when the cron fires.
- **Reports always render absolute timestamps**; UI uses hybrid (relative <7 days, absolute after) — see `formatHybrid` / `formatAbsolute` in `frontend/src/utils/helpers.js`.
- **Vendor outbound** drops attachments on status-change events; only `new_ticket` and `new_comment` carry images.
