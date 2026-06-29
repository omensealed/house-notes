# Operations

## Run

Local-only development:

```bash
./scripts/run.sh
```

Trusted LAN/VPN:

```bash
HOST=0.0.0.0 PORT=3000 ./scripts/run.sh
```

Do not expose this app directly to the public internet.

## Backup

```bash
./scripts/backup-db.sh
```

The default database is `data/canarynotes.sqlite3`. The default backup directory is `backups/`.

## Restore

Stop the server before restoring over the active database:

```bash
./scripts/restore-db.sh backups/example.sqlite3 data/canarynotes.sqlite3 --force
```

## Maintain Backups

Dry-run check:

```bash
./scripts/maintain-backups.sh
```

Prune after reviewing the output:

```bash
./scripts/maintain-backups.sh backups 14 --prune
```

Keep at least 14 verified daily backups plus a manual backup before local upgrades or migrations.
