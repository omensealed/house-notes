# Testing

Run the full local gate:

```bash
./scripts/check.sh
```

Focused commands:

```bash
node --test tests/notes.test.js
node --test tests/server-smoke.test.js
node --test tests/backup-restore.test.js
```

The default tests use temporary databases and do not require external services.
