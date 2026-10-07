# Bothy ↔ Resolvd integration

Status: design, 2026-10-06. Nothing here is built yet.

Goal: Bothy (`/opt/bothy`, bothy.gomotx.com, public site kb.gomotx.com) becomes the
company's documentation platform. Resolvd stays the place for tickets and problems.
Resolvd's own KB (`kb_articles`, runbooks, ticket links, suggestions) is retired in
favor of reading from Bothy. Later: one "How may I help you" chat that searches Bothy
and Resolvd before escalating to a ticket.

## 1. What exists today

### Bothy
- Postgres, Next.js, Drizzle. Container `bothy` on 127.0.0.1:3080, one DB.
- KB model: `kb_collections` → `kb_articles` → `kb_chunks` (tsvector search).
  Articles are Markdown, upserted on `(collection_id, source_key)`; `external_id`
  chosen by the writer; `archived_at` instead of delete; `public_hidden` per article.
- Live: 7 collections, ~6,100 articles, 1 user (no OIDC configured yet).
  Public site `open` at https://kb.gomotx.com behind Cloudflare Access (team
  `motorhomesoftexas`). Collections `Bothy KB` and `Unifi KB` are not public.
- Access model: collections are open to all companies or kept to some
  (`kb_collection_companies`); users reach collections through their companies.
  API keys may be granted a collection directly, read or write
  (`api_key_kb_collections`). **No per-user or per-group collection grant.**
- REST `/api/v1`: companies, locations, documents, doc-types, search (documents
  only), external-refs, lookup, vault. **No KB routes.** No users route. No grants
  route. Webhooks have no KB events.
- MCP `POST /api/mcp` (same API keys): `list_kb_collections`, `search_kb`,
  `get_kb_article`, `list_kb_articles`, and with a write grant `upsert_kb_article`,
  `archive_kb_article`. This is the only programmatic KB surface today.
- Auth: Better Auth local accounts + MFA, one generic OIDC provider (env
  `OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET`). Email is the only cross-system key.
- `external_refs.system` is free text and already names `'resolvd'` as an example,
  but covers company/location/document only.

### Resolvd
- Postgres, Express, React. Entra SSO (MSAL, tenant `4bf060fe-…`), 42 users, all
  Entra. Roles: Admin, Manager, Tech, Submitter, Viewer, Support. Session auth only;
  **no bearer/API-key middleware**, no outbound webhooks, no MCP server.
- Own KB: `kb_articles` (per project, BlockNote JSON + `content_text`, status,
  tags, keywords, `agent_only`, `kind` article|runbook), `kb_article_versions`,
  `ticket_kb_links`, `ticket_runbook_runs` (per-ticket checkbox state keyed by
  BlockNote block id), suggestions by pg_trgm on ticket title.
  Live: 14 articles (9 article, 5 runbook), 9 ticket links, 22 runbook runs.
- Frontend: left-rail "Knowledge Base" → `/kb/*` pages; `KnowledgePanel` and KB
  hint banner on `TicketDetail`; `RunbookPanel`.
- AI: provider adapters (`anthropic`, `openai`, `ollama`), org key encrypted under
  `RESOLVD_MASTER_KEY`, per-user BYOK, per-project context. Only feature is rewrite.
- Admin pattern: one singleton settings row per feature + `services/<x>.js` +
  `routes/<x>.js` behind `requireRole('Admin')`, Integrations group in `Admin.jsx`.

## 2. Target shape

```
 staff / users ──► Resolvd (tickets) ──reads/writes via API key──► Bothy (docs, runbooks)
                       │                                              │
                       │  "Help me" chat (Claude + tools)              │  kb.gomotx.com (public)
                       └── search_kb / get_kb_article / runbooks ─────┘  bothy.gomotx.com (staff)
```

- **Bothy owns content**: articles, runbook definitions, categories, public/internal.
- **Resolvd owns ticket state**: which article/runbook is linked to a ticket, runbook
  step progress per ticket, resolution summary.
- **Resolvd is a trusted reader of Bothy** with one API key, and enforces who in
  Resolvd sees what (Submitter vs handler). Users do not need Bothy accounts to see
  internal docs inside Resolvd. Staff who author docs sign in to Bothy via Entra OIDC.
- **Public docs** live on kb.gomotx.com. Resolvd links out to
  `https://kb.gomotx.com/pub/kb/articles/<id>` for public articles and renders
  internal ones inline.

## 3. Bothy changes needed (generic, no Resolvd coupling)

Bothy's CLAUDE.md forbids PSA-specific code, so everything below is plain REST/MCP.

### 3a. REST KB routes under `/api/v1/kb` (read mirrors MCP, write mirrors grants)
| Method | Route | Scope / grant |
|---|---|---|
| GET | `/kb/collections` (`?writable=`) | read |
| GET | `/kb/collections/:id` (categories, counts) | read |
| GET | `/kb/search?q=&collection_id=&category=&kind=&limit=&cursor=` | read |
| GET | `/kb/articles?collection_id=&category=&kind=&updated_since=&cursor=` | read |
| GET | `/kb/articles/:id` (full body, `external_id`, `source_url`, `public_url`) | read |
| PUT | `/kb/collections/:id/articles/:external_id` (upsert) | write grant on collection |
| DELETE | `/kb/collections/:id/articles/:external_id` (archive) | write grant |
Services already exist (`searchKb`, `kb-write.ts`); routes are thin `withApi` wrappers
plus Zod schemas so OpenAPI picks them up. `public_url` = `kb_public_url + /pub/kb/articles/<id>`
when the article is public, else null.

### 3b. Per-user collection grants (the "allow-list users via API" ask)
New table `user_kb_collections (user_id, collection_id, can_write, granted_at)`,
same shape as `api_key_kb_collections`; `readable()` in `services/kb.ts` treats it
like the key grants. Admin UI on `/admin/kb/[id]` gets a "People" section beside
"API key access".
REST (scope `admin`):
- `GET/POST /api/v1/users` — list; create or find by email (role, `all_companies`).
  Needed so an integration can provision before the person's first OIDC sign-in.
- `PUT/DELETE /api/v1/kb/collections/:id/grants/users/:userId` (`{can_write}`)
- `PUT/DELETE /api/v1/kb/collections/:id/grants/api-keys/:keyId`
Optional later: group grants once OIDC `groups` claim is read.

### 3c. Runbooks as a first-class KB kind
Keep a runbook as an article so search, categories, public/internal, MCP, and
upsert all work unchanged. Add `kb_articles.kind` (`article` | `runbook`, default
`article`) and, for runbooks, a `steps` jsonb derived from the body on save:
```
steps: [{ id: "s1", text: "Open Entra admin center", note?: "markdown", canned?: "slug" }]
```
Rules: step `id` is stable across edits (author-assigned in Markdown as `- [ ] {#s1} text`
or minted on first save and preserved by text match), because ticket progress in the
consuming system is keyed by step id. Nested bullets under a step are its `note`.
Expose on `GET /kb/articles/:id` and `get_kb_article`. Filter `kind=runbook` in
list/search. Editor in Bothy: the usual Markdown editor plus a step preview.
Progress of a run is *not* stored in Bothy; the ticketing side owns it.

### 3d. Entra OIDC
Set `OIDC_ISSUER=https://login.microsoftonline.com/<tenant>/v2.0`, client id/secret
from a new Entra app registration, redirect `https://bothy.gomotx.com/api/auth/callback/oidc`.
Same emails as Resolvd, so `readerKey(email)` favorites already match across the
public site and the app.

### 3e. Webhook events (nice to have)
`kb.article.upserted`, `kb.article.archived` with `{collection_id, article_id,
external_id, kind}` so Resolvd can drop its cache instead of polling.

## 4. Resolvd changes

### Phase 1 — Bothy as a source (built 2026-10-06)
- `bothy_settings` singleton: `enabled`, `base_url`, `public_url`, `api_key_enc`
  (under `RESOLVD_MASTER_KEY`), `internal_collection_ids text[]`,
  `public_collection_ids text[]`, `collection_names jsonb` (id → name snapshot),
  `suggestions_enabled`, `last_ok_at`, `last_error`.
  Admin → Integrations → **Bothy knowledge base**: Connection pane (URLs, key,
  enabled, test) and Collections pane (Internal / Public / Hidden per collection).
- `backend/services/bothy.js`: client with an **MCP transport** (`POST
  {base_url}/api/mcp`, JSON-RPC `tools/call`, reads `structuredContent`) because
  Bothy has no REST KB routes yet. Swap to `/api/v1/kb` (3a) when it lands; callers
  do not change. 60 s result cache, 12 s timeout, errors never carry the key.
  Multi-collection search fans out one call per collection (Bothy's search takes
  one `collection_id`); an article's body is its chunks joined. Bothy ANDs every
  word, so title-driven searches (suggestions, drafts, briefs) retry with the
  title's key terms joined by OR when the exact query finds nothing (`orFallback`).
- Mapping as of 2026-10-06: Public = Fidium ProConnect Support, Foretravel Wiki,
  IDS G2 KB, Proofpoint Total Protection 365, MOT IT Public. Internal = MOT IT
  Internal. Projects: IDS G2 Astra → IDS G2 KB; Helpdesk Incidents, HR Helpdesk,
  Service Requests, DevOps → MOT IT Internal.
- `base_url` is `https://bothy.gomotx.com`: the container cannot reach the host's
  127.0.0.1:3080, and the public hostname answers API calls without an Access
  redirect (verified 2026-10-06).
- Visibility is decided in Resolvd: handlers (global Admin/Manager/Tech or
  project handlers) see internal + public; everyone else public only. Nothing
  mapped → handlers see everything the key reads, others see nothing.
- Routes: `/api/bothy-settings` (Admin) and `/api/bothy` (status, collections,
  search, articles/:id, tickets/:id/links, tickets/:id/suggestions).
- `ticket_bothy_links (ticket_id, article_id uuid, title, collection_id,
  collection_name, kind, created_by)` — a **separate** table from `ticket_kb_links`
  so the local KB keeps working until Phase 3 moves its rows. Title and collection
  name are snapshots for when Bothy is down.
- Frontend: Bothy search + collection chips on `/kb`; reader at
  `/kb/article/:uuid` (Markdown via react-markdown, "Open in Bothy" / public link);
  `BothyKnowledge` block inside the ticket `KnowledgePanel` (links, title-based
  suggestions, search-to-link). Local suggestions banner untouched.
- **Project ↔ collection**: `projects.bothy_collection_id` (UUID), edited in Admin →
  AI Assist → Project contexts ("Bothy collection ID", datalist of known names).
  Suggestions search that collection first; resolution drafts prefer it; Phase 3
  promote-to-KB will write to it.
- **Resolution draft** (`POST /api/bothy/tickets/:id/resolution-draft`,
  `services/bothyResolution.js`): two tiers from the same inputs.
  1. *Extractive digest*, no AI, always: per article the title, link, collection ·
     category, and the passage Bothy matched for the ticket title (heading +
     snippet), else the article's opening; runbook steps when Bothy returns `steps`.
  2. *AI summary*, only when the caller may use AI Assist (org key or BYOK,
     resolved by `aiSettings.resolveEffectiveConfig`): synthesizes ticket +
     articles into a short write-up with steps citing their article. Logged in
     `ai_rewrite_logs` with surface `kb_resolution_summary`. When unavailable, the
     response carries a `note` telling the tech an AI token is required for the
     summary, and the digest still comes back.
  Articles: explicit ids → the ticket's Bothy links → top 3 title matches.
  UI: "Draft resolution from Bothy" in the ticket's Bothy block, appends to the
  resolution summary editor; "AI summary" checkbox when available, otherwise
  "Extracted passages only (no AI token)".
- **Knowledge briefs** (`services/bothyAssist.js`, `ticket_assist_briefs`,
  `POST /api/bothy/tickets/:id/assist/{brief,compose}`, `GET …/assist/briefs`):
  "Scope with knowledge" on the comment composer. The brief is built with no AI from
  trusted inputs: what the user reported (title, description, non-handler comments),
  what the team said, the tech's draft, the tech's **corrections** (what the user left
  out; carried into the next brief on the ticket), the project context, and Bothy
  articles matched on the title (project collection first) and the draft's key terms,
  each include/exclude with a per-article note. The tech reviews everything in a
  scrollable form, then:
  - **Build (no AI)**, default: reply = the draft plus links to included *public*
    articles; resolution = reported + clarifications + response + article digest.
  - **Rewrite with AI**: the curated brief goes to the configured provider with the
    rules that reported/draft/corrections are true (corrections override), procedure
    comes only from the articles, INTERNAL articles are never named in the reply,
    PUBLIC ones may be linked. Output is `## Reply` + `## Resolution`. Logged with
    surface `comment_assisted`. Falls back to the extractive result on failure.
  Every run is stored with its inputs and output for audit. "Use as comment" fills
  the composer (AI log id attached); "Save as resolution" patches the ticket.
- **Project collection picker**: Admin → AI Assist → Project contexts now offers a
  dropdown of live Bothy collections (plus "Paste a collection ID…").
- **Held-back articles**: Bothy's `public_hidden` and a collection's "Show on the
  public site" gate only `/pub/kb`; an API key sees everything it is granted.
  Resolvd therefore sends `audience: "public"` on every non-handler read (Bothy
  strips unknown args today, honors it once the addendum in
  `docs/bothy-runbooks-prompt.md` ships) and filters on the `public` flag Bothy
  will return. `bothy_settings.public_strict` (default on): non-handlers see an
  article only when that flag is true, so until Bothy ships it they see nothing
  from Bothy. Off = trust the whole Public collection, held-back included.
- **Bothy links**: only Resolvd Admins get `base_url` / `staff_url` ("Open Bothy",
  "Open in Bothy"). Everyone else reads in-app; digest links use the public site or
  `/kb/article/<id>`.
- **Transport switched to REST** (2026-10-06 evening) once Bothy shipped `/api/v1/kb/*`:
  `{data,next_cursor}` lists, articles with `kind`, `steps`, `internal_only`,
  `public_url`. `audience` is still not implemented in Bothy, so for non-handlers
  Resolvd fetches each search hit (cached) and keeps only articles with a
  `public_url` (collection public, site on, not held back). Strict mode is now
  real rather than empty.
- **Phase 2 done — runbooks from Bothy**: `ticket_runbook_runs.bothy_article_id`
  (+ `bothy_title`, `article_id` nullable), routes `GET /api/bothy/runbooks`,
  `/api/bothy/tickets/:id/runbook-runs` (list/start/patch/delete), step state
  keyed by Bothy step id, `canned` on a step → canned-response pill.
  `BothyRunbookPanel` renders above the local panel; the local one hides when
  `local_kb_enabled` is off.
- **Phase 3 built — Replace local KB**: Admin → Bothy → "Replace local KB" shows
  the plan (`services/bothyMigration.js`: twin by `external_id resolvd:kb:<id>`,
  links, runs, step coverage) and applies it: copy `ticket_kb_links` →
  `ticket_bothy_links`, re-key runs (block id → first 8 hex = Bothy step id),
  archive local articles, `local_kb_enabled = false`. Local rows kept.
  Promote-to-KB goes to Bothy (`POST /api/bothy/tickets/:id/promote`, upsert
  `resolvd:ticket:<id>` into the project's collection, internal-only, category =
  project, subcategory Drafts) — needs the key to have the `write` scope and a
  write grant on that collection.
- Not done: the suggestions *banner* still uses the local ranker; no UI yet for
  browsing saved briefs (the API exists); `audience` still pending in Bothy.

### Phase 2 — Runbooks from Bothy
- `ticket_runbook_runs.article_id` → `bothy_article_id UUID`; `step_states` keyed
  by Bothy step id instead of BlockNote block id. `RunbookPanel` fetches steps from
  Bothy and renders checkboxes; `@canned:<slug>` pills keep working via the
  `canned` field on a step.
- Picker filters `kind=runbook` in the project's mapped collection.

### Phase 3 — Retire Resolvd's KB editor
- Migrate the 14 articles: BlockNote JSON → Markdown, upsert into Bothy collections
  (`MOT IT Internal`, internal_only; `MOT IT Public`, public). Runbooks → kind
  runbook with step ids; rewrite `ticket_runbook_runs.step_states` keys
  block id → step id (22 rows, one-off script with a mapping table).
  `ticket_kb_links.article_id` → `bothy_article_id` (9 rows).
- "Promote ticket to article" (`POST /from-ticket/:id`) becomes an upsert into
  Bothy as a draft (`internal_only: true`, category `Drafts`), opened in Bothy.
- Delete `KbEditor.jsx`, versions routes; keep `kb_article*` tables one release
  for rollback, then drop.

### Phase 4 — "How may I help you"
- Resolvd route `POST /api/assist/chat` using the existing Anthropic adapter with
  tool use: `search_kb`, `get_kb_article` (Bothy REST), `search_my_tickets`,
  `get_ticket`, `draft_ticket` (Resolvd). System prompt from `ai_settings` tone +
  project context. Visible to everyone; Submitters see public articles only.
- Escalation: the bot fills a ticket form (project → category → form fields from the
  custom-forms work) and shows it for confirmation; creates the ticket with
  `ticket_kb_links kind='system'` for whatever it cited.
- Resolvd MCP server (`/api/mcp`, API-key auth) exposing tickets read + create, so
  Claude Desktop and Bothy-side tooling can see ticket context. Needs the new
  API-key middleware (per-client scopes, rotation, revocation).

## 5. Identity and access rules
- Email is the join key. Both apps sit on the same Entra tenant.
- Resolvd never forwards a user's Bothy session; it uses its own key and enforces
  its own roles. Internal collections are never shown to Submitter/Viewer.
- Bothy stays behind Cloudflare Access for staff; kb.gomotx.com keeps its current
  Access policy. Nothing on kb.gomotx.com reaches the API or MCP (nginx 404).
- Resolvd's Bothy key: `read` scope, no companies, read grants on the internal and
  public collections, write grant only on the collection used for ticket promotions.

## 6. Open decisions
1. Per-user grants in Bothy (3b) vs. Resolvd-as-sole-reader. Recommend both: 3a
   first (unblocks everything), 3b second (lets staff author in Bothy by collection).
2. Runbook step id scheme (3c): author-written `{#id}` vs minted-and-matched.
   Recommend minted on save, preserved by text match, overridable with `{#id}`.
3. Where runbook *progress* for non-ticket runs (ad-hoc checklists) lives, if ever.
   Proposal: nowhere; a runbook outside a ticket is read-only.
4. Collections for MOT content: one internal + one public, or per Resolvd project.
   Recommend two, with `category` = Resolvd project/category name.

## 7. Order of work
1. Bothy 3a (REST KB read + upsert) and 3d (Entra OIDC)  ← no Resolvd change yet
2. Resolvd Phase 1 (settings, client, suggestions, reader)
3. Bothy 3c (runbooks) → Resolvd Phase 2
4. Bothy 3b (user grants API) in parallel with Resolvd Phase 3 migration
5. Phase 4 chat + Resolvd MCP
