# Questions for Fable

A second set of eyes wanted on the following. Each entry says what we currently believe,
why it matters, and what a good answer would change. Disagreement is the point — please
push back on the lean, not just fill in blanks.

Entries marked **Settled** were answered by the code rather than by a reviewer, and the
thing that settled them is named. They are kept rather than deleted, so that the answer
sits next to the question and a reviewer can disagree with it.

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
**Our worry:** `Referer` leakage if the page ever links out. It does not today, and every
response carries `Referrer-Policy: no-referrer` and a CSP with `form-action 'none'` — but
note that a CSP does not stop a plain link, so the referrer policy is the control here,
not the CSP. Also shoulder-surfing on a shared screen.
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

**Nothing in this section has been checked against live Brightwheel.** No HAR has been
captured, and no request from this project has ever reached the real service. Every field
name, pagination rule and date claim below is still a reading of other people's code. The
tests do not change that: they prove we agree with our own mock, and the mock was written
from the same guesses.

### B1. The API map is unverified.
Every endpoint, field name and pagination rule came from reading six existing open-source
scrapers, some years old. **Nothing has been checked against the live service.** The
highest-value thing anyone can do is capture a HAR from an authenticated session and
confirm: `event_date` vs `created_at` semantics, the real media URL field, whether a
higher-resolution original exists, whether `page` is 0- or 1-based, and the true max
`page_size`. See `packages/brightwheel-archive/src/api/schema.ts`.

**There is now a read-only command for most of this.** `brightwheel-archive verify`
(`src/verify.ts`) makes three API reads — `/users/me`, the guardian's students, and one
five-record page of activities — plus one HEAD probe of a single media URL, sent without
the session, and downloads nothing. It reports which fields are **present** and what
**type** they are rather than their values. A few values it does print, deliberately and
with care: the last two labels of the media host, the *names* of the signature parameters,
and how far apart `event_date` and `created_at` are on one record. None of those names a
family, which is what makes the report safe to paste into a public issue — but "no values
at all" would be the wrong thing to promise. It settles the `object_id`-versus-`id`
question, the `.student` nesting, whether `action_type=ac_photo` is accepted, where the
media URL lives, and whether that URL is signed. It deliberately does **not** settle
whether the media host rejects the session cookie: finding out means sending an
account-takeover credential to a third party, which this tool will not do.

It does **not** settle three of the five above: whether `page` is 0- or 1-based (it only
ever asks for page 0), the true maximum `page_size` (it asks for 5, while a real run asks
for 100), or whether a higher-resolution original exists. Those still need the HAR.

As of 2026-09-22 the owner has a signed-in session on the development machine, so what
stands between this section and an answer is someone running the command.

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
this is Brightwheel-wide or local. **New question, C6:** given the photos arrive with no
metadata whatsoever, is the tool's real value that it is the only thing that ever puts any
in them? The README now says so; it is worth a second opinion on whether that is the honest
framing or a consolation prize.

**What this cost:** the premise came from six existing open-source scrapers, all of which
assume `event_date` is capture time. None of them appears to have checked either. That is
the argument for `verify` existing at all, and for running it before believing a field name.

### B3. Do Brightwheel media URLs actually expire, and how fast?
We assume signed URLs and strip signature params to keep identity stable. If they are
in fact stable URLs, `transferIdentity` is harmless but unnecessary.

**Settled in part, by code.** The old worry here — that a long run outlives the signatures
on its early pages, "which we do not currently handle" — is handled. A download refused
with 401 or 403 re-fetches the listing page that issued the URL and retries with the fresh
signature, at most once per item; every other item on that page then reuses the refreshed
page rather than paying for a request of its own (`fetchMedia` in `src/sync.ts`). A world
of stable URLs costs nothing: the same URL coming back means no retry is attempted.

**Still open, and now a second question underneath it.** We read an `expires=` parameter
as a Unix time — seconds, unless the number is too large to be seconds. Not every CDN
means a Unix time by that name, and one that means "seconds of life" would read as 1970,
that is, as permanently expired. So the proactive refresh is bounded to one per listing
page per run, after which the CDN's own answer is the only authority we trust. A HAR would
tell us whether the parameter is epoch seconds at all, and how long a real signature
lives — which is what decides whether any of this machinery earns its place.

### B4. Is the feed ordered by upload time while our cut-off is a capture time?
An incremental run stops paging once every media post on a page is older than the newest
post of the last complete walk, comparing `event_date` — capture time. The order of the
feed itself is Brightwheel's, and we have never seen it.
**Our worry:** if the feed is ordered by `created_at`, a teacher who backfills a batch of
old photos puts them at the *top* of the feed carrying old capture times. The ones on the
first page are saved, because a page is downloaded before the stop is evaluated. But a
first page made up entirely of such posts ends the walk, and any that spilled onto the
second page are not found until someone runs `--all`.
**If the feed is ordered by `event_date`,** the design is exactly right and there is
nothing to do.
**What would change:** either nothing, or the cut-off keys on `created_at` and the
manifest records both times.

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

---

## D. Things we know are unfinished

- **Windows is exercised by CI, not by a person.** The matrix in
  `.github/workflows/ci.yml` builds, runs the whole suite and starts `dist/cli.js where`
  on windows-latest with Node 20, 22, 24 and 26, and
  `checkArchiveDir` takes the platform, home directory, temp directory and environment as
  options so the Windows rules can be run from a Mac
  (`BRIGHTWHEEL_ARCHIVE_TEST_PLATFORM=win32 pnpm test`). Nobody on this project owns a
  Windows machine and these cells have not been watched going green. Specifically
  unproven: whether ExifTool's `-stay_open` process starts and exits cleanly there;
  whether `exiftool-vendored`, which declares `node >= 22`, is skipped on the Node 20
  cells and degrades to JSON sidecars as intended if it is not; and whether renaming over
  an open file (`Manifest.save`, the `.part` → final rename) trips an antivirus scanner.
  File permissions on Windows remain ACL-inherited: no `0600` on the session, no `0700`
  on the archive.
- **Nothing checks that `docs/images/*.png` are current.** CI runs
  `node scripts/screenshots.js` on every pull request, and the script now refuses to write
  an image whose callouts overlap each other or the page, so a broken capture turns that
  job red. But the fresh images are uploaded as an artifact rather than compared with the
  committed ones, so a change to the UI that leaves the old pictures in place still
  merges.
- **The setup page's client script is never executed by a test.** `pnpm test` has no DOM,
  so the page's behaviour is asserted by reading the script the server serves and matching
  source text. The only place that script really runs is `scripts/screenshots.js`, in a
  browser that one CI job installs. A regression that preserved the source shape and broke
  the behaviour would pass.
- **A session that expires mid-run still ends the run.** There is no re-login and no retry
  of the listing: the client raises `SessionExpiredError`, and the run stops there and
  says so. What changed is that stopping is no longer lossy — everything downloaded is
  written to the manifest before the error propagates, the interrupted child's cut-off is
  left where it was, and the next run after reconnecting carries on from it. Whether real
  sessions die often enough mid-run to deserve a retry is a question for whoever answers
  B1.
- **One permanently failing item makes every later run re-list that child's whole feed.**
  A child's cut-off only advances when their walk finished with nothing left behind, so an
  item that can never succeed — media deleted server-side, a 404 for ever — holds the
  window open indefinitely. The cost is listing requests rather than downloads, and it is
  the honest choice; but paid on every run against a feed of years, it may not be the
  right one.

### Settled since the last round

- **Video metadata** was untested for want of a fixture. There is now a generated MP4 and
  a round-trip test that reads the tags back out of the archived file. What it does and
  does not prove is C5.
- **Choosing which children to sync** was a config field the UI could not reach. The setup
  page now lists the children on the account as tick boxes, saves the choice as it
  changes, says in words whose photos will be saved, and refuses an empty selection;
  `run --child <id or name>` does the same for a single run without touching the saved
  settings, and `children` prints the ids.
- **Manifest paths across platforms.** `archive.json` records each file's path with
  forward slashes on every platform, so an archive written on Windows reads on a Mac.
