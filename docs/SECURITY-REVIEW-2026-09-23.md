# Security review before the first push — 2026-09-23

Reviewer: Fable 5.1, in the same session that wrote the handoff (the brief this review was
run from is in git history at d13f8ff, as `docs/SECURITY-REVIEW-HANDOFF.md`; its threat
model, trust boundaries and assets now live in [SECURITY.md](../SECURITY.md)) — the self-review trap the
adversarial-reviewer skill warns about. To compensate, the code was reviewed by sixteen agents
that had not seen it written: seven lanes running the Saboteur / New Hire / Security Auditor
personas over their files, one adversarial verifier per lane that had to reproduce or refute
each finding, and two lanes that viewed every one of the 88 screenshots ever committed. The
reviewer ran the probes in §2 by hand. Review target: `main` at 894d820 (the dead-code audit
plus the handoff). Time-boxed to forty minutes at the owner's request: the filesystem and
processes verifiers had reported when this was first written, and the outbound, page,
supply-chain and docs verifiers before it was committed — every one of their reviewers'
findings below was CONFIRMED or PLAUSIBLE, none refuted. The web-server verifier returned
minutes after the deadline: lane BLOCK before the fixes, every finding CONFIRMED (web-12
PLAUSIBLE), and two misses folded in below.

## 1. Verdict

**NO-GO for the push as the repository stands; GO with CONCERNS once two things are done.**
Both are the owner's, not the code's:

1. **Rewrite the history.** Five screenshot blobs in the four earliest commits (26f8b5b,
   7aa54e1, 2022973, 3837be3 — all ancestors of `main`) render the owner's home path with a
   real username; three more show a per-user temporary-folder hash. Confirmed by viewing
   every historical PNG (44 + 44, all viewed). Pushing `main` alone still publishes them. The
   rewrite is rehearsed and proven below (§3): 0 leaking blobs left, `main`'s tree unchanged.
2. **Decide the commit identities.** Every one of the 141 commits carries one of the owner's
   personal email addresses; the GitHub
   profile hides its email. Either a mailmap rewrite to the account's `noreply` address (do it
   in the same `filter-branch` pass) or an explicit decision to publish it. GitHub may refuse
   the push outright if "Block command line pushes that expose my email" is on.

The code: three CRITICALs were reproduced (§4.1) and **all three are fixed and merged**
(b9bee3b), with eight further reproduced defects. What remains open is WARNING-level (§4.2):
none of it blocks publishing, each is listed with its fix, and the ones marked ★ should go in
before the first release because they are one crafted input or one unlucky failure away.

Both skills' verification gates: the secret scan exits with zero findings; every DFD element
had at least one STRIDE row considered by a lane; every CRITICAL has an owner (this session)
and a fix landed.

## 2. Probes run by hand

| Question (handoff §4) | Result |
|---|---|
| Does the session Cookie follow a redirect? | Node v26.9.0 `fetch`, `redirect: 'follow'`, two local servers: a manually set `Cookie` header is **kept on a same-origin redirect and dropped on a cross-origin one**. A redirect off Brightwheel's host does not carry the session. No change needed. |
| Can a newline in a note add ExifTool arguments? | exiftool-vendored 38.1.0 / ExifTool 13.59: a Description of `…\n-Keywords=INJECTED\n-o\n<file>` was written **verbatim as the Description**; no tag injected, no file written. No change needed. |
| Secrets in the committed tree | senior-security's 20-pattern `secret_scanner.py` over `git archive main`: **0 findings**. |
| Personal data in the history's text | All 123 commits, `git grep -I`: the two real child-name tokens 0/0, the staff name 0, `/Users/<either username>` 0/0, `_brightwheel_v2=<value>` 0, a `session.json` payload 0, signed media URLs 149 — all deliberate fakes in `test/fix-privacy.test.js`, `test/gitleaks-rules.test.js` and the pre-rename copy of the first, allowlisted in `.gitleaks.toml`. |
| Personal data in the history's images | 88 distinct PNG blobs extracted and every one viewed: **5 CRITICAL** (home path with a real username, in `03-options` and `02-connected` of the three 21 Sept commits), **3 NOTE** (per-user `/var/folders/<hash>` temp path in `04-done` of the same commits), 6 NOTE (development-checkout cache paths under the `alex` placeholder, 22–23 Sept; one is the current `03-options.png` at HEAD — a placeholder, not a leak). Every `/Users/alex/…` is the placeholder; the cookie how-to figures are drawings with values that decode to "ExampleOnly"; no real photograph, child, nursery, email or token anywhere. |
| Dependency advisories | `pnpm audit --audit-level=moderate`: **No known vulnerabilities found.** |
| The Docker image | Builds (474 MB); runs as `node`; saved the mock's 8 items into a bind-mounted folder with metadata embedded by the vendored ExifTool (read back). Before the fix it carried the host's `dist/api/login.js`; after the `.dockerignore` fix, planted `HOST-MARKER` files in `dist/`, `node_modules/` and a fake `session.json` all stayed out (0 of 3). |

## 3. The history rewrite, rehearsed

Rule that works — "drop `docs/images` from any commit whose tree carries one of the eight
blobs" — rehearsed twice in a throwaway clone (an ancestor-based rule missed three blobs on
a side line):

```sh
# In a fresh clone, never the working checkout.
cat > /tmp/cas-index-filter.sh <<'EOF'
#!/bin/sh
if git ls-files -s -- docs/images | grep -qE ' (cfdf0d25|87beb8ad|cead4e7d|baddecbb|f468505b|9b660240|2189dd46|15b2b46e)[0-9a-f]{32} '; then
  git rm -q --cached --ignore-unmatch -r docs/images >/dev/null 2>&1 || true
fi
EOF
chmod +x /tmp/cas-index-filter.sh
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --index-filter /tmp/cas-index-filter.sh -- --all
rm -rf .git/refs/original && git reflog expire --expire=now --all && git gc --prune=now
```

Result: 88 → 74 PNG objects, **0 of the 8 remaining**, 14 commits lose their `docs/images`,
`main`'s tree identical to the original (all 12 current images intact). Add `--env-filter`
(or `git filter-repo --mailmap`, not installed here) for the identities in the same pass.
Afterwards: re-run the extraction and view the survivors; `rm -rf ~/Applications/care-album-saver`
and `node scripts/deploy.js` (it clones afresh; the daily job's plist is rewritten); delete
the merged local branches first — 60 exist, 16 of them `worktree-wf_*` harness names — and
push `main` only.

## 4. Findings

Ids are the lanes': `fs` filesystem, `processes`, `web` web-server, `page`, `outbound`,
`sc` supply-chain-ci, `docs`, `img` images. **Verified** = the lane's verifier reproduced or
proved it; **reproduced** = the reviewer did, verifier pending at the deadline.

### 4.1 CRITICAL — all fixed this session (merge b9bee3b, 320 tests pass)

| id | what | fix |
|---|---|---|
| fs-1 (verified) | `findDuplicates`/`removeDuplicates` joined `record.path` under the archive with no containment: a crafted `archive.json` (a cloud-sync peer or any co-writer of the folder) made the remover delete a file **outside** the archive, and two spellings of one file were "duplicates", so it deleted a photo's only copy while reporting "the photos they were copies of are still here". | `src/contain.ts`: one `containedFile()` (realpath both sides, symlinks refused, `..` refused) used by every consumer of `archive.json` — gallery, duplicates, repair, Photos step; two spellings of one file are one file. |
| web-1, web-2 (verified) | A suffix `Range` on a zero-byte file, or a file that stats but cannot be opened, raised an unhandled stream error after headers were sent and **killed the whole process** — the setup page and any run in progress. web-3: an abandoned range request leaked its file handle for the life of the process. | `parseRange` answers 416 for any range on an empty file; `/photo` opens the file before writing headers (500 if it cannot), handles stream errors, destroys the stream when the browser goes. |
| sc-1 (verified; its verifier re-rated it WARNING, since a session still needed a `docker build` from a tree holding one), img (verified) | `.dockerignore` patterns were root-anchored: the host's `dist/`, `node_modules` and anything under `packages/` went into the image (the review image carried `dist/api/login.js`); no photo/sidecar rule at all. | Every pattern `**/`-anchored, archive folders and the production marker added; proven with planted markers. |

Also fixed, from the audit's list and the review's WARNINGs (all reproduced): a malformed
JSON body echoed ~10 characters of a paste in a 500 → fixed 400 that never quotes the body;
`/api/config` spread every key into `config.json` (web-6: one bad patch then bricked the
page on every load) → whitelist of eight typed settings; `photoAt` hard-coded `/` (every
photo a 404 on Windows) and followed symlinks (fs-3, web-4) → `containedFile`; the Photos
step trusted the list lexically and followed symlinks (processes-5, the containment half) →
`containedFile`; `crontab -l` failing for any reason was an "empty crontab" and then
**overwritten**, and `remove()` ignored `crontab -`'s exit code (processes-2, verified) →
only "no crontab for" is empty, failures throw before anything is written; the Photos-failure
notification could never fire; the demo's "open the log" ran a real `open -a Console`; the
release link's prefix check was bypassed by `..` segments (outbound-6, page-5) → parsed and
normalised; `acceptableUserAgent` admitted CR/LF/NUL and non-ASCII inside the parentheses
(outbound-1) → printable ASCII only; CLAUDE.md named the owner's private sibling project's
content (docs-5) → reworded.

### 4.2 WARNING — all fixed by 2026-09-24; ★ = did before the first release

Filesystem and processes (verifier: BLOCK before the fixes above, CONCERNS after):
- ★ **FIXED 2026-09-23** (branch `fix/2026-09-23@review-star-items`, tests in `test/review-star-items.test.js`): `ferry/atomic.ts` `writeAtomically()` (random temp name, `wx`, fchmod, rename) for all five, plus the download's `.part` and the schtasks XML created with `wx`. — **fs-2 (verified)** Fixed-name temp writes follow a planted symlink: `Manifest.save` writes `archive.json.tmp` with flag `w`, chmods it, renames — a symlink at that name makes the next run overwrite and 0600 any owner-writable file. Same pattern in `writeManifestJson`, the week `README.md`, the `.json` sidecar (predictable name) and `writeSecureFile`'s `.tmp`. Fix: `rm` then open with `wx` (or a random temp name), one `writeAtomically()` helper for all of them.
- ★ **FIXED 2026-09-23** (branch `fix/2026-09-23@review-star-items`, tests in `test/review-star-items.test.js`): `SAVED_EXTENSIONS` in `sync.ts`; magic bytes not checked. — **fs-4 (verified)** The saved extension is whatever 2–5 alphanumerics end the CDN URL: `.html`, `.svg`, `.exe`, `.lnk` are accepted into a folder the parent double-clicks in. Fix: allowlist per kind (image: jpg/jpeg/png/heic/heif/webp/gif; video: mp4/mov/m4v), fall back to the kind's default; optionally check magic bytes.
- ★ **FIXED 2026-09-23** (branch `fix/2026-09-23@review-star-items`, tests in `test/review-star-items.test.js`): `UnreadableFileError`/`ConfigUnusableError`/`SessionUnusableError`; the scheduled run records the refusal; the Photos record refuses too (read as empty it would re-add everything). — **fs-5 / outbound-5 (verified)** A corrupt `config.json` is indistinguishable from a first run: `readJsonFile` returns null for "missing" and "unparseable" alike, so the daily job silently forgets `archiveDir` and `includeStudents`, creates the default folder and downloads every child's whole feed again. Same for `session.json` (a false "signed out"). Fix: distinguish ENOENT from a parse error and refuse, as `Manifest.open` already does.
- **FIXED 2026-09-24** (branch `fix/2026-09-24@review-warnings`; `test/run-lock-refresh.test.js`): the holder refreshes the lock every 30 s on a timer; an old lock whose pid is alive here is given two intervals to show it is refreshed before it is taken over, and Stop ends that wait. — **fs-6 (verified)** The run lock is touched only on progress events; a single slow download (>30 min) or a Retry-After wait emits none, so the daily job reads the lock as abandoned — and age alone overrides a live pid. Fix: touch on a timer while held.
- **FIXED 2026-09-24** (branch `fix/2026-09-24@review-warnings`; `test/schedule-quoting-and-failures.test.js`, the crontab round-tripped through five real shells): every path single-quoted for cron with `%` produced outside the quotes, C-escaped and `%%`/`$$` for systemd, the C runtime's rules for Task Scheduler; control characters, two `%` on Windows, and a quote, backslash or `* ? [` in systemd's program path are refused before anything is written. — **processes-1 (verified)** `cronLine`/`rebootLine` and the systemd `ExecStart` wrap machine paths in double quotes only: `$(…)`, backticks, `"`, `%` (cron's newline) and a newline in the Node, CLI or log path break or run something else. Reproduced: `$(echo INJECTED)` in the path executed. Inputs are local paths, so this is a broken daily run for a parent with such a path, not remote injection. Fix: a fixed wrapper script (0700) the crontab calls, or single-quote every path and refuse newlines.
- **FIXED 2026-09-24** (branch `fix/2026-09-24@review-warnings`): a refused bootstrap (or systemd enable) takes its files away again, and puts back the job it was replacing, or says there is none; install waits while launchd is still stopping a run (EINPROGRESS) rather than bootstrapping into it. — **processes-4 (verified)** A failed `launchctl bootstrap` leaves the plist (with `RunAtLoad`) in `~/Library/LaunchAgents` while `config.schedule` stays null: the job goes live at the next login with no record. Fix: remove the plist before throwing.
- **FIXED 2026-09-24** (branch `fix/2026-09-24@review-warnings`; `test/review-outbound-photos.test.js`, `test/photos.test.js`): Photos is handed only private copies (APFS clones in an owner-only folder), each hashed and checked against `fingerprints.json` in the config directory — a record sync writes as it saves, which a co-writer of the archive cannot edit — so neither a replaced file nor a matching edit of `archive.json` gets through; albums are named from where a file really is; the script refuses unless Photos, and every process running as Photos, is `/System/Applications/Photos.app`, and addresses it by bundle id; `/usr/bin/osascript` by full path everywhere. Cloud-synced folder: noted beside the switch, not refused (reasoning in `cloudWarning`). — **processes-5, remainder (verified)** The Photos step never verifies a file against its recorded `sha256` (a dedup key only) and album names come from the list, so a co-writer of the archive still chooses what enters the parent's Photos library (and iCloud) — now only with files inside the archive. Fix: hash and compare before handing to osascript; consider refusing the Photos step on a folder `safety.ts` flagged as cloud-synced.
- **FIXED 2026-09-24** (branch `fix/2026-09-24@review-warnings`; `test/run-lock-both-ways.test.js`): repair and duplicate removal hold the run lock. — **missed-fs (verifier)** `repairManifest` and `removeDuplicates` rewrite `archive.json` without taking the run lock; a sync in another process loses the update. Fix: take the lock.
- **FIXED 2026-09-24** (branch `fix/2026-09-24@review-warnings`): each remover's answer is read; "no such job" is established by asking the scheduler again (`launchctl print`, `schtasks /Query`) or by the unit file's absence, not from translated wording; launchd's 36 is waited out. — **missed-processes (verifier)** `remove()` ignores the exit code of every remover, not only cron: a failed `schtasks /Delete` leaves the task while the tool records it gone.

Web server, page, outbound, supply chain and docs (all verified):
- ★ **FIXED 2026-09-23** (branch `fix/2026-09-23@review-star-items`, tests in `test/review-star-items.test.js`): the record names the owning copy's `cli.js`; another existing copy needs `replace` (page: after a confirm) and a production copy's job needs the CLI's `--replace`. — **missed-web (verifier)** Any copy of the tool that is not marked development can replace the owner's real daily job: `schedule.install` writes the calling copy's own `cli.js` path into `~/Library/LaunchAgents/com.care-album-saver.daily.plist`, so a throwaway or extracted copy with no `.git` (an "installed" copy) that runs `schedule on` or the page's schedule route re-points the real job at itself. The development marker covers checkouts, not stray copies. Fix: refuse to install from any copy that is not production when a production marker exists elsewhere — or record the installing copy's path in the config and warn when it differs.
- **FIXED 2026-09-24** (branch `fix/2026-09-24@review-warnings`): the run lock both ways, plus a `maintaining` counter in the page's process. — **web-5** The maintenance-versus-run guard is one-way: a run can start while a repair or duplicate removal is in progress. Fix: the run lock, as above.
- ★ **FIXED 2026-09-23** (branch `fix/2026-09-23@review-star-items`, tests in `test/review-star-items.test.js`): `Accept-Encoding: identity`, and no length check when a `Content-Encoding` is present. — **outbound-3** `download()` compares the decoded byte count with the `Content-Length` of the encoded body, so any `Content-Encoding` (gzip) fails every download as "truncated". Fix: compare only when there is no content-encoding, or compare encoded sizes.
- **FIXED 2026-09-24** (branch `fix/2026-09-24@review-warnings`): capped at 300 s; a longer ask ends the run in words and the next carries on. — **outbound-2** `Retry-After` is honoured verbatim with no cap: a 429 can park a run for up to 24.8 days. Fix: cap at a few minutes.
- **FIXED 2026-09-24** (branch `fix/2026-09-24@review-warnings`): a blank or unusable id is replaced by one derived from the media's transfer identity; every id that worked before is unchanged. — **outbound-4** The post id — the de-duplication key — is not validated; an empty `object_id` makes every post collapse into one and the rest are skipped as "already had". Fix: require a non-empty id or fall back to the media URL identity.
- **FIXED 2026-09-24** (branch `fix/2026-09-24@review-warnings`): `http-body.ts` `readBodyText()` caps while reading — 16 MB for Brightwheel (client and `verify`), 1 MB for GitHub. — **outbound-7** No size cap on API responses; GitHub's 1 MB cap is applied after the whole body is read. Fix: cap the body while reading.
- **FIXED 2026-09-24** (branch `fix/2026-09-24@review-warnings`; `test/page-warnings.test.js`, and Playwright against the mock): `readState()` never throws and retries with backoff; a 401 `sessionRejected` from `/api/children` (and the Maintenance check) sends the page back to step 1. — **page-1** `poll()` has no failure path: one refused `/api/state` freezes the page in "running". **page-2** A session Brightwheel now rejects still shows "Connected" with "Connect first to see your children". Fix: handle the non-2xx in both.
- **FIXED 2026-09-24** (branch `fix/2026-09-24@review-warnings`): `script-src 'nonce-…' 'strict-dynamic'`, a fresh nonce per response, no script-src anywhere else; `esc()` is gone, every sink with outside data is a text-node builder, and a test fails on any innerHTML given anything but literal markup. — **page-3** Every HTML sink relies on call-site discipline under a CSP that permits inline script (all 20 sinks audited, none exploitable today). Fix (design): a nonce for the one inline script, `'strict-dynamic'`, and text-node builders like `paintNotes` for the rest.
- **FIXED 2026-09-24** (branch `fix/2026-09-24@review-warnings`): quoted for the shell it is for (brackets, `$`, backtick and `%` on Windows are named as unhandled). — **page-4** "How to update" commands put an unquoted folder after `cd`; a path with a space breaks. Fix: quote it.
- **FIXED 2026-09-24** (branch `fix/2026-09-24@review-warnings`; `test/verify-ignores.test.js`, `test/workflows.test.js`): sc-2, `must_track` requires the file to be tracked and not ignored by the rules alone; sc-3, confirmed read-only, with `persist-credentials: false` and a job-level `contents: read`; sc-4, `security.yml` also runs by hand and weekly, when gitleaks-action scans the whole history (on push and pull_request it scans only that range — read in its v3 source). No local full-history scan: gitleaks is not installed here. The first full-history run (by hand, 2026-09-24, after the merge) found two matches of the custom `signed-media-url` rule, both invented test URLs on `example.invalid`/`example.net` in commits of 2026-09-22 that today's files no longer carry; they are listed by exact commit fingerprint in `.gitleaksignore`. — **sc-2** `verify-ignores.sh`'s `must_track` proves nothing (`git check-ignore` never reports tracked files). **sc-3** The screenshots job runs fork code on `pull_request` and uploads what it wrote to `docs/images` — confirm `permissions` and that nothing publishes. **sc-4** gitleaks over the full history has not been run locally; the CI push scan is not a substitute for a pre-push check.
- **FIXED 2026-09-24** (branch `fix/2026-09-24@review-warnings`): the script asks `git check-ignore --no-index` about names and writes nothing; `.dockerignore` has a test, and a second one that holds it to every personal-data rule in `.gitignore`. — **missed-sc (verifier)** `scripts/verify-ignores.sh`'s `must_ignore` overwrites and then deletes any real gitignored file of the same name at the repository root — a developer's own `session.json` dropped there, for instance. Fix: work in a temporary clone (this review scanned `git archive main` for that reason). Also from that verifier: the `.dockerignore` fix carries a build proof but no test; the handoff's "a test each" overstated it.
- **FIXED 2026-09-23** (PR #3): `tmpdir()` is in the substitution list. — **img (reviewer)** `scripts/screenshots.js`'s `scrubPersonal()` has no pair for `tmpdir()`, which is how three early shots printed a per-user hash. Fix: add `tmpdir()` to the substitution list.
- **docs-2** **FIXED 2026-09-23**: enabled by the owner's instruction. — GitHub's private vulnerability reporting was **off** on the repository while `SECURITY.md` names it as the only channel (owner: enable it). **docs-3, docs-4, docs-7** **FIXED** before 2026-09-24 (checked then: neither phrase, nor a stale count, appears in any document). — **docs-3** README says the tool talks to Brightwheel "and to nothing else" — untrue with the update check on (fix the sentence). **docs-4** Three docs promise that signing out of Brightwheel "invalidates it immediately", which nothing has verified (soften). **docs-7** Three documents give three test counts; README says 121 (it is 320).

### 4.3 NOTES — fixed on 2026-09-24, except as §4.6 lists

**Status, 2026-09-24:** every id below was fixed, found already fixed, or decided, in the
pass §4.6 describes; what is left open, and why, is listed at its end. The list is kept as it
was written, for the ids.

fs-7 (stale-lock takeover race; fix by `rename` before `rm`), fs-8 (`Manifest.open` does not validate records: `files:[null]` throws a raw TypeError through sync, `/api/gallery` and maintenance — web-9 the same), fs-9 (`CON.x` passes the Windows reserved-name check), fs-10 (every file except `archive.json` is written at umask default), fs-11 (`checkArchiveDir` is lexical and accepts the tool's own config folder), fs-12 (a NUL in a note makes ExifTool refuse the whole write, so that photo also loses its dates), processes-3/6/7/8/9/10, web-7/8/10/11/12/13 (Host and Origin checks ignore the port; `?i=` accepts `0x1`; `String.replace` `$`-patterns in the banner splice; `xml()` does not escape `'`), page-6…12, outbound-8…13 (`--base-url` sends the session to any origin the owner names, including `http://`), sc-5…13 (no `packageManager` field; the image ships `src/` and all test files; deploy.js runs fetched `main` as the owner; Node 20 in the CI matrix while the only dependency needs ≥22 — those cells will fail on the first run), docs-6…15 (the handoff and CLAUDE.md status lines are already stale in places; 60 local branches, 14 of them `worktree-wf_*`), and one for the owner: the Mac's folder layout (`~/Developer/…`, `~/Applications/…`) appears in the handoff, CHANGELOG, CLAUDE.md, `scripts/deploy.js` and a test fixture — a layout, not an identity, but a deliberate yes or no before the push. Outbound's verifier added: a media URL is any non-empty string, so the API can point `download()` at any URL reachable from the parent's machine (fix: require the CDN's scheme and host); the sign-in heuristic runs on any non-JSON body before the status is considered (a captive portal reads as "signed out"); `CARE_ALBUM_SESSION` in `name=value` form goes out doubled.


### 4.4 An adversarial pass over the ★ fixes (same night)

Six reviewers, one per ★ item and one for portability, each tried to break the fix on
`fix/2026-09-23@review-star-items` with real inputs (verdict CONCERNS in every lane: no
CRITICAL, 11 WARNING). All WARNINGs were fixed on the same branch before it was merged;
`test/review-star-items.test.js` holds a test for each.

| found | what | fix |
|---|---|---|
| fs-2 | ExifTool's own `<photo>_exiftool_tmp` and the `.xmp` sidecar are predictable names, and ExifTool writes through a *dangling* link: reproduced, the tagged photo or a sidecar naming the child landed outside the archive (pre-existing) | every item is staged in a `mkdtemp` folder (0700, dot-named) inside its week folder and renamed into place (`saveStaged` in `sync.ts`) |
| fs-2 | a week or child folder that is itself a symlink is written through: `writeAtomically` guards the last component only (pre-existing) | `realFolderUnder` in `contain.ts`, checked before and after `mkdir`; the folder's items fail with a message |
| fs-2 (notes) | replaced files lost their mode; no fsync; `.part`/`_exiftool_tmp` litter adopted by the repair; Windows rename meets scanner locks | existing mode kept; `handle.sync()`; the audit skips them and hidden folders; EPERM/EACCES/EBUSY retried on win32 |
| fs-4 | regression: a per-kind list named a JPEG on a video post `.mp4` and TIFF/AVIF `.jpg`, so ExifTool refused to tag them | one list of inert media extensions for both kinds |
| fs-5 | following the refusal's advice (move the file aside) made the next daily run a first run again | a scheduled run with no `config.json` refuses and records it |
| fs-5 | regression: a damaged Photos record hid the Photos card ("needs a Mac") | `photosStatus` reports `problem` instead of throwing; the page shows it beside the switch |
| fs-5 | a UTF-8 BOM (Notepad) bricked every command; a session of the wrong shape was still "not signed in"; a scheduled run with no session recorded nothing | BOM stripped; `SessionUnusableError` for any unusable session; recorded |
| fs-5 (notes) | wrong-typed `includeStudents` meant every child; `setup`/`where`/`doctor`/`schedule off` refused on damaged settings; an invalid `savedAt` took `/api/state` down; errno codes shown raw; a duplicate unstamped log line; deploy.js crashed | the three harmful fields are type-checked; those commands run and report it; all guarded or put in words |
| missed-web | any copy carrying the production marker bypassed every ownership check — including a Finder duplicate of production | the marker's first line is the production folder's real path (`isProductionRoot`); production may not take the job from another production folder without `--replace`, which deploy.js passes |
| outbound-3 (notes) | a compressed stream cut short inside a complete response decodes silently to a shorter file; bare `identity` is wget's header | a compressed body is refused (retried next run); the header is a browser's media value, `identity;q=1, *;q=0` |

Still open from this pass, each a NOTE: a child's name ending in `.app` makes macOS show the
child's folder as an application (fs-4); ownership lives only in `config.json`, so a copy from
before this fix writes records without an owner (missed-web); `login` writes back the whole
settings object it loaded at start, racing a schedule change (pre-existing); while the Photos
record is damaged, the Photos notice repeats every evening rather than once.

### 4.5 The remaining WARNINGs, fixed and reviewed adversarially (2026-09-24)

Five file-disjoint lanes, each an implementer in its own worktree followed by one read-only
adversarial reviewer (workflow `wf_8e67d281-280`, ten agents), then integration and the
reviewers' findings fixed in the main session. Every reviewer returned CONCERNS. What they
found, and what became of it:

| Lane | Finding | Severity | Outcome |
|---|---|---|---|
| schedule | Turning the daily run off while a run is stopping: launchctl answers 36 (EINPROGRESS), read as a refusal; the plist stayed to reload at login | WARNING (regression) | `unloadLaunchd` waits it out for ExitTimeOut plus 5 s |
| schedule | A change of time during a run bootstrapped into a job still stopping, and the rollback deleted both runs and the record; the page kept showing the old run | WARNING (regression) | waits first; a refused new job puts the old one back (launchd and systemd); a refusal carries the schedule as it is now |
| schedule | systemd refuses a program path with a quote, backslash or glob; the test's model accepted it | NOTE | refused in words; the model has `string_is_safe` |
| locks | Stop ignored during the new 60 s wait, then the lock taken over and Brightwheel called | NOTE | the wait takes the signal; a stopped run asks Brightwheel nothing |
| locks | A skipped scheduled run logged "another run was already saving photos" whatever held the lock | NOTE | logs the refusal itself |
| locks | macOS renames itself with the network, so a slept run's lock read as another computer's | NOTE | same short name plus a live pid gets the wait (never an immediate takeover) |
| page | Update section empty after the first load recovers | NOTE | asked on the first successful refresh |
| page | Step 3 ticked after a refused session | NOTE | not while the session is refused |
| page | `[` `]` break PowerShell's `cd` | NOTE | named with the other unhandled Windows cases |
| outbound-photos | Every photo of an archive saved before 2026-09-22 (pre-tag hashes) reported as tampered, none added | WARNING | the reference is no longer `archive.json`; a one-off baseline per folder |
| outbound-photos | The hash check trusted `archive.json`, which the co-writer can edit to match | WARNING | `fingerprints.json` in the config directory, written by sync; private copies checked |
| outbound-photos | `verify`'s `raw()` read answers uncapped | NOTE | `readBodyText`, 16 MB |
| outbound-photos | Retry waits across `me()`/`students()` could outlast the 30-minute lock age | NOTE | moot: the lock now refreshes on a timer; comment corrected |
| supply-chain | `.dockerignore` let keys, browser state and photos outside the default folders into the image | WARNING | every personal-data rule of `.gitignore`, and a test that keeps them in step |
| supply-chain | The workflow guard missed local and `docker://` actions and `secrets[...]`/`toJSON(secrets)` | NOTE | fixed; each mutation shown to fail |
| supply-chain | sc-4 still open: CI's scan is per-event | NOTE | `workflow_dispatch` and a weekly `schedule` |
| supply-chain | The default-folder rules could be deleted unnoticed (`*.jpg` caught the probe) | NOTE | probed with the lock file |

Added on the owner's instruction during the same pass, after asking whether the Photos
hand-off could reach an app other than Apple's: the bundle-id and `/System/Applications`
check in the script, `/usr/bin/osascript`, and the private copies. The identity check is
exercised on this Mac only as far as asking LaunchServices, which does not open Photos; no
test drives the real Photos app, so the script's end-to-end behaviour against Photos is for
the owner to confirm once by hand.

### 4.6 The NOTEs, fixed and reviewed adversarially (2026-09-24)

Five file-disjoint lanes again (schedule and command line; archive and locks; outbound and
metadata; page and server; supply chain and docs), each an implementer in its own worktree
followed by one read-only adversarial reviewer (workflow `wf_b1ceec66-b3f`, ten agents). The
lanes reported 63 items: 56 fixed, 4 found already fixed (page-5, sc-5, sc-13, docs-15), and 3
not changed by decision (below). Five §4.3 ids were in no lane's list and were checked in the
main session: web-8 and page-7 (the page is filled in with replacer functions) and web-12 (the
script runs by nonce, `base-uri 'none'`) were already fixed; outbound-10 is handled where the
date is printed (`/api/state` checks it); processes-7 was open and is fixed below.

Every reviewer returned CONCERNS: 5 WARNINGs and 25 NOTEs, no CRITICAL. The usage limits ruled
out a second fan-out, so all 30 were fixed in the main session, each WARNING with a test shown
to fail on the code before it:

| # | Lane | Finding | Severity | Outcome |
|---|---|---|---|---|
| F1 | schedule | The "scheduler changed" fix read exit 127 (not installed) as a refusal: on Linux, a run set up with systemd after systemctl went, or with cron after crontab went, could be neither moved nor turned off | WARNING (regression) | 127 means that scheduler can run nothing: systemd's files and enable link are removed; a real refusal names the files to delete |
| F2 | archive | processes-10 part-fixed: a lock whose time was set once to the future counted as fresh for ever (unreadable, this computer's with a live pid, or "perhaps this computer's"), and so did the takeover guard and `photos.lock` | WARNING | `touchedWithin`: no more than 5 min ahead counts as a refresh; a future-dated lock gets the one-minute wait (a real holder with a fast clock refreshes in it); an unreadable lock is not in use past a minute; `lutimes` |
| F3 | outbound | `verify` (plain and `--deep`) asked any media address in the feed, following redirects, and printed the answer | WARNING | media addresses and every redirect held to `mediaUrlRefusal`; a refusal is said without the address |
| F4 | page | The port was read from `server.address()` per request, null once `close()` began: a request in flight crashed the process | WARNING (regression) | the port is read once after `listen()`; the gate runs in its own `try` |
| F5 | supply | deploy.js said "Not deployed: Deployed abc1234 to production…" after production had been updated | WARNING | "Deployed, but not finished" |
| F6 | schedule | Crontab recovery took a person's own line of the same shape after a block whose end line was deleted | NOTE | a line is ours only by its words: `<node> <…/cli.js> run --scheduled >> <…/daily.log> 2>&1` |
| F7 | schedule | Deleting only the marker, as its comment invites, left both lines running and doubled them on reinstall | NOTE | a stray end line takes our lines directly above it |
| F8 | schedule | The live-API test guard missed a trailing dot, in-process clients and the setup page | NOTE | in the client's constructor, for the whole domain, dot or not |
| F9 | schedule | The printed `--child <id>` failed for an id beginning with `-` | NOTE | `--child=<id>` |
| F10 | schedule | SECURITY.md and the README still said `--base-url` sends the session anywhere | NOTE | corrected |
| F11 | archive | fs-11 part-fixed: `link/..` was judged by spelling, while the system follows the link first | NOTE | the real location is found from the path as typed |
| F12 | archive | The race tests barely told old code from new; tests failed in a checkout inside the temp folder | NOTE | six processes race for one lock, six rounds; those tests skip with a reason there. The Photos-lock test checks the outcome; its mechanism is the run lock's, tested there |
| F13 | archive | A named pipe at `archive.json` held a run (with the lock taken) and each page look for ever | NOTE | `readListText`: opened without blocking, an ordinary file only |
| F14 | archive | A stem cut to 120 characters could end in a dot | NOTE | stripped again after the cut |
| F15 | outbound | A same-origin redirect carrying `user:pw@` reached error text raw | NOTE | refused on every hop |
| F16 | outbound | `Retry-After: 00000000005` read as a year | NOTE | counted without leading zeros |
| F17 | outbound | A regression would hang a test for six hours instead of failing it | NOTE | the body ends by itself; timeouts |
| F18 | outbound | Removing control characters changes a child's folder when the name carried one | NOTE | decided: kept, and said in the CHANGELOG; nothing is downloaded again |
| F19 | outbound | Staged files were chmodded by path, which follows links | NOTE | by handle, `O_NOFOLLOW` |
| F20 | outbound | Media-rule gaps: some IPv6 ranges, special-use names | NOTE | `::ffff:0:0/96`, `64:ff9b:1::/48`, `100::/64`, `2001:db8::/32` added; `.test`/`.example`/`.invalid` decided against (see DECISIONS) |
| F21 | outbound | Run failures still said only "fetch failed" | NOTE | `failureReason` in sync, each warning, the daily log and the last message |
| F22 | outbound | Housekeeping: branch behind `main`, no CHANGELOG entry, fs-10 unrecorded | NOTE | integrated on `main`; CHANGELOG; SECURITY.md and DECISIONS |
| F23 | page | The address token was refused only under `/api/`, not allowed only on `/` and `/photo` | NOTE | an allowlist: `GET /` and `GET /photo` |
| F24 | page | Save and Start reported any unreadable answer as "cannot reach the tool" | NOTE | only no answer is; a 403 says to open the new link |
| F25 | supply | A config folder that was a link to the home folder narrowed the home folder; special bits were dropped | NOTE | compared and changed at real paths; `0o7700` |
| F26 | supply | The daily.log probe could not fail; three comments put the log in the config folder | NOTE | corrected, and said |
| F27 | supply | "Only your account can open" without its caveat in three places; doctor's "one request" | NOTE | caveat added (README's Docker section, the page's FAQ, PHOTOS.md); retries named |
| F28 | supply | SECURITY.md's run-lock row would miss the one-day rule | NOTE | updated, with F2 |
| F29 | supply | No CHANGELOG entry for the config folder's new mode | NOTE | added |
| F30 | supply | The owner's npm and GitHub records | NOTE | 0.1.1 published with the new address (0.1.0 to be unpublished by the owner); `a52f841`, a merge-button commit replaced on `main`, to be added to the GitHub Support request |

Also done in the main session, from the lanes' own lists of what they could not reach:
`verify`'s requests take the session header from the client's one builder (outbound-13's third
part); `environment.ts` and `version.ts` find this copy the way `copyRoot` does, so an npm
install inside someone's git project is not read as a clone (processes-9's rest); `/photo` sends
a type it does not know as an attachment (page-9's server half); the Task Scheduler comment
says only what the documentation says; processes-7 (one decoder per stamped stream; blank lines
decided when they end); `bin` is `dist/cli.js`, which npm rewrote `./dist/cli.js` to at each
publish while warning that it had been "removed".

**Still open, each with its reason:**
- *photos-pending* is an upper bound, not an exact count: an exact one would hash every pending
  file on each status read, and for older archives it would need the baseline, which writes.
- *A notice when the daily run is skipped for days by a held lock* (the archive lane's
  suggestion) is not built: the obvious signal, the time since the last run, gives false alarms
  when two computers share an archive, and with F2 a lock planted once no longer stops runs.
- *sc-6*: pnpm is pinned exactly everywhere instead of by a `packageManager` field, whose lockfile
  entry needs registry access to write. The Docker build stage has not been built with 12.5.1.
- *web-12*'s residue: a script injected into the page could still leave by top-level navigation,
  which CSP does not govern. No injection has been found.
- Minor and harmless today: `schedule.ts`'s `xml()` does not escape `'` (element content only);
  `fingerprints.ts` filters the list with its own check rather than `usableRecord`; archive dates
  are validated where the page shows them, not where gallery.ts reads them; bidi and format
  characters are not stripped from names; a 408 is not retried.
- Not verified on a real machine: Task Scheduler registration (CI runs the tests on Windows, but
  no test registers a task); launchctl, systemctl and crontab (stand-in runners only).

## 5. What was verified, and what was not

Verified: `pnpm clean && pnpm build && pnpm test` on `main` after the fixes: **320 tests, 320
pass**; the fixes' tests in `test/review-fixes.test.js` (a fixed 400 with no echo across five
malformed bodies; the settings whitelist; `..`, symlink and ordinary entries through
`containedFile`; the duplicate finder and remover against an outside copy and two spellings;
both notices as literals; the stand-in log viewer; a range on an empty file and an unopenable
file with the server still answering afterwards; the parsed release link; the User-Agent
guard; crontab unreadable / empty / write-refused); the Docker proof; the rewrite rehearsal;
the four probes in §2.

Not verified: the five pending verifier lanes (their reviewers' reproductions stand as
reproductions); the CI matrix has never run; systemd, cron and Task Scheduler on real
systems; a real `docker run --user` on Linux; gitleaks over the history; the fixes were not
mutation-checked (time-boxed).
