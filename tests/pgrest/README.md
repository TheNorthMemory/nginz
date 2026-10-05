# pgrest tests

Run the complete module suite from the nginz repository:

```sh
bun test tests/pgrest
```

The standard preload builds the local nginz binary. No sibling application
checkout, application credentials, saved settings or app container is needed.
The suite includes mock wire-protocol tests, PostgreSQL integration/security/
serialization tests, nine acquisition-queue tests and twelve delayed-spill
tests against PostgREST 16.4. All run by default.

## Prerequisites

- The normal nginz build dependencies, including Zig 0.16, Bun and libpq.
- Linux for the queue suite's `/proc` worker, memory and descriptor checks.
- Docker access (directly or through the existing `sudo -n docker` fallback).
- The existing PostgreSQL test container `pgrest-nginz-test`, exposing port
  5432 on localhost, with a named data volume and local `postgres` superuser
  access via `docker exec ... psql -U postgres`. PostgreSQL 18 is the tested
  version. Retain the fixture and its volume between runs; start it if stopped.
- `nc`, used by the existing PostgreSQL integration readiness check.
- The locally pulled `postgrest/postgrest:v16.4` image and `tar`. The spill suite
  extracts that image's static binary and runs it inside the existing PostgreSQL
  fixture, using a private temporary directory in its named `pg18` volume.
  No additional container, application checkout or supervisor is required.
  The existing fixture uses host networking for loopback access.

Missing infrastructure fails the suite explicitly. There is no opt-in or silent
skip for real-database or queue tests. Fixture SQL creates disposable users and
databases; use a test PostgreSQL service, never a production database.

## Acquisition queue coverage

`pgrest.queue.container.test.js` registers nine normal Bun tests:

1. Queue overflow, disabled queue and zero acquisition timeout.
2. FIFO across locations and newcomers arriving during queue drain.
3. Queued read/write cancellation, including an njs parent.
4. HTTP/2 stream reset without cancelling a sibling stream.
5. Active cancellation, transaction rollback and slot recovery.
6. Thirty slot-release/deadline races, checking database effects exactly once.
7. Database backend termination with confirmed waiters and reconnection.
8. Graceful reload with six confirmed queued requests.
9. A 60-second saturation test, included in the normal command.

The suite starts its own native nginz process on an ephemeral port and uses
a temporary PostgreSQL database/role. Advisory locks and debug events establish
actual occupancy/admission before faults are injected. HTTP calls are not
retried. Cleanup stops only this run's nginz and removes only its database/role.
Existing containers and named volumes remain intact.

Reports, configurations and logs are retained privately under
`$XDG_STATE_HOME/nginz/tests/pgrest-queue/<run>/`, or
`~/.local/state/nginz/tests/pgrest-queue/<run>/` by default. The report includes
the binary hash, per-scenario results, latency percentiles and RSS/descriptor/
database-connection samples. Set `PGREST_QUEUE_SOAK_SECONDS` to 60–3600 to
extend the load test. The per-test deadline scales with that duration; the race
test has its own 90-second deadline.

The soak guards gross leaks/stalls with a stable worker, one database slot,
at most 16 MiB RSS growth after warm-up, at most two additional descriptors and
p99 below two seconds. It is bounded regression coverage, not a throughput
benchmark or long-duration production qualification.

## Delayed spill coverage

`pgrest.spill.container.test.js` runs twelve cases covering native preference,
the acquisition deadline, full/disabled queues, rewritten requests and bodies,
JWT isolation, methods and response headers, committed-write errors, backup
failure/exhaustion, redirect loops, parent/subrequest lifetimes, cancellation,
HTTP/2, twenty deadline races and graceful reload. HTTP calls are not retried.
SQL effects prove writes execute once; worker logs must contain no lifetime or
open-socket alerts. Reports live under `$XDG_STATE_HOME/nginz/tests/pgrest-spill/`
(default `~/.local/state/nginz/tests/pgrest-spill/`). Cleanup terminates only the
fixture's own PostgREST process and removes its own database, role and temporary
volume directory. The existing container and named volume are retained.
