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
