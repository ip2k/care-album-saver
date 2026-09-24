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
- **Not hosted in Archive Ferry.** That repo is private and k3s-bound; a tool other parents
  will run cannot ship from there.

## Status

- 345 tests passing (`pnpm test`; the script is a glob, `packages/care-album-saver/test/*.test.js`,
  because `node --test <directory>` is accepted only by Node 26 — the first CI run failed 11
  of 12 cells on exactly that). The CI matrix is Ubuntu, macOS and Windows against Node 22,
  24 and 26; Node 20 was dropped on 2026-09-23 (EOL, and `exiftool-vendored` needs ≥22).
- **Pushed for the first time on 2026-09-23** to the public https://github.com/ip2k/care-album-saver,
  at b94e7cd, after a history rewrite that dropped eight leaking screenshot blobs and set every
  commit identity to the owner's GitHub noreply address (docs/SECURITY-REVIEW-2026-09-23.md
  §1/§3). **Rewritten and force-pushed once more the same night, at the owner's instruction**
  (main d13f8ff): eight commits made after the first rewrite had picked up the global git
  identity, and two review documents described the owner's personal address. Every commit now
  reads `ip2k <401146+ip2k@users.noreply.github.com>` (this checkout sets that as its local
  identity, so a changed global one cannot leak in again), and no file in any commit names a
  personal address or mail provider. Commit as that identity; never name the owner's mail
  provider or personal address anywhere in the repository. The ~60 local branches that pointed at the old history were deleted and the
  object database garbage-collected the same night: none of the eight blobs remains
  anywhere locally, and `main` is the only branch. CI is green on every
  cell since 90bcdff (Ubuntu, macOS and Windows × Node 22/24/26, the screenshots job, and
  the security workflow's gitleaks scan over the full history); the first two runs failed
  on the test script and on tests that assumed a Mac, both fixed the same night. The review's open WARNINGs are in the
  report with fixes; the ★ ones go in before a first release. `docs/SECURITY-REVIEW-HANDOFF.md`
  is the brief the review was run from.
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
  Tests are barred from the network by `CARE_ALBUM_NO_UPDATE_CHECK` and from desktop notifications
  by `CARE_ALBUM_NO_NOTIFY` (both set in test-env.js).
  See src/updates.ts, src/version.ts (install kinds), docs/UPDATING.md and, for how it works
  and what a release must consist of, docs/UPDATE-CHECK.md.
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

Last audited for dead code: **2026-09-23**, on `main` after the audit merge, at **12,721**
source lines (the counting method is below). The audit read every file: seven readers, one per
group of files, each followed by an adversarial verifier that tried to find a use for every
candidate; 152 verdicts, of which 56 removals, 4 un-exports, 43 comment or doc corrections, 21
referred to the owner (see the audit merge commit and CHANGELOG), 10 kept. The mark before
this was the initial commit (26f8b5b) at 2,593 lines. The security review that followed
(docs/SECURITY-REVIEW-2026-09-23.md) found eleven defects that were fixed the same night.

The global rule is an audit every ~10,000 lines added since the last mark, so the next one
is due at roughly **22,721** lines.

Referred to the owner and still open after the audit, each a product decision rather than
dead code: the pre-rename fallbacks (`BRIGHTWHEEL_*` env vars, the old config folder, the
old default archive folder, the `capturedAt` sidecar key) — all still load-bearing for the
owner's own install until that folder is migrated; the unused server-side filter options in
`src/api/client.ts` (planned item B4-7); the parser fallbacks for API shapes no live account
has shown; the nine npm-based install routes in `src/version.ts` (moot until the package is
published); the `?token=` on `/api/*` requests (DIRECTIONS item 14, for Fable's review); and
whether `src/index.ts` is a library surface at all.

Counting method, since the original figure does not say: `wc -l` over every `.ts` file
under `packages/*/src`, excluding tests, scripts and the generated `dist/`. That method
gives 2,593 at 26f8b5b rather than ~2,400 — the original was measured slightly
differently, most likely as non-blank lines, which come to 2,355 there. Later marks should
use the method stated here.
