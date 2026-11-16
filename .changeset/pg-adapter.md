---
"@stateledger/pg": minor
---

New package: `@stateledger/pg`, a raw-Postgres adapter for backends with no ORM at all.

Two factories, one implementation. `createPgAdapter` takes a node-postgres `Pool` (or an already-checked-out `PoolClient` / `Client`, to join a transaction the caller opened) and owns the BEGIN / COMMIT / ROLLBACK and the connection release itself. `createPostgresJsAdapter` takes a postgres.js instance (or a transaction `sql`, which it joins via a savepoint) and lets `sql.begin()` do that work. Both share the SQL, the advisory locking, the row mapping, and the error translation, so the two drivers cannot drift apart.

Until now, a team on a raw driver had to fabricate a Prisma-shaped or Drizzle-shaped object to get in the door. They no longer do.

Reads and the insert's `RETURNING` go through one explicit projection: every column aliased to the camelCase name the library uses, and `metadata` projected as `::text` and parsed in the adapter. That keeps both drivers on one deterministic path and keeps a postgres.js `transform` from rewriting the keys of the caller's own metadata. The metadata parameter is cast `::text::jsonb` on the way in for the matching reason: postgres.js serializes a parameter with the serializer for the type the server describes it as, so a plain `::jsonb` cast made it apply `JSON.stringify` to an already-encoded string and store a JSON string where an object belonged.

Also exports `STATELEDGER_SCHEMA_STATEMENTS` / `STATELEDGER_SCHEMA_SQL` (the same DDL the other adapters ship) and supports `tableName` and `locking` options, with the table name validated as a plain identifier before it is quoted into the SQL text.
