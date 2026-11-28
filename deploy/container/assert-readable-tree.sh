#!/bin/sh
# assert-readable-tree.sh [--root-owned] PATH...
# Fails an image build when an image's code tree depends on who runs it: every path under the
# given ones must be readable by any uid and every directory traversable by any uid. With
# --root-owned, nothing there may be owned by anyone but root or writable by group or others,
# so the user the image runs as cannot change its own code. Prints each offending path.
set -eu
root_owned=false
if [ "${1:-}" = --root-owned ]; then root_owned=true; shift; fi
[ "$#" -gt 0 ] || { echo 'assert-readable-tree.sh: name the trees to check' >&2; exit 64; }
bad=$(find "$@" ! -type l \( ! -perm -0004 -o \( -type d ! -perm -0001 \) \) -print)
if $root_owned; then
  bad="$bad$(find "$@" ! -type l \( ! -user 0 -o -perm -0020 -o -perm -0002 \) -print)"
fi
if [ -n "$bad" ]; then
  echo 'These paths would depend on the uid that runs this image:' >&2
  printf '%s\n' "$bad" | sort -u >&2
  exit 1
fi
