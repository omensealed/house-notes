#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

usage() {
  printf '%s\n' 'Usage: scripts/maintain-backups.sh [BACKUP_DIR] [KEEP_COUNT] [--prune]'
  printf '%s\n' 'Defaults: BACKUP_DIR=backups, KEEP_COUNT=14'
  printf '%s\n' 'Without --prune, the script checks backups and reports old files without deleting them.'
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

backup_dir="${1:-backups}"
keep_count="${2:-14}"
mode="${3:-}"

if [[ "$mode" != "" && "$mode" != "--prune" ]]; then
  usage >&2
  exit 2
fi

if ! [[ "$keep_count" =~ ^[0-9]+$ ]] || (( keep_count < 1 )); then
  printf 'KEEP_COUNT must be a positive integer: %s\n' "$keep_count" >&2
  exit 2
fi

if [[ ! -d "$backup_dir" ]]; then
  printf 'Backup directory does not exist: %s\n' "$backup_dir" >&2
  exit 1
fi

mapfile -d '' -t backups < <(find "$backup_dir" -maxdepth 1 -type f -name '*.sqlite3' -printf '%T@ %p\0' | sort -z -rn | cut -z -d' ' -f2-)

if (( ${#backups[@]} == 0 )); then
  printf 'No SQLite backups found in: %s\n' "$backup_dir"
  exit 0
fi

for backup in "${backups[@]}"; do
  if ! integrity="$(sqlite3 "$backup" 'PRAGMA integrity_check;' 2>&1)"; then
    printf 'Backup integrity check failed: %s: %s\n' "$backup" "$integrity" >&2
    exit 1
  fi
  if [[ "$integrity" != "ok" ]]; then
    printf 'Backup integrity check failed: %s: %s\n' "$backup" "$integrity" >&2
    exit 1
  fi
done

printf 'Verified backups: %s\n' "${#backups[@]}"

if (( ${#backups[@]} <= keep_count )); then
  printf 'No pruning needed; keeping %s most recent backup(s).\n' "$keep_count"
  exit 0
fi

old_backups=("${backups[@]:keep_count}")

if [[ "$mode" != "--prune" ]]; then
  printf 'Would prune %s old backup(s). Rerun with --prune to delete them.\n' "${#old_backups[@]}"
  printf '%s\n' "${old_backups[@]}"
  exit 0
fi

for backup in "${old_backups[@]}"; do
  rm -- "$backup"
  printf 'Pruned backup: %s\n' "$backup"
done
