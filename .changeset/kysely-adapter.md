---
"@stateledger/kysely": minor
---

New package: `@stateledger/kysely`, a Postgres adapter driven by [Kysely](https://kysely.dev).

`createKyselyAdapter(db)` takes a `Kysely` instance and opens its own transactions, or takes a `Transaction` and joins the one the caller already opened. Same guarantees as the Prisma and Drizzle adapters: `pg_advisory_xact_lock` per `(machine, subjectId)` in the default pessimistic mode, the partial unique index on `most_recent` translating a lost race into `OptimisticConcurrencyError` in optimistic mode, and the full `@stateledger/core/contract-tests` suite passing against a real Postgres.

Everything runs through the `sql` template tag, so the transitions table does not have to appear in your `Database` interface, and reads are written to come back identical whether or not your client has `CamelCasePlugin` installed.
