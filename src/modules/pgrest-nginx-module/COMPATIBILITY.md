# PostgREST 16.4 compatibility

The module targets interchangeable database API behavior with PostgREST 16.4,
including reads and commands. Compatibility remains partial: supported behavior
and unresolved features are listed below. Each request executes once; never
mirror commands or replay an uncertain write on another engine.

## Running module tests

From the nginz checkout:

```sh
bun test tests/pgrest
```

The normal test preload builds nginz. The suite includes mock-protocol tests,
real PostgreSQL integration/security/serialization tests, and all nine acquisition
queue scenarios. No application checkout, credentials, configuration, container
or saved settings are required. See [test prerequisites](../../../tests/pgrest/README.md).
The real-database tests use the existing `pgrest-nginz-test` PostgreSQL fixture
at 127.0.0.1:5432; retain its named data volume. Queue tests run a dedicated local
nginz process on an ephemeral port, create their own temporary database and role,
and stop/drop only resources created by that test run.

The queue suite records private reports and logs under
`$XDG_STATE_HOME/nginz/tests/pgrest-queue/<run>/`, defaulting to
`~/.local/state/nginz/tests/pgrest-queue/<run>/`. Its 60-second saturation test
runs by default, with no opt-in flag. `PGREST_QUEUE_SOAK_SECONDS` may extend
that duration to at most 3,600 seconds. Tests fail when required infrastructure
is unavailable; they do not silently skip queue or database coverage.

The synthetic SQL definitions in `tests/pgrest/postgrest-fixture.mjs` are also
available to downstream differential audits. Application catalogs, business
workflows and deployment evidence belong to those applications; passing them
does not establish universal module compatibility.

## Implemented corrections

| Area | Candidate behavior |
| --- | --- |
| Query/form decoding | Decode percent escapes and `+` once, including names; preserve malformed escapes as 16.4 does. Last ordinary duplicate wins; variadic occurrences accumulate. Values bind to the declared database type. |
| Function resolution | Match supplied names against required/default arguments, support INOUT and variadic signatures, reject unknown arguments with PGRST202 and ambiguous type overloads with 300/PGRST203. Long error argument lists use checked request-pool storage. |
| JSON arguments | Bind the original document and use catalog-directed PostgreSQL decoding. Preserve exact bigint/decimal tokens, SQL/JSON arrays, objects, null and omitted defaults. Large RPC values use request-pool storage, not a 2k/4k local ceiling. |
| Typed results | PostgreSQL serializes scalar, set, composite, domain, array, numeric, boolean and null values. Scalars are unwrapped by default; void returns 204. |
| Request transaction | Explicit BEGIN; GET/HEAD and stable/immutable RPC POST are read-only. Volatile GET is permitted inside a read-only transaction. Set role/identity/context locally; discard any non-idle connection on release. |
| Rejected writes | Singular, max-affected and serialization checks occur before COMMIT. Failed statements and rejected writes roll back. Deferred constraints are checked by asynchronous COMMIT before sending success. |
| Counts | Exact-count JSON RPC materializes the function result once; count and page derive from it. Counted volatile commands are not executed twice. Exact table JSON count and data share one statement snapshot. |
| Standard context | Supply request.jwt.claims, method, path, headers and cookies while retaining raw request.jwt for existing SQL. Settings cannot leak to the next pool user. |
| SQL errors | Match SQLSTATE HTTP mapping and code/message/details/hint, including PT statuses, permission errors and structured PGRST raises. Escape JSON control bytes. |
| SQL response settings | Validate response.status/response.headers, honor status and headers including Content-Type/Content-Range, and attach successful overrides after commit. |
| HTTP representation | Correct scalar and singular media types, minimal mutation defaults, explicit representation, POST RPC ranges, empty ranges, counted out-of-bounds PGRST103 and scalar max-affected PGRST128. |
| Pool acquisition | Bounded FIFO waiting using nginx events, no polling and no SQL retries; expiry/overflow use 504/PGRST003. |

Two oracle behaviors merit special care. Query text containing `%00` is
truncated at NUL by PostgREST 16.4's text parameter transport; the candidate
matches this for values and rejects NUL identifiers. Also, PostgREST **commits
before rejecting malformed SQL response.status/response.headers** with
PGRST111/112. The candidate deliberately matches this; an HTTP 500 is not proof
that a command had no effect. Deferred COMMIT errors suppress custom success
headers. Tests inspect final rows, not just matching HTTP errors.

## Queue and request lifetime

```nginx
pgrest_pool_size 6;
pgrest_pool_acquisition_timeout 10s;  # default; acquisition only
pgrest_pool_queue_size 128;          # default; 0 disables waiting
```

Pools remain per worker, keyed by complete DSN plus pool size. Two workers with
six slots each have at most twelve active queries for that pool; pending HTTP
requests can wait. There is no cross-worker borrowing. Size remains 1–32 and
queue size is 0–4096. Queue capacity limits admission against the shared pool's
waiter count; use consistent caps for locations sharing a pool. An acquisition
timeout can vary by location. A full or disabled queue returns 504/PGRST003
immediately. The DB I/O timeout is separate.

The queue regression is `tests/pgrest/pgrest.queue.container.test.js`, discovered
by the standard command above. A one-worker, one-slot pool and an external
advisory lock establish occupancy; debug queue events prove admission before a
fault is injected, and a SQL ledger checks order and side effects.

| Scenario | Required result |
| --- | --- |
| Queue cap, queue size 0, acquisition timeout 0 | 504/PGRST003; rejected writes never execute |
| FIFO across locations and arrivals during drain | Committed order preserves admitted order, including newcomers |
| Queued reads/writes and njs parent disconnect | Waiters removed before the busy slot is released; cancelled writes absent |
| HTTP/2 RST_STREAM | Cancelled waiter removed; sibling stream still succeeds |
| Active client cancellation | Unfinished transaction rolls back; next waiter can acquire immediately |
| Thirty slot-release/deadline races | Both 200 and 504 outcomes; database effects match each response exactly once; recovery works |
| PostgreSQL backend termination with waiters | Active request fails and rolls back; queued work reconnects and succeeds |
| Graceful reload with six confirmed waiters | Old worker drains FIFO and exits; new worker serves requests |
| Sustained saturation after warm-up | No request failures, worker replacement or unbounded RSS/descriptor/connection growth; bounded p99 |

This suite exposed missing disconnect monitoring/HTTP cleanup. The fix uses
nginx's protocol-aware abort handler and registers cleanup before asynchronous
work. Cleanup removes queued timers and posted callbacks before request-pool
memory can be freed, and closes an active libpq connection to roll back pending
work. Request-count holds alone do not protect against forced HTTP termination.

These are bounded regression tests. HTTP/3 aborts, a whole-server PostgreSQL
outage and long-duration production behavior remain outside this suite.
Cancellation checks prove pre-dispatch cancellation and rollback of deliberately
blocked active transactions. A transport failure after commit cannot establish
non-commit; never replay an uncertain write automatically.

## Rollout and remaining scope

This changes wire behavior: typed fields replace stringified numbers/booleans,
scalar unwrapping defaults on, mutations default to minimal responses, and SQL
errors expose PostgREST details instead of the old sanitized error object.
Explicit `pgrest_json_scalar off` retains the legacy scalar wrapper and is not
the tested compatibility profile. Applications must verify their own API and
identity contracts when upgrading the module or changing database gateways.

Universal PostgREST parity is **not yet established**. Remaining general areas
include transaction preferences, default-primary-key upsert inference, computed
and view relationships, RPC/mutation embedding, spread/null-embed grammar,
custom media handlers and binary edge cases, estimated-count thresholds,
role/function transaction settings, schema-cache reload semantics, full OpenAPI
and authentication configuration, and exact fuzzy error hints/transport errors.
Table writes and query grammar also retain the explicit parser/size limits in
README. These are not exceptions to the target; they need oracle cases and
implementation before advertising arbitrary PostgREST API compatibility.

Add module regressions when expanding the supported protocol surface. Applications
should also test their own endpoint contracts and database effects through both
engines; application tests supplement the public module suite.
