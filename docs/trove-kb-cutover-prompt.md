# Prompt for the Resolvd session: cut over from "Bothy" to Trove KB, and use its REST API

Paste everything below the line into a Claude Code session in `/opt/issues`.

---

Read `docs/BOTHY_INTEGRATION.md` first; it describes Phase 1 as built. Two things
have changed on the other side since: the product was renamed from **Bothy** to
**Trove KB** (hostname `https://trove-kb.gomotx.com`, repo `joshhearne/trove-kb`),
and it now offers the knowledge base over plain REST under `/api/v1/kb`, runbooks
with stable step ids, and webhooks for article changes. Do the work in three
commits, each with passing tests, `git commit -s`, no AI trailers.

## 1. The name

Rename every user-facing and code-level "Bothy" to "Trove KB" / `trove_kb`:

- Admin → Integrations pane title and copy ("Trove KB knowledge base"), the `/kb`
  page's collection chips and reader, the `KnowledgePanel` block, i18n strings.
- `backend/services/bothy.js` → `services/troveKb.js`; routes `/api/bothy-settings`
  → `/api/trove-kb-settings`, `/api/bothy` → `/api/trove-kb`; frontend API client
  calls to match.
- Tables: a migration renaming `bothy_settings` → `trove_kb_settings` and
  `ticket_bothy_links` → `ticket_trove_kb_links` (`ALTER TABLE … RENAME`, data kept),
  and every query that names them.
- Docs: `docs/BOTHY_INTEGRATION.md` → `docs/TROVE_KB_INTEGRATION.md`, text updated,
  and a one-line note at the top that Phases 3a/3b/3c/3e on the Trove KB side are
  built (see below), so the "Order of work" list is current.
- The settings row's `base_url` is already `https://trove-kb.gomotx.com`; the API key
  stays as it is (keys issued as `bothy_…` are still accepted; new keys are `trove_…`).

## 2. Read through REST instead of MCP

Swap the client's MCP transport for the REST routes. Same bearer key, same 60 s
cache, same 12 s timeout, errors never carry the key. Callers of the service do
not change. The routes, all under `{base_url}/api/v1`:

```
GET  /kb/collections?writable=true
       -> { data: [{ id, name, description, site_url, public, writable, articles, created_at }] }
GET  /kb/collections/:id?kind=runbook
       -> { ...collection, categories: [{ category, subcategory, articles }] }
GET  /kb/search?q=&collection_id=&category=&kind=&limit=&cursor=
       -> { data: [{ id, title, kind, collection: {id,name}, category, subcategory, source_url,
                     date_modified, matched: { chunk, heading, snippet } }], next_cursor }
GET  /kb/articles?collection_id=&category=&subcategory=&kind=&updated_since=&sort=&dir=&limit=&cursor=
       -> { data: [{ id, external_id, title, kind, category, subcategory, source_url,
                     date_modified, readable }], next_cursor }
GET  /kb/articles/:id
       -> { id, external_id, title, kind, category, subcategory, source_url, body (Markdown),
            format, steps? (runbooks), internal_only, public_url, attachments, date_created,
            date_modified, updated_at, collection: {id,name} }
PUT  /kb/collections/:id/articles/:external_id   body { title, body, category?, subcategory?,
                                                        kind?, source_url?, internal_only? }
       -> 201 created / 200 replaced; 400 when a runbook repeats a step id. Needs the
          write scope and a write grant on the collection.
DELETE /kb/collections/:id/articles/:external_id  -> 204 (archive)
```

Notes for the client:
- `search` takes one `collection_id` at most; keep the fan-out across mapped
  collections, but `collection_id` may now be left out to search every collection
  the key can read in one call — use that when all mapped collections are wanted.
- `GET /kb/articles/:id` returns the whole Markdown `body`; no more joining chunks.
- `public_url` is the address on `https://kb.gomotx.com` when the article is on the
  public site, else null; use it for the "public link" instead of composing one.
- Errors are `{ error: { code, message, details? } }` with 401/403/404/422/429;
  rate limit 600 requests a minute per key, `X-RateLimit-*` headers.
- Keep the MCP transport code only if something else still needs it; otherwise
  delete it.

## 3. Runbooks (Phase 2 of the plan), and cache invalidation

- A runbook is an article with `kind: "runbook"` and `steps: [{ id, text, note?, canned? }]`.
  `id` is stable across edits (`[a-z0-9-]{1,40}`), `text` is Markdown for the step,
  `note` is Markdown nested under it, `canned` is the name from the step's
  `@canned:[Name]` token. Bothy/Trove KB keeps no progress; Resolvd does.
- `ticket_runbook_runs`: add `trove_kb_article_id uuid` beside `article_id`; key
  `step_states` by Trove KB step id. `RunbookPanel` fetches `/kb/articles/:id`, renders
  one checkbox per step in order, the note under each, and keeps the `@canned`
  pill behaviour from the `canned` field.
- The picker lists `GET /kb/articles?collection_id=…&kind=runbook` for the project's
  mapped collections; search with `kind=runbook` too.
- Migrate the five existing runbook runs: `backups/bothy-kb-export/out/runbook-step-map.json`
  maps each local article id → the Trove KB `external_id` (`resolvd:kb:<id>`) and
  each BlockNote `block_id` → `step_id`. Look the article up by external id
  (`GET /kb/articles?collection_id=…` and match `external_id`, or keep a small map
  table), rewrite `step_states` keys block id → step id, set
  `trove_kb_article_id`, and do the same for `ticket_kb_links.article_id` →
  `ticket_trove_kb_links`. One-off script, idempotent, dry-run flag, counts printed.
  The articles are already in Trove KB in collections "MOT IT Internal" and
  "MOT IT Public".
- Webhooks: add `POST /api/trove-kb/webhook` that verifies
  `X-Trove-Signature: sha256=<hmac-sha256(secret, raw body)>`, reads
  `X-Trove-Event` (`kb.article.upserted` | `kb.article.archived`) and the payload
  `{ event, occurred_at, data: { collection_id, article_id, external_id, kind } }`,
  and drops the cached article / search entries for it. Store the signing secret
  in `trove_kb_settings` (encrypted like the key). The route must answer 2xx fast
  and never echo the secret. Document the admin step: in Trove KB, Admin → Webhooks →
  endpoint `https://issues.gomotx.com/api/trove-kb/webhook`, events
  `kb.article.upserted` and `kb.article.archived`, paste the secret here.
- Optional, cheap: a nightly `GET /kb/articles?updated_since=<last run>` per mapped
  collection to refresh snapshots in `ticket_trove_kb_links` (title, collection name).

## Conventions to keep
- Session auth and roles decide who sees internal collections; the Trove KB key is
  Resolvd's alone and is never sent to the browser.
- Every change to the settings row is audited as today.
- Tests for: REST client (mocked fetch) incl. error shapes and cache; webhook
  signature accept/reject; the migration script on a fixture copy of the step map.
