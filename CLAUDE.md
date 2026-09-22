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
  `packages/brightwheel-archive/src/mock/server.ts`, which invents "Robin" and "Sam Maple",
  and from `src/mock/fixtures.ts`, which draws the placeholder images as real JPEG and MP4
  bytes. Regenerate with `node scripts/screenshots.js`, after
  `pnpm exec playwright install chromium` once.
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
- **SETTLED, AGAINST US, 2026-09-22: there is no capture time to recover.** `event_date`
  and `created_at` were identical on all 50 records of a real account, no other field on the
  record carries a time, and the photographs arrive with no EXIF at all — no DateTimeOriginal,
  no GPS (`verify --deep` checks this on any account). So the tool records when a photo was
  POSTED, which is the best date that exists, and the README no longer claims otherwise.
  `event_date` is still preferred over `created_at`, now only because it would be the
  likelier capture time if some other nursery's records ever distinguished them.
- **Not hosted in Archive Ferry.** That repo is private, k3s-bound, and its sibling
  adapters are adult-content sites. A children's-photo tool cannot ship from there.

## Status

- 121 tests passing, no network required (`pnpm test`). CI runs the same suite on Ubuntu,
  macOS and Windows against Node 20, 22, 24 and 26. The win32 rehearsal
  (`BRIGHTWHEEL_ARCHIVE_TEST_PLATFORM=win32 pnpm test`) is 121 tests, 119 passed, 2 skipped.
- **Proven by test, against real bytes:** what is written into a photo and into a video,
  read back out with ExifTool, and that the pixels and the video frame are unaltered; that
  every file is still saved, with a JSON sidecar, when ExifTool is absent; that a run which
  is stopped, or which loses its session part-way, keeps what it saved and the next run
  carries on without skipping anything; that temporary and system folders are refused and
  cloud-synced ones warned about; that the setup page refuses a request with no token, the
  wrong `Host`, or a cross-site origin, and never echoes a session back.
- **The API surface is UNVERIFIED against live Brightwheel.** It was derived from six
  existing open-source scrapers, and no request from this project has ever reached the real
  service. `brightwheel-archive verify` now checks most of the shape read-only — three API
  reads and one HEAD probe sent without the session, downloading nothing and printing field
  names and types rather than values — so running it, or capturing a HAR, is the top
  outstanding task. Do not tell
  a user this is production-ready until that is done. See docs/QUESTIONS-FOR-FABLE.md,
  section B, for what is settled and what is not.
- **Settled 2026-09-22: there is one sign-in, and it is the pasted session.** `src/api/login.ts`
  implemented an email/password/2FA flow that nothing imported and no flag, command or field
  reached; the README promised it to parents anyway. The file is deleted and the promise is
  gone. The argument for not reviving it is in QUESTIONS-FOR-FABLE A1: Brightwheel enforces
  2FA, so unattended password login is impossible, and teaching a parent to type their real
  password into other people's software is the habit phishing depends on.

- **Two directories must be redirected before any test or throwaway script runs**, not one:
  `BRIGHTWHEEL_ARCHIVE_CONFIG_DIR` for the session and `BRIGHTWHEEL_ARCHIVE_DIR` for the
  photos. `scripts/test-env.js` sets both and refuses anything outside the temp directory;
  import it first in any test that touches either. Forgetting the second one put mock
  photographs in a developer's home folder three times on 2026-09-22, each time from code
  that believed the first one covered it.

## Repository hygiene

Last audited for dead code: 2026-09-21, at the initial commit (26f8b5b), where the counting
method below gives **2,593** source lines. (The original note said "~2,400"; see the method
paragraph for why the two differ.)

The global rule is an audit every ~10,000 lines added since the last mark, so the next one
is due at roughly **12,600** lines. An earlier edit here wrote 15,000, which did not follow
from any recorded mark; 2,593 + 10,000 is where it actually falls.

At c6cc452 the tree is **5,356** source lines — 2,763 added since the mark, so the audit is
not yet due.

Counting method, since the original figure does not say: `wc -l` over every `.ts` file
under `packages/*/src`, excluding tests, scripts and the generated `dist/`. That method
gives 2,593 at 26f8b5b rather than ~2,400 — the original was measured slightly
differently, most likely as non-blank lines, which come to 2,355 there. Later marks should
use the method stated here.
