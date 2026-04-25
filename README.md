# Punchlist

Internal issue and project tracking — keep every ticket in reach until it's closed.

## Stack

- **Frontend**: React + Vite + Tailwind CSS
- **Backend**: Node.js + Express
- **Database**: PostgreSQL 16
- **Auth**: Microsoft Entra ID, Google OAuth, and/or local username/password (configurable)
- **Email**: Microsoft Graph API, Gmail API, or SMTP (configurable)
- **Proxy**: nginx (Docker) + host reverse proxy

---

## Quick Start

```bash
cp .env.example .env
# Fill in required values — see Environment Variables below

mkdir -p data/uploads

docker compose up -d --build
docker compose logs -f
```

The stack binds to `127.0.0.1:8090` by default. A host reverse proxy (nginx, Caddy, etc.) handles TLS and forwards to that port.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `POSTGRES_PASSWORD` | Yes | PostgreSQL password |
| `SESSION_SECRET` | Yes | Random string — `openssl rand -hex 32` |
| `FRONTEND_URL` | Yes | Public base URL (e.g. `https://issues.example.com`) |
| `COOKIE_SECURE` | Yes | `true` when behind HTTPS proxy |
| `PORT` | No | Backend port (default `3001`) |
| `UPLOADS_DIR` | No | File upload path (default `/data/uploads`) |
| `MAX_UPLOAD_MB` | No | Max attachment size in MB (default `10`) |

**Microsoft Entra ID (optional)**

| Variable | Description |
|----------|-------------|
| `AZURE_TENANT_ID` | Directory (tenant) ID |
| `AZURE_CLIENT_ID` | Application (client) ID |
| `AZURE_CLIENT_SECRET` | Client secret |
| `AZURE_REDIRECT_URI` | Must match App Registration redirect URI |
| `AZURE_ALLOWED_ORIGINS` | Comma-separated allowed origins for multi-domain |

**Microsoft Graph email (optional)**

| Variable | Description |
|----------|-------------|
| `MAIL_FROM` | Sender mailbox (must exist in your M365 tenant) |

**Google OAuth (optional)**

| Variable | Description |
|----------|-------------|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | Must match Google Console redirect URI |

---

## Authentication

Punchlist supports multiple auth providers, configurable at runtime from **Admin → Authentication**:

- **Local** — username/password with Argon2 hashing, account lockout after 8 failed attempts
- **Microsoft Entra ID** — SSO via MSAL
- **Google OAuth** — SSO via Google Workspace or consumer accounts

MFA (TOTP) is available and can be enforced per role.

### First-Time Setup (Bootstrap)

On a fresh install with local auth enabled, the login page shows a **Create Admin Account** form. The first account created this way gets the Admin role. Subsequent users are invited by an Admin or Manager.

---

## Host Reverse Proxy

The Docker stack does not terminate TLS. Configure a host proxy to forward HTTPS traffic to `127.0.0.1:8090`.

**nginx example:**

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

A ready-to-use config for Cloudflare Origin Certificates is in `nginx/host-proxy.conf`.

---

## Email Notifications

Followers of a ticket receive email when:
- Ticket status changes
- A comment is posted

Admins are notified when a ticket reaches **Pending Review**.

Configure the email backend in **Admin → Authentication → Email**:
- **Microsoft Graph** — requires `Mail.Send` application permission granted in Entra ID
- **Gmail** — requires a service account with domain-wide delegation
- **SMTP** — any standard SMTP server

---

## User Roles

| Role | Permissions |
|------|-------------|
| **Admin** | Full access — branding, auth configuration, status workflows, all Manager actions |
| **Manager** | Projects, users, tickets, export, invitations |
| **Submitter** | Create tickets, comment, follow, upload attachments |
| **Viewer** | Read-only |

Roles can be assigned per-user globally, with optional per-project overrides.

---

## Projects

- Tickets are scoped to projects
- Projects can be marked **internal** (no external vendor fields) or with an external vendor
- Each project has a prefix used for ticket references (e.g. `WEB-0042`)
- Projects can be archived when no longer active

---

## Backup

PostgreSQL data lives in a Docker volume (`issues_pg-data`). Back it up with:

```bash
docker compose exec postgres pg_dump -U punchlist punchlist > backup-$(date +%Y%m%d).sql
```

Restore:

```bash
docker compose exec -T postgres psql -U punchlist punchlist < backup.sql
```

Uploaded files are stored in `data/uploads/` — include this directory in your backup.
