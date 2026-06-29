#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

printf '%s\n' '== Lint/static checks =='
./scripts/lint.sh
printf '%s\n' '== Build =='
./scripts/build.sh
printf '%s\n' '== Tests =='
./scripts/test.sh
printf '%s\n' '== Documentation invariants =='
test -s README.md
test -s SECURITY.md
test -s docs/README.md
test -s docs/OPERATIONS.md
test -s docs/TESTING.md
printf '%s\n' 'All configured checks passed.'
