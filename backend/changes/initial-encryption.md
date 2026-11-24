---
type: feature
audience: staff
---
**Encrypted from the first boot:** a new install can start with encryption already on. Set `RESOLVD_INITIAL_ENCRYPTION=standard` in `.env` (with `RESOLVD_MASTER_KEY`) before starting it for the first time, and nothing is ever stored unencrypted, with no backfill to run. Installs that already have data aren't affected. The README also has notes for running on AWS (Lightsail or EC2), with automatic updates.
