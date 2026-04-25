# MOT Website Issue Tracker

Internal vendor issue management portal for tracking website problems with Coastal Technologies.

## Stack

- **Frontend**: React + Vite + Tailwind CSS
- **Backend**: Node.js + Express
- **Database**: SQLite (single file at `data/issues.db`)
- **Auth**: Microsoft 365 / Entra ID via MSAL
- **Proxy**: nginx

---

## 1. Azure App Registration Setup

1. Go to [portal.azure.com](https://portal.azure.com) → **Entra ID** → **App registrations** → **New registration**
2. Name: `MOT Issue Tracker`
3. Supported account types: **Accounts in this organizational directory only**
4. Redirect URI: `Web` → `https://issues.mot.local/auth/callback`
5. After creation, note the **Application (client) ID** and **Directory (tenant) ID**
6. Go to **Certificates & secrets** → **New client secret** → note the value immediately
7. Go to **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated**:
   - `User.Read`
   - `offline_access`
8. Click **Grant admin consent**

---

## 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and fill in:
- `AZURE_TENANT_ID` — Directory (tenant) ID from App Registration
- `AZURE_CLIENT_ID` — Application (client) ID
- `AZURE_CLIENT_SECRET` — Client secret value
- `AZURE_REDIRECT_URI` — Must exactly match what you entered in Azure: `https://issues.mot.local/auth/callback`
- `SESSION_SECRET` — Run `openssl rand -hex 32` to generate

---

## 3. Start with Docker Compose

```bash
# Make sure the data directory exists and is writable
mkdir -p data

# Build and start
docker compose up -d --build

# Check logs
docker compose logs -f
```

The Docker stack binds to `127.0.0.1:8085` (localhost only). The host reverse proxy handles TLS and forwards to that port. The app is not reachable directly from the network — only through the proxy at `https://issues.mot.local`.

---

## 4. Host Reverse Proxy Setup

The Docker stack does not terminate TLS. A reverse proxy running on wbsrv01 (the host) handles HTTPS and forwards to the Docker stack on port 8085.

### Option A — nginx (recommended)

A ready-to-use config is at `nginx/host-proxy.conf`. Copy it to the host:

```bash
sudo cp nginx/host-proxy.conf /etc/nginx/sites-available/issues.mot.local
sudo ln -s /etc/nginx/sites-available/issues.mot.local /etc/nginx/sites-enabled/issues.mot.local
sudo nginx -t && sudo systemctl reload nginx
```

The cert files must exist first — see **Internal CA Certificate Setup** below.

If `APP_INTERNAL_PORT` is changed from the default `8085`, update the `proxy_pass` line in `host-proxy.conf` to match.

### Option B — Traefik

If your host proxy is Traefik, see the Traefik labels block at the bottom of `nginx/host-proxy.conf`. Remove the localhost port binding from `docker-compose.yml` and add those labels to the `nginx` service instead.

---

## 5. Internal CA Certificate Setup

The cert for `issues.mot.local` is issued by the MOT internal CA and deployed to domain-joined machines via GPO. The application itself does not handle the cert — only the host nginx does.

### Generate a CSR on wbsrv01

```bash
sudo mkdir -p /etc/ssl/mot

sudo openssl req -new -newkey rsa:2048 -nodes \
  -keyout /etc/nginx/certs/issues.mot.local.key \
  -out /etc/nginx/certs/issues.mot.local.csr \
  -subj "/CN=issues.mot.local/O=Motorhomes of Texas/C=US"
```

The CN **must** be `issues.mot.local`. Add a SAN if your CA requires it — create an ext file:

```bash
cat > /tmp/issues-san.ext << 'EOF'
[req_ext]
subjectAltName = DNS:issues.mot.local
EOF
```

Then add `-extensions req_ext -extfile /tmp/issues-san.ext` to the openssl command.

### Submit to Windows Server CA

**Via web enrollment** (easiest):
1. On a domain-joined machine, navigate to `https://[ca-server]/certsrv`
2. Click **Request a certificate** → **Advanced certificate request**
3. Paste the contents of `/etc/nginx/certs/issues.mot.local.csr`
4. Template: **Web Server** (or equivalent)
5. Submit and download the signed cert as Base64 `.cer`

**Via certreq** (from a Windows machine):
```cmd
certreq -submit -attrib "CertificateTemplate:WebServer" issues.mot.local.csr issues.mot.local.cer
```

### Place the signed cert on wbsrv01

```bash
# Copy the signed .cer file to the server, then:
sudo cp issues.mot.local.cer /etc/nginx/certs/issues.mot.local.crt
sudo chmod 640 /etc/nginx/certs/issues.mot.local.key
sudo chmod 644 /etc/nginx/certs/issues.mot.local.crt
```

The key stays on the server and never leaves. The `.crt` is what nginx presents to browsers.

### GPO distribution

Deploy the CA root cert (not the site cert) to domain-joined machines via GPO so browsers trust the chain automatically:

`Computer Configuration → Policies → Windows Settings → Security Settings → Public Key Policies → Trusted Root Certification Authorities`

Non-domain-joined devices (phones on guest WiFi, personal laptops) will not trust the cert and cannot reach the app — this is intentional.

---

## 6. DNS Setup

Add an A record in Windows Server DNS pointing `issues.mot.local` to wbsrv01's LAN IP.

**DNS Manager** → Forward Lookup Zones → `mot.local` → New Host (A):
- Name: `issues`
- IP: `<wbsrv01 LAN IP>`

Devices must be on the MOT network (or VPN) to resolve `issues.mot.local`. Non-domain-joined or off-network devices cannot reach the app — this is intentional for an internal tool.

---

## 7. First Login (Admin Bootstrap)

The **very first user** to log in is automatically assigned the **Admin** role. All subsequent users default to **Viewer** until an Admin promotes them.

1. Navigate to `https://issues.mot.local`
2. Click **Sign in with Microsoft 365**
3. Authenticate with your M365 account
4. You are now Admin — go to **Users** to assign roles to teammates

---

## 8. CSV Import Format

Use **Admin → Import** to bulk-ingest existing Coastal tickets.

Required columns (case-insensitive):

| Column | Description |
|--------|-------------|
| `coastal_ref` | Coastal's ticket ID — used to skip duplicates |
| `title` | Ticket title (required) |
| `description` | Optional description |
| `coastal_status` | `Unacknowledged`, `Acknowledged`, `In Progress`, `Resolved`, `Won't Fix` |

Example:
```csv
coastal_ref,title,description,coastal_status
CT-1001,Homepage hero image broken,Image fails to load on mobile,In Progress
CT-1002,Contact form not sending emails,,Acknowledged
CT-1003,Old pricing page still live,Should redirect to /pricing,Resolved
```

Tickets with `coastal_status=Resolved` are created as **Pending Review** and flagged for MOT review.

---

## 9. Backup

The entire database is a single file: `data/issues.db`

```bash
# Simple backup
cp data/issues.db data/issues.db.$(date +%Y%m%d-%H%M%S).bak
```

---

## User Roles

| Role | Permissions |
|------|-------------|
| **Admin** | Full access: create/edit/delete tickets, override priority, manage Coastal status, manage user roles, close/reopen tickets |
| **Submitter** | Create tickets, comment on any ticket, view all tickets |
| **Viewer** | Read-only: view tickets and comments |
