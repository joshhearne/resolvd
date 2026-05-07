---
name: draft-release-post
description: Draft a release blog post for Resolvd. Reads git commits since previous tag and ROADMAP.md, writes a markdown post into ../resolvd-dev/src/content/blog/<tag>.md. Skip patch releases — they don't get blog posts. Use after tagging a new vX.Y.0 minor or major release. Trigger phrases - "draft release post", "/draft-release-post", "release blog post for vX.Y.0".
---

# Draft Release Post

You are drafting a long-form release announcement post for Resolvd's marketing site (resolvd.dev). The post lives in the sibling `resolvd-dev` repo and gets published when the user commits + pushes it.

## Inputs

The user will invoke this skill with a tag, e.g. `/draft-release-post v1.3.0`. If they don't supply one, ask:

- "Which tag should I draft a post for? (e.g. v1.3.0)"

## Validation rules

1. **Tag must match `vX.Y.Z` semver.** Reject anything else.
2. **Tag must end `.0`.** If the tag is `v1.2.3` (patch), refuse with:
   > Patches don't get blog posts — they go in the changelog. If this release has a feature worth a post, retag as `v1.3.0` (minor) or write a follow-up post manually.
3. **Sibling repo must exist.** Check that `../resolvd-dev` resolves to a git working tree:
   ```bash
   git -C ../resolvd-dev rev-parse --show-toplevel
   ```
   If missing, instruct the user to clone resolvd-dev next to resolvd, or supply an alternative path.
4. **Tag must exist in this repo.** Run `git rev-parse "$TAG^{tag}"` (or `^{commit}` for lightweight tags). If missing, ask the user to push the tag first.

## Drafting steps

### 1. Find the previous tag

```bash
PREV=$(git describe --tags --abbrev=0 "${TAG}^" 2>/dev/null || true)
```

If empty (first release), use the `FIRST_RELEASE_BASELINE` from `.github/workflows/release.yml` — currently `14c6613` ("Finish Resolvd rebrand").

### 2. Pull the commit log

```bash
git log "${PREV:-14c6613}..${TAG}" --pretty=format:'%H%n%s%n%b%n---END---' --reverse
```

Group commits by conventional-commit type:

- `feat(*)` / `feat:` → **headline candidates** for the post body
- `fix(*)` / `fix:` → mention only if widely impactful (security, data loss, big UX bug)
- `refactor(*)`, `chore(*)`, `docs(*)`, `test(*)`, `ci(*)` → exclude from body, link to changelog instead

Belt-and-braces: drop any commit whose subject matches `\b(MOT|Coastal|Motorhomes|Punchlist)\b` (legacy rebrand noise filter — same regex used in `.github/workflows/release.yml`).

### 3. Read ROADMAP.md context

Read `ROADMAP.md` "Recently shipped" section. For each `feat:` commit grouped above, look for a matching entry — those entries have richer prose and "how to use" details that the commit alone won't capture. If no match, draft from the commit body alone.

### 4. Pick the headline features

Pick **3 to 5** features for the post body. Optimize for "things a user would notice and care about" — not internal refactors. If there are more than 5 candidate `feat:` commits, group related ones (e.g. multiple email-pipeline commits → one "Email pipeline upgrades" section).

### 5. Compose the post

Write the file to `../resolvd-dev/src/content/blog/<tag-with-dashes>.md`. Tag-with-dashes means `v1.3.0` → `v1-3-0`. Slug must match the tag for predictable URLs.

Use this frontmatter:

```yaml
---
title: "<tag> — <short headline ≤60 chars>"
tag: "<tag>"
publishDate: <YYYY-MM-DD from $(git log -1 --format=%aI "$TAG")>
summary: "<one declarative sentence ≤180 chars covering the headline>"
featured: true
icon: "<one emoji that fits the headline theme>"
pillLabel: "<2–4 words for homepage pill — present-tense or noun-phrase>"
---
```

Then write the body in this skeleton:

```markdown
<2–3 sentence intro framing the release>

## <Feature 1 name>

<3–6 sentence explanation drawn from commit + ROADMAP entry + your understanding of the codebase>

**How to use:** <1–2 sentence pointer — UI path, env var, CLI command, or admin tab>

**Screenshot:** _add later_

## <Feature 2 name>

...

## Full changelog

[<tag> on GitHub](https://github.com/joshhearne/resolvd/releases/tag/<tag>) has the complete commit list. This post covers the headline features; smaller wins live in the changelog.
```

### 6. Style notes

- Match the prose voice of the existing v0-1-0.md post in resolvd-dev: declarative, no fluff, occasional dry humor allowed but not forced.
- Drop Co-Authored-By trailers, AI attribution, marketing platitudes ("revolutionary", "best-in-class", etc.).
- Code blocks with backtick fencing and a language tag.
- Inline code (file paths, env vars, status names) in single backticks.
- Use `**How to use:**` and `**Screenshot:** _add later_` blocks consistently — the user will replace screenshot placeholders manually.
- Keep total length under ~800 words. The user will edit later.
- Don't invent features. If a commit message is opaque and there's no ROADMAP entry, leave the section out and mention it in the changelog link instead.

### 7. After writing

Print:

1. Absolute path of the new file.
2. A 5-line summary of what you put in it.
3. This reminder, verbatim:

   > Review the draft, add screenshots into a `public/blog/<tag>/` folder and reference them with `![alt](/blog/<tag>/file.png)`, then commit + push from `resolvd-dev`. The marketing site rebuilds via the existing `notify-website.yml` deploy hook the next time CI fires (or trigger a manual rebuild on your host).

## Edge cases

- **Pre-release tag** (e.g. `v1.3.0-rc.1`): refuse. Pre-releases don't get blog posts.
- **Already drafted** (`<tag>.md` exists in resolvd-dev): ask the user before overwriting. Offer to diff against existing.
- **No `feat:` commits in range**: warn the user — likely a release with only refactors / docs / fixes. Offer to skip drafting and recommend a changelog-only release.
- **Sibling repo on a non-clean working tree**: warn but proceed. The user is responsible for committing.

## Why this skill exists

Resolvd's GitHub Releases are commit-list dumps. Useful for diff hunting, useless for "what should I tell my team about this release". This skill bridges that gap — same source of truth (the commit log), better presentation, screenshots filled in by the human afterward.

Patch releases are excluded by design — they're for bug fixes, and the changelog is the right home for those. If a patch ever needs a post, write it manually.
