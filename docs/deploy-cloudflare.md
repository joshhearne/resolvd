# Deploying on Cloudflare Workers

Resolvd can run as a single Cloudflare Worker instead of the Docker stack. Both deployments run the same Express backend and the same frontend build; pick one per install.

| Docker | Cloudflare Workers |
|---|---|
| nginx + frontend container | Workers static assets (`frontend/dist`) |
| backend container (`node server.js`) | The same Express app, through the Workers Node HTTP bridge (`backend/worker/index.js`) |
| Postgres container | Your own Postgres, reached through **Hyperdrive** |
| `uploads-data` volume | **R2** bucket |
| in-process `setInterval` schedulers | One every-minute **Cron Trigger** (`services/schedulers.js`) |
| schema applied at boot | `npm run migrate` before each deploy |

## Requirements

- **Workers Paid plan.** Password hashing (argon2id) takes ~300 ms of CPU per login, far over the Free plan's 10 ms per request.
- **A Postgres database Cloudflare can reach** (Docker uses 16): Neon, Supabase, RDS, Cloud SQL, or self-hosted behind Cloudflare Tunnel (see Hyperdrive's docs for private databases).
- Node 24 and this repo checked out, for the build.

## First deploy

All commands run from `backend/`.

```bash
cd backend
npm ci && npm ci --prefix ../frontend
npx wrangler login
```

**1. Storage and database binding.**

```bash
npx wrangler r2 bucket create resolvd-uploads
npx wrangler hyperdrive create resolvd-db --connection-string="postgres://USER:PASSWORD@HOST:5432/resolvd"
```

Put the Hyperdrive id it prints into `wrangler.toml` (`[[hyperdrive]] id`). If you named the bucket something else, update `bucket_name` too.

**2. Settings.** In `wrangler.toml` `[vars]`, set `FRONTEND_URL` to the URL you'll serve Resolvd on. The other variables from [the README](../README.md#environment-variables) work the same way: add non-secret ones under `[vars]`, and secrets with:

```bash
npx wrangler secret put SESSION_SECRET        # required
npx wrangler secret put RESOLVD_MASTER_KEY    # required if you use encryption or AI
npx wrangler secret put AZURE_CLIENT_SECRET   # and any other secrets you use
```

Not used on Workers: `POSTGRES_PASSWORD`, `DATABASE_URL`, `PORT`, `UPLOADS_DIR`, `APP_INTERNAL_PORT`, `CLOUDFLARE_TUNNEL_TOKEN`.

**3. Schema.** Apply it with a direct connection string (not the Hyperdrive one):

```bash
DATABASE_URL="postgres://USER:PASSWORD@HOST:5432/resolvd" npm run migrate
```

Run this before every deploy. It's idempotent, the same pass Docker runs at boot.

**4. Deploy.**

```bash
npm run worker:deploy
```

This builds the frontend and deploys the Worker. Then attach a custom domain (Workers → resolvd → Settings → Domains & Routes) matching `FRONTEND_URL`, and update OAuth redirect URIs (Entra `AZURE_REDIRECT_URI`, Google) if the hostname changed. The callback paths are unchanged.

### Deploying from GitHub Actions

`.github/workflows/deploy-worker.yml` runs the migrate + deploy steps on demand (Actions → Deploy (Cloudflare Workers) → Run workflow). It needs repository secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `DATABASE_URL` (direct connection, for the schema step). CI also boots the Worker bundle on every PR (`Worker (bundle)` job) so a change that would break this deployment fails review.

## Moving an existing Docker install

1. **Database.** `pg_dump` from the `resolvd-postgres` container and restore into the new database, then run `npm run migrate`.
2. **Uploads.** Copy the uploads volume (named `<compose project>_uploads-data`, e.g. `resolvd_uploads-data`) into R2 keeping the same layout. Attachments and branding files sit at the bucket root, avatars under `avatars/`. With rclone pointed at R2:
   ```bash
   docker run --rm -v resolvd_uploads-data:/data -v "$PWD":/out alpine tar -C /data -cf /out/uploads.tar .
   mkdir uploads && tar -C uploads -xf uploads.tar
   rclone copy uploads r2:resolvd-uploads
   ```
3. **Secrets.** Reuse the same `SESSION_SECRET` and **the same `RESOLVD_MASTER_KEY`**. Encrypted data can't be read without it.

Passwords keep working. Each user's first login on Workers takes a second or two (it checks the hash Docker wrote) and rehashes it with settings tuned for Workers; later logins take ~300 ms. Switching back to Docker works the same way in reverse.

## Local development

```bash
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://resolvd:pw@localhost:5432/resolvd" \
  npm run worker:dev
```

R2 is emulated locally. Secure cookies need HTTPS, so either add `--local-protocol https` or put `COOKIE_SECURE=false` in `backend/.dev.vars` (gitignored). Trigger the cron with `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*&time=<epoch ms>"`.

## Differences from Docker

| Area | On Workers |
|---|---|
| **Label printers** | Not reachable. The printer integration opens a raw TCP connection to a printer on your LAN, which a Worker can't reach. Run Docker if you need label printing. |
| **Uptime Kuma status polling** | Needs a URL the Worker can reach over the internet. Docker-network hostnames like `http://uptime-kuma:3001` don't exist here. Inbound alert webhooks (all sources) and the Action1 cloud API work unchanged. |
| **SMTP** | Works on ports 587/465. Cloudflare blocks outbound port 25. Graph and Gmail API sending are unaffected. |
| **Upload size** | Capped at 25 MB (`MAX_UPLOAD_MB` in `wrangler.toml`), since uploads are buffered and encrypted in memory and an isolate gets 128 MB. |
| **Background jobs** | Run at most once a minute: the Action1 poll ticks every 60 s instead of 30 s. Everything else keeps its cadence. |
| **Settings caches** | Each Worker isolate caches settings (branding, auth, AI) for up to 60 s, so an admin change can take that long to reach every isolate. On Docker it's immediate. |
| **Login rate limiting** | Counted in Postgres (`rate_limit_hits`) so limits hold across isolates. Docker counts in memory. |
| **MFA recovery codes** created on Docker | Each check is slow on Workers (~1.5 s per stored code). Regenerating them (MFA settings → new recovery codes) fixes it. |
