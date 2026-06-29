#!/usr/bin/env bash
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit
failures=0

version_for() {
  "$1" --version 2>&1 | head -n 1 || true
}

check_required() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    printf '[ok]   %-16s %s\n' "$name" "$(version_for "$name")"
  else
    printf '[miss] %-16s required\n' "$name"
    failures=$((failures + 1))
  fi
}

printf 'Project: %s\n' 'House Notes'
printf 'Kernel:  %s\n' "$(uname -srmo)"
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  printf 'OS:      %s\n' "${PRETTY_NAME:-unknown}"
fi
printf '\nRequired toolchain:\n'
check_required git
check_required curl
check_required rg
check_required node
check_required npm
check_required bash
check_required shellcheck
check_required sqlite3

printf '\nRepository:\n'
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf '[ok]   git repository (%s)\n' "$(git branch --show-current 2>/dev/null || true)"
  if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    printf '[note] working tree has uncommitted changes\n'
  fi
else
  printf '[miss] git repository not initialized\n'
  failures=$((failures + 1))
fi

if (( failures > 0 )); then
  printf '\n%d required item(s) are missing. See docs/04-DEVELOPMENT-ENVIRONMENT.md.\n' "$failures"
  exit 1
fi
printf '\nEnvironment check passed; optional integrations may still be deferred.\n'
