---
"@stateledger/drizzle": patch
---

Two fixes for `@stateledger/drizzle`, both found by finally running the adapter against `drizzle-orm/postgres-js`. Until now only the `drizzle-orm/node-postgres` flavour was ever tested, while the package advertised support for any Drizzle Postgres driver.

**`stateAt()` threw on `drizzle-orm/postgres-js`.** The whole time-travel API was unusable on that driver, and had been since the feature shipped in v0.2.0. `readStateAt` bound the cutoff as a raw JS `Date`. node-postgres serializes Dates itself, so it worked there. postgres.js asks the server to describe the parameter and then applies its own serializer for the returned OID, and that serializer wants a string: it threw `TypeError: The "string" argument must be of type string or an instance of Buffer or ArrayBuffer. Received an instance of Date`, which the adapter wrapped as a generic `readStateAt failed`. The cutoff is now bound as an ISO string and cast server-side, so both flavours send the same bytes and Postgres does the conversion. `toISOString()` is always UTC, so the cutoff is an instant and cannot be reinterpreted in a session-local timezone.

**The documented usage did not typecheck.** `createDrizzleAdapter(drizzle(pool))`, the form in this package's README and in every example, was rejected by TypeScript against drizzle-orm 0.36. `DrizzleExecutor` declared `execute<T = unknown>(query: any): Promise<T>`, which promises a method returning whatever the caller asks for, and no real Drizzle client can satisfy that: node-postgres returns a fixed `QueryResult`, postgres.js a `RowList`. The contract is now stated honestly as `execute(query: any): Promise<unknown>`, which is all the adapter ever needed, since results are normalised internally either way. Runtime behaviour is unchanged and the accepted input shape only widens.

Both are now covered permanently: the shared contract suite runs against postgres.js as well as node-postgres, and each package's `tsconfig.json` includes `test` so the examples in the test files are typechecked rather than merely compiled by vitest at runtime.
