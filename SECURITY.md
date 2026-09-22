# Security

## Reporting a vulnerability

Open a [private security advisory](../../security/advisories/new) rather than a public
issue. Please do not include a real session cookie, a real photo, or a real child's name
in a report — a redacted reproduction is always enough.

## Design

| Risk | Control |
|---|---|
| A contributor commits their own session | The session is never written into the project tree. It lives in the OS config directory, so there is nothing to commit. |
| A session reaches a log, crash dump or issue report | Sessions are a `Secret` object whose `toString`, `toJSON` and `util.inspect` all return `[redacted]`. Reading the value requires an explicit, greppable `.expose()`. |
| A credential is committed anyway | `.gitignore` blocks `.har`, cookie, `.env` and session files. `gitleaks` runs on every PR with a custom rule for `_brightwheel_v2` and for signed media URLs. |
| A local file is published to npm | `package.json` uses a `files` allowlist, not `.npmignore`. Only `dist/` ships. |
| A developer's session is baked into a Docker image | `.dockerignore` excludes it, and the build is multi-stage so the build context never reaches the runtime layer. |
| Another local account reads the session | Written with mode `0600` at creation, inside a `0700` directory. On Windows it inherits the per-user AppData ACL — weaker, and the README says so. |
| The setup UI is reachable from the network | Bound to `127.0.0.1` only. |
| DNS rebinding against the setup UI | The `Host` header is checked against a localhost allowlist. Covered by a test that uses a raw HTTP client, because `fetch` cannot set `Host`. |
| CSRF from a site the parent is visiting | `Sec-Fetch-Site` and `Origin` are both checked, plus a per-run token compared in constant time. |
| Children's names cached by the browser | `Cache-Control: no-store` and a `default-src 'none'` CSP on every response. |
| A malicious dependency | There are no runtime dependencies. ExifTool is optional. CI runs `pnpm audit` and installs with `--ignore-scripts`. |
| Silently archiving nothing after a session expires | The client asserts the response content type and JSON shape. An HTML login page returned with HTTP 200 raises `SessionExpiredError` instead of parsing as zero photos. |

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
