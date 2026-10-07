# WeChat notification native/njs comparison

Run from the repository root:

```sh
ZIG_OPTIMIZE=ReleaseSafe bun perf/wechat-notify/benchmark/run.js
WECHAT_NOTIFY_BENCHMARK=1 ZIG_OPTIMIZE=ReleaseSafe bun test tests/wechat-notify/benchmark.test.js
```

The runner uses the shared `perf/common` lifecycle, CLI, reporting, artifact and
profiling helpers. It saves environment, configuration, individual rounds,
median comparisons, logs and process snapshots under `benchmark/output/`.
The integration comparison test is opt-in and checks successful processing and
valid measurements; it never asserts that native must beat njs.

Three arms run on one nginz worker with access logging disabled:

| Arm | Verification/decryption | Content |
| --- | --- | --- |
| `native-njs` | Native `wechat_notify_access` | njs reads the plaintext, parses the event, returns `success` |
| `njs` | SHA-1 and WebCrypto AES-CBC in njs | The same event consumer and response |
| `native-echo` | Native `wechat_notify_access` | Native echo returns `success` |

The primary comparison is `native-njs` versus `njs`: it holds content processing
constant. `native-echo` additionally shows the benefit of avoiding JavaScript
entirely. The njs reference follows the current WeChat 32-byte padding workaround:
it imports the key for each request, encrypts an extra padding block, decrypts,
and validates padding, length and AppID. Neither arm queries a provider/database
or performs application configuration-file reads during a request. This measures
protocol handling, rather than the full Duell backend or Gleam runtime.

Defaults are 256-byte, 2-KiB and 32-KiB JSON plaintext; concurrency 1 and 8;
100 warmup requests and 1,000 timed requests per arm per round; six rounds.
Each plaintext size is encrypted once before timing, and the identical envelope
is reused across all arms. Repeated delivery remains valid. Arm order rotates
each round. Every response must be exactly `200 success`; wrong signatures and
wrong AppIDs must be rejected before timing starts.

Reported speedups divide median per-round throughput, or median per-round p50
latency, for the same payload/concurrency. Single-request latency includes HTTP,
loopback, body handling and client overhead. Throughput at concurrency 8 is
more informative about worker saturation. Both paths use OpenSSL underneath;
the expected difference is JavaScript execution, allocations, key import and
the WebCrypto padding workaround, rather than a different AES implementation.
The runner also records the nginx master and worker resource snapshots.

Build/startup, configuration parsing, validation and warmup are outside timed
windows. Results are specific to the machine, build mode and workload; retain
the generated environment artifact alongside any quoted ratio. Use
`--requests=... --warmup=... --rounds=... --concurrency=... --profile=none|snapshot|perf-stat`
to repeat the comparison. The first-round table is a diagnostic view; use the
median comparisons in `benchmark.json` for conclusions.

See the [2026-10-02 measured comparison](notes/2026-10-02-native-njs-comparison.md)
for six-round results, worker CPU evidence and the narrower gain at 32 KiB.
