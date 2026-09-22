# Security

## Reporting a vulnerability

Open a [private security advisory](../../security/advisories/new) rather than a public
issue. Please do not include a real session cookie, a real photo, or a real child's name
in a report — a redacted reproduction is always enough.

## Design

| Risk | Control |
|---|---|
| A contributor commits their own session | The session is never written into the project tree. It lives in the OS config directory, so there is nothing to commit. |
| A session reaches a log, crash dump or issue report | Sessions are a `Secret` holding the value in a `#private` field, so no inspect option, spread, clone or serializer reaches it. `toString`, `Symbol.toPrimitive`, `toJSON` and `util.inspect` all redact. Probed on Node 26 against string coercion, `JSON.stringify`, `util.inspect` with `customInspect: false` and `showHidden`, `util.format` `%o/%O/%s/%j`, `structuredClone`, `v8.serialize`, spread, `Object.entries`, `Reflect.ownKeys`, an `Error` built from it or carrying it as `cause`, assertion failure messages, worker `postMessage`, uncaught-exception and unhandled-rejection output, and `process.report` — none leaked a byte. Reading the value requires an explicit, greppable `.expose()`, which happens in exactly three places: writing `session.json`, and building the `Cookie` header in the client and in `verify`. **Two things it cannot cover:** a V8 heap snapshot contains the plaintext, and so does the caller's own variable before the value is wrapped — which is why the paste is validated at the boundary (`src/paste.ts`) rather than trusted to the scrubber. |
| A credential is committed anyway | `.gitignore` blocks `.har`, cookie, `.env` and session files, and `scripts/verify-ignores.sh` proves each rule rather than asserting it. `gitleaks` is configured to run on every PR (`.github/workflows/security.yml`) with custom rules for `_brightwheel_v2` and for signed media URLs, and `test/gitleaks-rules.test.js` proves those rules fire on a CloudFront-signed URL and on a session-shaped cookie. **Two honest limits.** The workflow has never run: this repository has no remote yet. And CI is a merge gate for *this* history, not a leak control for a fork — a commit on a fork is public before anything here can scan it. What protects someone who forks this repository is that the tool never writes a credential into the tree in the first place. |
| A local file is published to npm | `package.json` uses a `files` allowlist, not `.npmignore`. Only `dist/` ships. |
| A developer's session is baked into a Docker image | `.dockerignore` — and only `.dockerignore`. It excludes `.har`, `.env*`, `session.json`, `config.json` and `cookies.*`, so a session never enters the build context in the first place. The build being multi-stage does **not** add to this: the build stage copies `packages/` in and the runtime stage copies that same tree out of it, so anything the context carried would arrive in the published image anyway. Multi-stage is there to leave build tooling and dev dependencies behind, which is a size and attack-surface win, not a credential control. |
| Another local account reads the session | Written with mode `0600` at creation, inside a `0700` directory. Windows has no owner-only file mode: there the session inherits the ACL of `%APPDATA%`, which already excludes other standard accounts on the PC but is weaker than `0600`. |
| Another local account reads the archived photos | Every folder the tool creates inside the archive is created with mode `0700`, so another account cannot walk into it. This matters because the tool writes the child's name into each file's metadata by default, which makes them identified photographs. A folder that already existed keeps the permissions it already had, and Windows inherits the parent ACL instead of the mode. |
| Photos saved somewhere that empties itself, or that copies them to a third party | `checkArchiveDir` refuses a temporary directory, a system location, and a bare drive root or the whole home folder, and it warns — without refusing, because it is a legitimate choice — when the path is inside Dropbox, iCloud Drive, OneDrive or Google Drive, where a copy of every photo would be uploaded. The CLI and the setup page both go through it. The only way past the temporary-directory refusal is a test-only option that no production call site passes. |
| The setup UI is reachable from the network | Bound to `127.0.0.1` only. |
| DNS rebinding against the setup UI | The `Host` header is checked against a localhost allowlist. Covered by a test that uses a raw HTTP client, because `fetch` cannot set `Host`. |
| CSRF from a site the parent is visiting | `Sec-Fetch-Site` and `Origin` are both checked, plus a 24-byte token generated once per `setup` launch, compared in constant time, and dead with the process — the port changes with it. It is printed for the parent to paste, never placed on a command line and never set as a cookie. |
| Children's names cached by the browser | `Cache-Control: no-store, no-cache, must-revalidate, private`, plus `Referrer-Policy: no-referrer`, `X-Content-Type-Options` and `X-Frame-Options`, set on every response before any routing. The CSP starts at `default-src 'none'` and opens only what the one page needs: its own images, `data:` images, and inline style and script. It loads nothing from the network, and `form-action` and `frame-ancestors` are `'none'`. |
| A malicious dependency | The code itself has no third-party runtime dependency: the one `dependencies` entry is `media-ferry`, a package in this repo with none of its own. `exiftool-vendored` is an `optionalDependencies` entry, and optional means "installation may fail", not "not installed" — a plain `npm install` fetches it plus six transitive packages (~30 MB, including a bundled Perl ExifTool), so the default install really does carry third-party code, and `--omit=optional` is what a reader who wants none must pass. Without it the tool degrades to JSON sidecars. The audit job installs with `--ignore-scripts` and runs `pnpm audit`; the test matrix installs normally, because it exercises the optional ExifTool. |
| Silently archiving nothing after a session expires | The client asserts the response content type and JSON shape. An HTML login page returned with HTTP 200 raises `SessionExpiredError` instead of parsing as zero photos. |
| Losing the record of what was saved when a run stops or fails | The manifest is written in a `finally`, so a stop, an expired session or a full disk still records every file already downloaded, and a manifest that cannot be written is reported on the progress stream rather than swallowed. A child's incremental cut-off advances only for a walk that reached the end with nothing left behind, so an interrupted run re-walks that feed rather than skipping past what it missed. |
| The test suite overwriting the developer's own session | `pnpm test` preloads `scripts/test-env.js`, which points `CARE_ALBUM_CONFIG_DIR` at a throwaway directory; every test file that touches config imports it before the module under test and calls `assertIsolatedConfigDir()`, which throws if the variable names a real config location. This is a repair, not a precaution: during development the mock's session was written into the real config directory on 2026-09-21, and again on 2026-09-22 when a single file was run with `node --test`, which does not apply the preload. A test asserts the guard itself. |

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
