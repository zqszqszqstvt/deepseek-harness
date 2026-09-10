#!/usr/bin/env bash
# Retention for Server workspaces. Dry-run by default; --apply deletes.
#
#   ./workspace-gc.sh --data-dir /var/lib/dsh/server-data --older-than-days 14
#   ./workspace-gc.sh --data-dir /var/lib/dsh/server-data --apply
#
# Only two kinds of harness-owned artifact are ever pruned, because the Server
# keeps no retention policy of its own:
#
#   <workspace>/.cache/**       package caches the contract tells agents to create
#   <workspace>/.dsh/spill/**   truncated command output and oversized tool results
#
# Nothing else is touched: no .venv, no .pylibs, no user file. Deleting a .venv
# would break work in progress, so capacity control for those belongs to a
# filesystem quota on the data volume (see the deployment README).
set -uo pipefail

DATA_DIR=""
DAYS=14
APPLY=0
TOP=20
while [ $# -gt 0 ]; do
  case "$1" in
    --data-dir) DATA_DIR="${2:?--data-dir needs a value}"; shift 2 ;;
    --older-than-days) DAYS="${2:?--older-than-days needs a value}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --top) TOP="${2:?--top needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$DATA_DIR" ] || { echo "--data-dir is required" >&2; exit 2; }
[ -d "$DATA_DIR" ] || { echo "no such data directory: $DATA_DIR" >&2; exit 2; }

# Every workspace the Server created: users/<sha>/workspace and
# users/<sha>/projects/<sha>/workspace (packages/bundle/server/src/project-session.ts).
mapfile -t WORKSPACES < <(find "$DATA_DIR/users" -mindepth 2 -maxdepth 4 -type d -name workspace 2>/dev/null | sort)
if [ "${#WORKSPACES[@]}" -eq 0 ]; then
  echo "no workspaces under $DATA_DIR/users"
  exit 0
fi

echo "data directory : $DATA_DIR"
echo "workspaces     : ${#WORKSPACES[@]}"
echo "prune targets  : .cache/**, .dsh/spill/**  older than $DAYS day(s)"
echo "mode           : $([ "$APPLY" -eq 1 ] && echo APPLY || echo 'dry run (pass --apply to delete)')"
echo

freed=0
for ws in "${WORKSPACES[@]}"; do
  for target in "$ws/.cache" "$ws/.dsh/spill"; do
    [ -d "$target" ] || continue
    size=$(du -sm --apparent-size "$target" 2>/dev/null | cut -f1)
    found=$(find "$target" -type f -mtime "+$DAYS" 2>/dev/null | wc -l)
    [ "${found:-0}" -eq 0 ] && continue
    printf '%-8s %-40s %6s MB, %s file(s)\n' \
      "$([ "$APPLY" -eq 1 ] && echo DELETE || echo would)" "${target#"$DATA_DIR"/}" "${size:-0}" "$found"
    if [ "$APPLY" -eq 1 ]; then
      find "$target" -type f -mtime "+$DAYS" -print0 2>/dev/null | xargs -0 -r rm -f
      find "$target" -mindepth 1 -type d -empty -delete 2>/dev/null
      freed=$((freed + ${size:-0}))
    fi
  done
done

echo
echo "largest workspaces (du -sh, whole workspace including .venv and user files):"
du -sh "${WORKSPACES[@]}" 2>/dev/null | sort -rh | head -n "$TOP" | sed 's/^/  /'
echo
printf 'total data directory: %s\n' "$(du -sh "$DATA_DIR" 2>/dev/null | cut -f1)"
if [ "$APPLY" -eq 1 ]; then
  printf 'freed (cache + spill only): %s MB\n' "$freed"
else
  echo "dry run deleted nothing."
fi
