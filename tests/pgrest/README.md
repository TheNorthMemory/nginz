# pgrest tests

Run the complete module suite from the nginz repository:

```sh
bun test tests/pgrest
```

The standard preload builds the local nginz binary. No sibling application
checkout, application credentials, saved settings or app container is needed.
The suite includes mock wire-protocol tests, PostgreSQL integration/security/
serialization tests, nine acquisition-queue tests and twelve delayed-spill
tests against PostgREST 16.4. Available tests run automatically. External-service
suites are optional: missing Docker, a test database or the local PostgREST image
produces explicit Bun skips with a reason, not setup/cleanup failures. The mock
and configuration tests still run. A failed assertion after setup is never
converted to a skip.

## Prerequisites

- The normal nginz build dependencies, including Zig 0.16, Bun and libpq.
- Optional Docker access (directly or through `sudo -n docker`) and a disposable
  PostgreSQL test container. The default name is `pgrest-nginz-test`; override it
  with `PGREST_TEST_CONTAINER`. Tests discover its port, published endpoints,
  container addresses and writable named data volume. No network name, host
  network mode, volume name or mount path is required. A stopped selected fixture
  is started and reused. Local `psql` superuser access inside that fixture is
  required; PostgreSQL 18 is tested. No `nc` dependency is needed.
- Linux `/proc` is needed only for two queue tests that inspect worker lifetime,
  memory and descriptors. Those two cases skip when `/proc` is unavailable;
  the other queue cases still run if PostgreSQL is available.
- Optional local `postgrest/postgrest:v16.4` image. When present, spill starts its
  own temporary PostgREST container with `--pull=never` and configuration supplied
  through environment variables. It removes that container after the tests,
  including failed setup. When the image is absent, spill explicitly skips.
  No `tar`, image export/extraction, host-installed PostgREST binary or host
  PostgREST configuration is used. The existing PostgreSQL named volume is reused
  for all database data; the stateless PostgREST container needs no new volume.
  Host and reachable bridge/custom networks are supported. Docker Desktop uses
  an ephemeral loopback HTTP mapping on the fixture's existing network. Remote
  Docker requires a reachable host/container address; otherwise spill skips.

No test automatically pulls images or reconfigures existing containers, networking
or volumes. Spill owns one temporary PostgREST container. Tests create uniquely
named databases and roles and remove only their own resources. Select a
disposable PostgreSQL test service, never production.

| Environment variable | Default / purpose |
|---|---|
| `PGREST_TEST_CONTAINER` | `pgrest-nginz-test`; explicit disposable PostgreSQL fixture |
| `PGREST_TEST_HOST` | Discover from published ports/container network; override for remote Docker |
| `PGREST_TEST_PORT` | Discover the published/database port; optional host-port override |
| `PGREST_TEST_ADMIN` | `postgres`; local fixture administrator |
| `PGREST_TEST_CONTAINER_PORT` | Container's `psql` default; override a nonstandard server port |
| `PGREST_SPILL_POSTGREST_IMAGE` | `postgrest/postgrest:v16.4`; locally available oracle image, including mirrors |

Invalid explicit host/port settings fail clearly. Missing optional dependencies
are announced once per suite and counted as skipped tests, so test results show
which integration coverage actually ran. Cleanup handles partial setup without
reading logs or deleting resources that were never created.

## Acquisition queue coverage

`pgrest.queue.container.test.js` registers nine normal Bun tests:

1. Queue overflow, disabled queue and zero acquisition timeout.
2. FIFO across locations and newcomers arriving during queue drain.
3. Queued read/write cancellation, including an njs parent.
4. HTTP/2 stream reset without cancelling a sibling stream.
5. Active cancellation, transaction rollback and slot recovery.
6. Thirty slot-release/deadline races around an 80 ms acquisition deadline,
   checking database effects exactly once and recovery after stale timers.
7. Database backend termination with confirmed waiters and reconnection.
8. Graceful reload with six confirmed queued requests.
9. A 60-second saturation test, included in the normal command.

The suite starts its own native nginz process on an ephemeral port and uses
a temporary PostgreSQL database/role. Advisory locks and debug events establish
actual occupancy/admission before faults are injected. HTTP calls are not
retried. The race test reserves one direct PostgreSQL connection through Bun's
built-in SQL client for advisory locks, occupancy probes and each ledger
assertion, avoiding Docker startup per query.
Cleanup stops only this run's nginz and removes only its database/role.
Existing containers and named volumes remain intact.

Reports, configurations and logs are retained privately under
`$XDG_STATE_HOME/nginz/tests/pgrest-queue/<run>/`, or
`~/.local/state/nginz/tests/pgrest-queue/<run>/` by default. The report includes
the binary hash, per-scenario results, latency percentiles and RSS/descriptor/
database-connection samples. Set `PGREST_QUEUE_SOAK_SECONDS` to 60–3600 to
extend the load test. The per-test deadline scales with that duration; the race
test targets about four seconds locally and has its original 90-second test
deadline.

The soak guards gross leaks/stalls with a stable worker, one database slot,
at most 16 MiB RSS growth after warm-up, at most two additional descriptors and
p99 below two seconds. It is bounded regression coverage, not a throughput
benchmark or long-duration production qualification.

## Subrequest coverage

`pgrest.subrequest.container.test.js` uses the same optional PostgreSQL fixture,
an isolated database/role and its own nginz process on an ephemeral port. Seven
cases cover repeated CRUD/RPC in one njs parent on a keep-alive connection,
parallel siblings and transaction-local request context, SQL and committed
response-setting errors followed by recovery, HEAD success/error statuses,
SSI and auth bodies, background mirrors and detached njs writes. Background
writes must complete exactly once even when the client closes after receiving
the parent response. Worker logs are checked for lifetime and header alerts.

No PostgREST image is required for these cases. Missing PostgreSQL prerequisites
produce explicit skips; setup/assertion errors with available prerequisites
fail. Cleanup stops only this run's process and drops its database and role.
Configurations and logs remain private under
`$XDG_STATE_HOME/nginz/tests/pgrest-subrequest/<run>/` (default
`~/.local/state/nginz/tests/pgrest-subrequest/`).

## Delayed spill coverage

`pgrest.spill.container.test.js` runs twelve cases covering native preference,
the acquisition deadline, full/disabled queues, rewritten requests and bodies,
JWT isolation, methods and response headers, committed-write errors, backup
failure/exhaustion, redirect loops, parent/subrequest lifetimes, cancellation,
HTTP/2, twenty deadline races and graceful reload. HTTP calls are not retried.
SQL effects prove writes execute once; worker logs must contain no lifetime or
open-socket alerts. The backup exhaustion case holds both pool slots with
advisory locks until PostgREST returns its acquisition timeout, then checks that
the rejected write never executes after release. Native blocker requests use a
separate 10-second I/O timeout to allow fixture coordination; ordinary routes
use two seconds and the explicit I/O timeout case uses 60 ms.

Reports live under `$XDG_STATE_HOME/nginz/tests/pgrest-spill/`
(default `~/.local/state/nginz/tests/pgrest-spill/`). Cleanup stops only this
run's nginz, removes its own PostgREST container and drops its own database and
role. The selected PostgreSQL fixture and named volumes are retained. Cleanup
does not depend on setup having reached container startup or log creation.
