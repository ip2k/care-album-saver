# Decisions

Why Care Album Saver is built the way it is: the decisions that are settled, each with the
reason and the alternatives that were turned down, and the questions that are still open.
It is written for anyone reading or reviewing the code — and for anyone about to propose one
of the rejected alternatives, so that the argument does not have to be had twice.

**How far the evidence goes.** Everything said here about Brightwheel's service was checked
against **one real account, at one nursery**, on 21 and 22 September 2026: a full run that
read every endpoint the tool uses and saved 632 files (174 MB), then `verify` and
`verify --deep`. No HAR capture has ever been made. The automated tests prove the tool agrees
with its own mock server, which carries the record shape the live service showed.

**Ids are stable.** The settled decisions keep the ids they had in the design review of
22 September 2026 — A for security, B for correctness against the live service, C for
design — so that older commit messages and the [CHANGELOG](../CHANGELOG.md) still point at
the right entry. Open questions are numbered Q1, Q2, …; when one is answered it moves up to
the settled part and keeps its number. The review's own notes (a question-and-answer
document and the work list that followed it) are in git history at d13f8ff, as
`docs/QUESTIONS-FOR-FABLE.md` and `docs/DIRECTIONS-FOR-OPUS.md`.

**Contents**

- Settled: [A1](#a1-the-only-sign-in-is-a-pasted-session) ·
  [A2](#a2-the-session-is-an-unprintable-object-and-the-paste-is-checked-at-the-boundary) ·
  [A3](#a3-the-setup-pages-token-goes-in-the-link-not-in-a-cookie) ·
  [A4](#a4-what-protects-a-fork-is-that-nothing-secret-is-ever-in-the-tree) ·
  [A5](#a5-check-in-codes-are-dropped-as-each-answer-is-read) ·
  [B1](#b1-the-api-as-far-as-one-live-account-confirms-it) ·
  [B2](#b2-there-is-no-capture-time-to-recover) ·
  [B3](#b3-media-urls-are-signed-and-short-lived) ·
  [B4](#b4-the-incremental-cut-off-never-runs-ahead-of-the-walk) ·
  [C1](#c1-one-package-with-the-service-agnostic-half-as-a-directory) ·
  [C2](#c2-archive-ferry-is-provenance-not-a-shared-contract) ·
  [C3](#c3-no-perceptual-de-duplication) ·
  [C4](#c4-the-childs-name-is-written-into-each-file-by-default) ·
  [C5](#c5-a-videos-dates-are-written-in-utc-with-apples-local-time-key-beside-them) ·
  [C6](#c6-how-the-tool-describes-itself) ·
  [C7](#c7-the-name-is-care-album-saver) ·
  [C8](#c8-every-photo-goes-to-apple-photosapp-once-and-copy-items-is-asked-about) ·
  [rejected for good](#rejected-for-good) ·
  [decided elsewhere](#decided-elsewhere)
- Open: [the API](#what-nobody-has-checked-yet-about-brightwheels-api) (Q1–Q8) ·
  [sessions](#what-only-a-real-account-can-answer-about-sessions) (Q9) ·
  [agreed but not built](#agreed-but-not-built) (Q11–Q16; Q10 built, see A3) ·
  [Apple Photos.app](#what-only-a-real-mac-can-answer-about-apple-photosapp) (Q17)

---

## Settled decisions

### A1. The only sign-in is a pasted session

**Decision.** The tool signs in one way: the parent signs in on Brightwheel's own website, in
their own browser, and pastes the value of the `_brightwheel_v2` session cookie into the
setup page (or into `care-album-saver login`). There is no password sign-in, and there will
not be one. An email, password and two-factor flow once existed in `src/api/login.ts`;
nothing imported it and no command, flag or field reached it, while the README promised it
to parents. It was deleted on 22 September 2026, along with the promise.

**Why.**

- Teaching a parent to type their real Brightwheel password into other people's software is
  the habit phishing depends on. That argument stands on its own, and is the main one.
- Brightwheel sends a 6-digit code at sign-in, so an unattended password sign-in — the
  daily run — could not work anyway. (Nobody has confirmed that the code is required on
  every account, which is why this is the supporting reason and not the main one.)
- The pasted session never touches the password. It is stored only on the parent's
  computer, in a file only their account can open, and is sent only back to Brightwheel.

**Alternatives turned down.**

- *A bookmarklet or a console snippet* to fetch the cookie. It cannot work: every note we
  have says `_brightwheel_v2` is an `HttpOnly` cookie, which page scripts cannot read (Q9
  confirms that on the live site). Chrome's console also now demands the user type "allow
  pasting" first.
- *A browser extension.* It could read the cookie, but costs a Chrome Web Store identity,
  Apple and Mozilla signing, and a permanent cookie grant on a childcare site. Gentler, not
  safer; if it ever happens, it belongs in a separate repository.
- *Reading the browser's cookie store from disk.* It needs a keychain prompt on macOS,
  defeats App-Bound Encryption on Windows and Full Disk Access for Safari. That is the shape
  of an infostealer.
- *A bundled or remote-controlled browser* the parent signs in through. It is the
  password-into-our-software habit again, plus a ~150 MB dependency.
- *Masking the paste box as a password field.* It would hide what was pasted — which is how
  a parent tells the value from the cookie's name — and invite in the password managers the
  box is marked to keep out.

**What was done to make the flow gentler instead.** The paste box turns off spell-check,
autocomplete and password-manager filling (Chrome's enhanced spell-check sends a text box's
contents off the machine); `src/paste.ts` recognises a copied DevTools row, a whole
`Cookie:` line and a quoted value, and says what was pasted when it is the wrong thing; the
`login` command does not echo the paste; the setup page links to Brightwheel's sign-in page,
because a mistyped sign-in address is how a password ends up on a stranger's site; and
[COOKIE.md](COOKIE.md) has drawings of the step for three browsers.

Still open: [Q9](#q9-what-ends-a-session-and-how-long-does-one-live).

### A2. The session is an unprintable object, and the paste is checked at the boundary

**Decision.** A session is a `Secret` holding its value in a `#private` field. String
coercion, `JSON.stringify` and `util.inspect` all print `[redacted]`, and reading the value
takes an explicit, searchable `.expose()`. On Node 26 it was probed against string
coercion, template literals, `JSON.stringify`, `util.inspect` with `customInspect: false`
and `showHidden`, `util.format` with `%o`, `%O`, `%s` and `%j`, `structuredClone`,
`v8.serialize`, spread, `Object.entries`, `Reflect.ownKeys`, an `Error` built from it or
carrying it as `cause`, assertion failure messages, worker `postMessage`, uncaught-exception
and unhandled-rejection output, and `process.report`. None leaked a byte. [SECURITY.md](../SECURITY.md)
lists where `.expose()` is called.

**What it cannot cover.** A V8 heap snapshot holds the plaintext, and so does the caller's
own string before it is wrapped. So the pasted value is validated where it enters —
`src/paste.ts`, used by the setup page, the server and `login` — and anything that is not a
valid cookie character is refused with a message that quotes no part of it.

**Why the boundary and not the scrubber.** On 22 September 2026 a paste containing a line
break was accepted, handed to `fetch`, and rejected there with an error quoting the whole
header. The scrubber redacted up to the first whitespace — the line break — and everything
after it went back to the page. A scrubber that stops at whitespace is precisely wrong when
the pasted value is the thing that contains whitespace. The paste is now joined into one
value at the boundary, and the progress stream the page reads is scrubbed as the terminal's
is.

**Alternatives turned down.** A heuristic "long base64 string" rule in the scrubber: a guess
about what a secret looks like, and still the scrubber doing the boundary's job.

### A3. The setup page's token goes in the link, not in a cookie

**Decision.** The setup page is protected by a token of 24 random bytes, generated once per
`setup` launch, compared in constant time and dead when the program stops; the port changes
with each launch too. The tool prints a link containing it for the parent to paste into their
browser. It is never put on a command line (the tool never opens a browser itself) and never
set as a cookie. Every response carries `Referrer-Policy: no-referrer`, and every outward
link carries `rel="noopener noreferrer"`, so the address never leaves the page. The cost that
was accepted: the link lands in browser history.

**Why.** A link is the one thing a parent can reliably copy and paste — the pattern Jupyter
uses. The `Host`, fetch-metadata and token checks all run before any routing, so every route
needs all three.

**Alternatives turned down.**

- *A code printed in the terminal to type into the page.* Better hygiene, worse for the
  audience.
- *A cookie exchanged for the link's token.* Cookies ignore the port on `127.0.0.1`, so every
  other local program's pages would share it; `SameSite` treats other local ports as the same
  site; the `__Host-` prefix needs HTTPS; and a parent who closed and reopened the browser
  would be locked out.
- *A one-shot bootstrap link.* Only worth it if the tool ever opens the browser itself.

**Built 2026-09-24** (it was [Q10](#q10-the-token-only-where-a-header-cannot-carry-it); security
review web-7, page-8, web-10). The token is taken from the `x-setup-token` header, which every
request the page makes carries, and from the address only for a `GET` of the page itself or of
`/photo`, the two places a header cannot be sent: an allowlist, so a route added later does not
start taking it from the address unasked. The `Host` and `Origin` checks compare the port
exactly.

### A4. What protects a fork is that nothing secret is ever in the tree

**Decision.** The tool never writes a credential into the project folder: the session and
settings live in the operating system's config folder, the photos in the archive folder.
That is the control. `.gitignore`, the gitleaks scan in CI, the npm `files` allowlist and
`.dockerignore` are defence in depth.

**Why the rest is only defence in depth.**

- gitleaks in CI is a merge gate for this repository's history, not a leak control for a
  fork: a commit on a fork is public before anything here can scan it, and a first-time
  contributor's workflow waits for a maintainer's approval.
- GitHub's push protection is on by default for personal accounts and blocks GitHub's own
  secret patterns on public repositories, forks included — but it knows nothing about a
  `_brightwheel_v2` cookie. Custom patterns need GitHub Secret Protection, which is sold only
  to organisations; a personal account cannot add one at any price.
- The signed-URL rule in `.gitleaks.toml` is case-insensitive and admits `~`, because the
  live CDN is CloudFront, whose parameter is `Signature=` and whose base64 variant uses `~`.
  `test/gitleaks-rules.test.js` proves the rules fire.

**Alternatives turned down.** gitleaks, husky, lefthook or pre-commit as dependencies. A hook,
if one is added, is a few lines of Node with no dependency ([Q13](#q13-ignore-rules-and-a-pre-commit-hook)).

### A5. Check-in codes are dropped as each answer is read

**Decision.** Settled on 24 September 2026, when the owner asked that the tool have no access
to any child's check-in or check-out code. Every answer from Brightwheel is parsed by
`parseWithheld` ([`src/api/withheld.ts`](../packages/care-album-saver/src/api/withheld.ts)),
whose `JSON.parse` reviver drops every field whose name says it is a code, a PIN, a password
or passkey, a token, a secret, a phone or SMS number, or something like a pickup word or a
check-in number, *while the text is parsed*. The parsed answer never holds one, so nothing
after it can: not a parser, a log line, an error message, `verify`'s report or a file (an
answer that is not JSON is reported without quoting it). It goes by the words in a name rather
than a list of names, so `checkin_code`, `pickupPin2` and `kioskPasscode` are dropped too; a
name that says none of those things is not, which is why the parsers still take named fields
only. Tests check that no field
the tool reads matches, that the mock's codes are in none of the client's parsed answers, and
that the client and `verify` parse Brightwheel's answers no other way.

**Why it has to be done this way.** Brightwheel keeps no endpoint for these codes. It embeds
them: every activity record carries the child as `target`, with `raw_passcode` (the code that
checks them in and out) and `invite_code`, and `/users/me` carries the parent's own
([B1](#b1-the-api-as-far-as-one-live-account-confirms-it)). The photos are in the same
answers. Before this, the protection was the parsers' allowlist, so nothing unnamed reached
disk. That still holds, but it left every later parser, log line and error path responsible
for not touching a value that sat in memory beside the photos.

**What it cannot do** is stop the codes being sent. They arrive in the answer's bytes and are
text for as long as the parse takes. Brightwheel's own website is sent the same fields, by the
same endpoint, every time the feed scrolls.

**Turned down.**
- *Asking Brightwheel for less*, with a field-selection parameter or another endpoint.
  Nothing shows one exists, and finding out would mean probing the live API with a parent's
  session, which B1 rules out.
- *Asking the server for photos only* (`action_type=ac_photo`, Q3). It would leave out the
  check-in records, but the codes are on every record, photos included.
- *A fixed list of field names.* A code Brightwheel added under a new name would be kept.
- *Remembering the parent's id so as to skip `/users/me`.* The parent's own code would stop
  arriving, the children's would not, and both are dropped as they are read in any case.

### B1. The API, as far as one live account confirms it

**Decision.** The tool reads the paginated endpoint behind the website's photo feed,
`/students/{id}/activities?page=N`, and never drives a browser or simulates scrolling.

**Confirmed against the real account:** `object_id` as the id; the `.student` nesting;
`media.image_url` and `video_info.downloadable_url` as the media fields; `actor.first_name`
and `actor.last_name` for who posted it — there is no `actor.name`, so every archive written
before commit c6d6c2d recorded no author, and no test caught it because the mock had been
written from the same guess; `event_date` identical to `created_at` on all 50 records
sampled ([B2](#b2-there-is-no-capture-time-to-recover)); no EXIF in the photographs (B2);
CloudFront-signed media URLs ([B3](#b3-media-urls-are-signed-and-short-lived)); and
`target.*` carrying the pickup passcode, invite code and phone numbers beside every photo,
which the tool never persists ([SECURITY.md](../SECURITY.md)). The field names were first
pieced together from six other open-source Brightwheel clients; the live service confirmed,
corrected or left open each one.

**How it is checked.** `care-album-saver verify` makes three API reads — the signed-in
user, the guardian's children, and one 50-record page of photo activities — plus one
`HEAD` request to a single media URL, sent without the session, and downloads nothing. It
reports which fields are present and their types rather than their values. The few values it
does print are chosen to name nobody: the last two labels of the media host, the names of
the signature parameters, and how far apart `event_date` and `created_at` are. When a
session dies part-way through, its error names a label, not a path containing an id.

**Deliberately never done.** Probing URL variants the API did not hand over; asking for pages
larger than 100 records; sending the session to the media host to see whether it is
rejected — that would send a credential which reaches a child's pickup code to a third party.

Still open: [Q1–Q8](#what-nobody-has-checked-yet-about-brightwheels-api).

### B2. There is no capture time to recover

**Decision.** Settled on 22 September 2026, and against the original assumption. The tool
records when each photo was **posted** to Brightwheel, and says so everywhere; it never
claims to know when a photo was taken.

**The evidence**, from the real account:

- `event_date` and `created_at` are identical on all 50 records sampled.
- No other field on the record carries a time. `verify` prints every field name on a photo
  record, so this is checkable rather than assumed. The full list: `action_type`, `actor.*`,
  `category_tags`, `created_at`, `details_blob`, `event_date`, `health_*`,
  `is_archive_ready`, `learning_activity`, `likes`, `media.*`, `menu_item_tags`, `note`,
  `object_id`, `observation_milestones`, `progress_tags`, `room.*`, `scale_tags`, `source`,
  `staff_only`, `state`, `target.*`, `updated_at`, `video_info`.
- **The photographs carry no EXIF at all** — no `DateTimeOriginal`, no `CreateDate`, no GPS.
  `verify --deep` downloads three, reads them and deletes them, and found nothing on any.

So the moment the shutter clicked cannot be recovered, by this tool or by anything else
reading the same API. The posted time is usually minutes later and nearly always the same
day, and it is far better than the download time a browser stamps on a file saved by hand.

**Why `event_date` is still preferred over `created_at`.** Only because, if some other
nursery's records ever distinguished them, `event_date` would be the likelier capture time.
Fifty equal records cannot separate "the fields are always equal" from "nobody back-dated a
post in the sample", and `verify` says so ([Q6](#q6-does-a-second-nursery-distinguish-event_date-from-created_at)).

**What it cost.** The premise came from six existing open-source clients, all of which assume
`event_date` is the capture time; none appears to have checked. That is the argument for
`verify` existing at all, and for running it before believing a field name. The sidecar key
that holds this time is `postedAt`; files written before 22 September 2026 call it
`capturedAt`, and both are read.

### B3. Media URLs are signed and short-lived

**Decision.** Settled on 22 September 2026 by `verify` and by AWS's documentation. The media
URLs are CloudFront-signed with a canned policy — `Expires`, `Signature` and `Key-Pair-Id`
— and the signature alone fetches the file; no session is sent to the media host.
CloudFront defines `Expires` as Unix time in seconds, which is how `signedUrlExpiry` reads
it.

**What follows from it.**

- *A file's identity is its URL without the signature.* `transferIdentity` removes the
  signature and expiry parameters and keeps the origin and path — which is exactly what AWS
  defines as the signed resource — so a photo is recognised across runs even though its
  link changes every time.
- *A long run outlives the signatures on its early pages*, and the tool handles it: a
  download refused with 401 or 403 re-fetches the listing page that issued the URL and
  retries once with the fresh signature, and the rest of that page reuses the refreshed
  listing (`fetchMedia` in `src/sync.ts`). A page is re-fetched on the strength of a
  declared expiry at most once per run. That costs at most one extra listing request per
  page per child per run, and a test pins it.

**Why the bound stays although CloudFront is well-behaved.** `src/ferry/` serves hosts other
than CloudFront by design, and another host that meant "seconds of life" by `expires=` would
read as 1970 — permanently expired — without it.

**Alternatives turned down.** Removing the bound; narrowing `signedUrlExpiry` to CloudFront's
format; decoding the JSON in a custom-policy `Policy=` parameter; adding a clock-skew margin
to the expiry.

Still open: how long a signature lives ([Q5](#q5-how-long-does-a-media-signature-live)), and
two small follow-ups ([Q12](#q12-cloudfront-shaped-urls-in-the-mock)).

### B4. The incremental cut-off never runs ahead of the walk

**Decision.** An incremental run stops paging once three consecutive pages
(`PAGES_PAST_THE_CUT_OFF` in `src/api/client.ts`) each carry media and nothing newer than the
newest post of the last complete walk. Pages of check-ins alone do not count towards the
three. Every page read is downloaded before the stop is evaluated. The newest post recorded
for a child is clamped to the moment the walk began.

**Why the clamp.** The cut-off is a maximum over dates the feed supplies. Before
22 September 2026, one future-dated record — a wrong clock on a teacher's phone, a typo —
made every later incremental run stop after three pages, silently: a probe on the mock saved
30 of 35 new posts and lost 5 with no warning. A run now also counts, without naming them,
posts dated more than a day in the future.

**Also settled.** A child's marker only moves when a walk reached the end of that child's
feed with nothing left behind. A file that has gone from Brightwheel (a 404) is recorded as
gone and no longer holds the marker back; a permanent failure that is not a 404 still does,
which is the honest choice, and stays until a real feed shows one.

Still open: which timestamp the feed is ordered by ([Q7](#q7-what-order-is-the-feed-in-and-should-the-cut-off-compare-both-timestamps)).

### C1. One package, with the service-agnostic half as a directory

**Decision.** Settled on 23 September 2026. The downloading, signed-URL identity, checksums,
safe file names, ISO weeks and archive list live in `packages/care-album-saver/src/ferry/`,
a directory with its own barrel file and no knowledge of Brightwheel — not in a second
package.

**Why.** It had been a separate package, `media-ferry`, with exactly one consumer, fourteen
exports nothing used, and every change after the first made for this tool. The deciding
point was publishing: `pnpm pack` rewrote the workspace dependency to `media-ferry@0.1.0`, a
name nobody had registered on npm. The install instructions could not have worked, and until
someone claimed the name, anybody could have published code into the dependency graph of a
tool that handles children's photos.

**Alternatives turned down.** Two packages until a second consumer appears.

**Distribution.** The tool is installed from a clone of this repository. Releases will be
published on GitHub, which is where the update check looks; none has been cut yet. It is not
on npm; the npm-based install routes `src/version.ts` recognises are there for the day it is.

### C2. Archive Ferry is provenance, not a shared contract

**Decision.** Several algorithms in `src/ferry/` descend from Archive Ferry, a separate,
private Python project, and say so in comments where they do. That is
provenance only. They are re-implemented here, not bound; no behavioural pinning between
the two is intended; and there is no shared test fixture. This tool is not hosted in, and
does not depend on, that project.

**Why.**

- A TypeScript library cannot be imported by a Python worker, and the reverse is no easier.
- The two use different hash algorithms, so hashing test vectors could never be shared. The
  only shareable vectors would be twenty-odd lines of URL-identity cases.
- The audiences are unrelated, and a tool other parents run cannot ship from a private
  repository.

**Alternatives turned down.** Two implementations pinned by a shared, language-agnostic
test-vector fixture — ceremony with nothing to protect; and building this tool inside Archive
Ferry.

### C3. No perceptual de-duplication

**Decision.** Never. Brightwheel gives every post a stable id, which is a better key than any
image hash; a sync recognises a file by that id and by its URL without the signature.
Perceptual hashing would only catch the same photo posted twice by two teachers.

**Worth knowing.** The `sha256` in `archive.json` is taken after the tags are written in, so
two posts of one JPEG with different notes hash differently. It is an integrity checksum,
not a de-duplication key. The `duplicates` command is byte-exact and reads only
`archive.json`, so it says when unrecorded files mean `check --repair` should run first. If
re-posts ever matter, the answer is to record a hash taken before tagging, as provenance,
and group on that — not pHash.

### C4. The child's name is written into each file by default

**Decision.** "Label photos with names" is on by default and disclosed prominently. It is a
master switch: turn it off and nothing inside a photo or video says who or where — not the
child, not the nursery, not the person who posted it, and not the teacher's note, which
routinely names all three. The teacher's note has a second switch of its own, **Keep the
teacher's note**, which only applies while names are on.

**Why on.** It is what makes the archive searchable in a photo app, and the switch only
governs a file that travels on its own — a photo shared with family — where a parent's own
child's name harms nobody.

**What "off" does not do.** It does not make the archive anonymous. The child's folder, each
week's `README.md`, every `.json` sidecar and `archive.json` name the child whichever way the
switch is set. That is deliberate: they stay behind when a photo is shared, and they are what
keeps the archive readable without the tool.

**Alternatives turned down.** Names off by default; anonymising folder names and sidecars.

Still open: moving the nursery, poster and note behind a second switch that is off by
default ([Q11](#q11-a-second-switch-for-the-nursery-the-poster-and-the-note)).

### C5. A video's dates are written in UTC, with Apple's local-time key beside them

**Decision.** A video cannot take the photo tags — `DateTimeOriginal` is not a QuickTime tag
at all. So an MP4 or MOV gets `QuickTime:CreateDate` and the track and media header dates in
**UTC**, which is what the QuickTime specification defines them as and what ffprobe, Apple
Photos, Immich, Plex and Jellyfin are understood to convert from; plus `Keys:CreationDate`,
which is local time with its offset and is the key Apple Photos prefers. Immich consults
`CreationDate` before `CreateDate`, so it takes the Apple key, offset and all. See
`quickTimeUtc` in `src/metadata.ts`.

**Why the tool renders UTC itself** rather than using ExifTool's `QuickTimeUTC` option: that
option converts using ExifTool's own time zone, and the bundled ExifTool is started with a
bare environment. The bytes written are the same.

**Proven:** the round trip — a generated MP4 is archived and read back, and the dates, name,
note and untouched frame data come out as intended (`test/real-media-fixtures.test.js`).
**Not proven** by running them: what each consumer application does with those headers.
ExifTool's QuickTime documentation and Immich's metadata code were read on
22 September 2026, and agree.

**The one consequence that surprises people:** plain `exiftool` shows a video's `CreateDate`
as the UTC wall clock with no zone beside it, apparently "hours off", while every photo app
shows the local time. The README says so. It also answers the related worry, that a
late-evening video sits in one day's folder and reads as the next day in a hex editor: both
are correct.

### C6. How the tool describes itself

**Decision.** The README leads with what a parent ends up with — an archive that is
**independent of the account**. Brightwheel's own help centre says a family loses a
profile's history when its access ends and tells parents to download first. What
distinguishes the tool: dates from when a photo was posted rather than when it was saved,
names and notes written in, week folders, plain-text sidecars readable without the tool,
and runs that fetch only what is new, on a schedule.

**Never "only".** No document, page or package description says the tool is the only thing
that puts metadata into these photos, or the only way to save them. It is unverifiable,
probably false, and the wrong headline.

**Not a differentiator:** saving in bulk. Brightwheel's mobile app has a bulk save in its
gallery, and browser extensions exist.

### C7. The name is Care Album Saver

**Decision.** Settled by the owner on 22 September 2026: the project is Care Album Saver, and
no name it owns contains "Brightwheel".

**Why**, and either reason alone would be enough:

- A tool named after somebody else's service is the one that gets a letter. This is a free
  tool that helps a parent get their own child's photographs out of a service they already
  use, and it should not hand anyone an easy reason to close it. Saying which service a parent
  signs in to is what a trade mark permits, and stays; a package, command, folder or heading
  *named* Brightwheel is a claim on the mark, and went.
- The project may one day read more than one service. A generic name costs nothing now and
  saves a second rename later, when there would be archives and installs to carry through it.

**What changed:** the npm package and the command are `care-album-saver`, the workspace
directory is `packages/care-album-saver`, the config folder is `care-album-saver`, the
environment variables are `CARE_ALBUM_*`, and a fresh install saves into
`~/Care Album Photos`. **What did not:** every descriptive mention of Brightwheel — the API
client, the mock, the cookie name, the gitleaks rule ids that describe that cookie, and the
sentence on the setup page telling a parent which site to sign in to.

**Nothing on an existing machine moved.** The old config folder is still read when the new one
does not exist, the old `BRIGHTWHEEL_ARCHIVE_*` and `BRIGHTWHEEL_SESSION` variables are still
honoured, and an archive already in `~/Brightwheel Photos` stays the default while it is
there. Tests pin all three, and `doctor` says when the old folder is the one in use.

Not decided, because it is still hypothetical: whether reading a second service would mean a
source-adapter boundary in `src/api/`.

### C8. Every photo goes to Apple Photos.app once, and Copy items is asked about

**Decision.** Settled on 24 September 2026. Turning on *Add them to Apple Photos.app* makes
every photo and video saved so far, for every child, due, and each run's new ones after that.
Each file goes once: `photos.json` keeps the SHA-256 of everything handed over, so a file
moved by a change of layout is not handed over again (two posts of one picture are two files,
each tagged with its own date, and each goes in; a batch that was cut off before it could be
written down is handed over again). Ticking the box adds nothing by itself; the next run does, or *Add them to
Apple Photos.app now* under it, which fetches nothing from Brightwheel. The count the page
shows is the one integer the AppleScript prints, what Apple Photos.app's `import` returned;
when it works, that integer is all that comes back from Apple Photos.app, and when it fails,
the last line of the error osascript reports. A batch it counts short is
still written down whole, because it does not say which ones it took, and handing them all
over again would duplicate those it did; the page says how many it did not confirm. Every
time the option is turned on, the page first asks the parent to confirm that Apple
Photos.app's *Copy items to the Photos library* is ticked.

**An install that already had it on is not widened.** Its `addToPhotosFrom`, the moment it
was turned on, still limits what goes in, so updating never sends Apple Photos.app (and so
iCloud) photos the parent did not agree to. The page says how many saved earlier are not being
added; turning the option off and on again removes the limit, and turning it on asks.

**Why every photo.** Until this date only photos saved after the option was turned on were
due, with a separate button for the earlier ones. The owner turned it on after a run, and
Apple Photos.app got that run's photos, of one child, and nothing else, which looked like a
fault and was, from where a parent stands: someone who asks for their photos in Apple
Photos.app means all of them.

**Why the question.** The tool hands Apple Photos.app private copies and deletes them once it
has them ([PHOTOS.md](PHOTOS.md#how-it-works)). With *Copy items* off it keeps only a
reference, to a file about to be deleted: a preview that will not open, never uploaded to
iCloud, and written down as added, so never offered again. Nothing can see the setting. It is
a private preference inside Apple Photos.app's sandbox, and reading it would be reaching into
the parent's Photos data, the direction this tool never goes.

**Turned down.**
- *Reading the preference* (`defaults read`, or the sandboxed container): private,
  undocumented, and a path from Photos' data back into the tool.
- *Keeping the copies rather than deleting them*: a second full copy of the archive, for
  ever, to cover a setting that comes ticked.
- *PhotoKit, through a compiled helper*: a native binary to build, sign and ship, against
  zero runtime dependencies, for the same import.
- *A test import, checked afterwards*: finding out whether it opens means reading the library.
- *Asking Apple Photos.app which items it took*: names or ids from the library back into the
  tool, where the count is enough.

### Rejected for good

Each of these was considered and turned down; the entry named gives the reason. Please read
it before proposing one again.

| Proposal | Why not |
|---|---|
| A cookie in place of the setup link's token | [A3](#a3-the-setup-pages-token-goes-in-the-link-not-in-a-cookie) |
| A bookmarklet or console snippet to fetch the session | [A1](#a1-the-only-sign-in-is-a-pasted-session) |
| Reading the browser's cookie store from disk | A1 |
| A bundled or remote-controlled browser to sign in through | A1 |
| Password sign-in | A1 |
| Masking the paste box as a password field | A1 |
| A heuristic "long base64" rule in the scrubber | [A2](#a2-the-session-is-an-unprintable-object-and-the-paste-is-checked-at-the-boundary) |
| gitleaks, husky, lefthook or pre-commit as dependencies | [A4](#a4-what-protects-a-fork-is-that-nothing-secret-is-ever-in-the-tree) |
| Probing URL variants the API did not hand over | [B1](#b1-the-api-as-far-as-one-live-account-confirms-it) |
| Sending the session to the media host | B1 |
| Asking for pages larger than 100 records | B1 |
| A clock-skew margin on media-URL expiry | [B3](#b3-media-urls-are-signed-and-short-lived) |
| Decoding a custom-policy `Policy=` parameter | B3 |
| Perceptual de-duplication | [C3](#c3-no-perceptual-de-duplication) |
| Names off by default | [C4](#c4-the-childs-name-is-written-into-each-file-by-default) |
| Anonymising folder names and sidecars | C4 |
| Holding the check-in codes Brightwheel sends, or probing for a way to be sent them no more | [A5](#a5-check-in-codes-are-dropped-as-each-answer-is-read) |
| Reading Apple Photos.app's settings or library | [C8](#c8-every-photo-goes-to-apple-photosapp-once-and-copy-items-is-asked-about) |
| Keeping the copies handed to Apple Photos.app | C8 |

### Decided elsewhere

Settled decisions with a document of their own:

- **Adding photos to Apple Photos.app is off by default**, and is turned on only after macOS
  has asked permission — it is the one setting that can send photos off the computer.
  [PHOTOS.md](PHOTOS.md), and [C8](#c8-every-photo-goes-to-apple-photosapp-once-and-copy-items-is-asked-about)
  for what it adds and the question it asks.
- **The update check asks once**, and sends nothing before a yes; after that it asks GitHub at
  most daily, only from the setup page, never from the daily run.
  [UPDATE-CHECK.md](UPDATE-CHECK.md).
- **Zero runtime dependencies.** Node's standard library only; ExifTool is optional, and
  without it everything goes into the `.json` sidecars. [README](../README.md#how-the-code-is-laid-out).
- **Why the design is safe, and what it does not protect against.** [SECURITY.md](../SECURITY.md).
- **Decided while fixing the security review's notes** (2026-09-24; each with its reasons in
  [SECURITY-REVIEW-2026-09-23.md](SECURITY-REVIEW-2026-09-23.md) §4.6):
  - Every file the tool saves into the archive is owner-only (`0600`), like its folders; files
    saved earlier keep their modes (fs-10).
  - A list entry that is not in the form this tool writes stops the run and offers the repair,
    rather than being dropped silently (fs-8).
  - Control characters are removed from names, not replaced, so a name that carried one gets
    a new folder; nothing is downloaded again (processes-8).
  - The special-use names `.test`, `.example` and `.invalid` are not refused as media hosts:
    a local resolver answering for them is the same gap as any public name resolving to a
    private address, which only a connect-time check could close.
  - The Node path in the Task Scheduler task stays unquoted, as the task schema describes it.

---

## Open questions

The review of 23 September 2026 left a list of warnings, each with its fix; those are tracked
in [SECURITY-REVIEW-2026-09-23.md](SECURITY-REVIEW-2026-09-23.md), not repeated here.

### What nobody has checked yet about Brightwheel's API

Each of Q1–Q5 can be settled read-only by one more request that prints a count or a name and
no value. The plan is to extend `verify` to make those requests, then run it on a real
account and move the answers up into [B1](#b1-the-api-as-far-as-one-live-account-confirms-it).

#### Q1. Does `page` count from 0 or from 1?

The run only proves that page 0 is not empty. To settle it: request page 1 and report how
many of its ids also appear on page 0.

#### Q2. Is `page_size=100` honoured?

`run` asks for 100 records a page. `verify` asks for 50 and was given 50, so the ceiling is at
least 50. How many a page the full run of 21 September 2026 actually received is not known. To settle it: ask for 100 and report how many came back and what page size the
response says. Never ask for more than 100 ([B1](#b1-the-api-as-far-as-one-live-account-confirms-it)).

#### Q3. Does `action_type=ac_photo` filter the feed, or is it ignored?

`verify` reports "accepted" for any page that is not empty, which cannot tell the two apart.
The mock server filters, so no test can catch a live server that ignores it. To settle it:
count the records on the filtered page that are not photos.

#### Q4. Does a higher-resolution original exist?

To settle it without probing URLs the API did not hand over: list the key names under
`media.*` and `video_info.*`, and report the media `HEAD`'s content type, and its size
rounded to the nearest 100 KB.

#### Q5. How long does a media signature live?

To settle it: print the time left until a URL's `Expires` as a duration, which names nobody.
That says whether the refresh path in [B3](#b3-media-urls-are-signed-and-short-lived) ever
fires on a real run.

#### Q6. Does a second nursery distinguish `event_date` from `created_at`?

It needs a second account's `verify` report — a friend's, at another nursery. See
[B2](#b2-there-is-no-capture-time-to-recover).

#### Q7. What order is the feed in, and should the cut-off compare both timestamps?

The feed's order is Brightwheel's, and nobody has seen it documented. If it were ordered by
`created_at`, a teacher back-filling old photos would put them at the top of the feed
carrying old `event_date`s, and a batch large enough to fill three pages would trip the stop
early ([B4](#b4-the-incremental-cut-off-never-runs-ahead-of-the-walk)). On the one real
account the question is moot, because the two dates are identical on every record.

Agreed in principle, not built: record `created_at` as well, in the sidecar and in
`archive.json`; count a page as older only when every post on it is older by **both**
timestamps (identical to today where they agree, and right under either ordering); give the
mock a way to emit records where the two differ and to sort by either; and have `verify`
report whether each timestamp is non-increasing down the page, which needs no values.
Switching the stop to `created_at` alone was turned down: under `event_date` ordering it is
the mirror-image bug.

#### Q8. Can the listing be narrowed on the server by date?

The client can send `start_date` and `end_date` (`src/api/client.ts`), but nothing sets them,
and nobody has checked that the real API honours them. After a read-only probe, a date window
could replace some of the paging past the cut-off. Related, and not started: expressing the
three-page slack as a number of posts rather than pages, since the page size is itself open
(Q2).

### What only a real account can answer about sessions

#### Q9. What ends a session, and how long does one live?

The documents say that signing out of Brightwheel everywhere **should** end a session that
was copied out, because nobody has tested it — and a Rails cookie-store session often
survives sign-out. The test: paste a session, sign out in the browser, run
`care-album-saver doctor`. Also unknown: how long a session lives if nothing ends it, and
whether DevTools shows `_brightwheel_v2` as `HttpOnly` on the live site
([A1](#a1-the-only-sign-in-is-a-pasted-session)). Planned alongside: have the tool print how
old the stored session is, so its lifetime can be learnt.

### Agreed but not built

#### Q10. The token only where a header cannot carry it

Built on 2026-09-24; what was decided is in
[A3](#a3-the-setup-pages-token-goes-in-the-link-not-in-a-cookie).

#### Q11. A second switch for the nursery, the poster and the note

Keep the child's name on by default; move the nursery's name (written into a *location*
field, which contradicts removing GPS "so a shared file cannot reveal where it was taken"),
the poster's name and the teacher's note behind a second switch, off by default and effective
only while names are on, replacing **Keep the teacher's note**. The note is free text that
routinely names the room, the staff and other families' children, who never agreed to be in
this archive. Nothing would be lost: the sidecar is unchanged. See
[C4](#c4-the-childs-name-is-written-into-each-file-by-default).

#### Q12. CloudFront-shaped URLs in the mock

The mock mints lowercase `signature=` and a millisecond `expires=`, so no test exercises a URL
shaped like the real ones. Make it mint `Expires` in seconds, `Signature` and `Key-Pair-Id`,
read case-insensitively; and have `transferIdentity` strip CloudFront's optional
`Hash-Algorithm` parameter too. See [B3](#b3-media-urls-are-signed-and-short-lived).

#### Q13. Ignore rules and a pre-commit hook

`.gitignore` does not yet cover the temporary names the tool writes (`session.json.tmp`,
`config.json.tmp`, `archive.json.tmp`) or partial downloads (`*.part`); add them, mirror them
in `.dockerignore`, and add cases to `scripts/verify-ignores.sh`. Then a zero-dependency
pre-commit hook — a small Node script wired by `prepare` through `core.hooksPath` — that
applies the `.gitleaks.toml` rules to staged files, documented as unable to reach someone
editing on GitHub's website. And narrow the `!docs/images/*.png` exception, which re-admits
any PNG. See [A4](#a4-what-protects-a-fork-is-that-nothing-secret-is-ever-in-the-tree).

#### Q14. Smaller things

Have each week's `README.md` say what the files in it carry; say in the README what
Brightwheel itself offers for saving photos; and review the npm package keywords.

#### Q15. Checking the screenshots and the page's own script

Nothing checks that `docs/images/*.png` are current: CI regenerates them on every pull request
and fails if a capture breaks, but uploads the fresh images rather than comparing them, so a
change to the page that leaves old pictures in place still merges. A `--check` mode for
`scripts/screenshots.js` would close that. And the setup page's client script is never run by
the unit tests, which have no DOM — only by the screenshot script. A Playwright smoke test in
the same CI job, which already installs Chromium, is the proportionate fix.

#### Q16. Windows, beyond the test suite

CI runs the whole suite on Windows with Node 22, 24 and 26. Still unproven there: whether
renaming over an open file — `archive.json` on save, a `.part` file into place — trips an
antivirus scanner. File permissions on Windows are inherited from the folder, so there is no
owner-only mode on the session or the archive ([SECURITY.md](../SECURITY.md)).

### What only a real Mac can answer about Apple Photos.app

#### Q17. Does the script's import follow *Copy items to the Photos library*?

[C8](#c8-every-photo-goes-to-apple-photosapp-once-and-copy-items-is-asked-about) assumes
that AppleScript's `import` obeys the setting as **File › Import** does, so that with it off
Apple Photos.app keeps a reference to the private copy rather than a copy of its own. If it
always copies, the question the page asks is harmless but unnecessary; if it follows the
setting, the question is what stands between a parent and photos that will not open. No test
can answer it: no test may drive the real app. To check by hand, in a throwaway library so
nothing of yours is touched: first untick *Add them to Apple Photos.app* on your own setup
page, and do this well away from the daily run's time, so that no run of yours hands your
archive to the throwaway library (and writes it down as added). Quit Apple Photos.app, then
hold Option while opening it, and create a new library. Untick *Copy items* in its Settings ›
General. While `node scripts/demo.js` is running, copy one of its invented photos from its archive
folder (`node_modules/.cache/care-album-saver-demo`, deleted when the demo stops) into a
temporary folder, run the script on it
(`osascript packages/care-album-saver/applescript/add-to-photos.applescript Test Q17 -- <that copy>`),
delete the copy, and see whether the photo in the Test › Q17 album still opens or says
**Missing File**. Then tick *Copy items* again, quit, hold Option while opening Apple Photos.app
to switch back to your own library, and tick *Add them to Apple Photos.app* again.

**Half answered, 2026-09-24.** In the owner's own library, with *Copy items* ticked, every
photo the tool had added still opened at full size after the private copies it handed over had
been deleted (as they are after every batch), and again after the archive folder was renamed
and Apple Photos.app restarted. So with the setting on, the script's import copies into the
library: the path the page asks every parent to be on works. What it does with the setting
off, the half the steps above check, is still open, and low in stakes: either answer leaves
the tool as safe as it is, and decides only whether the page's question is necessary.
