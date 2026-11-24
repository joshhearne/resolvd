# Deploying Resolvd on Fly.io (single container, encrypted)

This runs Resolvd as **one app machine** (backend serving the built
frontend, from `Dockerfile.single`) plus **Postgres** and a **volume** for
uploads. A fresh database starts with encryption already on, so there's no
backfill and no SQL to run.

The Docker Compose install (`docker-compose.yml`) is unaffected. The same
image also runs on Render, Railway or any Docker host; see
[Other hosts](#other-hosts).

## What you need

- [`flyctl`](https://fly.io/docs/flyctl/install/), logged in (`fly auth login`).
- A checkout of the branch you want to run (e.g. `dev`).
- A password manager entry for the encryption key (step 4).

## 1. Name the app

Edit `fly.toml`: set `app` to a globally unique name (e.g. `resolvd-hearnetech`)
and `primary_region` to a region near you (`fly platform regions`). Then:

```bash
fly apps create resolvd-hearnetech
```

## 2. Postgres

Pick one:

- **Fly Postgres (unmanaged, cheapest).** One small machine with its own
  volume and daily snapshots, but upgrades and recovery are up to you.

  ```bash
  fly postgres create --name resolvd-hearnetech-db --region dfw --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 1
  ```

  ```bash
  fly postgres attach resolvd-hearnetech-db --app resolvd-hearnetech
  ```

  `attach` creates the database and sets the `DATABASE_URL` secret on the app.

- **Fly Managed Postgres.** Fly runs it (backups, failover, upgrades), but it costs
  more. Create it from the dashboard or `fly mpg create`, then set its
  connection string as `DATABASE_URL` (step 4).

Any other Postgres 14+ works too (Neon, Supabase, RDS): just set `DATABASE_URL`.

## 3. Volume for uploads

```bash
fly volumes create resolvd_data --region dfw --size 1 --app resolvd-hearnetech
```

Use the same region as the app. Attachments are encrypted on disk.

## 4. Secrets

Generate the encryption master key **once** and save it in your password
manager **before** going further. If you lose it, the encrypted data can't be
recovered.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Set the secrets (one command; `--stage` applies them on the first deploy):

```bash
fly secrets set --stage --app resolvd-hearnetech RESOLVD_MASTER_KEY='paste-the-key' SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")" INBOUND_WEBHOOK_SECRET="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")" FRONTEND_URL='https://resolvd.hearnetech.com'
```

Add the rest as you need them, with the same names as `.env.example`:

| Need | Secrets |
|---|---|
| Microsoft sign-in | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_REDIRECT_URI=https://resolvd.hearnetech.com/auth/callback` |
| Google sign-in | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI=https://resolvd.hearnetech.com/auth/google/callback` |
| Vendor replies | `INBOUND_REPLY_TO` (the monitored mailbox) |
| Browser push | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` |

Leave out `RESOLVD_UPDATER_TOKEN` and the label-printer settings: the
in-app updater and the on-site print pipeline don't apply here.

## 5. Deploy

```bash
fly deploy --ha=false --build-arg APP_VERSION="$(git describe --tags --always)" --build-arg APP_COMMIT="$(git rev-parse --short HEAD)" --build-arg BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

`--ha=false` matters: Resolvd runs its schedulers (SLA timers, reminders,
inbox renewals, digests, alert polling) inside the app, so there must be
**exactly one machine**. `fly.toml` also keeps it from auto-stopping. Don't
`fly scale count` above 1.

Check the logs for the encryption line on first boot:

```bash
fly logs --app resolvd-hearnetech
```

You should see `[encryption] fresh install: encryption mode set to standard`.
If the key is missing or wrong, the app exits at boot with an error instead
of starting unencrypted.

## 6. Your domain

```bash
fly certs add resolvd.hearnetech.com --app resolvd-hearnetech
```

Point DNS at the app: a `CNAME resolvd → resolvd-hearnetech.fly.dev`. On
Cloudflare, leave the record **DNS only** (grey cloud) until
`fly certs show resolvd.hearnetech.com` says the certificate is issued. After
that you can proxy it, with SSL mode **Full (strict)**.

## 7. First sign-in

Open `https://resolvd.hearnetech.com`. On an empty database it shows the
setup screen, which creates the first Admin with a local password. Add SSO
and invite people from there. **Admin → Import** loads locations and users
from CSV.

## Updating

From an updated checkout, run the same `fly deploy …` command again. Schema
changes apply at boot. (The in-app "update available" flow is for Docker
installs with the host updater; on Fly, updates are deploys.)

## Backups

- **Database:** Fly Postgres keeps daily volume snapshots. For your own
  copies, run `fly postgres connect -a resolvd-hearnetech-db` or `fly proxy 15432:5432 -a resolvd-hearnetech-db` and then `pg_dump`.
  Managed Postgres has its own backups.
- **Uploads:** the `resolvd_data` volume is snapshotted daily (`fly volumes snapshots list`).
- **Encryption key:** keep `RESOLVD_MASTER_KEY` in your password manager. A
  database or volume backup is unreadable without it.

## Other hosts

`Dockerfile.single` is a plain image, so other platforms work the same way:

- Build from the repo root with `Dockerfile.single`, and expose port 3001.
- Health check: `/health`.
- Persistent disk mounted at `/data`.
- Postgres via `DATABASE_URL`.
- The same secrets as step 4, plus `COOKIE_SECURE=true` and `RESOLVD_INITIAL_ENCRYPTION=standard`.
- Run **one instance** with no scale-to-zero.

For a VPS, the existing Docker Compose install (see README) also works, and
keeps the automatic updater.
