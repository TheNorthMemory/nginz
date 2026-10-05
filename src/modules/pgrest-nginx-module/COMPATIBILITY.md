# PostgREST 16.4 compatibility

The target is interchangeable database API execution, including commands:
route an individual request to either engine without a per-RPC allowlist or a
read/write split. Each request executes once. Never mirror writes or replay an
uncertain write on the other engine.

**The candidate passes the current Carve/Duell public API and protocol audit.**
This is not certification of every PostgREST feature. The broader gaps below
remain explicit. The old Duell read-cohort proposal is superseded as a target;
no candidate binary or PostgREST topology has been deployed to beta.

## Reproduction and evidence

Build from `nginz`, then run the audit from the sibling `duell` checkout:

```sh
zig build -Doptimize=ReleaseSmall
zig build test -Doptimize=ReleaseSmall
# In ../duell:
PGREST_COMPATIBILITY_STRICT=1 npm run backend:test:postgrest-compatibility
```

The runner is `duell/backend/test/postgrest-compatibility.mjs`; the independent
SQL protocol fixture is `nginz/tests/pgrest/postgrest-fixture.mjs`. It compares:

1. Unchanged beta image `registry.cn-shanghai.aliyuncs.com/darkanchor/nginz:1.30`,
   image ID `17a8528eb4c666624e7cb1c51b489982a4ad38a7b59651349622586ff23573d5`.
2. The locally built candidate with its executable/dependency hashes recorded.
   Its host-built library closure is carried in the test volume; it is distinct
   from the beta image's executable.
3. `postgrest/postgrest:v16.4`, verified using `--version`, as behavioral oracle.

Source study uses `/home/kaiwu/Documents/github/postgrest` (`Plan.hs`, `Query.hs`,
`Error.hs` and the vendored Hasql pool). That checkout need not be the image's
exact revision: disputed behavior is checked against the pinned executable.

All container runtime files use the existing `nginz_test_runtime` named volume.
PostgreSQL reuses `pgrest-nginz-test` and its named data volume. The runner reuses
`duell-postgrest-nginz-pilot`, `duell-postgrest-pilot` and
`duell-postgrest-nginz-candidate`, refusing already-running fixtures. It stops
only fixtures it started, removes only its temporary databases/roles, and
retains containers/volumes. It changes no beta service.

Reports live under
`~/.local/state/duell/local/evidence/postgrest-compatibility/<run>/report.json`.
`status: completed` only means the run finished; require
`acceptance.interchangeable: true` and `cleaned: true`. The report retains status,
body, selected headers, catalog signatures, workflow coverage and cleanup.
JSON object ordering is ignored and UTF-8 charset spelling is normalized.
Generated IDs/timestamps are not stripped to manufacture equality: workflows
assert their semantics on separate clones and then on a shared database.

The 2026-10-05 run `20261005064735719-142640` passed 2,397 checks and 180 direct
comparisons with **zero status/body differences and zero selected-header
differences**. Candidate SHA-256:
`cca79070b9e2770fabd4a3dd8cb5153c205691cc4cc8ad14361876f7c6a98405`.
All 318 tests in `ZIG_OPTIMIZE=ReleaseSmall bun test tests/pgrest` passed,
including real-PostgreSQL security/serialization suites and the updated wire
mock fixtures. Zig unit tests, Duell `npm run check` and
`npm run backend:check` also passed. The run cleaned its temporary databases and
roles, left all three pilot containers stopped and retained the named volumes.

## Application coverage

Inventory comes from migrated `pg_proc` and actual grants, not a selected read
list. Private provider, payment and maintenance helpers stay private integrations.

Carve's `carve_public` exposes all four of `public_account`, `save_profile`,
`receipts` and `recordings`. Fixtures include profile writes, Premium owned
recordings, two nonempty pages with encoded timestamp cursors, receipts, invalid
inputs and denial for a second owner without entitlement. Its `carve_api`
integration helpers are outside this public fallback.
All four also pass on one database with native writes read by PostgREST,
PostgREST writes read by native, and recording pagination crossing engines.

Duell's `duell_api` exposes 55 functions:

```
account profile receipts
game_create game_finalize game_lock game_pause game_provision game_read
game_reopen game_resume game_retire game_setup_read game_setup_update
game_unlock game_update my_games my_series
play_correct play_record play_void
player_join_game player_join_series player_quit_game player_quit_series
rule_action_type rule_create rule_read rule_seal rule_update
scorekeeper_join scorekeeper_leave scorekeeper_list
series_complete series_create series_lock series_plan series_player_stats_read
series_read series_reopen series_results_read series_retire
series_teams_reorder series_teams_shuffle series_unlock series_update
sports_read team_create team_delete team_read team_update
venue_create venue_list venue_retire venue_update
```

Existing sporting, series, reports, registration and endpoint workflows pass
on each engine independently and with individual requests distributed between
engines on one database. All 55 functions have successful calls in each mode;
minimum-input rejection probes do not count as success. The mixed workflows
exercise command visibility, locking, concurrent scoring/creation, idempotency,
permissions, revisions, reports and retirement. New uncovered functions fail
the inventory check.

Duell business rejections deliberately remain `{ok:false,status,code}` with
HTTP 200. Workflow assertions inspect the embedded business status; differential
probes retain actual HTTP status. No proxy rewrites business failures.

Both apps' existing SQL identity helpers consume raw `request.jwt`. The test
PostgREST pre-request bridge supplies it transaction-locally after checking
verified claims, roles and authenticator identity. Native JWT guards and fixed
app schemas remain in front of both engines. A production PostgREST deployment
must package this bridge or migrate the shared identity contract; merely
pointing proxy_pass at an unconfigured PostgREST container is insufficient.

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

Tests send 20 simultaneous 100 ms queries successfully through both candidate
and PostgREST; sustained pressure expires with the same 504/PGRST003 contract
and the pool recovers. These controlled waits establish queue behavior, not
beta throughput or safe production connection counts.

Lifecycle coverage includes njs subrequests (success, missing function,
application error and acquisition timeout), SSI, auth_request, twenty in-flight
requests across graceful reload, twenty-four abandoned reads and recovery.
The libpq loop drains every result without blocking, preserves setup errors,
and wakes posted parent requests on every completion path. Tests reject worker
crashes and nginx request-count/header alerts. Abandoned-read recovery does not
establish that a disconnected write was cancelled: never infer non-commit from
a transport failure.

## Rollout and remaining scope

This changes wire behavior: typed fields replace stringified numbers/booleans,
scalar unwrapping defaults on, mutations default to minimal responses, and SQL
errors expose PostgREST details instead of the old sanitized error object.
Explicit `pgrest_json_scalar off` retains the legacy scalar wrapper and is not
the tested compatibility profile. Carve's live clients and private integrations
need regression verification when packaging an image rollout. Keep the previous
image/recovery snapshot and the existing app migration/deployment safeguards.
The existing beta image still has immediate saturation 503 behavior.

Universal PostgREST parity is **not yet established**. Remaining general areas
include transaction preferences, default-primary-key upsert inference, computed
and view relationships, RPC/mutation embedding, spread/null-embed grammar,
custom media handlers and binary edge cases, estimated-count thresholds,
role/function transaction settings, schema-cache reload semantics, full OpenAPI
and authentication configuration, and exact fuzzy error hints/transport errors.
Table writes and query grammar also retain the explicit parser/size limits in
README. These are not exceptions to the target; they need oracle cases and
implementation before advertising arbitrary PostgREST API compatibility.

The acceptance gate currently covers every public RPC used by these two apps
plus the synthetic protocol corpus. It is evidence for routing their ordinary
DB calls through either properly configured engine, without per-RPC exceptions;
it is not evidence for untested future features. Broaden the same strict gate
when the API surface changes. No extra client requests, Redis lookups, provider
calls, app migrations or beta topology changes were introduced by this work.
