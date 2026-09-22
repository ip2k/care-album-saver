# Questions for Fable

A second set of eyes wanted on the following. Each entry says what we currently believe,
why it matters, and what a good answer would change. Disagreement is the point — please
push back on the lean, not just fill in blanks.

**Context:** MIT, public repo. A TypeScript CLI + local web UI that lets a parent archive
their own child's photos from Brightwheel (a childcare app with no public API) onto their
own computer. Zero runtime dependencies. Code is at `~/Developer/brightwheel-archive`;
start with `SECURITY.md` and `packages/brightwheel-archive/src/{secrets,paths,web/server}.ts`.

---

## A. Security — highest priority

### A1. Is "session cookie pasted from DevTools" the right primary login flow?
**Our lean:** Yes, and deliberately so. Brightwheel enforces 2FA, so unattended
password login is impossible anyway. The alternatives are worse: bundling a Chromium
(~150MB) and asking a parent to type their real password into a browser *our software
controls* normalises exactly the behaviour phishing depends on. Pasting a cookie is
clunky but it never touches the password.
**Why it matters:** It is the first thing every user does, and the biggest usability cost
in the project. If there is a flow that is both safer and gentler, we should take it.
**What would change:** The whole of step 1 and the guide.

### A2. Is the `Secret` unprintable-object pattern actually airtight in Node 26?
**Our lean:** `toString` + `toJSON` + `util.inspect.custom` covers string coercion,
`JSON.stringify` and `console.log`, which is every realistic accidental path.
**Where we are unsure:** structured clone, worker `postMessage`, `Error.cause` chains,
async stack traces, and whatever a future log shipper does. Is there a path we missed?
**What would change:** `src/secrets.ts`. This is the control the fork-leak story rests on.

### A3. Should the localhost UI token be in the URL at all?
**Our lean:** Yes — it is the Jupyter pattern and it is the only thing a parent can
reliably copy-paste. We accept that it lands in browser history.
**Our worry:** `Referer` leakage if the page ever links out (it does not today, and CSP
`default-src 'none'` blocks it), and shoulder-surfing on a shared screen.
**Alternative we rejected:** printing a code to type in. Better hygiene, worse for the
audience. Is that trade right?

### A4. Have we missed a credential-leak path for someone who forks the repo?
**Our lean:** the structural control (nothing secret is ever in the tree) plus gitignore +
gitleaks + npm `files` allowlist + `.dockerignore` covers it.
**Specifically unsure about:** a fresh clone before `npm install` has run — no hooks are
installed yet, so is there a window where a first commit is unscanned? Does GitHub push
protection apply to forks of a public repo in 2026, and can we register a custom pattern?

---

## B. Correctness — needs live verification

### B1. The API map is unverified.
Every endpoint, field name and pagination rule came from reading six existing open-source
scrapers, some years old. **Nothing has been checked against the live service.** The
highest-value thing anyone can do is capture a HAR from an authenticated session and
confirm: `event_date` vs `created_at` semantics, the real media URL field, whether a
higher-resolution original exists, whether `page` is 0- or 1-based, and the true max
`page_size`. See `packages/brightwheel-archive/src/api/schema.ts`.

### B2. Is `event_date` really capture time?
**Our lean:** yes, and we prefer it over `created_at` precisely because upload lag would
misfile photos at week boundaries.
**If wrong:** every timestamp we write is wrong, which is the tool's core value
proposition. Worth confirming before anyone builds an archive on it.

### B3. Do Brightwheel media URLs actually expire, and how fast?
We assume signed URLs and strip signature params to keep identity stable. If they are
in fact stable URLs, `transferIdentity` is harmless but unnecessary. If they expire in
under a minute, long runs need re-fetching of the listing mid-download — which we do not
currently handle.

---

## C. Design

### C1. Two packages, or one?
**Our lean:** two. `media-ferry` (resumable download, signed-URL identity, hashing, safe
names, ISO weeks) is genuinely service-agnostic and reusable.
**The honest counter:** it is ~500 lines and has exactly one consumer. A reviewer arguing
for one package until a second consumer exists would have a point.

### C2. The Python/TypeScript reuse problem.
Archive Ferry (private, Python) has the originals of these algorithms. A TS library cannot
be imported by a Python worker. **Our lean:** do not try — keep them as two
implementations pinned by a shared language-agnostic test-vector fixture, so behaviour
cannot silently diverge. Is the shared-fixture approach worth the ceremony, or should we
drop the cross-project goal entirely?

### C3. Should perceptual (fuzzy) dedupe exist at all here?
**Our lean:** no, not in v1. Brightwheel gives a stable media id, which is a better key
than any hash. Ferry's pHash/dHash banding is elegant but earns nothing when the server
hands you an identity. It would only catch the same photo posted twice by two teachers.
**Push back if** you think re-posts are common enough to matter.

### C4. Writing the child's name into every file — right default?
**Our lean:** on by default, because it is what makes the archive useful in a photo app,
and it is disclosed prominently in the README and the UI.
**The counter:** it makes every file permanently self-identifying, including if it is ever
shared or leaked. A privacy-maximising default would be off. We may have the default
backwards.

---

## D. Things we know are unfinished

- No Windows testing at all. File permissions there are ACL-inherited, not `0600`.
- Video metadata is untested — ExifTool handles QuickTime but we have no video fixture.
- No retry of the *listing* if a session expires mid-run; it aborts and reports.
- The UI cannot yet select which children to sync (the config field exists, unused).
- `docs/images/` should be regenerated whenever the UI changes; nothing enforces that.
