# Changelog

Everything that changes for the people who use Care Album Saver, newest first. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Each change's entry is its pull
request's release notes (or, before the repository had a remote, its merge commit's), so the
two always say the same thing.

There has been no release yet, so everything is under Unreleased. Entries from before
23 September 2026's durable-Node change were reconstructed from the merge history when this
file was started.

## [Unreleased]

### Added

- **It can tell you when there is a new version.** The first time you see your archive, the page
  asks once whether to check for new versions daily; say yes and it asks GitHub's releases,
  once a day, while the page is open (never from the daily run), and shows a gold **New version**
  button when there is one. The button opens what is new and the steps to update for the way
  this copy was installed — a git clone, a downloaded ZIP, Docker, npm, pnpm, Yarn or Bun
  (global or run once), or the maintainer's deploy script. Settings shows which version and
  commit you are running, the switch, and **Check now**. [docs/UPDATING.md](docs/UPDATING.md).
- **A photo viewer, and all of the last run on the dashboard.** The dashboard shows every photo
  and video the last run saved, twenty-four to a page, newest first. Clicking one opens it over
  the page rather than in a new tab: ← and →, or the arrows at the edges of the screen, step
  through the whole run, and Escape, the ✕ in the corner, or a click anywhere on the dark area
  around the photo closes it and returns to the page where you were. Videos play in place and
  can be scrubbed, in Safari too.
- **Production and development are separate.** `node scripts/deploy.js` keeps a production
  copy on `main` (by default `~/Applications/care-album-saver`), builds and tests it there, and
  moves the daily run onto it; `node scripts/production.js setup` opens its setup page. The
  checkout it deploys from, and every worktree of it, is marked as development: it refuses to set
  up the daily run and says so across the top of its setup page when it is using real settings,
  and the demo names the branch it is showing. Any other copy, including a clone made by
  following this README, is an ordinary install and sets up the daily run as before.
- **Also add them to Apple Photos** (Mac only, off unless you turn it on). New photos go into a
  Brightwheel folder in Photos with the same folders and weekly albums as on disk. With iCloud
  Photos on, Apple uploads them — the one way anything leaves your computer, which is why it is
  off by default and asks first. See [docs/PHOTOS.md](docs/PHOTOS.md).
- A dashboard once the archive has something in it: what was saved and when, thumbnails from the
  last run that open the full picture, and the daily run's log. Settings and the FAQ moved
  behind two buttons in the top right.
- Missed daily runs happen as soon as the computer is back on, on every platform, using the
  operating system's own catch-up rather than a timer of the tool's.
- Windows and Linux scheduling, with each platform's own log.
- The session box checks what you paste as you paste it, cleans up what it safely can (spaces,
  line breaks, quotes, a whole `Cookie:` line) and says at once when it is the wrong value.
- `scripts/demo.js`: the whole page against pretend children, a pretend Photos app and a pretend
  scheduler, for trying changes without touching anything real. It says so in a ribbon across
  the top.

### Changed

- A dead-code audit of the whole tree removed options nothing set, exports nothing imported,
  branches that could not run, and a download-resume path that was never taken; and corrected
  the comments and documentation that described them. Two small things a person could notice:
  `pnpm clean` now removes the whole build output, and the FAQ, README and guide now show
  folder names the way the tool writes them (`Robin-Maple`, not `Robin Maple`). The
  `Brightwheel Photos` suggestion in the temporary-folder refusal now names `Care Album Photos`.
- **Every line of the daily log says when it was written**, as ISO 8601 in your own time
  zone with its offset from UTC (`2026-09-23T17:00:04-07:00`). Before, only the start and result
  lines had a time, and it was in UTC, so the five o'clock run appeared as midnight the next
  day. Blank lines are left out. On Linux with systemd the journal keeps its own times, so the
  run's output there is left as it was.
- **Once set up, the page opens on your photos**, with who it is connected as, when the daily
  run is, how the last run went and where the photos are, underneath. **Settings is a column of
  sections** — Account, Children, Save Locations, Schedule, Integrations, Maintenance — showing
  one at a time, with nothing folded away, and every section fits one screen.
- **Colours are Rosé Pine**: Dawn when your computer is in light mode, the main Rosé Pine
  palette in dark mode. A few colours are nudged darker where the palette's own would be too
  faint to read comfortably as text.
- **Larger text throughout**: 18px body text, and every button and text box at least that.
  If you have told your browser to use larger text, the page follows it.
- The project is called **Care Album Saver**. Settings and photo folders saved under the old
  name are still found; nothing needs moving.
- Requests to Brightwheel no longer carry this tool's name; they identify as the browser the
  session was copied from, or as an ordinary desktop Chrome.
- The date recorded is the time each photo was **posted**: Brightwheel keeps no capture time.

### Fixed

- Six things the dead-code audit found on the way. The Docker build context now excludes
  `node_modules`, `dist`, sessions and archives at any depth, not only at the root (the host's
  build output had been going into the image). A request the setup page's server cannot read
  gets a fixed "not understood" answer instead of an error that quoted part of it. The settings
  patch stores only the eight settings the page can change, each in its expected shape. The
  "could not be added to Photos" notification can now actually be shown. Photos are served on
  Windows (the containment check assumed `/`), and a symbolic link planted inside the archive
  can no longer reach a file outside it. The demo's "open the log" no longer opens a real
  log viewer.
- Two things the security review reproduced. Everything that reads the archive's list —
  the gallery, the duplicate finder and remover, the repair, the Photos step — now resolves
  each entry to a real place inside the archive and refuses anything else, so a list edited
  by something else that can write the folder cannot make the tool delete, serve or import a
  file outside it, and the duplicate remover can no longer mistake two spellings of one file
  for a copy and delete the only one. A crontab the tool cannot read is no longer treated as
  empty and overwritten, and a `crontab` write that fails is reported instead of recorded as
  done.
- `docker build` failed: the Dockerfile still copied the `media-ferry` package, which was folded
  into this one on 23 September. A test now checks that everything the Dockerfile copies exists.
- `scripts/deploy.js` could deploy only once: every later deploy failed a test that assumed the
  suite never runs in production. And when a deploy did fail, the daily run had already been
  switched to the new build, which the script said had not happened. A failed deploy now puts
  production back on the commit it was on and rebuilds it, and production's tests always run in
  folders of their own.
- The dashboard's photos and numbers catch up when a run started from the page finishes,
  instead of at the next reload.
- A last run that took longer than ninety minutes lost its first photos from the dashboard: which
  files were "the last run" was a fixed window from the newest one. It is now every file saved
  without a half-hour pause between them.
- A folder typed into the page must be a full path (or start with `~/`). A relative one was
  quietly put inside the tool's own folder. The command line's `--dir` still means relative to
  where you typed it.
- Reconnecting after the session had run out no longer leaves the page stuck on the setup steps.
- **Two runs can no longer save into the archive at the same time.** Turning the daily run on
  starts one straight away, and pressing "Save new photos" in the same minute used to start a
  second beside it; the two overwrote each other's list, and the next run fetched photos again
  as "-2" copies. Now the second one says another run is already saving, and stops without
  changing anything.
- **A run you start counts as the day's run.** Runs started from the page or the command line
  were never recorded, so the daily run's missed-run catch-up always thought today had been
  missed and started a full run of its own.
- **Sizes match your file manager.** The dashboard divided by 1,048,576 and called it MB, while
  the folder check divided by 1,000,000, so one archive read 218 MB on one screen and 231 MB on
  the next. Both now measure the whole folder and write it as this computer's own file manager
  does: Finder and Ubuntu's Files count 1 MB as 1,000,000 bytes, Windows Explorer as 1,048,576.
- **When Brightwheel refuses a pasted value, the page says so in words that fit a browser**,
  and where the right value comes from — instead of a terminal command to run and a guess that
  the session had expired, which a value from the wrong row, or pasted into the demo, is not.
- **Button and text-box text was stuck at 13px**, whatever size the page asked for: an
  invalid rule made the browser ignore it and fall back to its own default. It is now the
  intended size, and a test stops the mistake coming back.
- A daily run that is set up but has not run shows as a warning, on the dashboard and in
  Settings, instead of in a green box.
- Where the daily run is written down is shown as `~/Library/LaunchAgents/…`, not the full
  path with your account name in it.
- **The daily run survives `brew upgrade node`.** A Mac that got Node from Homebrew had its
  daily run point at that exact Node version, which the next upgrade deletes — after which the
  run never happened again and nothing said so. It now uses Homebrew's own stable link
  (`/opt/homebrew/opt/node/bin/node`), which follows every upgrade. Older Intel installs and a
  Cellar kept on another disk are handled too. **If you set up the daily run before this
  change, turn it off and on again once** to pick it up.
- **Stopping, changing or reinstalling the daily run while it is saving no longer loses its
  place.** It finishes the photo it is on, writes down what it saved and stops; before, up to
  24 photos could be fetched again as duplicates by the next run.
- **The daily run's log is private to your account.** macOS created it readable by every
  account on the Mac, and it names your children. Existing logs are corrected the next time a
  line is written.
- The daily run's status recognises a Node that fnm (in its current default folder) or nvm
  under `~/.config` will later remove, and no longer mistakes a project that merely sits in a
  folder called "cellar" for one.
- A single post dated in the future no longer stops every later run from finding new photos.
- The session can no longer reach a terminal, a log line or the page, even in an error message.
- The secret scanner now recognises the signed photo links Brightwheel actually hands out.
