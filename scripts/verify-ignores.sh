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
# Run:  ./scripts/verify-ignores.sh      (also runs in CI on every pull request)

set -uo pipefail
cd "$(dirname "$0")/.."

FAIL=0
TMP=".ignore-check-tmp"
mkdir -p "$TMP"

must_ignore() {
  local path="$1" label="$2"
  mkdir -p "$(dirname "$path")"
  printf 'synthetic test content\n' > "$path"
  if git check-ignore -q "$path"; then
    printf '  ok      %-46s %s\n' "$path" "$label"
  else
    printf '  FAILED  %-46s %s  <-- would be committable\n' "$path" "$label"
    FAIL=1
  fi
  rm -f "$path"
}

must_track() {
  local path="$1" label="$2"
  if git check-ignore -q "$path"; then
    printf '  FAILED  %-46s %s  <-- wrongly ignored\n' "$path" "$label"
    FAIL=1
  else
    printf '  ok      %-46s %s\n' "$path" "$label"
  fi
}

echo "Credentials and personal data must be ignored:"
must_ignore "capture.har"                        "browser capture with live session"
must_ignore "$TMP/nested/debug.har"              "capture in a subfolder"
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
must_ignore "$TMP/child.jpg"                     "photo"
must_ignore "$TMP/child.jpeg"                    "photo"
must_ignore "$TMP/child.heic"                    "photo"
must_ignore "$TMP/clip.mp4"                      "video"
must_ignore "$TMP/clip.mov"                      "video"
must_ignore "Brightwheel Photos/a.jpg"           "default archive folder"

echo
echo "Documentation screenshots must still be committable:"
must_track "docs/images/01-connect.png"          "synthetic mock screenshot"

rm -rf "$TMP"
rmdir "Brightwheel Photos" 2>/dev/null || true

echo
if [ "$FAIL" -eq 0 ]; then
  echo "All ignore rules verified."
else
  echo "Ignore rules are NOT doing what they appear to do. Fix before committing."
fi
exit "$FAIL"
