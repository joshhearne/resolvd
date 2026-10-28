# Prompt for the Trove KB session: reactions over the API, document types, and `audience`

Paste everything below the line into a Claude Code session in `/opt/trove-kb`.

---

Read CLAUDE.md, docs/ARCHITECTURE.md (Knowledge base → Readers on the public site,
Access) and docs/API.md first. A ticketing system reads the knowledge base through
one API key and shows it to signed-in people whose identity it already knows. Three
things are missing from `/api/v1/kb` for parity with the public site. Work in three
commits, each with passing Vitest + Playwright, `git commit -s`, no AI trailers.

## 1. Favorites and votes through the API, shared with the public site

Favorites and helpfulness votes (`kb_favorites`, `kb_votes`) are keyed by
`readerKey(email)` = sha256(`AUTH_SECRET` + "\n" + lowercased trimmed email)
(`src/server/kb/identity.ts`). A trusted integration should act for a reader by
naming that reader's email, so a favorite made in Resolvd is the same favorite the
person sees on kb.gomotx.com, and the other way round.

- New API scope `reactions` (`API_SCOPES`), granted explicitly like `secrets:reveal`.
  Admin implies it. Without it the routes below answer 403.
- Header `X-Trove-Reader: <email>` names the reader on every reactions call. Derive
  the key with the same `readerKey()`; never store the email. No header → 400.
- The reader must be able to read the article under the key's own grants and the
  `audience` rules below; otherwise 404, like everything else.
- Routes:
  ```
  GET    /kb/articles/:id/reactions
           -> { favorites, helpful_up, helpful_down, helpfulness (0–100 | null),
                mine: { favorite: bool, vote: "up" | "down" | null } }
  PUT    /kb/articles/:id/favorite            -> 204    DELETE -> 204
  PUT    /kb/articles/:id/vote  { helpful }   -> 204    DELETE -> 204
  GET    /kb/favorites?limit=&cursor=
           -> { data: [ article list item + { favorited_at } ], next_cursor }
  ```
  Reuse `src/server/services/kb-reactions.ts`; the public server actions and these
  routes must share one code path so counts and "mine" agree everywhere.
- Also add `favorites`, `helpfulness`, and (when `X-Trove-Reader` is present)
  `mine` to `GET /kb/articles/:id`, so a reader of an article gets its reactions
  in the same call.
- Audit: a reaction through a key is not audited (same as the public site), but a
  key using the scope is logged like any key use.

## 2. Document types, so a reader can filter PDF/Word documents from articles

- `source_type` on every article item in `GET /kb/articles`, `GET /kb/search`,
  `GET /kb/favorites`, and on `GET /kb/articles/:id`: the stored `kb_articles.source_type`
  (`md`, `html`, `pdf`, `docx`, `txt`, …).
- `GET /kb/collections/:id` gains `kinds: { article: n, runbook: n }` and
  `source_types: [{ source_type, articles }]` for the readable, non-archived articles
  (respecting `audience`).
- `source_type` filter on `GET /kb/articles` and `GET /kb/search` (exact match,
  repeatable: `source_type=pdf&source_type=docx`).

## 3. `audience` (from the earlier addendum, still open)

`audience: "key" | "public"` on `GET /kb/search`, `GET /kb/articles`,
`GET /kb/articles/:id`, `GET /kb/collections`, `GET /kb/collections/:id`, and the
reactions routes. With `"public"`, apply the public-site predicate
(`kbArticlesPublic()`, `kb_collections.public_access`) on top of the key's grants, so
a result equals what `/pub/kb` would show. Add `public: boolean` to every article
item and to each collection. Tests: a held-back article is absent with
`audience=public` and present with `key`; counts in `kinds`/`source_types` shrink
accordingly.

## Conventions
- Every read takes a `KbReader`; out of reach is "not found".
- Zod schemas feed the OpenAPI spec; document each route and the header in API.md;
  ARCHITECTURE.md gets a paragraph under Readers on the public site.
