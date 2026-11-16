---
"@stateledger/typeorm": minor
---

New package: `@stateledger/typeorm`, a Postgres adapter driven by TypeORM.

`createTypeormAdapter` accepts either a `DataSource` (the adapter opens its own transactions) or a transaction-scoped `EntityManager` (the adapter joins the transaction the caller already opened, which is the common case inside a NestJS service). Both routes guarantee that the `pg_advisory_xact_lock` and the insert it protects run on the same pooled connection.

Peer range is `typeorm >=0.3`, covering both the 0.3.x installed base and the 1.x line. The transitions table is created from `STATELEDGER_SCHEMA_STATEMENTS` / `STATELEDGER_SCHEMA_SQL` rather than from an entity class, so `synchronize: true` and `migration:generate` leave it alone. Passes the shared `@stateledger/core/contract-tests` suite against a real Postgres.
