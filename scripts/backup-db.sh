#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

usage() {
  printf '%s\n' 'Usage: scripts/backup-db.sh [SOURCE_DB] [BACKUP_DB]'
  printf '%s\n' "Defaults: SOURCE_DB=\${CANARYNOTES_DB:-data/canarynotes.sqlite3}, BACKUP_DB=backups/canarynotes-<utc>.sqlite3"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

source_db="${1:-${CANARYNOTES_DB:-data/canarynotes.sqlite3}}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_db="${2:-backups/canarynotes-${timestamp}.sqlite3}"

if [[ ! -f "$source_db" ]]; then
  printf 'Source database does not exist: %s\n' "$source_db" >&2
  exit 1
fi

if [[ -e "$backup_db" ]]; then
  printf 'Backup destination already exists: %s\n' "$backup_db" >&2
  exit 1
fi

mkdir -p "$(dirname "$backup_db")"
sqlite3 "$source_db" ".backup '$backup_db'"

integrity="$(sqlite3 "$backup_db" 'PRAGMA integrity_check;')"
if [[ "$integrity" != "ok" ]]; then
  printf 'Backup integrity check failed: %s\n' "$integrity" >&2
  exit 1
fi

printf 'Backup created: %s\n' "$backup_db"
