#!/usr/bin/env bash
set -euo pipefail

PACKAGES=(git curl jq ripgrep fd unzip base-devel nodejs npm bash shellcheck sqlite)

if ! command -v pacman >/dev/null 2>&1; then
  printf '%s\n' 'This helper targets CachyOS/Arch Linux and could not find pacman.' >&2
  exit 1
fi

printf '%s\n' 'Recommended official-repository packages:'
printf '  sudo pacman -S --needed'
printf ' %q' "${PACKAGES[@]}"
printf '\n\n'

if [[ "${1:-}" == "--install" ]]; then
  printf '%s\n' 'System package installation requires human sudo approval.'
  sudo pacman -S --needed "${PACKAGES[@]}"
else
  printf '%s\n' 'No packages were installed. Re-run with --install after reviewing the command.'
fi

printf '\n%s\n' 'Project-level setup commands to review/run after system packages:'
printf '%s\n' 'No project setup command has been finalized yet.'
