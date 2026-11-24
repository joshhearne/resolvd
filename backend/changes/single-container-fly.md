---
type: feature
audience: staff
---
**Run on Fly.io or any container host:** Resolvd can now run as a single container (`Dockerfile.single`) with the backend serving the app itself, using the included `fly.toml` or on Render, Railway or a plain Docker host. A new install can start with encryption already on (`RESOLVD_INITIAL_ENCRYPTION=standard`), so nothing is ever stored unencrypted. See docs/DEPLOY-FLY.md.
