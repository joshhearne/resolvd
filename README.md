# Resolvd

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
| `CLOUDFLARE_TUNNEL_TOKEN` | no | When set, the optional `cloudflared` service runs the tunnel. |

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
| **Manager** | Projects, users, tickets, exports, invites, vendor companies/contacts, comments + attachments, vendor-visible comments |
| **Submitter** | Create tickets, comment, follow, upload attachments |
| **Viewer** | Read-only |
| **Support** | External support principals — every request blocked unless an active grant exists (see "JIT support access") |

---

## Projects

- Tickets are scoped to projects
- Projects can be marked with or without an external vendor — when off, the External Vendor section, vendor outbound, and Team-Input blocker are hidden
- Each project has a prefix used for ticket references (e.g. `WEB-0042`). The same prefix powers email-to-ticket auto-create.

---

## Vendor coordination (CRM)

External vendor projects support a lightweight CRM in **Admin → Companies**:

- **Companies** are scoped to a project and carry an optional `domain` (used for inbound sender-domain matching)
- **Contacts** belong to a company. Each contact has name, email, phone, role/title — all encrypted under standard mode. Email is also HMAC'd into a blind index for inbound webhook lookup.
- **Generic mailboxes** (`support@`, `helpdesk@`, `noreply@`, …) are rejected at write time to prevent reply loops with the vendor's helpdesk. The list is extensible per-workspace via `auth_settings.email_blocklist`.
- **Tickets** can attach contacts. Attached contacts receive vendor-visible comments and can be CC'd in inbound creation flows.

### Vendor outbound (admin-curated)

Comments marked **Share with vendor** by an Admin/Manager fire an outbound email per attached contact, rendered through an admin-editable template (see "Email templates"). Outbound carries:

- `Auto-Submitted: auto-generated`
- `X-Resolvd-No-Reply: 1`
- `Reply-To: $INBOUND_REPLY_TO` when configured

so vendor helpdesks don't auto-reply and reflective loops are dropped on ingest.

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
docker compose exec postgres psql -U mot_issues -d mot_issues \
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
- **Print export** — always renders in light mode regardless of UI theme.

---

## Host reverse proxy

The Docker stack does not terminate TLS. Either:

- **Cloudflare Tunnel** — set `CLOUDFLARE_TUNNEL_TOKEN` in `.env`; the bundled `cloudflared` service runs the tunnel.
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
docker compose exec postgres pg_dump -U mot_issues mot_issues > backup-$(date +%Y%m%d).sql
```

Restore:

```bash
docker compose exec -T postgres psql -U mot_issues mot_issues < backup.sql
```

Uploaded files (encrypted on disk under standard mode):

```bash
docker run --rm -v issues_uploads-data:/src:ro -v "$(pwd)":/dst alpine \
  tar czf /dst/uploads-$(date +%Y%m%d).tar.gz -C /src .
```

**Always back up `RESOLVD_MASTER_KEY` separately** to a password manager / KMS / sealed envelope.

---

## Admin tabs reference

| Tab | Role | Purpose |
|---|---|---|
| Users | Admin/Mgr | Invite, role, MFA, status |
| Companies | Admin/Mgr | Vendor CRM (companies + contacts) |
| Inbound | Admin/Mgr | Manual-match queue, with auto-create reject reasons surfaced |
| Export | Admin/Mgr | Bulk PDF/print export |
| Authentication | Admin | SSO providers, MFA enforcement, email blocklist, digest schedule |
| Statuses | Admin | Internal/external status workflow |
| Branding | Admin | Site name, logo, accent color |
| Email templates | Admin | Tag-substitution editor + preview + test-send |
| Email backends | Admin | Connect M365/Gmail via OAuth, SMTP fallback, monitor inbox toggle |
| Support access | Admin | JIT grants — approve, revoke, deny, view access log |
| Encryption | Admin | Mode reference + Standard-mode runbook |
