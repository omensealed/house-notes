# Security

House Notes is for trusted private LAN/VPN use. The app intentionally has no accounts, so network reachability is
the access boundary.

Current controls include request size caps, input validation, HTML escaping, parameterized SQLite queries,
tested backup/restore, and backup integrity checks.

Keep database files, backups, logs, and `.env` files private.
