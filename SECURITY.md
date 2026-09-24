# Security

## Reporting a vulnerability

Open a [private security advisory](../../security/advisories/new) rather than a public
issue. Please do not include a real session cookie, a real photo, or a real child's name
in a report — a redacted reproduction is always enough.

The review made before the repository was first published, with its open findings and
their fixes, is [docs/SECURITY-REVIEW-2026-09-23.md](docs/SECURITY-REVIEW-2026-09-23.md).
The reasoning behind the design choices below, and the alternatives turned down, is in
[docs/DECISIONS.md](docs/DECISIONS.md).

## Threat model

### What is worth protecting

| Asset | Where it is | Why it matters |
|---|---|---|
| The Brightwheel session | `session.json` in the operating system's config folder | It reaches more than photos: the API hands back a child's pickup passcode and the family's phone numbers alongside them ([below](#what-the-api-hands-us-that-we-do-not-want)). |
| The archive | the folder the parent chooses | Photographs of children, with — by default — the child's name, the nursery, the person who posted each one and the teacher's note written into the file. Every `.json` sidecar and `archive.json` record all of that whatever the switches say. |
| The daily log | `~/Library/Logs/care-album-saver/` on a Mac, `~/.local/state/care-album-saver/` on Linux, a `logs` folder inside the config folder on Windows | It records each run in the tool's own words, so it names children and the archive folder. Lines pass through the scrubber on the way in; the file is `0600` in a `0700` folder. macOS diagnostic collection gathers `~/Library/Logs`. |
| Signed media URLs | in memory during a run | Bearer credentials while they last: anyone holding one can fetch the photo. `redactUrl` and `scrub` keep them out of logs and messages. |
| The setup token | the link `setup` prints | Anyone on this computer who has it can drive the setup page until the program stops. |
| The parent's Photos library, and iCloud | only with the Photos option on | The one route by which photos leave the computer ([docs/PHOTOS.md](docs/PHOTOS.md)). |

### Trust boundaries

1. **The browser and the setup page.** The setup server listens on `127.0.0.1` only. Before
   any routing, every request must pass the `Host` allowlist, the fetch-metadata and `Origin`
   checks, and the per-launch token. The `Host` and `Origin` checks include the port, and the
   token travels in the `x-setup-token` header, except for a `GET` of the page itself or of
   `/photo`, the two places a header cannot be sent. Everything the page shows that came from outside — the
   children's names, notes, file names, the account's email, staff names, GitHub release
   notes — must reach the page as text, never as markup.
2. **The tool and Brightwheel's API.** The session goes here and nowhere else, as a `Cookie`
   header — unless whoever runs the tool points `--base-url` somewhere else, as the tests do,
   in which case it goes there: to an https address, or over http only to this computer (the
   mock server); anything else is refused before the session is read. Under test
   (`CARE_ALBUM_NO_LIVE_API`, set by `scripts/test-env.js`) no client can be made for
   Brightwheel's own domain at all. Node's `fetch` keeps a hand-set `Cookie` header on a same-origin redirect and drops
   it on a cross-origin one (checked on 23 September 2026), so a redirect off Brightwheel's
   host does not carry it. Everything that comes back is untrusted input: names, notes, ids,
   dates and file extensions become folder names, file names and metadata, so they pass
   through `src/ferry/names.ts` on the way, and every response is checked for its type and
   shape.
3. **The tool and the media host.** The signed URLs Brightwheel hands back are fetched with
   no cookie: the session never leaves the API's origin. They are fetched only when they are
   https, carry no user name or password, and name neither this computer nor the local
   network (`mediaUrlRefusal`); a redirect that leaves the address's origin is held to the
   same rule, and one carrying a user name is refused on any hop. `verify` asks media
   addresses under the same rule.
4. **The tool and GitHub.** Only after the parent says yes to the update check. One `GET` of
   this repository's latest release, with no cookie, no token and no User-Agent of the tool's
   own; the answer is size-capped and validated, the release link must be this repository's
   releases page, and the "how to update" steps are built by the tool from how it was
   installed, never from the answer ([docs/UPDATE-CHECK.md](docs/UPDATE-CHECK.md)).
5. **The tool and the files it reads back.** The archive folder can be written by something
   else — a cloud-sync peer, another program — so every path read from `archive.json` is
   resolved with `containedFile()` (real paths on both sides; symlinks and `..` refused)
   before the gallery, the duplicate finder, repair or the Photos step touch it. The Photos
   step goes further, because what it hands over can reach iCloud: it gives Photos private
   copies, each checked against `fingerprints.json`, the record of what sync saved, which is
   kept in the config directory where the archive's co-writers cannot edit it
   ([docs/PHOTOS.md](docs/PHOTOS.md)). A settings change is accepted only as one of a fixed
   list of typed settings.
6. **The tool and the programs it starts.** Always `execFile` with an argument array, never a
   shell, and `osascript` by its full path: the Photos AppleScript is a fixed file run with
   arguments, never `-e`, which talks only to `/System/Applications/Photos.app`; the folder
   chooser and file-manager openers; the schedulers (`launchctl`, `systemctl --user`,
   `crontab`, `schtasks`); desktop notifications, whose text is fixed. Two of those read a
   file the tool writes — the crontab and the Task Scheduler XML — and systemd reads a unit
   file, so each path is quoted the way its reader reads it, and one it cannot carry is refused. ExifTool's tag values come from the API;
   a note containing a line break followed by an ExifTool option was written verbatim as the
   note (checked on 23 September 2026).
7. **The supply chain.** No runtime dependencies; `exiftool-vendored` is optional and runs a
   bundled Perl ExifTool. pnpm is one exact version in every workflow and in the Docker build,
   by version and not by hash. GitHub Actions are pinned by tag, not by commit, and the Docker
   base image (`node:22-slim`) is not pinned by digest.

### Who this defends against, and who it does not

It is built to hold against: a contributor or someone who forks this repository committing
their own session by accident; a web page the parent visits trying to reach the setup page
(cross-site requests, DNS rebinding); another account on the same computer (fully on a Mac
or Linux, less so on Windows — see below); malformed or hostile data in Brightwheel's
responses, including names and notes a nursery wrote; someone else who can write into the
archive folder, crafting `archive.json`; and a hostile GitHub release.

It does not try to hold against, and says so rather than implying otherwise: anyone who can
use the parent's own account on the computer, to whom the photos and the session are ordinary
files; a memory dump of the running tool (see the `Secret` row below); and Brightwheel
itself.

## Design

| Risk | Control |
|---|---|
| A contributor commits their own session | The session is never written into the project tree. It lives in the OS config directory, so there is nothing to commit. |
| A session reaches a log, crash dump or issue report | Sessions are a `Secret` holding the value in a `#private` field, so no inspect option, spread, clone or serializer reaches it. `toString`, `Symbol.toPrimitive`, `toJSON` and `util.inspect` all redact. Probed on Node 26 against string coercion, `JSON.stringify`, `util.inspect` with `customInspect: false` and `showHidden`, `util.format` `%o/%O/%s/%j`, `structuredClone`, `v8.serialize`, spread, `Object.entries`, `Reflect.ownKeys`, an `Error` built from it or carrying it as `cause`, assertion failure messages, worker `postMessage`, uncaught-exception and unhandled-rejection output, and `process.report` — none leaked a byte. Reading the value requires an explicit, greppable `.expose()`, which happens in exactly four places: writing `session.json`, building the `Cookie` header in the client and in `verify`, and `doctor`'s shape check, which passes the value to `inspectCookiePaste` and prints only its kind and length. **Two things it cannot cover:** a V8 heap snapshot contains the plaintext, and so does the caller's own variable before the value is wrapped — which is why the paste is validated at the boundary (`src/paste.ts`) rather than trusted to the scrubber. |
| A credential is committed anyway | `.gitignore` blocks `.har`, cookie, `.env` and session files, the photos and everything a run writes beside them or leaves behind (sidecars, `archive.json`, the run lock, `.part` downloads, temporaries), and the tool's own state files (`photos.json`, `fingerprints.json`, `last-run.json`, `update-check.json`, the daily log, the Photos hand-over folders), and `scripts/verify-ignores.sh` proves each rule rather than asserting it. A test fails if the production or the development mark's name is ever tracked, `git add -f` included. `gitleaks` is configured to run on every PR (`.github/workflows/security.yml`) with custom rules for `_brightwheel_v2` and for signed media URLs, and `test/gitleaks-rules.test.js` proves those rules fire on a CloudFront-signed URL and on a session-shaped cookie. It runs on every push to `main` and every pull request. **One honest limit:** CI is a merge gate for *this* history, not a leak control for a fork — a commit on a fork is public before anything here can scan it. What protects someone who forks this repository is that the tool never writes a credential into the tree in the first place. |
| A local file is published to npm | `package.json` uses a `files` allowlist, not `.npmignore`: `dist/`, `applescript/`, `README.md` and `LICENSE`. `dist/` is whatever `tsc` left there, which includes the mock server and any output whose source has since been deleted — `tsc --build` never removes those, which is how `dist/api/login.*` outlived its source — so anything published must be built from a clean `dist/`. |
| A developer's session is baked into a Docker image | `.dockerignore`, first. Every pattern in it starts with `**/`, so it applies at any depth: `node_modules`, `dist`, `.har`, `.env*`, `session.json`, `config.json`, `cookies.*`, the archive folders and every file `.gitignore` keeps out as personal (a test holds the two files to each other) are kept out of the build context wherever they sit, so a session never enters it in the first place. (Until 2026-09-23 the patterns were bare, which Docker anchors at the context root; the host's `dist/` and `node_modules` under `packages/` went into the image.) Second, and only second: the runtime stage takes from the build stage just `dist/`, `applescript/`, `LICENSE`, the package's `package.json` and the production `node_modules`, so the published image has no `src/`, no test files and no tsconfig, and a stray file elsewhere under `packages/` stays behind (since 2026-09-24; before, the whole `packages/` tree was copied across). That is not a credential control on its own: the build stage's layers still hold everything the context carried, in the build cache of the machine that built it and in any image made with `--target build`, and a file under `dist/` or `node_modules` would be copied forward. |
| Another local account reads the session | Written with mode `0600` at creation. The config folder is `0700`: made so when the tool creates it, and narrowed to its owner's bits at the next write when it was there first with more — a folder made by hand, one named by `CARE_ALBUM_CONFIG_DIR`, or the image's `/config`, which the Dockerfile makes `755`. A folder this account does not own (a root-owned bind mount, say) cannot be changed and is left as it is, as is one on a file system without POSIX modes, and the home folder is never narrowed; in each of those the files are still `0600`, so another account can see their names but not open them. An administrator (root) can open any file on every system, these included. Windows has no owner-only file mode: there the session inherits the ACL of `%APPDATA%`, which already excludes other standard accounts on the PC but not its administrators, and is weaker than `0600`. |
| Another local account reads the archived photos | Every folder the tool creates inside the archive is created with mode `0700`, so another account cannot walk into it, and every file it saves there — each photo, its `.json` and `.xmp` sidecars, the READMEs — is written `0600` (security review fs-10; files saved by earlier versions keep the modes they had). This matters because the tool writes the child's name into each file's metadata by default, which makes them identified photographs. The archive folder itself is narrowed to `0700` at every run if it is wider, and the run says so, since a parent may have opened it up on purpose; a folder inside it that already existed keeps the permissions it had, behind that one. Windows inherits the parent ACL instead of the mode. |
| Photos saved somewhere that empties itself, or that copies them to a third party | `checkArchiveDir` refuses a temporary directory, a system location, and a bare drive root or the whole home folder, and it warns — without refusing, because it is a legitimate choice — when the path is inside Dropbox, iCloud Drive, OneDrive or Google Drive, where a copy of every photo would be uploaded. The CLI and the setup page both go through it. The only way past the temporary-directory refusal is a test-only option that no production call site passes. |
| The setup UI is reachable from the network | Bound to `127.0.0.1` only. |
| DNS rebinding against the setup UI | The `Host` header is checked against a localhost allowlist. Covered by a test that uses a raw HTTP client, because `fetch` cannot set `Host`. |
| CSRF from a site the parent is visiting | `Sec-Fetch-Site` and `Origin` are both checked, plus a 24-byte token generated once per `setup` launch, compared in constant time, and dead with the process — the port changes with it. It is printed for the parent to paste, never placed on a command line and never set as a cookie. |
| Children's names cached by the browser | `Cache-Control: no-store, no-cache, must-revalidate, private`, plus `Referrer-Policy: no-referrer`, `X-Content-Type-Options` and `X-Frame-Options`, set on every response before any routing. The CSP starts at `default-src 'none'` and opens only what the one page needs: its own images, `data:` images, its own videos for the photo viewer, inline style, and one script, which runs because it carries that response's nonce (`'strict-dynamic'`, and no `'unsafe-inline'` for scripts; every other response has no `script-src` at all). It loads nothing from the network, and `base-uri`, `form-action` and `frame-ancestors` are `'none'`. |
| A malicious dependency | The code itself has no third-party runtime dependency: there is no `dependencies` entry at all. (Until 23 September 2026 there was one, on a sibling package in this repository — which would have resolved from the public registry on a published install, against a name nobody had registered. It is folded in.) `exiftool-vendored` is an `optionalDependencies` entry, and optional means "installation may fail", not "not installed" — a plain `npm install` fetches it plus six transitive packages (~30 MB, including a bundled Perl ExifTool), so the default install really does carry third-party code, and `--omit=optional` is what a reader who wants none must pass. Without it the tool degrades to JSON sidecars. The Docker build and the audit job, which runs `pnpm audit`, install with `--ignore-scripts`, since neither runs the installed code afterwards; the test matrix and `scripts/deploy.js` install as a parent's clone does, and go on to run the build and the suite in any case. Every install is `--frozen-lockfile`. |
| Silently archiving nothing after a session expires | The client asserts the response content type and JSON shape. An HTML login page returned with HTTP 200 raises `SessionExpiredError` instead of parsing as zero photos. |
| Losing the record of what was saved when a run stops or fails | The manifest is written in a `finally`, so a stop, an expired session or a full disk still records every file already downloaded, and a manifest that cannot be written is reported on the progress stream rather than swallowed. A child's incremental cut-off advances only for a walk that reached the end with nothing left behind, so an interrupted run re-walks that feed rather than skipping past what it missed. |
| The daily log giving away what it records | Each line passes through `scrub()` on the way in, which redacts a session value still attached to its cookie name, cookie and authorisation headers, and the token and signature fields of a signed URL. It still names children and the archive folder, by design. On a Mac or Linux the file is `0600` in a `0700` folder, and both are set again on every write, because launchd creates the file first, at `0644`, from the job's own output. On a Mac it is in `~/Library/Logs`, which macOS diagnostic collection gathers. |
| The update check telling someone something | Off until the parent answers the question once on the setup page; only that answer turns it on. Then at most one `GET` a day, only from the setup page and never from the daily run, of this repository's latest release on GitHub, with no cookie, no token and no User-Agent of the tool's own. The answer is capped at 1 MB while it is read, and checked for shape; the release link must be this repository's releases page; the steps to update are the tool's own, chosen from how this copy was installed, never text from the answer. What it learnt is kept in `update-check.json` in the config folder. Tests and the demo cannot reach GitHub (`CARE_ALBUM_NO_UPDATE_CHECK`). See [docs/UPDATE-CHECK.md](docs/UPDATE-CHECK.md). |
| Apple Photos, and so iCloud, given a file this tool did not save | Off unless turned on, and turned on only through the setup page, which asks macOS for permission first. Photos is never handed the archive's own files: each is copied into a fresh owner-only hand-over folder in the config folder (an APFS clone where the disk allows), the copy is hashed and checked against `fingerprints.json` — the record of every file sync saved, kept in the config folder where something else that writes into the archive cannot edit it — and only a copy that matches is handed over; the rest are left out and named on the page. The AppleScript is a fixed file run by `/usr/bin/osascript` with arguments, never `-e`, and it refuses unless the Photos it would talk to, and every process running as Photos, is `/System/Applications/Photos.app`. `photos.json` records what Photos has accepted, and is updated only after it accepts a batch. No test can drive the real Photos (`CARE_ALBUM_NO_PHOTOS`). See [docs/PHOTOS.md](docs/PHOTOS.md). |
| The tool's own state files | `photos.json`, `fingerprints.json`, `last-run.json` and `update-check.json` live in the config folder beside the session and are written the way it is: `0600`, through a temporary file with a random name, opened exclusively and renamed into place. They name children, folders and photo fingerprints, never the session. One that cannot be read is not taken for a fresh start where that would do harm: a damaged `fingerprints.json` or `photos.json` stops the Photos step rather than handing everything over again, while a damaged `update-check.json` or `last-run.json` is read as no record, which at worst means asking GitHub again or a daily run that repeats. |
| Two runs writing the archive at once | The run lock, `.care-album-saver.lock` in the archive folder, is created exclusively and holds the process id, the computer's name and the start time. A run, a repair of `archive.json` and duplicate removal each take it and refuse one another; the holder refreshes it every 30 seconds, and a lock whose process has gone, or that has stopped being refreshed, is taken over, as is one from another computer taken more than a day ago however recently it was refreshed. A time set in the future does not count as a refresh (it gets a minute's wait, in which a real holder refreshes), and a lock nobody can read is not in use after a minute. It names the computer, so `.gitignore` and `.dockerignore` keep it out. The Photos step has its own lock, `photos.lock`, in the config folder. |
| The test suite overwriting the developer's own session | `pnpm test` preloads `scripts/test-env.js`, which points `CARE_ALBUM_CONFIG_DIR`, and `CARE_ALBUM_DIR` for the photos, at throwaway directories (`scripts/demo.js` and `scripts/screenshots.js` set both, and the log folder, before they load the tool); every test file that touches config imports it before the module under test and calls `assertIsolatedConfigDir()`, which throws if the variable names a real config location. This is a repair, not a precaution: during development the mock's session was written into the real config directory on 2026-09-21, and again on 2026-09-22 when a single file was run with `node --test`, which does not apply the preload. A test asserts the guard itself. |

## What the API hands us that we do not want

Confirmed against the live service on 2026-09-22, and worth writing down because it is not
obvious from the endpoint names:

| Response | Also contains |
|---|---|
| `GET /users/me` | `raw_passcode` (the physical pickup code), `invite_code`, `auth_phone_number`, `phone_1` |
| `GET /students/{id}/activities` | `target.invite_code`, `target.raw_passcode`, `target.phone_1`, `target.phone_2`, `target.auth_phone_number`, `target.profile_photo.*`, and `actor.email` — a member of staff's address |

None of it is persisted: the parser takes named fields and the sidecar is built from those,
so a field we never read cannot reach disk. There is a test asserting that nothing written
to disk contains the passcode. Two consequences worth keeping in mind:

- **The session is a bigger credential than "can see photos."** It reaches a child's pickup
  code. That is the argument for the session never leaving the API origin, and for the
  media host being fetched without it.
- **`verify` prints field names, not values**, for exactly this reason — the report is meant
  to be safe to paste into a public issue, and half these field names would not be.

## Scope

This tool reads only the authenticated user's own account. The endpoint for listing
children is scoped to the guardian the session resolves to, so a parent can only ever
enumerate their own children. That is Brightwheel's server-side guarantee; this tool does
not widen it and could not.

## Deliberately not done

- **Encrypting the session at rest.** The key would have to sit next to it, which protects
  against nothing an attacker with file access could not defeat. We use file permissions
  and say plainly what they do and do not cover.
- **An OS keychain dependency.** `keytar` is unmaintained, and the alternatives need a
  native build toolchain that would break `npm install` for exactly the non-technical users
  this tool targets. Revisit if a pure-JS option matures.
