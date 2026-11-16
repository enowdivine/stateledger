---
"@stateledger/prisma": patch
"@stateledger/drizzle": patch
---

Reject a `tableName` longer than 63 characters instead of silently addressing a different table.

Postgres does not error on an over-long identifier. It truncates to `NAMEDATALEN - 1`, which is 63 bytes, with no error and no warning. So a 70-character `tableName` was accepted and quietly operated on its own first 63 characters. The sharper edge is that two configured names sharing a 63-character prefix resolve to the same physical table, so a per-tenant-table layout would mix tenants together with nothing anywhere reporting a problem.

The identifier whitelist now carries a length bound alongside the character pattern. Both are checked before any statement reaches the wire, and a violation throws `AdapterError` naming the actual length.
