# care-album-saver — project context

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
  `packages/care-album-saver/src/mock/server.ts`, which invents "Robin" and "Sam Maple",
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

- 310 tests passing on 2026-09-23 (evening, at 3a44cbe), no network required (`pnpm test`).
  The CI matrix in `.github/workflows/ci.yml` is written for Ubuntu, macOS and Windows
  against Node 20, 22, 24 and 26 but **has never run**. The remote exists — `origin` is
  https://github.com/ip2k/care-album-saver, **public**, and still empty: nothing has been
  pushed. Before the first push, scan the whole history, not just the tree: an earlier
  commit's screenshots held the owner's home path (fixed later, still in history). No CI
  job builds the Docker image; `test/dockerfile.test.js` checks what it copies exists.
- **Production and development are separate (2026-09-23).** Production is a clone on
  `main` at ~/Applications/care-album-saver, changed only by `node scripts/deploy.js`,
  which builds and runs the whole suite there, puts production back on its previous commit
  if anything fails, and moves the owner's daily run onto it. **After merging to main,
  deploy.** Development is *marked*, not inferred: deploy.js writes
  `care-album-saver-development` into this checkout's git common dir, so this checkout and
  every worktree of it refuse to install the real daily run, while a parent's plain clone
  (which has no mark) is an ordinary install. Dev UI work uses `scripts/demo.js`.
- **The update check is ask-once and must stay that way (settled with the owner,
  2026-09-23).** `checkForUpdates` is null until the parent answers on the dashboard; only
  `/api/update` sets it. Then GitHub's releases API is asked at most daily, only from the
  setup page, never from the daily run, with no cookie, token or tool-named User-Agent.
  Tests are barred from the network by `CARE_ALBUM_NO_UPDATE_CHECK` (set in test-env.js).
  See src/updates.ts, src/version.ts (install kinds) and docs/UPDATING.md.
- **Adding to Apple Photos is off by default and must stay that way** (settled 2026-09-23).
  It is the one setting that can send photos off the machine — with iCloud Photos on, Apple
  uploads them — so it is turned on only through `/api/photos`, which asks macOS for
  permission first and records *from when*; a settings patch cannot set it. Everything the
  tool asks Photos to do is in `applescript/add-to-photos.applescript`, run with argv and
  never with `-e`. Photos gets a `Brightwheel` folder mirroring the disk layout. No test may
  drive the real Photos app: `scripts/test-env.js` sets `CARE_ALBUM_NO_PHOTOS`, and
  `src/photos.ts` refuses to start osascript while it is set. See docs/PHOTOS.md.
- **Proven by test, against real bytes:** what is written into a photo and into a video,
  read back out with ExifTool, and that the pixels and the video frame are unaltered; that
  every file is still saved, with a JSON sidecar, when ExifTool is absent; that a run which
  is stopped, or which loses its session part-way, keeps what it saved and the next run
  carries on without skipping anything; that temporary and system folders are refused and
  cloud-synced ones warned about; that the setup page refuses a request with no token, the
  wrong `Host`, or a cross-site origin, and never echoes a session back.
- **The API surface has been checked against one live account, at one nursery.** A full
  run on 2026-09-21 read every endpoint the tool uses and saved 632 files (174 MB);
  `verify` and `verify --deep` ran on 2026-09-22 and confirmed the field names, corrected
  one (`actor.first_name`/`last_name`, not `actor.name`) and found no EXIF in the photos.
  Still open, each with a read-only `verify` extension planned: whether `page` is 0- or
  1-based, whether `page_size=100` is honoured, whether `action_type=ac_photo` filters or
  is ignored, whether a higher-resolution original exists, how long a media signature
  lives, and whether a second nursery's records distinguish `event_date` from
  `created_at`. No HAR has been captured. See docs/QUESTIONS-FOR-FABLE.md section B.
- **Settled 2026-09-22: there is one sign-in, and it is the pasted session.** `src/api/login.ts`
  implemented an email/password/2FA flow that nothing imported and no flag, command or field
  reached; the README promised it to parents anyway. The file is deleted and the promise is
  gone. The argument for not reviving it is in QUESTIONS-FOR-FABLE A1: Brightwheel enforces
  2FA, so unattended password login is impossible, and teaching a parent to type their real
  password into other people's software is the habit phishing depends on.

- **Two directories must be redirected before any test or throwaway script runs**, not one:
  `CARE_ALBUM_CONFIG_DIR` for the session and `CARE_ALBUM_DIR` for the
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

At 6527f06, with the four `ux/*` branches merged, the tree was **8,843** source lines;
with the Apple Photos option merged, **10,850**. On 2026-09-23 at 3a44cbe it is
**12,891** — 10,298 added since the mark, so **the dead-code audit is now due**. The
2026-09-22 review (docs/DIRECTIONS-FOR-OPUS.md) already lists things to remove when it
comes: the `openBrowser` option, `dist/api/login.*`, fourteen unused `media-ferry` exports
(now under src/ferry since the fold).

Counting method, since the original figure does not say: `wc -l` over every `.ts` file
under `packages/*/src`, excluding tests, scripts and the generated `dist/`. That method
gives 2,593 at 26f8b5b rather than ~2,400 — the original was measured slightly
differently, most likely as non-blank lines, which come to 2,355 there. Later marks should
use the method stated here.
