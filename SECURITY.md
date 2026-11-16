# Security policy

stateledger is often wired into payment and ledger paths, so a flaw here can
mean a double capture or a corrupted audit trail rather than just a crash.
Reports are taken seriously, and private disclosure is always welcome.

Please read the response times below before you rely on them. This is a
single-maintainer project, not a vendor with a security team, and the
commitments are written to be ones that can actually be met.

## Supported versions

| Version | Supported |
|---|---|
| 1.x | Yes. Security fixes land here. |
| 0.x | No. These were pre-1.0 releases. Upgrade to 1.x. |

Fixes ship forward on the current minor of 1.x. There are no backport
branches for older 1.x minors, so staying current is part of staying
supported.

Supported runtime is Node 20 or newer, matching the `engines` field on every
package. The Postgres adapters are tested against Postgres 16 in CI.

## Reporting a vulnerability

**Do not open a public issue, pull request, or discussion for a security
issue.**

**Primary channel: GitHub private vulnerability reporting.** Go to the
repository's
[Security tab and report a vulnerability](https://github.com/enowdivine/stateledger/security/advisories/new).
The report stays private between you and the maintainer, the discussion
happens on the advisory itself, and a fix can be prepared and credited there.
This is the preferred route for everything.

**Fallback: `hello@saassimplified.net`.** Use this if private reporting is
unavailable to you or the form is not working. Put "stateledger security" in
the subject line. Email is not encrypted, so keep the first message to enough
detail to confirm there is something real, and move specifics to a private
advisory once one is open.

Either way, a useful report has:

- The affected package and version, and the adapter in use.
- Postgres and Node versions where relevant.
- What an attacker or a concurrent caller can cause, concretely. "Two
  transitions on one subject can both commit" is actionable. "Locking looks
  wrong" is not.
- A reproduction, even a rough one, plus whether the default pessimistic mode
  or `locking: "optimistic"` was configured.

Please leave production data, credentials, and connection strings out of the
report.

## What happens next

- **Acknowledgement within 3 business days.** Usually sooner. If you have
  heard nothing after 3 business days, assume the message got lost and ping
  the other channel.
- **An assessment within 10 business days**: whether it is confirmed, the
  severity, and the intended fix.
- **A fix for a confirmed high-severity issue in the next release**, with a
  published GitHub Security Advisory and a changeset entry. Lower-severity
  issues get folded into normal release work.
- **Credit in the advisory** unless you would rather stay anonymous. Just say
  which you prefer.

There is no bug bounty and no paid disclosure programme. There is also no
on-call rotation, so a report filed on a Friday night is read on Monday.
Teams that need a response commitment stronger than this can arrange one
through [paid support](https://stateledger.saassimplified.net/support).

## In scope

The things worth reporting privately:

- Any way two concurrent transitions on the same `(machine, subjectId)` can
  both commit, defeating the advisory lock or the partial unique index on
  `most_recent`.
- SQL injection through any value the library interpolates, including a
  configured `tableName`, metadata, actor fields, or subject identifiers.
- A transition that commits while its after-callback rolled back, or the
  reverse, since the atomicity of the two is a documented guarantee.
- History or time-travel reads that return another subject's rows, or that
  silently drop rows and so understate an audit trail.
- A path that writes a transition the machine definition does not declare,
  bypassing `InvalidTransition`.
- A vulnerable dependency that actually ships in a published package. Note
  that core has zero runtime dependencies and the adapters take their ORM or
  driver as a peer dependency, so most advisories you will find belong to the
  dev dependency tree, not to anything installed by a user.

## Out of scope

Not security issues, though they may still be worth a normal bug report:

- The in-memory adapter losing state. It is documented as unfit for
  production.
- A hand-rolled transitions table missing the partial unique index on
  `most_recent` or the unique index on `(machine, subject_id, sort_key)`. The
  guarantees are carried by that DDL, which is why the adapters ship it.
- Using `locking: "optimistic"` and not retrying on
  `OptimisticConcurrencyError`. The retry is the caller's job and the error
  exists to prompt it.
- CockroachDB behaving differently under pessimistic locking. It has no
  advisory locks, and the README says to use optimistic mode there.
- Anything that needs database credentials or write access to your
  transitions table to begin with.
- Advisories affecting only dev dependencies or the example apps under
  `examples/`.
