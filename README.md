# House Notes

House Notes is a small private-network note exchange app. It is designed for a trusted household or office LAN
where people can post notes and replies that update live in open browsers.

It intentionally has no user accounts. Anyone who can reach the running server can read, create, edit, and
delete notes, so run it only on a trusted private LAN or VPN. Do not expose it directly to the public internet.

## Requirements

- Node.js 26 or newer
- npm
- SQLite command-line tool
- Bash and ShellCheck for the local check scripts

## Check

```bash
./scripts/check.sh
```

## Run Locally

```bash
./scripts/run.sh
```

The default URL is:

```text
http://127.0.0.1:3000
```

## Run On A Trusted LAN

```bash
HOST=0.0.0.0 PORT=3000 ./scripts/run.sh
```

Use this only behind a trusted LAN firewall or VPN.

## Data

The default database is `data/canarynotes.sqlite3`. Database files and backups are ignored by Git.

Create a backup:

```bash
./scripts/backup-db.sh
```

Restore a backup:

```bash
./scripts/restore-db.sh backups/example.sqlite3 data/canarynotes.sqlite3 --force
```

Check and prune backups:

```bash
./scripts/maintain-backups.sh
./scripts/maintain-backups.sh backups 14 --prune
```
