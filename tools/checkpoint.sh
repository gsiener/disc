#!/usr/bin/env bash
# Periodic source snapshots, so a run that dies mid-flight never loses work.
#
#   tools/checkpoint.sh once          # take one snapshot now
#   tools/checkpoint.sh watch [secs]  # snapshot on change, default every 180s
#   tools/checkpoint.sh list          # what we have
#   tools/checkpoint.sh restore <f>   # unpack a snapshot into ./restored/
#
# Deliberately does NOT touch git. Agents run git commands themselves (one has
# already run `git stash` mid-task and wiped the working tree), so anything that
# moves HEAD, the index or the stash can collide with them. A tar in a directory
# cannot. Snapshots are gitignored.
set -euo pipefail
cd "$(dirname "$0")/.."

DIR=.snapshots
KEEP=${KEEP:-40}
PATHS=(src tools docs index.html package.json package-lock.json tsconfig.json vite.config.ts BRIEF.md README.md .github)

mkdir -p "$DIR"

# Hash of every tracked-ish source file's content, so we only snapshot on change.
fingerprint() {
  find "${PATHS[@]}" -type f \
    ! -path '*/node_modules/*' ! -name '*.tgz' -print0 2>/dev/null \
  | sort -z | xargs -0 shasum -a 1 2>/dev/null | shasum -a 1 | cut -d' ' -f1
}

snap() {
  local fp stamp out last
  fp=$(fingerprint)
  last=$(cat "$DIR/.last" 2>/dev/null || echo none)
  if [ "$fp" = "$last" ] && [ "${1:-}" != force ]; then
    return 1
  fi
  stamp=$(date +%Y%m%d-%H%M%S)
  out="$DIR/$stamp.tgz"
  tar czf "$out" --exclude=node_modules --exclude='*.tgz' "${PATHS[@]}" 2>/dev/null || true
  echo "$fp" > "$DIR/.last"
  printf '%s  %s  (%s)\n' "$(date '+%H:%M:%S')" "$out" "$(du -h "$out" | cut -f1)"
  # Prune oldest beyond KEEP.
  ls -1t "$DIR"/*.tgz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
  return 0
}

case "${1:-once}" in
  once)  snap force ;;
  watch)
    every=${2:-180}
    echo "checkpointing every ${every}s into $DIR (keeping $KEEP) — ctrl-c to stop"
    snap force
    while true; do
      sleep "$every"
      snap || true
    done
    ;;
  list)
    ls -1t "$DIR"/*.tgz 2>/dev/null | while read -r f; do
      printf '%s  %6s  %s\n' "$(basename "$f" .tgz)" "$(du -h "$f" | cut -f1)" \
        "$(tar tzf "$f" 2>/dev/null | wc -l | tr -d ' ') files"
    done || echo "no snapshots yet"
    ;;
  restore)
    [ -n "${2:-}" ] || { echo "usage: checkpoint.sh restore <name-or-path>"; exit 2; }
    f="$2"; [ -f "$f" ] || f="$DIR/${2%.tgz}.tgz"
    [ -f "$f" ] || { echo "no such snapshot: $2"; exit 2; }
    rm -rf restored && mkdir -p restored && tar xzf "$f" -C restored
    echo "unpacked $f -> ./restored/  (diff it before copying anything back)"
    ;;
  *) echo "usage: checkpoint.sh [once|watch [secs]|list|restore <name>]"; exit 2 ;;
esac
