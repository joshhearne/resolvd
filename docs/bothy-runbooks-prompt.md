# Prompt for the Bothy Claude session: Runbooks + REST knowledge base routes

Paste everything below the line into a Claude Code session in `/opt/bothy`.

---

Read CLAUDE.md, CLAUDE.local.md, docs/ARCHITECTURE.md (Knowledge base section) and
docs/API.md first. Work in phases, each ending with passing Vitest + Playwright and a
working `docker compose build`. Commit each phase with `git commit -s`, no AI trailers.
Keep Bothy PSA-agnostic: nothing in core names any specific ticketing system.

## Why
Bothy is becoming this company's documentation platform. A ticketing system will read
knowledge base articles and runbooks from Bothy over its API, link them to tickets,
and track per-ticket runbook progress on its own side. Today the KB is reachable only
through MCP and has no notion of a runbook. Two things are needed.

## Phase A: Runbooks as a kind of knowledge base article

A runbook is an article whose body is a step-by-step procedure. It stays an article so
collections, categories, public/internal, search, MCP, import and upsert all keep
working. Nothing about progress is stored in Bothy; the consumer owns that.

Schema (new migration, mirror in db/schema.sql and src/server/db/schema.ts):
- `kb_articles.kind text not null default 'article' check (kind in ('article','runbook'))`
- `kb_articles.steps jsonb not null default '[]'` — derived from the body on every
  save/import/upsert; never authored directly.
- Partial index on `(collection_id) where kind='runbook'`.

Step derivation (`src/server/kb/runbook.ts`, pure function, Vitest-covered):
- The steps are the items of the first top-level ordered list in the body (`1.`, `2.`,
  or task-list items `- [ ]` when no ordered list exists). Headings and paragraphs
  before the list are the preamble and stay in the body.
- Each item may end with an attribute block `{#step-id}`; the id is `[a-z0-9-]{1,40}`.
  Items without one get an id minted on save (8 lowercase hex), written back into the
  stored body so the id is stable across later edits. When a re-save has an item with
  no id whose text matches a previous step's text, that step's id is reused.
- Anything nested under an item (indented paragraphs, bullets, images, code) is the
  step's `note`, kept as Markdown.
- A token `@canned:[Name]` anywhere in the step text is preserved verbatim and also
  surfaced as `canned: "Name"` on the step, so a consumer can offer a reply template.
- Output: `[{ id, text, note?, canned? }]`. Ids must be unique within an article;
  a duplicate is an error that the editor and the API report (400), import records
  as a failure for that file.

Where `kind` comes from:
- Frontmatter `kind: runbook` on import (`src/server/kb/extract.ts`), MCP
  `upsert_kb_article` gains an optional `kind` argument, the REST upsert below takes
  it, and the in-app editor has a toggle. Default `article`.

Reading:
- `get_kb_article` (MCP), the signed-in `/kb/articles/[id]` page and the public
  `/pub/kb/articles/[id]` page return/render `kind` and `steps`. A runbook renders
  its steps as a numbered checklist (visual only, nothing persisted) with the note
  under each step and the outline as usual.
- `search_kb`, `list_kb_articles` and `list_kb_collections` category listings accept
  `kind` as a filter. Search results and article cards show a "Runbook" badge.

Editing:
- If there is no in-app Markdown editor for KB articles yet, add one for collections
  the user may write to (admin, or a person with a write grant once Phase C exists):
  title, category, subcategory, kind toggle, body textarea with a live step preview
  for runbooks, internal-only (public_hidden) toggle. Every save writes an audit entry.
  Reuse the same service as MCP's upsert (`src/server/services/kb-write.ts`).

Docs: ARCHITECTURE.md gets a "Runbooks" paragraph under Knowledge base; API.md
documents `kind`/`steps`; the Bothy KB collection gets articles "Runbooks" and
"Writing a runbook" via `upsert_kb_article` per CLAUDE.local.md. Playwright: create a
runbook, reload, ids stable; import a zip with `kind: runbook` frontmatter.

## Phase B: REST routes for the knowledge base under `/api/v1/kb`

Thin `withApi` wrappers over the existing services, Zod schemas so the OpenAPI spec
picks them up, same `KbReader` rules as MCP (`via: "api"` behaves like `"mcp"` for
grants; `mcp_enabled` does not apply to REST).

| Method | Route | Scope / grant |
|---|---|---|
| GET | `/api/v1/kb/collections` (`?writable=true`) | read |
| GET | `/api/v1/kb/collections/:id` (categories with counts) | read |
| GET | `/api/v1/kb/search?q=&collection_id=&category=&kind=&limit=&cursor=` | read |
| GET | `/api/v1/kb/articles?collection_id=&category=&subcategory=&kind=&updated_since=&limit=&cursor=` | read |
| GET | `/api/v1/kb/articles/:id` — full body, `kind`, `steps`, `external_id`, `source_url`, `public_url` | read |
| PUT | `/api/v1/kb/collections/:id/articles/:external_id` — upsert `{title, body, category?, subcategory?, kind?, source_url?, internal_only?}` | write grant on that collection |
| DELETE | `/api/v1/kb/collections/:id/articles/:external_id` — archive | write grant |

`public_url` is `kb_public_url + "/pub/kb/articles/<id>"` when the site is on, the
collection is public and the article is not hidden; otherwise null. Rate limits and
error shapes as the rest of `/api/v1`. Document every route in docs/API.md and cover
each with e2e/api.spec.ts cases (read with a KB-only key, write refused without grant,
`kind` filter, upsert then get returns steps).

Webhooks: add events `kb.article.upserted` and `kb.article.archived` with
`{collection_id, article_id, external_id, kind}` to `src/server/services/webhooks.ts`
and API.md.

## Phase C (after A and B): grant a collection to a person, and manage people, by API

- New table `user_kb_collections (user_id, collection_id, can_write, granted_at)`,
  same shape as `api_key_kb_collections`; `readable()` in `src/server/services/kb.ts`
  treats it like key grants. Admin → Knowledge base → collection gets a "People"
  section beside "API key access".
- REST, scope `admin`:
  - `GET /api/v1/users`, `POST /api/v1/users` `{email, name, role?, all_companies?}`
    — create or return the existing account by email, no password set (the person
    signs in through OIDC or an admin sets a temporary password).
  - `PUT` / `DELETE /api/v1/kb/collections/:id/grants/users/:userId` `{can_write}`
  - `PUT` / `DELETE /api/v1/kb/collections/:id/grants/api-keys/:keyId` `{can_write}`
- Every grant change is an audit entry naming the key or the person who made it.

## Conventions to keep
- Every read takes a `KbReader`; out of reach is "not found".
- Never hard-delete; `archived_at`.
- Validate with Zod; the same schemas feed the OpenAPI spec.
- Copy through `getMessages()` / `useMessages()`, en-US source, en-GB overrides.
- Sanitize rendered Markdown server-side as today.

## Addendum (2026-10-06): read as the public site would — `audience`

A ticketing system reads the knowledge base through one API key and shows some of
it to people who are *not* staff. Today a key sees held-back articles
(`kb_articles.public_hidden`) and collections not shown on the public site
(`kb_collections.public_access = false`), because `readable()` applies those
filters only to `via: "public"`. Give a key a way to read as an anonymous visitor
would, and tell every caller what is public:

1. **`audience` argument** on `search_kb`, `list_kb_articles`, `get_kb_article`
   (and the REST equivalents in Phase B): `z.enum(["key", "public"]).optional()`,
   default `"key"`. With `"public"`, apply the public-site filters **in addition
   to** the key's own grants: `kb_collections.public_access = true` and
   `public_hidden = false`. Nothing the key could not already read becomes
   readable; the audience only narrows. The result must be identical to what
   `/pub/kb` would show, so reuse the same predicate (`kbArticlesPublic()`), not a
   copy of it. Out of reach reads as not found, as everywhere.
2. **`public: boolean`** on every article in `search_kb`, `list_kb_articles`,
   `get_kb_article`, and the REST routes: true when the collection is on the public
   site and the article is not held back. Cheap to compute in the same query.
3. **`public_url`** on `get_kb_article` and REST article reads: the public address
   (`kb_public_url + /pub/kb/articles/<id>`) when `public` is true and the site is
   on; null otherwise. `src/server/kb/share.ts` already builds it.
4. Vitest: a key with a read grant on a collection that is not public gets nothing
   with `audience: "public"`; a held-back article is absent from search and 404 on
   get with `audience: "public"`, present with `"key"`. e2e in mcp.spec.ts.
5. Document in API.md and ARCHITECTURE.md (Knowledge base → Access).
