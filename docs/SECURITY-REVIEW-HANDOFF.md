# Handoff: adversarial security review before the first push

For Fable, from the Opus session of 2026-09-23. The owner's request: an adversarial security
review of the whole thing, and a go / no-go on pushing the repository — **all of its
history** — to the public `ip2k/care-album-saver`, which exists, is public, and is still
empty.

Nothing here is a finding of yours. It is what changed since your review of 2026-09-22
([QUESTIONS-FOR-FABLE.md](QUESTIONS-FOR-FABLE.md), [DIRECTIONS-FOR-OPUS.md](DIRECTIONS-FOR-OPUS.md)),
an inventory of what can be attacked, the first-pass checks already run with their exact
results, and the places I would push hardest. Treat my "verified" as a claim to test, not a
result to trust. Where I did not check something, it says so.

The review target is `main` at 1f86f3b. The tree is at `~/Developer/brightwheel-archive`
(the folder kept its old name; the project is Care Album Saver). The owner's own
production copy, which runs their real daily job, is a separate clone at
`~/Applications/care-album-saver`; see "Two copies on this machine" below.

**This file is written to be publishable**: no real names, paths, tokens or account
details. Keep it that way if you add to it, or delete it before the push — your call.

---

## 1. Go / no-go: what has to be true before the push

| # | Check | State |
|---|---|---|
| 1 | No real child's name, staff name, nursery, photo or note anywhere in history | Text: **clean** (first pass below). **Images: not checked** — 88 PNG blobs |
| 2 | No session cookie, session payload, signed media URL or token in history | **Clean** except the deliberate fakes in two test files (allowlisted) |
| 3 | No home-folder path in history | Text: **clean**. Images: the known leak lives in early screenshots — not checked |
| 4 | Author and committer identities are what the owner wants public | **Owner decision needed** — see 1.3 |
| 5 | gitleaks with `.gitleaks.toml` passes over the full history | **Not run** (not installed here; CI would run it on push) |
| 6 | The CI and security workflows are safe to run on a public repo with forks | Not reviewed since 09-22 |
| 7 | Everything in section 4 you consider blocking is fixed | — |

### 1.1 History scan already run (text only)

A script read, locally and without printing them, the two child-name tokens from the
owner's real archive folder names, the one staff name in its sidecars, and the owner's two
historical home-folder usernames, then ran `git grep -I` over **every one of the 123 commits
reachable from any of the 44 branches** (`git rev-list --all`), excluding only
`pnpm-lock.yaml`:

| pattern | hits |
|---|---|
| child-name tokens (whole word, case-insensitive) | 0, 0 |
| staff name | 0 |
| `/Users/<owner>` for both historical usernames | 0, 0 |
| `_brightwheel_v2` followed by a value (the gitleaks rule) | 0 |
| a `session.json` payload (`"cookie": "<20+ chars>"`) | 0 |
| a signed media URL (`signature=` etc.) | 149, all in `test/fix-privacy.test.js`, `test/gitleaks-rules.test.js` and the pre-rename copy of the first — deliberately fabricated to test the rules, and covered by the allowlist in `.gitleaks.toml` |

`-I` skips binary files, so **this says nothing about images**. No `.jpg`, `.heic`,
`.mp4`, `.mov` or `.har` has ever been added in any commit; the only images ever committed
are the documentation screenshots, `docs/images/*.png` — 88 distinct blobs across history.
The known leak (CLAUDE.md, Status) is that early screenshots rendered the owner's home path;
it was fixed in the tree and is still in history. To look at every one of them:

```sh
mkdir -p /tmp/png-history && git rev-list --all --objects -- docs/images \
  | awk '$2 ~ /\.png$/ {print $1, $2}' | sort -u -k1,1 \
  | while read blob path; do git cat-file -p "$blob" > "/tmp/png-history/${blob:0:10}-$(basename "$path")"; done
ls /tmp/png-history | wc -l   # 88
```

Only synthetic data should appear in any of them: the mock's "Robin Maple" and "Sam Maple",
`parent@example.com`, and tilde paths. Anything else — a real first name, a `/Users/…`
path, a real nursery — is a rewrite before the push.

### 1.2 How to rewrite, if needed

Nothing has been pushed, so a rewrite costs nothing but the local branch names. Suggested:
`git filter-repo` (not installed here) with `--path` / `--invert-paths` for bad blobs or
`--replace-text` for text, then re-run section 1.1 and the PNG extraction on the result.
The owner's production clone (`~/Applications/care-album-saver`) fetches from this checkout
by path: after a rewrite, `scripts/deploy.js` will refuse to fast-forward it; re-clone it
(`rm -rf` it and run `node scripts/deploy.js`, which clones fresh) — but check with the
owner first, since the daily job runs from it.

### 1.3 Identities in every commit — owner decision

Every commit carries the owner's name and one of two personal addresses: 168
author/committer entries use a plus-addressed alias (`…+itunes@…`), 78 the plain address.
The project is classified PERSONAL, so the global "no personal identifiers" rule is relaxed —
but publishing is irreversible, and GitHub may refuse the push outright if the account has
"Block command line pushes that expose my email" turned on. The usual answer is a mailmap
rewrite to the account's `@users.noreply.github.com` address before the first push. Ask.

### 1.4 Also going public with the history

Worth a deliberate yes or no from you or the owner, not a default:

- `CLAUDE.md` (project instructions for agents; describes the owner's local setup in
  general terms), `docs/QUESTIONS-FOR-FABLE.md`, `docs/DIRECTIONS-FOR-OPUS.md` and this
  file. The 1.1 scan found nothing personal in them.
- `.claude/launch.json` is tracked: two dev-server entries (the demo on 4719, the
  production setup page on 4720). Nothing personal.
- 44 local branches, many merged. Pushing only `main` is simplest; pushing all publishes
  every intermediate state, which is where old screenshots live too.
- `QUESTIONS-FOR-FABLE.md` still says the code is at `~/Developer/care-album-saver`; it is
  at `~/Developer/brightwheel-archive`.

---

## 2. What changed since your 2026-09-22 review

All of it merged to `main` with an Intent / Release notes / Test results record in the merge
commit, and a `CHANGELOG.md` entry. The security-relevant surface each one added:

| Stream | What it added that an attacker could touch |
|---|---|
| Apple Photos import (off by default) | `osascript` with the fixed script `applescript/add-to-photos.applescript` and argv (never `-e`); album and folder names from archive paths; TCC Automation consent; `/api/photos`; state in `photos.json` |
| Generic User-Agent | the browser's UA captured from the setup page's own request and stored in `session.json`, re-validated on load (`acceptableUserAgent`: `Mozilla/5.0 (`, ASCII, ≤512) and sent as a header on every request |
| Durable Node path, SIGTERM, log modes | launchd plist `Umask` 63 and `ExitTimeOut`; `daily.log` chmod 600/700 on every write |
| Refused-session wording | messages only |
| Sizes like the file manager | none |
| One run at a time | `.care-album-saver.lock` in the archive folder, created `wx`; stale by dead pid on this host or 30 min untouched; an unreadable lock is never treated as abandoned |
| Settings as sections | `/api/config` refuses relative folder paths from the page |
| Production / development split | `scripts/deploy.js` (fetches this checkout's `main` into the production clone, `pnpm install --frozen-lockfile`, runs the suite, `git reset --hard` to the previous commit on failure, reinstalls the daily run); `scripts/production.js`; an untracked `.care-album-saver-production` marker; a `care-album-saver-development` marker inside `.git` (see 3.9) |
| Photo viewer, last run in full | `GET /api/gallery?page=N`; `/photo` now answers single byte ranges (`parseRange`, 206/416); CSP gains `media-src 'self'` |
| Log line timestamps | a scheduled run replaces `process.stdout.write` / `process.stderr.write` with a line-stamping wrapper (`src/log-lines.ts`) |
| Update check (ask once) | the first outbound request to anyone but Brightwheel: `GET https://api.github.com/repos/ip2k/care-album-saver/releases/latest`, from the server, after an explicit yes; `/api/update`; `update-check.json`; install-kind detection from file paths; release notes rendered in the page |
| Dockerfile fixed | the image builds again (it had been broken since the media-ferry fold) |
| Dead-code audit | nothing new to attack: 56 removals and 4 un-exports (a never-taken download-resume path, the manifest's hash index, options nothing set, the legacy one-line cron block, stale `dist/api/login.*`), 43 comment and doc corrections; six defects found on the way are listed at the end of the merge commit and in section 4 |

Owner decisions taken in these streams that you may want to challenge, but should know are
deliberate: Photos import off by default and enabled only through `/api/photos`; the update
check asks once and sends nothing before a yes; GitHub Releases rather than npm; no gallery
library (zero runtime dependencies stands); `event_date` preferred but the tool claims only
"posted", never "taken".

---

## 3. Attack surface

### 3.1 The local web server — `src/web/server.ts`

Binds `127.0.0.1`, random port unless given. Every request: `Cache-Control: no-store`,
`Referrer-Policy: no-referrer`, `nosniff`, `X-Frame-Options: DENY`, CSP
`default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline';
script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'`;
then a `Host` allowlist (DNS rebinding), a fetch-metadata cross-site refusal, and a 32-byte
setup token compared with `timingSafeEqual`, taken from `?token=` or `x-setup-token`.

Routes: `GET /`, `/api/state`, `/api/children`, `/api/gallery`, `/api/logs`,
`/api/schedule`, `/photo`, `GET|POST /api/update`; `POST /api/session`, `/api/config`,
`/api/choose-folder`, `/api/open-folder`, `/api/open-logs`, `/api/photos`, `/api/schedule`,
`/api/schedule/off`, `/api/sync`, `/api/stop`.

Push on:
- **`/photo`** takes `?i=<manifest index>` and the token in the query (an `<img>` cannot send
  a header — the one documented exception). `photoAt` resolves only manifest entries and
  checks the result is under the archive folder with `startsWith(root + '/')`. Try a
  hand-edited `archive.json` with `..` segments, absolute paths, symlinks inside the archive
  pointing out of it, and Windows paths.
- **`parseRange`** (new): single ranges only; multi-range and malformed fall back to the
  whole file. Try huge numbers (beyond `Number.MAX_SAFE_INTEGER`), `bytes=-0`, leading
  zeros, whitespace, and a range on a file that shrinks between `stat` and the read.
- **`/api/update` POST `{enabled:true}`** is the one route that makes the server start
  talking to a third party. It is behind the token like everything else; confirm a
  cross-site page cannot reach it (it should die at the fetch-metadata check).
- **`/api/session`** stores the pasted cookie and the request's own `User-Agent`. Confirm
  the stored UA cannot carry CR/LF or anything else into a header later.
- The **token in the page URL** lives in browser history. Accepted on 09-22; restate if you
  now disagree.

### 3.2 The page — `src/web/page.ts`

One `String.raw` template: HTML, CSS and an inline script. Every string from outside —
child names, notes, file names, the account email, staff names, and now **GitHub release
notes** — must reach the DOM as text. There are 17 `innerHTML` assignments; most build
fixed markup around values passed through `esc()`. Audit each one; the ones that interpolate
anything at all are at lines of `show()`, `howto`, the children list, the dashboard facts
(`dash-connected`, `dash-last`) and the duplicates actions. Release notes go through
`paintNotes`, which builds text nodes only (a test asserts the function contains no
`innerHTML`). The release link's `href` comes from the server only after `parseRelease`
checked it starts with `https://github.com/ip2k/care-album-saver/releases/`.

### 3.3 Outbound requests

- **Brightwheel API** (`src/api/client.ts`): the session goes as a `Cookie` header, with the
  stored UA. `fetch` uses its default `redirect: 'follow'`. **Probe:** does undici strip a
  manually set `Cookie` header on a cross-origin redirect? If it does not, a redirect from
  the API host to anywhere else carries the session with it. A mock that answers 302 to a
  second local server settles it in a few lines; `redirect: 'manual'` for API calls is the
  obvious fix if needed.
- **Media CDN** (`src/ferry/download.ts`): signed URLs, sent with only a `User-Agent` —
  no cookie — and `redirect: 'follow'`. Resumable with `Range` / `If-Range`. Signed URLs
  are bearer credentials; `redactUrl` and `scrub` keep them out of logs — check every
  error path that could print one.
- **GitHub** (`src/updates.ts`): no cookie, no token, no tool-named User-Agent; 10 s
  timeout; body capped at 1 MB; the release is kept only if `tag_name` is a version and
  `html_url` is this repository's releases page; drafts and pre-releases dropped. The "how to
  update" commands are built locally from the install kind (`updateSteps`), **never** from
  the response — a hostile release body cannot put a command in front of the parent. Check
  that stays true.

### 3.4 Things the tool writes, and where their names come from

Archive folder (0700, refused if temporary or a system folder, warned if cloud-synced):
photos, `.json` sidecars, optional `.xmp`, a `README.md` per week folder, `archive.json`
(atomic), `.care-album-saver.lock`. Config folder (0700): `session.json`, `config.json`,
`last-run.json`, `photos.json`, `update-check.json`, all 0600 via `writeSecureFile`. Logs:
`~/Library/Logs/care-album-saver/daily.log` (0600/0700). Scheduler files: the launchd plist,
systemd units, a crontab block, a Task Scheduler XML.

Folder and file names are built from **remote data** — child names, dates, ids,
extensions — through `src/ferry/names.ts` (`safeName`, `safeExtension`). Fuzz them: `..`,
`/`, `\`, NUL, Windows reserved names (`CON`, `NUL`, `COM1`), trailing dots and spaces,
Unicode that normalises to `/` or `.`, and very long names.

### 3.5 Processes started

`osascript` (Photos: fixed script, argv; notifications: **`osascript -e`** with a script
built in `src/schedule.ts` — confirm only fixed text can reach it), the folder chooser and
file-manager openers in `src/native.ts` (`osascript`, `zenity`/`kdialog`, PowerShell,
`open`/`xdg-open`/`explorer`), `launchctl`, `systemctl --user`, `crontab`, `schtasks`,
`notify-send`, `open -a Console`, `cmd /c start`. All through `execFile` (no shell) except
that **`crontab -` reads a file the tool writes** and **`schtasks /XML` reads an XML file
the tool writes**: probe quoting and escaping of paths containing spaces, quotes, `%`, `$`,
backticks, newlines and `&` / `<` in both.

### 3.6 ExifTool

`exiftool-vendored` (optional dependency; ships a Perl ExifTool and runs it as a long-lived
process fed through an argument file, one argument per line). Tag values come from the API:
notes, child names, staff names. **Probe:** a note containing a newline followed by an
ExifTool option (`-o`, `-@`, `-execute`, `-TagsFromFile`) — does exiftool-vendored encode
newlines in values, or can a note written by a nursery add arguments? `src/metadata.ts`
does no escaping of its own.

### 3.7 Secrets in memory, logs and errors

`Secret` wraps the session (`expose()` only at the header); `scrub` / `scrubDeep` redact
cookies, signed URLs and tokens from anything printed or logged; the page never echoes a
session back. The daily log names children and the archive path — owner-only files, and
never in the repo (`CARE_ALBUM_LOG_DIR` redirects it for tests and screenshots).

### 3.8 Supply chain and CI

- Runtime dependencies: none. Optional: `exiftool-vendored@38.1.0` and its platform package
  `exiftool-vendored.pl@13.59.2` (a Perl script from npm that the tool executes).
- GitHub Actions are pinned by **tag**, not commit SHA: `actions/checkout@v5`,
  `pnpm/action-setup@v6`, `actions/setup-node@v6`, `actions/upload-artifact@v4`,
  `gitleaks/gitleaks-action@v3`. The security workflow runs on `pull_request` from forks
  with `permissions: contents: read` and passes `GITHUB_TOKEN` to gitleaks.
- Docker: `node:22-slim` unpinned by digest; Debian's `libimage-exiftool-perl` installed but
  not used (the vendored one is); the image runs as `node` (uid 1000).
- `pnpm audit --audit-level=moderate` runs in CI; not run locally this session.

### 3.9 Two copies on this machine, and the development marker

`scripts/deploy.js` keeps the owner's production clone on `main`, runs the whole suite
there before switching the daily run to it, and `git reset --hard`s back on failure. It
writes `care-album-saver-development` into this checkout's **git common directory**; the
tool treats that as development and refuses to install the real daily run from it, or from
any worktree of it. A parent's plain clone has no marker and behaves as an ordinary install.
Confirm nothing in a cloned repository can make a copy think it is production or
development (both markers are untracked; the development one is inside `.git`).

---

## 4. Where I would push hardest

0. Six defects the audit found and did not change — **fixed in the merge of
   `fix/2026-09-23@review-defects` (b9bee3b), with a test each in `test/review-fixes.test.js`
   except `.dockerignore`, which has a build proof; the review's report,
   [SECURITY-REVIEW-2026-09-23.md](SECURITY-REVIEW-2026-09-23.md), says what was verified.** They were:
   `.dockerignore` patterns are root-anchored, so the host's `dist/` and `node_modules`
   went into the image (the review image contains `dist/api/login.js`, which exists only
   on the host); a malformed JSON body to any POST route reaches the outer catch and the
   500 echoes ~10 characters of the input (`JSON.parse`'s message quotes it; `scrub` does
   not recognise it); `/api/config` spreads every unvalidated key into `config.json`
   (`delayMs: 0`, a forged `schedule`, a non-string `archiveDir`); the Photos-failure
   notification can never fire (`notify()` builds a script only for `FAILED_NOTICE`);
   `/photo`'s containment check hard-codes `/` and fails on Windows; the demo's "open the
   log" runs a real `open -a Console`.
1. The PNG history (1.1) — the one place a real path is known to have been.
2. The cookie across a redirect (3.3).
3. Newlines in ExifTool values (3.6).
4. Remote names into paths (3.4), including on Windows.
5. The scheduler files' quoting (3.5): `crontab` and the Task Scheduler XML.
6. `photoAt` with a hand-edited manifest (3.1).
7. Every `innerHTML` in the page (3.2).
8. The notification `osascript -e` (3.5).
9. Whether pinning Actions and the Docker base by digest is worth the upkeep.

---

## 5. What was verified this session, and what was not

Verified: `pnpm clean && pnpm build && pnpm test` on main at 1f86f3b: 310 tests, 310 pass, 0 fail; `tsc --noUnusedLocals --noUnusedParameters` clean; the Docker image built (`docker build`, legacy builder, 474 MB) and,
inside the container, saved the mock's 8 items into a bind-mounted folder with metadata
embedded by the vendored ExifTool 13.59, running as `node`, with no session, `.git`, HAR or
`.env` in the image; the viewer, update flow and paging driven in Chromium; the deploy
rollback rehearsed on throwaway clones; the history text scan in 1.1.

Not verified: the CI matrix has **never run** (no push yet), so Windows and Linux are only
rehearsed (`CARE_ALBUM_TEST_PLATFORM=win32`); systemd, cron and Task Scheduler installs on
real systems; a real `docker run --user` on Linux; Safari playing video through the viewer
(Chromium with H.264 was); the update check against a real release (none exists); gitleaks
and `pnpm audit` locally; the 88 PNGs.
