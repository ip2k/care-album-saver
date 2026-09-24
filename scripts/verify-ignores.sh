#!/usr/bin/env bash
#
# Prove that .gitignore actually blocks credentials and photos.
#
# This exists because a .gitignore can look completely correct and do nothing. Git does
# not support trailing comments on a pattern line, so `*.har  # browser captures` becomes
# a literal pattern that matches no file — and the rule silently fails open. That exact
# bug shipped in the first draft of this repo and was caught only by running this check.
#
# Asserting on behaviour, not on the file's contents, is the only way to know.
#
# It asks git about names and never creates, changes or deletes a file. The first version
# wrote a file of each tested name, asked about it and deleted it, so a developer's own
# gitignored session.json or config.json at the root of their clone was overwritten and
# then removed by the very check meant to keep it out of a commit (security review
# missed-sc). `git check-ignore --no-index` answers for a path that need not exist.
#
# Run:  ./scripts/verify-ignores.sh      (also runs in CI on every pull request)

set -uo pipefail
cd "$(dirname "$0")/.."

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not inside a git checkout, so there are no ignore rules to verify."
  exit 2
fi

FAIL=0
# A folder that is never created. A path under it only has to have the right shape: git
# treats each leading component as a directory whether or not it exists.
SOME=".never-created"

RULE=""
# Which rule decides a path, from this repository's .gitignore files alone.
#
#   --no-index   answers from the rules, as for a file not yet added. A plain check-ignore
#                reports a tracked file as not ignored whatever the rules say, which is
#                how the first version's "must still be committable" checks passed
#                without looking (security review sc-2).
#   -v -z        names the deciding rule, NUL-separated so a name with spaces survives
#                (git allows -z only with --stdin, hence the printf). A `!` rule decides
#                too, and means the path is committable.
#   core.excludesFile=/dev/null
#                leaves out the developer's personal global ignore file, which nobody
#                who clones this repository has.
#
# A rule from the clone's own .git/info/exclude cannot be left out that way, so it is told
# apart instead: only a .gitignore travels with the repository, so only a .gitignore
# protects a parent. Git consults every .gitignore before info/exclude, so when that file
# decides, no .gitignore rule matched at all.
#
# Sets RULE to "source:line:pattern" and returns 0 when a .gitignore rule ignores the path,
# 1 when nothing does, 2 when git could not answer, and 3 when only a personal rule does.
decide() {
  local path="$1" out status source line pattern
  out=$(printf '%s\0' "$path" |
    git -c core.excludesFile=/dev/null check-ignore --no-index -v -z --stdin |
    tr '\0' '\t')
  status=$?
  RULE=""
  case "$status" in
    1) return 1 ;;
    0) ;;
    *) RULE="git check-ignore exited $status"; return 2 ;;
  esac
  IFS=$'\t' read -r source line pattern _ <<<"$out"
  RULE="$source:$line:$pattern"
  case "$pattern" in
    '!'*) return 1 ;;
  esac
  case "$source" in
    .gitignore | */.gitignore) return 0 ;;
  esac
  return 3
}

# Whether the path is in the index, i.e. committed or staged. Literal, so that a `*` or
# `[0-9]` in a name is never read as a pattern that happens to match some other file.
# (check-ignore takes names already, and refuses this setting.)
tracked() {
  GIT_LITERAL_PATHSPECS=1 git ls-files --error-unmatch -- "$1" >/dev/null 2>&1
}

ok() { printf '  ok      %-46s %s\n' "$1" "$2"; }
failed() {
  printf '  FAILED  %-46s %s  <-- %s\n' "$1" "$2" "$3"
  FAIL=1
}

# A credential, a photo or anything else a run writes: a new file of this name must not be
# committable, and none may already be committed (an ignore rule does not untrack a file).
must_ignore() {
  local path="$1" label="$2"
  decide "$path"
  case $? in
    0)
      if tracked "$path"; then
        failed "$path" "$label" "ignored, but already committed"
      else
        ok "$path" "$label"
      fi
      ;;
    1) failed "$path" "$label" "would be committable${RULE:+ ($RULE)}" ;;
    3) failed "$path" "$label" "only a personal rule ignores it ($RULE)" ;;
    *) failed "$path" "$label" "$RULE" ;;
  esac
}

# One of the project's own files: it must be tracked, so the check is about a real file and
# not a typo, and the rules alone must not ignore it, so that a fresh copy, or the file
# deleted and added again, can still be committed.
must_track() {
  local path="$1" label="$2"
  if ! tracked "$path"; then
    failed "$path" "$label" "not tracked"
    return
  fi
  decide "$path"
  case $? in
    1 | 3) ok "$path" "$label" ;;
    0) failed "$path" "$label" "tracked, but $RULE ignores it" ;;
    *) failed "$path" "$label" "$RULE" ;;
  esac
}

# A file that does not exist yet and must be committable when it does.
must_allow() {
  local path="$1" label="$2"
  decide "$path"
  case $? in
    1 | 3) ok "$path" "$label" ;;
    0) failed "$path" "$label" "$RULE would refuse it" ;;
    *) failed "$path" "$label" "$RULE" ;;
  esac
}

echo "Credentials and personal data must be ignored:"
must_ignore "capture.har"                        "browser capture with live session"
must_ignore "$SOME/nested/debug.har"             "capture in a subfolder"
must_ignore "session.json"                       "saved session"
must_ignore "config.json"                        "local config"
must_ignore ".env"                               "env file"
must_ignore ".env.local"                         "env variant"
must_ignore "cookies.txt"                        "cookie jar"
must_ignore "cookies.json"                       "cookie jar"
must_ignore "private.key"                        "key material"
must_ignore "server.pem"                         "certificate"
must_ignore "storageState.json"                  "playwright session state"

echo
echo "Downloaded photos must be ignored:"
must_ignore "$SOME/child.jpg"                    "photo"
must_ignore "$SOME/child.jpeg"                   "photo"
must_ignore "$SOME/child.heic"                   "photo"
must_ignore "$SOME/clip.mp4"                     "video"
must_ignore "$SOME/clip.mov"                     "video"
# The lock file, not a photo: *.jpg would catch a photo with the folder rule gone, and the
# lock (pid, host name and start time, left behind by a crashed run) is caught by nothing else.
must_ignore "Care Album Photos/.care-album-saver.lock"  "default archive folder"
must_ignore "Brightwheel Photos/.care-album-saver.lock" "default archive folder, pre-rename"

echo
echo "Everything else an archive run writes must be ignored:"
# The photos are only half of what a run leaves on disk. These files name the child in
# plain text, and a parent who archives into a folder inside their clone of this repo is
# one `git add -A` away from publishing them.
must_ignore "$SOME/Robin-Maple/2026-W38/2026-09-18_1530_ab12cd34.jpg"      "archived photo"
must_ignore "$SOME/Robin-Maple/2026-W38/2026-09-18_1530_ab12cd34.jpg.json" "sidecar naming the child"
must_ignore "$SOME/Robin-Maple/2026-W38/2026-09-18_1530_ab12cd34.jpg.xmp"  "xmp sidecar"
must_ignore "$SOME/Robin-Maple/2026-W38/2026-09-18_1530_ab12cd34.mp4.json" "video sidecar"
must_ignore "$SOME/Robin-Maple/2026-W38/README.md"                        "week README naming the child"
must_ignore "$SOME/2026-W01/README.md"                                    "week README, week-only layout"
must_ignore "$SOME/archive.json"                                          "manifest naming every child and note"

echo
echo "Documentation screenshots must still be committable:"
must_track "docs/images/01-connect.png"          "synthetic mock screenshot"
must_allow "docs/images/99-a-new-screenshot.png" "a screenshot not taken yet"

echo
echo "The project's own files must still be committable:"
# The rules above match a directory shape and media sidecar suffixes precisely so that they
# cannot swallow the repository's own documentation. Proving it beats believing it.
must_track "README.md"                           "the project's own README"
must_track "docs/GUIDE.md"                       "the guide"
must_track "package.json"                        "a project manifest that is not archive.json"

echo
if [ "$FAIL" -eq 0 ]; then
  echo "All ignore rules verified."
else
  echo "Ignore rules are NOT doing what they appear to do. Fix before committing."
fi
exit "$FAIL"
