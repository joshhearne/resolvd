# Resolvd

![License: FSL-1.1-ALv2](https://img.shields.io/badge/license-FSL--1.1--ALv2-2da44e)

Internal issue and project tracking — keep every ticket in reach until it's closed.

## Stack

- **Frontend**: React + Vite + Tailwind CSS, light/dark theming with system match
- **Backend**: Node.js + Express
- **Database**: PostgreSQL 16
- **Auth**: Microsoft Entra ID, Google OAuth (Workspace + consumer), and/or local username/password (configurable). MFA per role.
- **Email**: OAuth-connected Microsoft 365 / Gmail mailboxes (per-account), or legacy SMTP/Graph-app/service-account fallbacks.
- **Encryption**: AES-256-GCM envelope encryption at rest (off / standard / vault). HMAC blind index keeps title search working under encryption.
- **Proxy**: nginx (Docker) + host reverse proxy or Cloudflare Tunnel.

---

## Quick Start

```bash
cp .env.example .env
# Fill in required values — see Environment Variables below
mkdir -p data/uploads
docker compose up -d --build
docker compose logs -f
```

The stack binds to `127.0.0.1:8090`. A host proxy (nginx, Caddy) or `cloudflared` tunnel handles TLS and forwards there.

---

## Environment Variables

### Core

| Variable | Required | Description |
|---|---|---|
| `POSTGRES_PASSWORD` | yes | Postgres password |
| `SESSION_SECRET` | yes | `openssl rand -hex 32` |
| `FRONTEND_URL` | yes | Public base URL (e.g. `https://issues.example.com`). Required for OAuth callbacks and inbox webhooks. |
| `COOKIE_SECURE` | yes | `true` when behind HTTPS |
| `PORT` | no | Backend port (default `3001`) |
| `UPLOADS_DIR` | no | Attachment dir (default `/data/uploads`) |
| `MAX_UPLOAD_MB` | no | Max attachment size (default `50`) |
| `COMPOSE_PROJECT_NAME` | no | Override Compose project (preserve volumes after dir rename) |
| `CLOUDFLARE_TUNNEL_TOKEN` | no | When set, the optional in-Compose `cloudflared` service runs the tunnel. Leave unset if you run `cloudflared` on the host instead (recommended — see [Host reverse proxy](#host-reverse-proxy)). |

### Microsoft Entra ID (login + email backend OAuth)

| Variable | Description |
|---|---|
| `AZURE_TENANT_ID` | Directory tenant ID |
| `AZURE_CLIENT_ID` | App Registration client ID |
| `AZURE_CLIENT_SECRET` | Client secret |
| `AZURE_REDIRECT_URI` | Login redirect (`https://yourdomain/auth/callback`) |
| `AZURE_ALLOWED_ORIGINS` | Comma-separated allowed origins |

The same App Registration powers SSO and OAuth-connected email backends. For email backends, also add `https://yourdomain/api/email-backends/oauth/callback` as a redirect URI and grant **delegated** API permissions: `User.Read`, `Mail.Send`, `offline_access`. For inbox monitoring add no extra perm — `Mail.Send` covers reading too in delegated context.

### Google OAuth (login + email backend OAuth)

| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_REDIRECT_URI` | Login redirect (`https://yourdomain/auth/google/callback`) |

Add `https://yourdomain/api/email-backends/oauth/callback` to the OAuth client's authorized redirect URIs for the email-backend flow. Workspace + consumer support is controlled in **Admin → Authentication** (`google_workspace_domain` + `google_allow_consumer`).

### Encryption

| Variable | Description |
|---|---|
| `RESOLVD_MASTER_KEY` | base64 of 32 random bytes. Required when `encryption_settings.mode` is `standard`. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Losing this key after enabling encryption permanently destroys access.** |

### Web Push (browser notifications)

| Variable | Required | Description |
|---|---|---|
| `VAPID_PUBLIC_KEY` | for push | Public VAPID key. Generate once with `npx web-push generate-vapid-keys`. |
| `VAPID_PRIVATE_KEY` | for push | Private VAPID key. Treat as a secret — never commit. |
| `VAPID_SUBJECT` | for push | `mailto:` or `https://` identifying the operator (e.g. `mailto:ops@example.com`). |

When unset, push silently no-ops; in-app and email channels are unaffected. Subscriptions live in `push_subscriptions`. HTTPS is required for browsers to register a service worker — Cloudflare Tunnel or a real cert works.

### Inbound email pipeline

| Variable | Description |
|---|---|
| `INBOUND_WEBHOOK_SECRET` | Required header value on `POST /api/inbound/generic` (`X-Inbound-Secret`). When unset, the endpoint refuses with 503. |
| `INBOUND_REPLY_TO` | Optional. When set, vendor outbound emails carry this address as `Reply-To` so vendor replies route to the inbound pipe. |
| `GMAIL_PUBSUB_TOPIC` | When using Gmail inbox monitoring: `projects/<gcp>/topics/<topic>`. Operators must grant `gmail-api-push@system.gserviceaccount.com` Publisher on the topic. |
| `GMAIL_PUBSUB_TOKEN` | Optional shared secret on `?token=` for Pub/Sub Push subscriptions. |

### Legacy email fallbacks

When no email backend account is connected via the UI, the app falls back to the legacy env-driven config:

| Variable | Description |
|---|---|
| `MAIL_FROM` | Sender address for Graph app-only flow |
| `SMTP_HOST/PORT/USER/PASSWORD/SECURE/FROM` | SMTP fallback |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Workspace service account JSON for Gmail API fallback |

Recommend connecting an OAuth backend through `/admin/email-backends` instead of using these — Microsoft and Google are deprecating SMTP basic auth and shared-credential flows.

---

## Authentication

Configurable at runtime in **Admin → Authentication**:

- **Local** — username/password with Argon2, lockout after 8 failed attempts
- **Microsoft Entra ID** — SSO via MSAL
- **Google OAuth** — Workspace, consumer, or both. Domain enforcement when `google_workspace_domain` is set; `google_allow_consumer` widens to consumer Gmail.

MFA (TOTP) can be enforced per role. Recovery codes generated on enrollment.

### First-time setup (bootstrap)

Fresh install with local auth enabled shows a **Create Admin Account** form. First user becomes Admin. Subsequent users are invited by Admin or Manager.

---

## User Roles

| Role | Permissions |
|---|---|
| **Admin** | Everything — branding, auth, encryption mode, support grants, email templates, email backends, status workflows, all Manager actions |
| **Manager** | Projects, users, tickets, exports, invites, vendor companies/contacts, comments + attachments, vendor-visible comments, delete any comment |
| **Submitter** | Create tickets, comment, follow, upload attachments |
| **Viewer** | Read-only |
| **Support** | External support principals — every request blocked unless an active grant exists (see "JIT support access") |

---

## Projects

- Tickets are scoped to projects
- Projects can be marked with or without an external vendor — when off, the External Vendor section, vendor outbound, and Team-Input blocker are hidden
- Each project has a prefix used for ticket references (e.g. `WEB-0042`). The same prefix powers email-to-ticket auto-create.
- **Default assignee**: Admin/Manager can pick a default assignee per project. New tickets in that project auto-assign to the chosen user when the creator doesn't pick one. Eligible: Admin / Manager / Submitter.
- **Bulk add members**: project member panel takes a multi-select picker with search and "Select all" — pick a role override once, apply to every chosen user. Capped at 500 per call.
- **Auto-add new users**: per-project toggle. When on, every newly-activated user (SSO first login or invite acceptance) is added as a member here. Use it for org-wide queues like the helpdesk / incident project where every employee should be able to file or follow.
- **Move tickets**: any role can move a ticket between projects they have access to. Admin/Manager can move to any project; Submitters need membership of both source and target. The ticket gets a fresh `internal_ref` from the new project's counter; vendor contacts detach (vendor scope is project-bound).
- **Cross-project visibility**: per-project tri-state controls for `@mentions` autocomplete/resolution and the "add follower" picker — `Inherit` (org default), `Restrict to project members`, or `Open to all users`. Org defaults live in **Admin → Branding → Cross-project visibility** (both default ON / restricted). Admins (global role) bypass these gates.

---

## Ticket workflow

### Statuses and the chain

Internal statuses ship with semantic tags that drive workflow logic (admin can rename the names without breaking behavior):

| Tag | Default name | Role |
|---|---|---|
| _none_ | Open | Initial |
| `in_progress` | In Progress | Active work |
| `awaiting_input` | Awaiting Input | External block (waiting on vendor / customer) |
| `on_hold` | On Hold | Internal block (team can't proceed) |
| `pending_review` | Pending Review | Awaiting verification |
| `resolved_pending_close` | Resolved | Verified, in grace period before auto-close |
| _none_ (terminal) | Closed | Done |
| `reopened` | Reopened | Resumed after closure / auto-reopen |

**Advance button** on the ticket status card walks the chain `Open → In Progress → Pending Review → Resolved → Closed`. Side states (`awaiting_input`, `on_hold`, `reopened`) are skipped from the next step; from any of them the button resumes to `in_progress`.

### Resolved auto-close

Any internal status with `semantic_tag='resolved_pending_close'` carries an `auto_close_after_days` value (default 3 on the seeded `Resolved` row, edited per status under **Admin → Statuses**). Tickets sitting in such a status past the grace period get promoted to the kind's terminal status by an hourly cron, with an audit row.

Inbound email replies during the grace window, and web UI comments on any terminal ticket, auto-reopen the ticket unless the body matches the editable gratitude phrase list (also under **Admin → Statuses**). "Thanks" → leave alone. Anything substantive → flip to `Reopened`. This covers the case where a ticket is closed in someone else's name and the actual reporter follows up with a still-open issue. Auto-reopens also fire a `ticket_reopened` vendor outbound email if the ticket has attached contacts and they have been previously contacted.

### In-app notifications

All authenticated users (Admin, Manager, Submitter, Viewer, Support) see the notification bell. Clicking a notification navigates to the relevant ticket. Mention notifications scroll to and flash the specific comment so the user lands on the exact context, not just the page.

Notification types:

| Event | Who receives |
|---|---|
| `mention` | The @mentioned user (in-app + email + opt-in browser push) |
| Followed-ticket comment | All followers (email) |
| Followed-ticket status change | All followers (email) |
| Assignment | Assigned user (email + opt-in browser push) |
| Follow-up reminder | Followers of the ticket (in-app + email) |

### Pending Review follow-ups

Any internal status with `semantic_tag='pending_review'` accepts a follow-up reminder (1–90 days, default 3). Click "Schedule follow-up" on the ticket; an in-app notification + email fire when the timer elapses. Status advancement is blocked while a reminder is pending — cancel it or wait for it to fire (then ack via the bell tray) before moving on. Another reminder can be scheduled afterwards.

### SLA tracker

Two clocks per ticket: **response** (closes when someone other than the submitter posts a non-system comment) and **resolve** (closes when `resolved_at` is set). Targets come from `sla_policies` keyed on `priority` (org default) or `priority + project_id` (project override beats default). Default policies seeded P1 30m/4h, P2 1h/8h, P3 4h/24h, P4 8h/72h, P5 1d/7d — admins tune them at **Admin → SLA policies**.

Both clocks **pause** when the ticket transitions into a status tagged `awaiting_input` or `on_hold` (vendor / customer wait time doesn't count against you), and **resume** on transition out — the due-at timestamps shift forward by the paused duration. A 5-minute breach scheduler flips the breached flag + stamps the breach timestamp + fans out via the `sla_breach` notification event (in-app + immediate email — bypasses the digest cadence since breaches are action-required) to assignee + followers + submitter, deduped.

The dashboard gets a **SLA — Month to date** card: stat tiles for MTD response/resolve breach counts, currently-breached count (clickable to a filtered ticket list), open-with-SLA-clock count, plus a per-project breakdown table when MTD breaches exist. Admin / Manager see "All projects"; Submitter / Viewer see only their `project_members` rows. Empty-state collapses to a single line.

### Other ticket admin tools

- **Submit on behalf**: Admin/Manager can pick a different submitter at creation time, or change the submitter on an existing ticket.
- **Manage followers**: Admin/Manager can add / remove followers via a popover next to the Follow button (audited).
- **Inline title edit**: anyone with edit access (Admin / Manager / Submitter) can rename a ticket from its header.
- **@mentions**: type `@` in the comment box to open a dropdown scoped to members of the ticket's project. Up/Down to navigate, Right arrow or Enter to inject the token, Escape to dismiss. Token format: `@first.last` derived from the user's display name. Matched users auto-follow the ticket and receive an in-app notification + best-effort email (gated by recipient's `email_on_comment` preference).
- **Ctrl+Enter posts a comment** (per-user pref).
- **Bulk Edit** (Admin only): button next to the "Tickets (##)" header swaps the search bar + New Ticket button for an action bar (Status / Assignee / Project) and adds a checkbox column. Select up to 500 rows, pick the fields to change, hit Apply. Each ticket is updated in its own transaction (one failure doesn't roll back the batch), audited, and assignment / status-change notifications fan out per recipient prefs. Vendor outbound is skipped for bulk to avoid noise — fire per-ticket if needed. Project moves re-issue `internal_ref` and detach vendor contacts (mirrors single-move semantics).
- **Merge tickets** (Admin only): search-driven picker by ticket reference (e.g. `WEB-0042`), title, or description — no more guessing numeric IDs. Inline from a ticket (the current ticket is pre-filled as one side; pick the partner) or standalone via **Admin → Merge tickets** with both sides empty. Direction is chosen with a "Swap winner ⇄" toggle, not by which ticket you opened first. Comments, attachments, audit history, vendor contacts, and followers reassign to the winner; loser is closed with a pointer.

---

## User preferences

`Account settings → Preferences` exposes per-user toggles. Store: `users.preferences` JSONB with merged defaults from `/api/users/me/prefs`.

| Pref | Default | Effect |
|---|---|---|
| `scope_follows_filter` | on | "+ New Ticket" from a filtered list preselects that project |
| `ctrl_enter_to_post` | on | Ctrl+Enter posts a comment |
| `auto_follow_on_comment` | on | Posting a comment auto-follows the ticket |
| `confirm_before_close` | off | Post & Close prompts before firing |
| `default_ticket_sort` | Recently updated | Initial sort on the ticket list |
| `email_on_comment` | on | Email on followed-ticket comments |
| `email_on_status_change` | on | Email on followed-ticket status changes |
| `email_on_assignment` | on | Email when a ticket is assigned to you |
| `push_on_assignment` | off | Browser push when a ticket is assigned to you (requires enabling browser notifications first) |
| `push_on_mention` | off | Browser push when you're @mentioned in a comment (requires enabling browser notifications first) |
| `date_style_override` | inherit | Override org date style (`iso` / `us` / `eu`); empty = follow Branding admin |
| `time_style_override` | inherit | Override org time style (`iso` / `12h`); empty = follow Branding admin |
| `timezone_override` | inherit | Override org timezone (any IANA zone); empty = follow Branding admin |
| `compact_mode` | off | Tighter padding + smaller font |

### Browser push notifications

Per-device opt-in lives in `Account settings → Preferences → Browser notifications`. First enable prompts the browser for notification permission and registers a Web Push subscription against the backend (multi-device — each browser is its own row in `push_subscriptions`). Stale endpoints (HTTP 410 Gone from the push service) are auto-pruned on next send. Requires `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` env vars; generate once with `npx web-push generate-vapid-keys`.

---

## Companies (CRM)

Resolvd's CRM is multi-modal. **Admin → Branding → Company modes** toggles which kinds are active:

| Kind | Default | Use case |
|---|---|---|
| **Vendor** | on | External party you escalate to (printer vendor, ISP, software support). Project-scoped; drives existing vendor outbound + inbound flows. |
| **Customer** (MSP) | off | External party you serve. One customer can map to multiple projects (helpdesk + infra + security). Off by default — flip on for MSP installs. |
| **Internal** | on | Your own org units (Internal IT, DevOps, departments). Members are Resolvd users, optionally pinned to a Location. |

**Admin → Companies** is master-detail (account list left, selected company detail right). Detail tabs vary by kind:

- **Vendor**: Contacts, Locations, Notification prefs
- **Customer**: Contacts, Locations, Linked projects (multi-select)
- **Internal**: Members (Resolvd users + optional location + role label), Locations

### Locations

Available on all kinds. Track sites with `name`, optional `location_code` (HQ, EAST), `address`, `timezone`, `phone`, `is_primary`, and `use_extensions`.

When a contact is created against a location whose `use_extensions=true` AND has a phone number, the contact form locks the phone field to the location's number and asks only for an extension. If `use_extensions=false` or there's no location phone, you provide a DID phone manually. Contact rows render as `(555) 123-4567 ext. 1234`.

Locations are soft-archived — deleting preserves contact `location_id` references.

### Members (internal companies)

Internal kind tracks which Resolvd users belong to that org unit, with optional location assignment and a free-text role label. Single source of truth for "who's on the IT team" / "who's in DevOps".

#### Auto-join by email domain

Each internal company carries an `auto_add_domains` list (e.g. `acme.com, acme.co.uk`). On any user activation event — SSO first login, invite acceptance — Resolvd matches the user's email domain against every internal company's list and auto-adds matching users to `company_members`. Idempotent. Saving an updated domain list also retroactively syncs existing matching users.

Match is exact apex (no subdomain wildcards). List both `acme.com` and `dev.acme.com` if you need both.

### Contacts

External-kind companies (vendor + customer) carry contact lists:

- **Contacts** belong to a company, optionally pinned to a location for routing + extension pre-fill. Name, email, phone, extension, role/title — all encrypted under standard mode. Email is also HMAC'd into a blind index for inbound webhook lookup.
- **Generic mailboxes** (`support@`, `helpdesk@`, `noreply@`, …) are rejected at write time to prevent reply loops with the vendor's helpdesk. The list is extensible per-workspace via `auth_settings.email_blocklist`.
- **Tickets** can attach contacts. Attached contacts receive vendor-visible comments and can be CC'd in inbound creation flows.

### Vendor outbound (admin-curated)

Comments marked **Share with vendor** by an Admin/Manager fire an outbound email per attached contact, rendered through an admin-editable template (see "Email templates"). Outbound carries:

- `Auto-Submitted: auto-generated`
- `X-Resolvd-No-Reply: 1`
- `Reply-To: $INBOUND_REPLY_TO` when configured (defaults to the connected mailbox's `from_address` so replies always loop back to the system)

so vendor helpdesks don't auto-reply and reflective loops are dropped on ingest.

**From identity.** The `From` address is always the connected mailbox (e.g. `resolvd@motorhomesoftexas.com`). The acting human rides as the display name in the `Actor via SiteName` convention — `"Josh Hearne via Resolvd" <resolvd@…>`. Outlook, Gmail, and anti-spoof gateways (Inky VIP, Mimecast Impersonation Protect, Proofpoint) recognize `via` as legitimate proxied mail and don't override the display name with a directory match. No Exchange "Send As" permission required.

**Reply-above-this-line marker.** Every vendor outbound prepends a visible `--- Type your reply above this line — ticket {ref} ---` divider. The inbound parser cuts at the marker so quoted history, mail-client headers, and signatures drop automatically — the comment ends up as exactly what the vendor typed.

**Comment pills.** Vendor-visible comments show a brand-colored `TO VENDOR` pill. Inbound vendor replies (auto-ingested via email match) show a `FROM {company}` pill in a deterministic per-vendor color hashed from the company id — same vendor, same color across renders, sessions, and users. Hue spread is theme-aware (pastel + dark text on light, muted dark + light text on dark) so multiple vendors on one ticket stay readable.

Images attached to the ticket are included as file attachments only on the `new_ticket` and `new_comment` events. Status-change and resolved emails send body text only — keeps the inbox light when a ticket churns through several states (Graph, SMTP, and Gmail backends all supported).

The `new_ticket` event is **not** fired automatically on ticket creation. An Admin/Manager must click the **Notify Vendor** button on the ticket detail page to send the initial vendor notification. This gives staff a chance to review the ticket before contacting the vendor.

Status-change and resolved notifications are only sent if the vendor has already been contacted (i.e. a `new_ticket` or vendor-visible comment outbound succeeded at least once — stamped on `tickets.vendor_notified_at`). Attaching contacts to a ticket does not automatically enroll them in status updates.

### Per-company notification preferences

Each company in **Admin → Companies** has a notification preferences panel controlling which automated emails that company's contacts receive:

| Toggle | Default | Behaviour |
|---|---|---|
| Status change notifications | on | Fires on `status_change` events |
| Filter to specific statuses | (all) | Uncheck "All statuses" to select individual status names |
| Ticket resolved | on | Fires on `ticket_resolved` |
| Ticket reopened | off | Fires on `ticket_reopened` (auto-reopen or manual reopen) |

`new_ticket` and `new_comment` always send regardless of company preferences — those are explicitly triggered by staff.

### Send As

When an Admin or Manager sends a vendor-visible comment or clicks **Notify Vendor**, the system prompts a **Send As** choice so vendor correspondence stays attributed to a real person.

**Ticket has a submitter (and the actor isn't them):**
- **Send as me** — outbound uses the acting Admin's name/email
- **Send as submitter** — outbound uses the ticket's original submitter as the sender identity

**Ticket has no submitter** (e.g. imported tickets, omitted submitter field):
- **Send as** — pick any project member; outbound uses their identity once. Ticket unchanged.
- **Submit as** — pick any project member; ticket's `submitted_by` is backfilled and the email goes out under their name. Best for cleaning up imports.

Goal: drop the rate of vendor mail leaking out under the system's `MAIL_FROM` fallback.

### Mute vendor + daily digest

Each ticket has an **Auto-mute vendor replies** toggle. When on, matched vendor replies still land in the thread but with `is_muted=true`; the UI collapses them into a "N muted vendor replies" bucket. Followers don't get paged.

A **daily digest** at the configured local time (default 15:00 in `auth_settings.muted_digest_timezone`) catches up every follower with a summary of muted replies in the prior 24h. Admin/Manager can un-mute any single comment to bring it back into the main thread.

---

## Email-to-ticket ingestion

Authorized internal users (Admin/Manager/Submitter) can create tickets by emailing the inbound mailbox with a subject prefixed `#PREFIX`:

```
To:      inbound@yourdomain.com
Cc:      jane@vendor.com
Subject: #WEB Login button crashes on submit
Body:    Steps to reproduce: ...
```

Behaviour:

- **`#WEB`** matches the project with prefix `WEB`
- **Sender** must be an active internal user with role Admin/Manager/Submitter (matched by email). Otherwise the row stays in the unmatched queue with `reject_reason: sender_not_authorized`.
- **Body** is signature-stripped (RFC 3676 `-- `, "On <date> wrote:", Outlook quoted headers, mobile sigs) before becoming the ticket description
- **Attachments** are persisted with the same encrypted-at-rest treatment as direct uploads
- **CC** addresses that match an existing active contact in the project auto-attach to the ticket. Unknowns are recorded on the queue row's `reject_reason: unknown_cc:...` for admin curation.
- **Confirmation email** goes only to the originator — CCs are never re-mailed by the auto-create flow

### Dedup

Before auto-creating, the inbound flow checks for duplicates:

1. **exact** — same project + same submitter + open ticket created in the last 7 days + identical title (case-insensitive). Email body is appended as a comment on the existing ticket; no new ticket is created.
2. **similar** — same project + open ticket from the last 24h whose title shares ≥80% of meaningful tokens. Auto-create bails; the row stays in the unmatched queue with `reject_reason: possible_dup:TICKET_REF` so an admin decides.

Anything that doesn't match the `#PREFIX` rule, or fails project/sender checks, falls through to the existing manual-match queue at **Admin → Inbound**.

### Provider adapters (auto-fed inbound)

For each connected OAuth email backend, an admin can toggle **Monitor inbox** in `/admin/email-backends`:

- **Microsoft Graph** — creates a `/subscriptions` resource pointed at `/api/inbound/graph`, validates with `clientState`, renews every ~70h
- **Gmail** — calls `users.watch` with the configured Pub/Sub topic, resumes on `historyId`, renews every 7 days

The renewal scheduler runs hourly and re-issues any subscription within 12h of expiry. Without these adapters, you can still pipe email into the system manually via the generic webhook (`POST /api/inbound/generic`).

---

## Email backends

**Admin → Email backends** lets an admin connect outbound mailboxes:

- **Microsoft 365** — OAuth flow, MFA handled by Microsoft. Refresh token encrypted under the workspace key.
- **Gmail** — OAuth flow, same shape.
- **SMTP** — legacy form for self-hosters. Use Gmail/Workspace App Passwords (`smtp.gmail.com:587`, STARTTLS, 16-char app password) when SMTP is the only option.

The active account is enforced single-row by a partial unique index. Token refresh runs automatically before expiry.

### Project scope (helpdesk routing)

Each connected mailbox can be scoped to one or more projects via **Admin → Email backends → {account} → Project scope**. Many-to-many with per-direction toggles (`send`, `recv`).

- **Multiple-project scope**: inbound mail still requires `#PREFIX` in the subject; scope just authorizes the mailbox to dispatch outbound for those projects.
- **Single-project scope** (helpdesk pattern): inbound mail with no `#PREFIX` auto-creates tickets in that one project. Mailbox = dedicated queue. Because this is high-power config, an Admin must approve before auto-routing activates — Manager-created single-scope assignments fire an Admin notification ("Approve mailbox scope"). Until approved, inbound falls back to the existing `#PREFIX` flow.
- **Outbound resolution**: `sendMail({ projectId })` prefers a `send_enabled` scoped account for that project, falls through to the global active account otherwise. Vendor outbound, follower notifications, and assignment emails all pass `ticket.project_id` so per-project sender identities work end-to-end.

Sender authorization on the inbound side still applies: the sender must be a Submitter+ user (Admin/Manager/Submitter). External-customer auto-create through a scoped helpdesk inbox is a separate feature (planned).

### Inbound banner stripping (per account)

Mail-security gateways (Inky, Mimecast, Proofpoint, Avanan) inject recipient banners on inbound mail flagging external/first-time/VIP senders. The banner sits **above** the user's reply, so cutting at it would discard real content. Per-account banner-strip patterns let the admin remove banners inline before the body lands in the queue.

**Try the gateway first.** If the connected inbox is a licensed resource mailbox (no human user), most gateways let you suppress recipient banners per-mailbox while keeping malware/phishing scans active. That's cleaner than regex stripping.

When upstream suppression isn't an option, **Admin → Email backends → {account} → Inbound banner stripping** accepts a list of regex patterns (one per line, applied case-insensitive multi-line). Preset buttons drop in the known regex for Inky, Mimecast, Proofpoint, and Avanan.

### Email templates

**Admin → Email templates** — admin-editable subject + body per `(event_type, audience)` with click-to-insert tag chips:

```
{vendor.name}        {vendor.contact}        {vendor.contact_email}
{ticket.ref}         {ticket.title}          {ticket.description}
{ticket.status}      {ticket.priority}       {ticket.url}
{ticket.reply}       {ticket.replies.N}      (last N vendor-visible comments, 1..20)
{actor.name}         {site.name}             {site.url}
```

Internal-only comments never leak through `{ticket.replies.N}` — the renderer filters on `is_external_visible=true`.

Seeded events: `new_ticket`, `new_comment`, `status_change`, `ticket_resolved`, `inbound_matched`, `ticket_created_via_email`.

---

## Markdown formatting

Comment bodies and ticket descriptions support **GitHub Flavored Markdown** (GFM). The editor has Write and Preview tabs with a formatting toolbar.

**Toolbar actions**: Bold, Italic, Inline code, Code block, Heading, Bullet list, Numbered list, Blockquote, Link.

**Keyboard shortcuts**: `Ctrl+B` bold · `Ctrl+I` italic · `Ctrl+`` ` inline code · `Ctrl+Enter` post comment.

On mobile, the toolbar collapses to the most-used tools (Bold, Italic, Code, Code block, Bullet list); the full toolbar is available at `sm:` breakpoint and wider.

The comment box uses the same mention-aware textarea as before — @mention autocomplete works inside the markdown editor.

---

## Help & Documentation

A built-in **Help** page (`/help`, linked in the nav) provides role-aware documentation for every section of the app:

- Content is filtered to the logged-in user's global role — irrelevant sections show access-denied banners rather than being hidden entirely, so users understand what exists and who to ask
- Each feature row lists which roles can use it, or shows **All roles** when universal
- Warns Submitter/Viewer/Support where features are restricted, and notes project-level role overrides where applicable
- Includes a **Support Access** section explaining the JIT grant workflow for Support-role users
- Screenshots in every section render via the `<HelpScreenshot>` wrapper — real PNGs live under `frontend/public/help/<slug>.png` and fall back to a dashed placeholder when an image is missing (useful while shots are being authored or reshot)

---

## JIT support access

Resolvd's "support deposit box" model. Users with role `Support` are blocked on every API request until an Admin approves an active grant.

- **Workflow**: support files a request → admin approves with a TTL (1..14 days, default 3) → grant activates with `expires_at` → grant lapses automatically when the clock crosses `expires_at`. Admin can revoke at any time.
- **Audit log**: every fine-grained read by a support principal (ticket views, attachment downloads) lands in `support_access_log` and is visible at **Admin → Support access → Access log**.
- **Read-only by default**: `scope='read'` blocks non-GET methods even with an active grant; `scope='read_write'` opens up.

---

## Encryption at rest

`encryption_settings.mode` controls behaviour:

- **off** (default) — plaintext storage; identical behaviour to a non-encrypted deployment
- **standard** — server-managed master key wraps per-row data encryption keys (envelope, AES-256-GCM, AAD bound to `<table>.<col>`). Sensitive columns (ticket title/description/notes, comment bodies, audit_log values, attachment names + on-disk file bytes, vendor company/contact details, OAuth refresh tokens, SMTP passwords, inbound queue subject/body) all encrypt. HMAC blind index on `tickets.title_blind_idx` keeps word-equality search working.
- **vault** — customer-held key (browser-derived). Reserved for zero-knowledge tenants. Schema supports it; UI flow not yet shipped.

### Enabling Standard mode

```bash
# 1. Generate a key and add to .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
echo "RESOLVD_MASTER_KEY=$KEY" >> .env

# 2. Force-recreate so .env reloads
docker compose up -d --force-recreate backend

# 3. Flip the mode
docker compose exec postgres psql -U resolvd -d resolvd \
  -c "UPDATE encryption_settings SET mode='standard' WHERE id = 1;"

# 4. Backfill existing rows (idempotent; --verify on first run)
docker compose exec backend node /app/scripts/encrypt-backfill.js --verify
```

The backfill encrypts plaintext into `*_enc` shadow columns, NULLs the plaintext under standard mode, populates `title_blind_idx`, and encrypts attachment file bodies on disk.

**Honest scope**: outbound email content goes in cleartext to recipients (unavoidable — recipient has no key). Encryption-at-rest is a server-side discipline, not E2EE.

---

## Theming and Branding

- **Light / Dark mode** — Light, Dark, or Auto (matches OS) from the user menu. Persists in `localStorage`.
- **Custom accent color** — Admin → Branding has a "Use custom accent color" toggle.
- **Logo orientation** — admins pick whether the logo "works best with Light Mode" or "Dark Mode"; the app smart-flips when displayed in the opposite mode.
- **Favicon & home-screen icon** — Admin → Branding accepts a custom square PNG (recommended 512×512, minimum 192×192) used for the browser tab favicon, iOS home-screen icon (Safari → Add to Home Screen), and Android PWA install icon. Served at `/api/branding/favicon`; the dynamic web app manifest at `/api/branding/manifest` references it for installs. Removing the upload reverts to the default Resolvd favicon.
- **Print export** — always renders in light mode regardless of UI theme.
- **Localization** — Admin → Branding sets org-wide date style (ISO / US / EU), time style (24-hour / 12-hour), and IANA timezone. UI uses hybrid rendering (relative if <7 days, absolute after); reports / CSV exports always render absolute timestamps.

---

## Host reverse proxy

The Docker stack does not terminate TLS. The bundled `nginx` service is plain HTTP only — it does not mount any certs (the `nginx/certs/` path is gitignored, so a cert volume on a fresh clone would point at nothing). Terminate TLS upstream with one of:

- **Cloudflare Tunnel (host-based, recommended)** — run `cloudflared` as a host service (systemd) pointing at `http://localhost:8090` (or `localhost:80` if a host nginx fans out by `Host` header for multiple apps). Keeps the tunnel out of the Compose lifecycle so `docker compose down` doesn't drop it, and lets one tunnel front several stacks.
- **Cloudflare Tunnel (in-Compose)** — set `CLOUDFLARE_TUNNEL_TOKEN` in `.env`; the optional `cloudflared` service in `docker-compose.yml` runs the tunnel inside the stack. Simpler for single-app deployments.
- **nginx / Caddy** — forward HTTPS to `127.0.0.1:8090`. Sample nginx config in `nginx/host-proxy.conf`.

```nginx
server {
    listen 443 ssl;
    server_name issues.example.com;
    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## Backup

Postgres data lives in the `<project>_pg-data` volume. Encrypted ciphertext backs up exactly the same as plaintext — but **the master key is not in the dump**. Lose `RESOLVD_MASTER_KEY` and your backup is unrecoverable.

```bash
docker compose exec postgres pg_dump -U resolvd resolvd > backup-$(date +%Y%m%d).sql
```

Restore:

```bash
docker compose exec -T postgres psql -U resolvd resolvd < backup.sql
```

Uploaded files (encrypted on disk under standard mode):

```bash
docker run --rm -v issues_uploads-data:/src:ro -v "$(pwd)":/dst alpine \
  tar czf /dst/uploads-$(date +%Y%m%d).tar.gz -C /src .
```

**Always back up `RESOLVD_MASTER_KEY` separately** to a password manager / KMS / sealed envelope.

---

## Admin layout reference

Admin uses a left-rail grouped sidebar (mobile collapses to a hamburger that auto-closes on selection). Manager role sees a subset (Users, Companies, Inbound email, System health, Export); Admin sees everything.

| Group | Item | Role | Purpose |
|---|---|---|---|
| **People** | Users | Admin/Mgr | Invite, role, MFA, status |
| | Companies | Admin/Mgr | Multi-modal CRM (vendor / customer / internal) — see [Companies](#companies-crm) |
| | Support access | Admin | JIT grants — approve, revoke, deny, view access log |
| **Workflow** | Statuses | Admin | Internal/external status workflow |
| | Canned responses | Admin/Mgr | Reusable comment templates with tag substitution + project scope — see [Canned responses](#canned-responses) |
| | Merge tickets | Admin | Search-driven picker for merging two tickets |
| **Integrations** | Alert sources | Admin | Inbound webhooks from monitoring tools (Zabbix today; Alertmanager + generic next) — see [Alert sources](#alert-sources-monitoring-integrations) |
| | Inbound email | Admin/Mgr | Manual-match queue, with auto-create reject reasons surfaced |
| | Email backends | Admin | Connect M365/Gmail via OAuth, SMTP fallback, monitor inbox toggle |
| | Email templates | Admin | Tag-substitution editor + preview + test-send |
| **Site** | Branding | Admin | Site name, logo, favicon / home-screen icon, accent color, company-mode toggles |
| | Authentication | Admin | SSO providers, MFA enforcement, email blocklist, digest schedule |
| | Encryption | Admin | Mode reference + Standard-mode runbook |
| **Data** | System health | Admin/Mgr | Scheduler heartbeats, integration last-seen, key counts, DB stats — see [System health](#system-health) |
| | Export | Admin/Mgr | Bulk PDF/print export and CSV download; toggle to include/exclude images |

### Page width + tables

- Pages opt into a width via `<PageShell variant="wide|standard|narrow">` (`Layout.jsx` no longer caps to `max-w-7xl`). Lists/dashboards use `wide`; ticket/project detail uses `standard`; settings forms use `narrow`.
- The ticket list table supports per-user **column visibility** via the ⚙ Columns popover. Hidden column ids persist to `users.preferences.hidden_columns.tickets[]`. Ref + Title are always-on. Reusable component (`<ColumnPicker>` + `useColumnPrefs(tableKey)` hook) ready for other tables.
- Tables wrap in `overflow-x-auto` so horizontal scroll handles overflow on narrow viewports.

---

## Alert sources (monitoring integrations)

**Admin → Integrations → Alert sources** turns Resolvd into a direct receiver for monitoring webhooks. No Zapier middleman.

Each source has:
- A **preset** (Zabbix today; Alertmanager / generic JSONPath fast-follow)
- A **token** (hashed at rest; raw token shown once on create + rotate)
- A **default project** + optional default assignee
- A configurable **severity → priority** map (preset defaults preloaded; reset button)
- An **auto-resolve on recovery** toggle
- An optional **API connection** (URL + encrypted token) for backfill of existing open problems

### Live ingestion

`POST /api/webhooks/<preset>/<token>` — token-auth via URL, no session. The mapper for the preset normalizes the payload. Behavior:

- **`event_status=problem`** — dedups by `external_ref = '<preset>:<event_id>'`. Existing open ticket → severity-update comment. New event → creates a ticket in the source's default project, severity → priority via the configured map.
- **`event_status=recovery`** — finds the open ticket by `external_ref`, appends recovery comment, optionally auto-resolves to the first `resolved_pending_close` status.
- **`user_email`** — when supplied (e.g. Zabbix `{INVENTORY.POC.PRIMARY.EMAIL}`), Resolvd looks up an active local user by that email; matched users are stamped as both `submitted_by` and `assigned_to`, auto-followed for notification fan-out. Unmatched emails surface in the ticket description and an `alert_unmatched_contact` audit row so they can be re-attributed once the user signs in.
- **Dedup**: `UNIQUE(source_id, external_event_id, event_type)` blocks dup tickets from Zabbix retries.
- **Audit**: every event (deduped or not) lands in `external_alert_event` with the raw payload for debugging.

### Zabbix media-type setup

The source detail page renders a copy-able JS snippet for Zabbix's Webhook media type. Required parameters set in the Zabbix media-type Parameters tab:

```
event_id        {EVENT.ID}
event_status    {EVENT.VALUE}        # 1 = problem, 0 = recovery
severity        {EVENT.SEVERITY}
host_name       {HOST.NAME}
trigger_name    {TRIGGER.NAME}
trigger_description  {TRIGGER.DESCRIPTION}
operational_data     {EVENT.OPDATA}
event_tags      {EVENT.TAGS}
event_url       {$ZABBIX.URL}/tr_events.php?triggerid={TRIGGER.ID}&eventid={EVENT.ID}
user_email      {INVENTORY.POC.PRIMARY.EMAIL}
```

Replace `<your-token>` in the snippet with the source's token, paste into Zabbix → Administration → Media types → Webhook → script, then create an Action that scopes to the host group(s) you want ticketed.

### Backfill of currently-open problems

When the source has an `api_url` + `api_token` set, the source detail page exposes a **Backfill open problems** button (with optional host-group filter). Resolvd calls Zabbix's `problem.get` + `event.get` (selectHosts) + `host.get` (selectInventory: poc_1_email), normalizes each row to a synthetic webhook payload, and ingests via the same pipeline as a live fire. Idempotent. Bearer auth tried first; falls back to legacy `auth` field for older Zabbix.

API tokens grant read of all monitored data — treat as prod creds. Encrypted at rest under the workspace key.

### Tickets carry the alert ref

Two new togglable columns on the ticket list:

- **Vendor ref** — `external_ticket_ref` (existing field, now exposed)
- **Alert ref** — `external_ref` (`zabbix:1234567`)

Both render with the same NATO phonetic readback popover as the internal ref, so ops can read codes verbatim over the phone.

---

## Canned responses

**Admin → Workflow → Canned responses** — saved comment templates for repeat replies. Two scopes (mix freely):

- **Global** — Admin/Manager-managed, visible to everyone
- **Personal** — your own; only you see them

Each response also has a project scope (default **All**, or pick specific projects) so the picker on a ticket only shows relevant entries.

### Tag substitution

| Tag | Resolves to |
|---|---|
| `{ticket.ref}` / `{ticket.title}` / `{ticket.priority}` / `{ticket.url}` | Current ticket |
| `{ticket.vendor_ref}` | `external_ticket_ref` |
| `{submitter.name}` / `{submitter.firstName}` / `{submitter.email}` | Ticket submitter |
| `{ticket.submitter}` | Alias for `{submitter.name}` |
| `{assignee.name}` / `{assignee.firstName}` / `{assignee.email}` | Assigned user |
| `{actor.name}` / `{actor.firstName}` / `{actor.email}` | The user inserting the response |
| `{site.name}` / `{site.url}` | Branding site name + frontend URL |

Unknown or unfilled tags pass through verbatim — the response never breaks. Insert via the **📋 Canned** button next to the comment composer. Inserting increments `use_count` so frequently-used responses float to the top of the picker.

---

## System health

**Admin → Data → System health** — single-page operational dashboard. Auto-refreshes every 30s.

Surfaces:

- Top-line counters: active tickets / P1+P2 / flagged / inbound queue / active users + projects / DB size + uptime
- **Scheduled jobs** — heartbeats from the in-process schedulers (`muted_digest`, `inbox_subscription_renewal`, `auto_close`) with a health dot (ok / stale / error / never_ran). "Stale" = last run older than 2× cadence.
- **Alert sources** — event count + last_seen per source, with link to manage
- **Email backends** — active, inbox monitor, last test
- **Inbound email queue** — counts per status (unmatched / matched / discarded / spam)

Manager role gets read access; Admin sees the same view.

---

## Releases

Resolvd follows **semantic versioning** (`vMAJOR.MINOR.PATCH`):

- **patch** (`v1.2.X`) — bug fixes, security patches. Cut as needed; no migration drama expected.
- **minor** (`v1.X.0`) — new features, additive schema changes. Roughly monthly.
- **major** (`vX.0.0`) — breaking schema migrations or API changes. Read the release notes carefully before upgrading.

### Cutting a release

```bash
# 1. Land your changes on main (CI green).
# 2. Tag locally and push:
git tag v1.2.3
git push origin v1.2.3
```

`.github/workflows/release.yml` then:
- generates release notes from every commit since the previous tag,
- publishes a GitHub Release with that body,
- marks any tag containing a hyphen (`v1.2.3-rc.1`, `v1.2.3-beta.0`) as a pre-release.

`.github/workflows/notify-website.yml` listens for `release: published` and POSTs the configured deploy hook (Vercel / Netlify / Cloudflare Pages — set `RESOLVD_DEPLOY_HOOK_URL` in repo Secrets) so the marketing site's changelog rebuilds with the new release.

### Pre-release tracks

```bash
git tag v1.3.0-rc.1
git push origin v1.3.0-rc.1
```

Pre-release tags are flagged on GitHub and skipped by the website's "latest stable" pill but still appear in the full changelog.

---

## License

Resolvd is **source-available** under the [Functional Source License (FSL-1.1-ALv2)](./LICENSE).

- ✓ Free to self-host, fork, modify, and audit
- ✓ Free for internal commercial use at your company
- ✓ Free to use in client work and managed services
- ✗ Not for reselling Resolvd as a hosted SaaS (during the 2-year non-compete window)

Each release converts to **Apache 2.0** two years after publication.

Plain-English explainer: https://resolvd.dev/license
Need a different license for procurement? hosted@resolvd.dev

### Contributing

By contributing, you agree your contribution is licensed under the same FSL-1.1-ALv2 terms as the rest of the project. We use the **Developer Certificate of Origin (DCO)** instead of a CLA — every commit must be signed off (`git commit -s`). See [CONTRIBUTING.md](./.github/CONTRIBUTING.md) for details.
