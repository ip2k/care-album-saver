# brightwheel-archive — project context

## Classification: PERSONAL, open source (MIT)

Established 2026-09-21. This is a personal project, published publicly so other parents can
archive their own children's photos. It is **not** a commercial product and has no business
entity behind it.

Consequences:
- The global "no personal identifiers in a commercial product" rules are relaxed — but see
  the hard rule below, which is stricter in the one way that matters here.
- If this ever heads toward being a product, re-read the global CLAUDE.md incorporation
  checklist first and start an ownership inventory.

## Hard rule: no real personal data, ever, anywhere in this repo

Stricter than the usual house rule, because the data is photographs of children.

- **No real child's photo, name, school, or teacher's note.** Not in tests, not in
  fixtures, not in screenshots, not in an issue.
- **No session cookies, HAR captures, or tokens.** The tool stores these in the OS config
  directory specifically so nothing is ever in the tree.
- All test data and every `docs/images/*.png` come from the mock server in
  `packages/brightwheel-archive/src/mock/server.ts`, which invents "Robin" and "Sam Maple"
  and draws placeholder images. Regenerate with `node scripts/screenshots.js`.
- `gitleaks` runs in CI with custom rules for `_brightwheel_v2` and signed media URLs.

## Adopted skills

Pre-approved, load without asking: `universal-scraping-architect`, `senior-architect`,
`senior-security`, `env-secrets-manager`, `docker-development`, `browser-automation`.

Note: `universal-scraping-architect` mandates its Python `validate_extraction.py` gate.
This repo is TypeScript, so the *principle* is implemented natively in
`src/api/schema.ts` (`validateExtraction` + `assertJsonResponse`). Do not add Python.

`secrets-vault-manager` was considered and rejected: it is for Vault and cloud secret
stores, and this tool is deliberately local-only with no cloud component.

## Architecture decisions worth not relitigating

- **Zero runtime dependencies.** Node stdlib only. ExifTool is optional with graceful
  degradation to JSON sidecars. Every proposed dependency must argue its way in.
- **Read the paginated API, never drive a browser.** The website's infinite scroll is a
  client of `/students/{id}/activities?page=N`. No Selenium, no scroll simulation.
- **Config and session live outside the repo**, in the OS config dir. This is the
  structural answer to the fork-credential-leak problem; everything else is defence in depth.
- **Capture time (`event_date`) beats upload time (`created_at`).** The entire point of
  correcting timestamps. UNVERIFIED against the live API — see docs/QUESTIONS-FOR-FABLE.md.
- **Not hosted in Archive Ferry.** That repo is private, k3s-bound, and its sibling
  adapters are adult-content sites. A children's-photo tool cannot ship from there.

## Status

- 25 tests passing, no network required (`pnpm test`).
- **The API surface is UNVERIFIED against live Brightwheel.** It was derived from six
  existing open-source scrapers. A HAR capture from an authenticated session is the top
  outstanding task. Do not tell a user this is production-ready until that is done.

## Repository hygiene

Last audited for dead code: 2026-09-21, at ~2,400 source lines, initial commit.
Next audit due at roughly 12,400 lines.
