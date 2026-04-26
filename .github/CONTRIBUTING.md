# Contributing to Resolvd

Thanks for your interest in contributing.

## License of contributions

By contributing, you agree your contribution is licensed under the same
**Functional Source License, Version 1.1, ALv2 Future License (FSL-1.1-ALv2)**
as the rest of the project. See [`LICENSE`](../LICENSE) for full terms.

## Developer Certificate of Origin (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org)
instead of a Contributor License Agreement. Every commit must be signed off:

```bash
git commit -s -m "your message"
```

This appends a `Signed-off-by: Your Name <you@example.com>` trailer to the
commit message and certifies that you wrote the code (or otherwise have the
right to submit it under the project's license).

PRs without DCO sign-off on every commit will be flagged automatically.

## Pull requests

- Keep changes focused. One concern per PR is easier to review and to revert
  if anything goes sideways.
- Update the README or in-app docs when you change behaviour.
- Add or update tests where it's reasonable. Backend tests live alongside
  the affected services; frontend changes generally need a manual smoke-
  test through the dev server.
- Write commit messages that describe the *why*, not just the *what*. The
  diff already shows what changed.

## Reporting security issues

Please **do not** open a public issue for security problems. Email
`security@resolvd.dev` (or `josh@hearnetech.com` until that mailbox is live)
with a description of the issue and reproduction steps. We aim to respond
within 48 hours.

## Questions

For commercial licensing or procurement-driven license changes, contact
`hosted@resolvd.dev`. For general questions, open a Discussion on GitHub.
