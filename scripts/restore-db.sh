#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

usage() {
  printf '%s\n' 'Usage: scripts/restore-db.sh BACKUP_DB [TARGET_DB] [--force]'
  printf '%s\n' "Default TARGET_DB: \${CANARYNOTES_DB:-data/canarynotes.sqlite3}"
  printf '%s\n' 'When TARGET_DB exists, --force is required and a pre-restore backup is created first.'
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

backup_db="${1:-}"
target_db="${2:-${CANARYNOTES_DB:-data/canarynotes.sqlite3}}"
force="${3:-}"

if [[ -z "$backup_db" ]]; then
  usage >&2
  exit 2
fi

if [[ "$force" != "" && "$force" != "--force" ]]; then
  usage >&2
  exit 2
fi

if [[ ! -f "$backup_db" ]]; then
  printf 'Backup database does not exist: %s\n' "$backup_db" >&2
  exit 1
fi

integrity="$(sqlite3 "$backup_db" 'PRAGMA integrity_check;')"
if [[ "$integrity" != "ok" ]]; then
  printf 'Backup integrity check failed: %s\n' "$integrity" >&2
  exit 1
fi

if [[ -e "$target_db" && "$force" != "--force" ]]; then
  printf 'Target database exists; rerun with --force after stopping the server: %s\n' "$target_db" >&2
  exit 1
fi

mkdir -p "$(dirname "$target_db")"

if [[ -e "$target_db" ]]; then
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  safety_backup="backups/pre-restore-${timestamp}.sqlite3"
  ./scripts/backup-db.sh "$target_db" "$safety_backup" >/dev/null
  printf 'Pre-restore backup created: %s\n' "$safety_backup"
fi

cp "$backup_db" "$target_db"
printf 'Restored database: %s\n' "$target_db"
