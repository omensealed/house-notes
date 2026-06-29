#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
: "${CANARYNOTES_DB:=data/canarynotes.sqlite3}"
export CANARYNOTES_DB
exec node src/http/server.js
