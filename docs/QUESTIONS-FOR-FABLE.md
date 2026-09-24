# Questions for Fable

A second set of eyes wanted on the following. Each entry says what we currently believe,
why it matters, and what a good answer would change. Disagreement is the point — please
push back on the lean, not just fill in blanks.

Entries marked **Settled** were answered by the code rather than by a reviewer, and the
thing that settled them is named. They are kept rather than deleted, so that the answer
sits next to the question and a reviewer can disagree with it.

**Reviewed by Fable on 2026-09-22.** Each entry now carries a **Fable:** paragraph with the
answer and the push-back, and the entries that were stale have been corrected in place.
The work that follows from the answers is in [DIRECTIONS-FOR-OPUS.md](DIRECTIONS-FOR-OPUS.md),
ordered, with file pointers; nothing here is an instruction, that file is. Where a
statement below was checked by running something, it says so. Where it rests on one
account at one nursery, it says that too. The review covered `main` at fcdd99e and the
four branches `ux/shell`, `ux/cookie-help`, `ux/native-dialogs` and `ux/scheduling`, all
cut from c6d6c2d; an Opus session merged all four into `main` while the review was being
written, so where an entry says "since `ux/shell`" read "since 3cf4581".

**Context:** MIT, public repo. A TypeScript CLI + local web UI that lets a parent archive
their own child's photos from Brightwheel (a childcare app with no public API) onto their
own computer. Zero runtime dependencies. Code is in this repository;
start with `SECURITY.md` and `packages/care-album-saver/src/{secrets,paths,web/server}.ts`.

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

**Fable: the lean stands, but the entry argues it badly and the code undercuts it.**
There are four alternatives, not one, and each loses on its own terms:

- *A bookmarklet or a console snippet* cannot work: `_brightwheel_v2` is a Rails session
  cookie and every note we have says it is `HttpOnly`, which `document.cookie` cannot
  read. Chrome's console now also demands the user type "allow pasting" first. Never.
- *A browser extension* can read the cookie, but costs a Chrome Web Store identity,
  Apple and Mozilla signing, and a permanent cookie grant on a childcare site. Gentler,
  not safer. If ever, a separate repository, and Safari users (the ones most stuck)
  are the hardest to ship to.
- *Reading the browser's cookie store from disk* means a "Chrome Safe Storage" keychain
  prompt on macOS, App-Bound Encryption on Windows, Full Disk Access for Safari. That is
  the shape of an infostealer. Never.
- *A bundled or remote-controlled browser* is the password-into-our-software habit the
  lean rejects, plus a dependency. Never.

What actually weakens the flow today, all verified against the mock: the paste box has
no `spellcheck="false"` or `autocomplete="off"`, and Chrome's enhanced spell-check ships
textarea contents off the machine; a copied DevTools *row* or a URL-decoded value is
misdiagnosed (the page shows a transport error, or "session expired"); the `login`
command echoes the pasted value into terminal scrollback, which is the screenshot
scenario the `Secret` class exists for; and the promise in four documents that signing
out "makes the old value useless immediately" has never been tested, and a Rails
cookie-store session often survives sign-out. The 2FA sentence should not carry the
argument either: nobody has confirmed 2FA is enforced for every account, and the
phishing-habit argument stands on its own.

`ux/cookie-help` and the link in `ux/shell` are the right investment in this step. Open,
and only the owner can answer: is the `HttpOnly` tick visible in the DevTools table on
the live site; does sign-out end a copied session; how long does a session live.

### A2. Is the `Secret` unprintable-object pattern actually airtight in Node 26?
**Our lean:** `toString` + `toJSON` + `util.inspect.custom` covers string coercion,
`JSON.stringify` and `console.log`, which is every realistic accidental path.
**Where we are unsure:** structured clone, worker `postMessage`, `Error.cause` chains,
async stack traces, and whatever a future log shipper does. Is there a path we missed?
**What would change:** `src/secrets.ts`. This is the control the fork-leak story rests on.

**Fable: the object is airtight; the boundary around it is not.** Probed on Node 26.9.0
against the built `dist/`: `String()`, template literals, concatenation,
`JSON.stringify`, `util.inspect` with `customInspect: false` and `showHidden`,
`util.format` with `%o`, `%O`, `%s` and `%j`, `structuredClone`, `v8.serialize`, spread,
`Object.entries`, `getOwnPropertyNames`, `Reflect.ownKeys`, an `Error` built from it or
carrying it as `cause` or as a property, `assert.strictEqual` and `deepStrictEqual`
failure messages, worker `postMessage`, an uncaught exception and an unhandled rejection
printed to stderr, and `process.report.getReport()`. None of them leaked a byte. The
`#private` field is the reason. Two things do hold the plaintext and always will: a V8
heap snapshot, and the raw string in the caller's scope before it is wrapped.
`SECURITY.md` should say the first plainly and not pretend otherwise.

The raw-string boundary is where the live gap is, and it was reproduced end to end
against `dist/`: paste a bare value containing a line break into the setup page (the
field is a `<textarea>`, so line breaks survive; `normaliseCookieInput` wraps anything
lacking `=` or `;`), and `client.ts` hands it to `fetch`, whose header validation throws
`Headers.append: "_brightwheel_v2=…\n…" is an invalid header value` with the whole
header quoted. `verifySession` returns that as the reason; `scrub()`'s first pattern
stops at the newline; everything after it comes back in the 400 body and the page
displays it. The fix belongs at the source, not in the scrubber: refuse any character
that is not an RFC 6265 cookie octet in `normaliseCookieInput` and in `loadSession`.
**Confirmed on 2026-09-22, and worth recording because two reviewers disagreed about it.**
A concurrent session checked this finding and reported the opposite — that a refused paste
returns a fixed string and echoes nothing. Both were right about different branches of the
same handler. A paste that `normaliseCookieInput` *refused* did return a fixed string. A
paste it *accepted* and the HTTP layer then rejected returned `scrub(error.message)`, and
that is the leaking path. Reconstructed against the real `scrub`:

    fetch throws: Headers.append: "_brightwheel_v2=NotARealSession…\nSECONDLINE_klmnop…" is an invalid header value
    after scrub: Headers.append: "_brightwheel_v2=[redacted]\nSECONDLINE_klmnop…" is an invalid header value

The regex `_brightwheel_v2=[^;\s]+` stops at the newline, so everything after it survives.
That is the general lesson, and the reason the fix belongs at the boundary and not in the
scrubber: `scrub` redacts up to the next whitespace, which is precisely wrong when the
pasted value is the thing that contains whitespace. Closed by `src/paste.ts`; the same
paste is now joined into one value and the message names no part of it.

Three smaller boundary leaks sit beside it: the setup server's progress stream and
`lastResult` are served unscrubbed while the CLI scrubs the same lines; `login` echoes
the paste (above); and `CARE_ALBUM_SESSION` stays in `process.env`, which a diagnostic
report includes verbatim. Also stale: `secrets.ts` says `scrub` protects a `bug-report`
command that does not exist. The doc's four "unsure" items are clean: there is no worker
in the tree, `fetch failed` carries no headers in its cause, and stack traces carry no
values. The future log shipper is `ux/scheduling`'s `daily.log`, which receives the
CLI's already-scrubbed stdout and Node's own stderr.

### A3. Should the localhost UI token be in the URL at all?
**Our lean:** Yes — it is the Jupyter pattern and it is the only thing a parent can
reliably copy-paste. We accept that it lands in browser history.
**Our worry:** `Referer` leakage if the page ever links out. Since `ux/shell` it does,
once, to `schools.mybrightwheel.com`, with `rel="noopener noreferrer"` on top of the
`Referrer-Policy: no-referrer` every response carries, and a test asserts both. Note
that a CSP does not stop a plain link, so the referrer policy is the control here, not
the CSP. Also shoulder-surfing on a shared screen.
**Alternative we rejected:** printing a code to type in. Better hygiene, worse for the
audience. Is that trade right?

**Fable: SETTLED, yes, in the URL — and a cookie would be worse.** The token is 24 random
bytes, generated once per `setup` launch, compared with `timingSafeEqual` behind a
length check, and dead with the process on a port that also changes per launch. Host,
fetch-metadata and token checks run before any routing, so every route on `main` and on
all four branches — including `ux/native-dialogs`' two process-spawning POSTs and
`ux/scheduling`'s install and delete POSTs — needs all three, and each branch's tests
say so. The token never goes on a command line (the tool never opens a browser; the
`openBrowser` option is dead code and should go), never leaves the origin, and is never
a cookie. A cookie exchanged for the URL token was considered and rejected: cookies are
port-blind on `127.0.0.1`, `SameSite` treats other local ports as same-site,
`__Host-` needs HTTPS, and a parent who closes the browser would get a 403 on reopening.

Push-back on the wording and two small tightenings: "one-time" (`server.ts` header,
`GUIDE.md`) and "per-run" (`SECURITY.md`) are both wrong; it is per launch and reused on
every request. The page also puts the token in every XHR URL as well as in the
`x-setup-token` header; require the header for `/api/*` and accept `?token=` only on
`GET /`, so the URL carries it exactly once. And the Origin check strips the port: a
probe with `Origin: http://127.0.0.1:1` was accepted. Harmless while the token is not
ambient; make it port-exact anyway, because it is the check a future cookie would rest on.

### A4. Have we missed a credential-leak path for someone who forks the repo?
**Our lean:** the structural control (nothing secret is ever in the tree) plus gitignore +
gitleaks + npm `files` allowlist + `.dockerignore` covers it.
**Specifically unsure about:** a fresh clone before `npm install` has run — no hooks are
installed yet, so is there a window where a first commit is unscanned? Does GitHub push
protection apply to forks of a public repo in 2026, and can we register a custom pattern?

**Fable: the structural control is the real one; the rest is weaker than stated.**
`git check-ignore` confirms every hand-placed name the doc lists is blocked, and nothing
the tool writes lands in the tree (`verify --deep` uses a temp dir; week READMEs go only
inside ignored folders). Everything else, in order of how wrong the entry was:

- **There is no window "before `npm install`"; there is no hook at any point.** No
  `prepare` script, no `core.hooksPath`, `.git/hooks` holds only samples. Nothing scans
  any local commit, first or hundredth, and a parent who edits in GitHub's web editor
  never has a hook. A zero-dependency Node pre-commit hook that applies the
  `.gitleaks.toml` rules to staged content, wired by `prepare`, is cheap and worth it.
  `husky`, `lefthook`, `pre-commit` and gitleaks-as-a-dependency are not.
- **gitleaks in CI is a merge gate, not a fork control.** A fork's commit is public on the
  fork before upstream's workflow can run, and for a first-time contributor it does not
  run until a maintainer approves. It has also never run anywhere: the remote exists
  (public, unpushed), and neither workflow has run yet. And before the first push two
  things must change or the job is red for reasons unrelated to secrets:
  `gitleaks-action@v2` runs on GitHub's `node20` runtime, which is being retired (v3 is
  `node24`), and the step passes no `GITHUB_TOKEN`. Both are done since: `security.yml`
  is on v3 and passes the token.
- **The signed-URL rule misses the URLs Brightwheel actually uses.** It is case-sensitive
  and matches `signature=`; the live CDN is CloudFront, whose parameter is `Signature=`.
  Prefix the regex with `(?i)` and admit `~` in the value class (CloudFront's base64
  variant uses it). One synthetic finding already sits in history (d47782c) and there is
  no `.gitleaksignore`.
- **GitHub push protection**, answered: it is on by default for every personal account
  and blocks pushes of GitHub's own patterns to any public repository, forks included,
  whatever the fork's settings. It knows nothing about `_brightwheel_v2`. Custom
  patterns need GitHub Secret Protection, sold only to organisations on Team or
  Enterprise; a personal account cannot add one at any price. So the README's "custom
  patterns are a paid feature" understates it.
- **Small gaps:** `session.json.tmp`, `config.json.tmp` and `archive.json.tmp` (the
  names `writeSecureFile` and the manifest actually produce) and `*.part` are
  trackable; `!docs/images/*.png` re-admits any PNG.

---

## B. Correctness — checked against one account

**Checked against live Brightwheel on 2026-09-21 and 2026-09-22 — one account, one
nursery.** A full `run` on 2026-09-21 read `/users/me`, the guardian's students and every
page of a child's activities, and saved 632 files (174 MB) from the signed media URLs.
`verify` and `verify --deep` ran on 2026-09-22 (commits c6d6c2d and 7f39f75). No HAR has
been captured. What each entry still lacks is stated in the entry. The tests still only
prove we agree with our own mock; the mock now carries the real record shape.

### B1. The API map: settled by the live service, with six things still open.
Every endpoint, field name and pagination rule was first taken from six existing
open-source scrapers. The live service has since confirmed, contradicted or left open
each one. See `packages/care-album-saver/src/api/schema.ts`.

**Settled against a real account:** `object_id` ids; the `.student` nesting;
`media.image_url` and `video_info.downloadable_url` as the media fields;
`actor.first_name` and `actor.last_name` (there is no `actor.name` — every archive
written before c6d6c2d recorded no author, and no test caught it because the mock was
written from the same guess); `event_date` identical to `created_at` on all 50 records
(B2); no EXIF in the photographs; CloudFront `Expires`/`Signature`/`Key-Pair-Id` on the
media URLs, with the signature alone sufficient to fetch (B3); and `target.*` carrying the
pickup passcode, invite code and phone numbers beside every photo (`SECURITY.md`).

**Still open**, each settleable read-only by one more request or one printed count:
whether `page` is 0- or 1-based (the run only proves page 0 is non-empty); whether
`page_size=100`, which `run` asks for, is honoured (`verify` asks for 50 and was given
50, so the ceiling is at least 50); whether `action_type=ac_photo` filters or is ignored
(`verify` says "accepted" for any non-empty page, which cannot tell the two apart);
whether a higher-resolution original exists; how long a signature lives (B3); and
whether a second nursery's records distinguish the two dates (B2).

**There is a read-only command for most of this.** `care-album-saver verify`
(`src/verify.ts`) makes three API reads — `/users/me`, the guardian's students, and one
50-record page of `ac_photo` activities — plus one HEAD probe of a single media URL, sent
without the session, and downloads nothing. It reports which fields are **present** and
what **type** they are rather than their values. A few values it does print, deliberately
and with care: the last two labels of the media host, the *names* of the signature
parameters, and how far apart `event_date` and `created_at` are on one record. None of
those names a family, which is what makes the report safe to paste into a public issue —
but "no values at all" would be the wrong thing to promise. It deliberately does **not**
settle whether the media host rejects the session cookie: finding out means sending an
account-takeover credential to a third party, which this tool will not do.

**Fable: the headline was wrong and the details were stale**, and the corrections are
above. Two things the entry missed. First, `verify`'s failure path breaks the README's
"names, not values" promise: a session that dies after the first request makes the CLI
print `Expected JSON from /guardians/<object_id>/students…` — an id — because `raw()`
hand-rolls the check instead of using `schema.ts`'s `assertJsonResponse`, which names
only a label. Second, every open item above has a one-request answer that prints a count
and no value: request page 1 and report how many of its ids also appear on page 0; ask
for `page_size=100` and report what came back and what the envelope echoes; count the
records on the `ac_photo` page that are not photos; list the key names under `media.*`
and `video_info.*` and the HEAD's `content-type` and `content-length` rounded to the
nearest 100 KB; and print the signature's remaining life as a duration. Do not probe URL
variants the API did not hand over, do not escalate `page_size` past 100, and do not send
the session to the media host. The doc previously said `verify` asks for five records; it
asks for 50.

### B2. Is `event_date` really capture time?
**Our lean was:** yes, and we prefer it over `created_at` precisely because upload lag would
misfile photos at week boundaries.

**SETTLED on 2026-09-22, and the lean was wrong.** Against a real account:

- `event_date` and `created_at` are **identical on all 50 records** sampled.
- No other field on the record carries a time. `verify` now prints every field name on a
  photo record, so this is checkable rather than assumable — the full list is `action_type`,
  `actor.*`, `category_tags`, `created_at`, `details_blob`, `event_date`, `health_*`,
  `is_archive_ready`, `learning_activity`, `likes`, `media.*`, `menu_item_tags`, `note`,
  `object_id`, `observation_milestones`, `progress_tags`, `room.*`, `scale_tags`, `source`,
  `staff_only`, `state`, `target.*`, `updated_at`, `video_info`.
- **The photographs carry no EXIF at all** — no `DateTimeOriginal`, no `CreateDate`, no GPS.
  `verify --deep` downloads three, reads them and deletes them; it found nothing on any.

So the moment the shutter clicked is not recoverable, by this tool or by anything else
reading the same API. What the tool records is when the photo was **posted**, which for a
nursery is usually minutes later and nearly always the same day — and which is still much
better than the download time a browser stamps on a manually saved file.

**One caveat on the evidence:** this is one account at one nursery. If some other provider's
records do distinguish the two fields, `event_date` remains the likelier capture time, which
is why the preference order is kept. A second account's `verify` output would settle whether
this is Brightwheel-wide or local. 50 equal records cannot separate "the fields are
always equal" from "nobody back-dated a post in the sample"; `verify` says so.

**New question, C6:** given the photos arrive with no metadata whatsoever, is the tool's
real value that it is the only thing that ever puts any in them? The commit message of
7f39f75 says so; the README says the narrower thing and never uses the word "only". See C6.

**What this cost:** the premise came from six existing open-source scrapers, all of which
assume `event_date` is capture time. None of them appears to have checked either. That is
the argument for `verify` existing at all, and for running it before believing a field name.

**Fable: agreed, and nothing to add except a sweep.** The premise is retired in the README's
"About the dates" section and, since fcdd99e, in the per-week README; it is still alive in
the README's tag tables ("when the photo was taken"), in "the clock in the room", in the
GUIDE's tree and troubleshooting rows, in `verify`'s own narrative, and in the sidecar key
`capturedAt`, which holds the posted time. Those are listed in the directions.

### B3. Do Brightwheel media URLs actually expire, and how fast?

**Settled 2026-09-22 by `verify` and by AWS.** The URLs are CloudFront-signed with a
canned policy — `Expires`, `Signature`, `Key-Pair-Id` — and the signature alone fetches
the file. `transferIdentity` is necessary, and what it leaves (origin + path) is exactly
what AWS defines as the signed resource. CloudFront's documentation defines `Expires` in
a canned-policy URL as Unix time **in seconds**, and the three parameter names `verify`
printed are that canned-policy shape (a custom policy carries `Policy=` instead). So the
old worry — that a CDN might mean "seconds of life" by `expires=` and the tool would read
it as 1970 — cannot occur on this host, and `signedUrlExpiry` reads it correctly.

The other old worry — that a long run outlives the signatures on its early pages — is
handled by code. A download refused with 401 or 403 re-fetches the listing page that
issued the URL and retries with the fresh signature, at most once per item; every other
item on that page then reuses the refreshed page (`fetchMedia` in `src/sync.ts`). The
one-refresh-per-page bound stays: it costs at most one listing request per page per
child per run, it is pinned by a test, and `src/ferry/` serves hosts other than
CloudFront by design. Its comments should stop calling the parse a guess.

**Still open: how long a signature lives.** No HAR is needed: `verify` can print
(`Expires` − now) as a duration, which names nobody, and that says whether the refresh
path ever fires on a real run.

**Fable: three consequences of the settled shape were missed.** The gitleaks signed-URL
rule is case-sensitive and does not match `Signature=` (A4). `transferIdentity` strips
`Expires`, `Signature`, `Key-Pair-Id` and `Policy` but not AWS's optional fourth
parameter, `Hash-Algorithm`. And no test exercises a CloudFront-shaped URL anywhere: the
mock mints lowercase `signature=` with a millisecond `expires=`, and the manifest
assertions are lowercase-only. The mock should mint the real shape. Do not remove the
`presumedExpired` bound, do not narrow `signedUrlExpiry` to CloudFront, and do not decode
`Policy=` JSON.

### B4. Is the feed ordered by the same timestamp our cut-off compares?
An incremental run stops paging once three consecutive pages (`PAGES_PAST_THE_CUT_OFF`,
`src/api/client.ts`) each carry media and nothing newer than the newest post of the last
complete walk, comparing `event_date`. Pages of check-ins alone do not vote. The order of
the feed itself is Brightwheel's, and we have never seen it.
**Our worry:** if the feed is ordered by `created_at`, a teacher who backfills a batch of
old photos puts them at the *top* of the feed carrying old `event_date`s. Every page read
is downloaded before the stop is evaluated, so a back-dated batch is only a problem when
it fills three consecutive pages — 3 × the effective page size, which is 300 posts if
Brightwheel honours `page_size=100` and proportionally fewer if it clamps (open in B1).
**On the one real account, the question is moot:** `event_date` and `created_at` are
identical on every record, so the feed is in the same order by either key and a
backfilled post carries the new time in both. It is live only on an account whose
records distinguish them.
**What would change:** the manifest and sidecar record both times regardless (cheap, and
the archive outlives the tool). For the stop, not a switch to `created_at` — under
`event_date` ordering that is the mirror-image bug — but a page counted as older only
when every post on it is older by **both** timestamps: identical to today where the
fields agree, and correct under either ordering.

**Fable: the entry as it stood was stale** (it described a one-page stop that 631f71e
replaced with the three-page slack) **and it hid a real bug that has nothing to do with
ordering.** The cut-off is a maximum over feed-supplied dates with no clamp. One
future-dated record — a wrong clock on a teacher's phone, a typo in a date field — makes
every later incremental run stop after three pages, silently: a probe on the mock saved
30 of 35 new posts and lost 5 with no warning. Clamp the cut-off to the instant the walk
began. That is a "now". The both-timestamps rule is a "next"; recording `postedAt` is
cheap and should go with it. And `verify` can report, from the page it already fetches,
whether each timestamp is non-increasing down the page — a monotonicity check needs no
values. Open, and only the owner's terminal from 2026-09-21 knows: what effective page
size did that run actually see.

---

## C. Design

### C1. Two packages, or one?
**Our lean:** two. `media-ferry` (resumable download, signed-URL identity, hashing, safe
names, ISO weeks) is genuinely service-agnostic and reusable.
**The honest counter:** it is ~750 lines and has exactly one consumer. A reviewer arguing
for one package until a second consumer exists would have a point.

**Fable: one package. The counter wins, and the publish story makes it urgent.**
`media-ferry` is 763 lines with nine tests of its own; every commit to it after the first
was made for `care-album-saver`; fourteen of its exports have no consumer; three
consumer tests import it by relative `dist` path; and `ux/scheduling` bypasses `Manifest`
entirely because the library has no remove. The decisive point is what `pnpm pack`
produces: it rewrites `workspace:*` to `media-ferry@0.1.0`, a name nobody has registered
on npm (E404 on 2026-09-22) — so the README's `npx care-album-saver` instructions
cannot work today, and until the name is claimed the dependency graph of a children's
photo tool is open to squatting. Fold it into `src/ferry/`, keep the barrel so the module
boundary survives as a directory, and delete the unused exports. Found on the way: `pnpm
pack` also ships `dist/api/login.js`, the deleted password flow, because `tsc` never
removes orphans and `files` lists `dist` wholesale; clean `dist` before packing. Whether
the tool is published to npm at all, or documented as "clone and build", is the owner's
decision and the README must match it either way.

### C2. The Python/TypeScript reuse problem.
Archive Ferry (private, Python) has the originals of these algorithms. A TS library cannot
be imported by a Python worker. **Our lean:** do not try — keep them as two
implementations pinned by a shared language-agnostic test-vector fixture, so behaviour
cannot silently diverge. Is the shared-fixture approach worth the ceremony, or should we
drop the cross-project goal entirely?

**Fable: drop it. Settled.** No such fixture exists (`src/ferry/index.ts` says so),
the two projects use different hash algorithms (XXH3 versus SHA-256) so hashing vectors
could never be shared, the only shareable vectors are twenty lines of `transferIdentity`
cases, and Archive Ferry's audience is unrelated. Keep the three "ported from Archive
Ferry" comments as provenance and say in the barrel that no behavioural pinning is
intended.

### C3. Should perceptual (fuzzy) dedupe exist at all here?
**Our lean:** no, not in v1. Brightwheel gives a stable media id, which is a better key
than any hash. Ferry's pHash/dHash banding is elegant but earns nothing when the server
hands you an identity. It would only catch the same photo posted twice by two teachers.
**Push back if** you think re-posts are common enough to matter.

**Fable: never, and the lean understates what is missing.** There is no byte-level dedupe
either: `sync.ts` checks the media id and the signature-stripped URL, `findByHash` has no
caller, and the `sha256` in `archive.json` is taken *after* the tags are embedded, so two
posts of one JPEG with different notes hash differently. It is an integrity checksum and
its comments should say so. `ux/scheduling`'s duplicate finder is byte-exact and
manifest-only, which means it cannot see the force-quit orphan it was written for until
`check --repair` has recorded it; its summary should say "run repair first" when the
audit finds unrecorded files. If a second nursery ever makes re-posts matter, record a
pre-embed hash as provenance and group on it later. Not pHash.

### C4. Writing the child's name into every file — right default?
**Our lean:** on by default, because it is what makes the archive useful in a photo app,
and it is disclosed prominently in the README and the UI.
**The counter:** it makes every file permanently self-identifying, including if it is ever
shared or leaked. A privacy-maximising default would be off. We may have the default
backwards.

**Fable: the lean is right for the child's own name and wrong for the bundle tied to it.**
"Off" does not make the archive anonymous: the folder is named after the child, every
week's `README.md`, every sidecar and `archive.json` name the child whichever way the
switch is set. So the switch only governs a file that travels alone — the share-with-
family case — and there the parent's own child's name harms nobody. What does harm there
is the rest of what one tick writes by default: the nursery's name into a *location*
field while `stripLocation`, also default-on, deletes GPS "so the file cannot reveal
where it was taken" (the two defaults contradict each other); a staff member's name; and
the teacher's free text into three caption fields, which routinely names the room, the
staff and other families' children who never consented to this parent's archive. Keep
the child's name **on**; move nursery, poster and note behind a second switch, default
**off**, effective only while names is on. That keeps d47782c's master-switch promise
("names off ⇒ nothing inside says who or where"). Nothing is lost: the sidecar is
unchanged. Two doc defects found on the way: the README's tag tables say the note is
written unconditionally, false since d47782c; and `archive.json` names every child, note
and poster while the docs say only the sidecar does.

### C5. Are a video's dates written the way video applications actually read them?
A video cannot take the photo tags: `DateTimeOriginal` is not a QuickTime tag at all. So
an MP4 gets `QuickTime:CreateDate` and the track and media headers **in UTC**, on the
reading that the QuickTime specification defines those headers as UTC and that ffprobe,
Apple Photos, Immich, Plex and Jellyfin all convert them to the viewer's zone; plus
`Keys:CreationDate` (`com.apple.quicktime.creationdate`), which is local time *with* its
offset and is what Apple Photos prefers. See `quickTimeUtc` in `src/metadata.ts`.
**What is proven:** the round trip. A generated MP4 is archived and read back, and the
headers come out in UTC, the Apple key in local time with its offset, the name and note
where they were put, and the frame data in `mdat` byte-identical
(`test/real-media-fixtures.test.js`).
**What is not:** that this is what the consumer applications a parent actually uses do
with those headers, and whether rendering UTC ourselves rather than using ExifTool's
`QuickTimeUTC` option is the convention a video person would pick. We render it ourselves
because that option converts using ExifTool's own zone, and the vendored wrapper spawns it
with a bare environment.
**A second-order worry:** a video's folder is its *local* calendar day while its container
header is UTC, so a late-evening video sits in one day's folder and reads as the next day
in a hex editor. Both are correct. Is it going to confuse someone?

**Fable: the choice is right; change one README sentence, not the code.** Checked
against sources on 2026-09-22: ExifTool's QuickTime documentation says the integer
date tags "should be stored as UTC" per the specification, that ExifTool by default
"does not assume a time zone for these values" because cameras often write local time,
and that `QuickTimeUTC` makes it treat them as UTC and convert on extraction. Immich's
metadata service consults, in order, `SubSecDateTimeOriginal`, `SubSecCreateDate`,
`DateTimeOriginal`, **`CreationDate`**, `CreateDate`, `MediaCreateDate`, … — so on an
MP4 it takes the Apple key, with its offset, before the UTC header, which is exactly the
key this tool writes for that purpose. Apple Photos prefers the same key; ffprobe-based
players read the movie header as UTC and print it with `Z`. Rendering UTC ourselves
produces the same bytes the `QuickTimeUTC` option would, and avoids the zone problem the
entry describes. The one consequence worth a sentence in the README: a parent who runs
plain `exiftool` on an archived video will see `CreateDate` as the UTC wall clock with no
zone, apparently "hours off", while every photo app shows the local time — which is also
the answer to the second-order worry. The hex editor is the only reader that sees UTC.

### C6. Is "the only thing that puts any metadata in them" the honest framing?
**Fable: true, checkable, and the wrong headline.** The README never says "only"; the
7f39f75 commit message does, in a universal form that is unverifiable and probably false
(the six scrapers this project studied read `event_date` precisely in order to write
it). The metadata line describes the tool by what a browser save lacks rather than by
what a parent ends up with, and it rests on one account. The strongest true claim is the
one the README buries in a subordinate clause at line 11: the archive is **independent
of the account** — Brightwheel's own help centre says a family loses a profile's history
when its access ends and tells parents to download first. Bulk is not a differentiator
(the mobile app has a Gallery bulk-save, and extensions exist). What is: posted-time
dating instead of save-time, names and notes written in, week folders, sidecars readable
without the tool, incremental and (soon) scheduled, and independence from the account.
The opening paragraph should lead with that and keep the metadata sentence as one item.
Never put "only" in the README, the GUIDE, the page or `package.json`.

---

### C7. What is this project called, and why not after the service it reads?

**SETTLED by the owner on 2026-09-22: the project is Care Album Saver, and no name it
owns contains "Brightwheel".** Two reasons, and either alone would be enough.

- **A tool named after somebody else's service is the one that gets a letter.** This is a
  free tool that helps a parent get their own child's photographs out of a service they
  already pay for, and it should not hand anyone an easy reason to close it. Nominative
  use — saying which service a parent signs in to — is exactly what a trade mark is for
  and stays; a package, a command, a folder or a heading *named* Brightwheel is a claim
  on the mark and goes.
- **The project may grow to read more than one service.** A generic name costs nothing
  now and saves a second rename later, when there would be archives and installs to
  carry through it.

What changed: the npm package and the command are `care-album-saver`, the workspace
directory is `packages/care-album-saver`, the config folder is `care-album-saver`, the
environment variables are `CARE_ALBUM_*`, and a fresh install saves into
`~/Care Album Photos`. What did not change: every descriptive mention of Brightwheel in
the code, the docs and the page — the API client, the mock, the cookie name, the gitleaks
rule ids that describe that cookie, and the sentence on the setup page telling a parent
which site to sign in to.

**Nothing on an existing machine is moved.** The old config folder is still read when the
new one does not exist, the old `BRIGHTWHEEL_ARCHIVE_*` and `BRIGHTWHEEL_SESSION`
variables are still honoured, and an archive already in `~/Brightwheel Photos` stays the
default while it is there. Three tests pin that, and `doctor` says when the old folder is
the one in use. The one thing a rename cannot reach is the checkout directory and the
git remote, which are the owner's to rename if they want to.

**Still to decide:** whether a multi-source future means a source-adapter boundary in
`src/api/` — worth its own entry when it stops being hypothetical. (Whether `media-ferry`
kept its name became moot on 2026-09-23, when it was folded into `src/ferry/`.)

---

## D. Things we know are unfinished

- **Windows has never been exercised, by CI or by a person.** The remote exists (public,
  unpushed), and neither workflow in `.github/workflows/` has run yet. The matrix
  in `ci.yml` is *written* to build, run the whole suite and start `dist/cli.js where` on
  windows-latest with Node 20, 22, 24 and 26, and `checkArchiveDir` takes the platform,
  home directory, temp directory and environment as options so the Windows rules can be
  run from a Mac (`CARE_ALBUM_TEST_PLATFORM=win32 pnpm test`). Checked on
  2026-09-22 for what will happen on the first run: pnpm 12 supports Node 18 and later,
  so the pnpm step is fine on every cell; `exiftool-vendored` declares `node >= 22`, so on
  the Node 20 cells it either fails to install or fails to import, and `getExifTool`'s
  dynamic import catches that and degrades to JSON sidecars as designed — untested there;
  `gitleaks-action` is on v3 (`security.yml:29`), off the retiring `node20` runtime.
  Specifically unproven: whether ExifTool's `-stay_open` process starts
  and exits cleanly on Windows, and whether renaming over an open file (`Manifest.save`,
  the `.part` → final rename) trips an antivirus scanner. File permissions on Windows
  remain ACL-inherited: no `0600` on the session, no `0700` on the archive.
- **Nothing checks that `docs/images/*.png` are current.** `ci.yml` is written to run
  `node scripts/screenshots.js` on every pull request, and the script refuses to write an
  image whose callouts overlap each other or the page, so a broken capture would turn that
  job red; but the fresh images are uploaded as an artifact rather than compared with the
  committed ones, so a change to the UI that leaves the old pictures in place still
  merges. Giving the script a `--check` mode that compares them would close that.
- **The setup page's client script is never executed by a test.** `pnpm test` has no DOM,
  so the page's behaviour is asserted by reading the script the server serves and matching
  source text. The only place that script really runs is `scripts/screenshots.js`, in a
  browser that one CI job installs. The three UI branches add roughly 1,300 lines of client
  script between them, so this grows. The proportionate fix is a Playwright smoke test in
  the same CI job that already installs Chromium, not a DOM in the unit suite. Later.
- **A session that expires mid-run still ends the run**, and with `ux/scheduling` the run
  that matters is the unattended one. The branch writes the failure to `last-run.json`,
  which the management view and `status` read — but nothing *tells* the parent, so an
  expired session at seven in the evening stays silent until someone opens the page. Add
  a desktop notification on a failed scheduled run (`osascript -e 'display notification'`
  on macOS, `notify-send` where present on Linux; Windows can wait) with fixed text that
  names nobody, and record `installedAt` so the page can say "set up on the 3rd, has not
  run since the 9th" when a job exists but its process never started (an nvm-managed Node
  path or an npx-cache `cli.js` that moved). Whether real sessions die often enough
  mid-run to deserve a retry is still a question for whoever answers B1.
- **One permanently failing item makes every later run re-list that child's whole feed** —
  partly stale. A 404 is now retired into `archive.json` (`GoneItem` in `src/sync.ts`) and
  no longer holds the cut-off. What remains are permanent failures that are not 404s: a
  403 that survives a refresh, a 5xx that never clears. Those still pin the cut-off, and
  it is the honest choice; leave it until a real feed shows one.

### Settled since the last round

- **Video metadata** was untested for want of a fixture. There is now a generated MP4 and
  a round-trip test that reads the tags back out of the archived file. What it does and
  does not prove is C5, now answered.
- **Choosing which children to sync** was a config field the UI could not reach. The setup
  page now lists the children on the account as tick boxes, saves the choice as it
  changes, says in words whose photos will be saved, and refuses an empty selection;
  `run --child <id or name>` does the same for a single run without touching the saved
  settings, and `children` prints the ids.
- **Manifest paths across platforms.** `archive.json` records each file's path with
  forward slashes on every platform, so an archive written on Windows reads on a Mac.
- **A3, B3, C2, C5** — settled above, on 2026-09-22.
