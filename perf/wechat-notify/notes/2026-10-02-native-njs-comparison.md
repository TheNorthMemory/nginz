# WeChat message verification: native versus njs

## Environment and method

Measured the working-tree `wechat_notify_*` implementation on 2026-10-02,
based on HEAD `6e821a1312ac7dfb7325113810945ec169ee3fbd`.
Intel Core i7 860 at 2.80 GHz, 8 logical CPUs, 16 GB RAM, Linux
7.2.7-arch1-1; Zig 0.16.0, Bun 1.3.14, ReleaseSmall. Initial system load
averages were 3.51 / 3.72 / 3.82; CPU affinity and frequency were not pinned.

```sh
ZIG_OPTIMIZE=ReleaseSmall bun perf/wechat-notify/benchmark/run.js \
  --requests=5000 --warmup=500 --rounds=6 --profile=snapshot \
  --artifact-tag=native-njs-comparison
```

Run directory:
`perf/wechat-notify/benchmark/output/2026-10-02T10-16-20.754Z-wechat-notify-releasesmall-native-njs-comparison/`.
It retains `benchmark.json`, environment/command/manifest JSON, `nginx.conf`,
logs and per-round master/worker snapshots. All 540,000 timed requests returned
exactly `200 success`. Invalid signatures and wrong AppIDs were rejected before
timing each arm.

One nginx worker, loopback HTTP, keepalive, access logging disabled. Each size
uses a JSON event with an ASCII text field, encrypted once outside timing and
reused identically across arms. Arm order rotates across six rounds. Results
below are medians of per-round measurements, not the runner's first-round table.
Build, startup, configuration reads, validation and warmup are excluded.

The primary comparison keeps the njs event consumer identical. `native-njs`
authenticates/decrypts in access, then njs reads and parses plaintext JSON.
`njs` authenticates/decrypts in JavaScript, then invokes the same consumer.
`native-echo` additionally removes JavaScript content processing. The njs
reference follows the current SHA-1/WebCrypto AES-CBC key-import and 32-byte
padding workaround; it omits Gleam wrappers, application configuration reads
and business/provider/database processing. Duell was not changed.

## Throughput and latency

Speedup is throughput relative to the njs verification/decryption arm.

| Plaintext | Concurrency | njs req/s | Native + njs req/s | Same content speedup | Native echo speedup | p50 ms: njs → native + njs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 256 B | 1 | 2,051 | 2,982 | 1.45× | 1.87× | 0.380 → 0.250 |
| 256 B | 8 | 4,690 | 8,659 | 1.85× | 2.55× | 1.419 → 0.727 |
| 2 KiB | 1 | 1,726 | 2,180 | 1.26× | 1.47× | 0.459 → 0.352 |
| 2 KiB | 8 | 3,394 | 5,019 | 1.48× | 1.86× | 1.955 → 1.299 |
| 32 KiB | 1 | 465 | 492 | 1.06× | 1.28× | 1.895 → 1.783 |
| 32 KiB | 8 | 592 | 619 | 1.04× | 1.34× | 13.221 → 12.576 |

The corresponding encrypted envelope sizes were 442, 2,830 and 43,790 bytes.
At 32 KiB/concurrency 8, native + njs rounds ranged from 609–621 req/s and njs
from 588–612 req/s. Those ranges overlap: the roughly 4% median gain is small
enough to require care when repeating on another machine. The smaller payloads
show a larger, consistent separation. HTTP/client overhead is included in every
latency and throughput measurement.

## CPU evidence and likely hot paths

Worker CPU time comes from before/after `/proc/<pid>/stat` user + system ticks,
with `getconf CLK_TCK = 100`, divided by 5,000 requests. These are approximate
medians over six rounds at concurrency 1, in microseconds per request:

| Plaintext | njs | Native + njs | Native echo | CPU reduction with the same content |
| --- | ---: | ---: | ---: | ---: |
| 256 B | 204 | 108 | 76 | 96 |
| 2 KiB | 273 | 182 | 138 | 91 |
| 32 KiB | 1,614 | 1,526 | 1,181 | 88 |

Native saves roughly 73–96 microseconds of worker CPU per request across all
six payload/concurrency combinations. This approximately fixed saving explains
why its relative advantage shrinks as messages grow. Both implementations use
OpenSSL; the comparison does not demonstrate a faster AES primitive. Likely
sources of the saving are fewer JavaScript/Buffer operations, no WebCrypto key
import, and no extra encrypted padding block or appended ciphertext allocation.
Native still initializes an OpenSSL cipher context per request.

The native steady-state path reads the envelope, performs strict cJSON parsing,
sorts and hashes the signed fields, validates and decodes canonical Base64,
decrypts CBC, checks padding/length/AppID, and replaces the body chain and
headers. Its Token/key files and decoded key are loaded during configuration,
outside the request path. There is no replay-store mutation, provider call or
database access in any measured arm.

At 32 KiB/concurrency 8, worker CPU estimates approach 97% of one CPU for all
three arms. At the smaller sizes they are roughly 72–85%, leaving HTTP/client
scheduling and other system work as credible limits. At 32 KiB/concurrency 1,
removing njs content also saves about 345 microseconds of worker CPU. Envelope
validation, Base64 scanning, body copies and plaintext parsing are therefore
useful candidates for subsequent profiling. The snapshots cannot assign costs
to individual functions. No hardware instructions, IPC, branch-miss or
cache-miss counters were captured, so no microarchitectural claim follows from
this run. XML and application business processing were not benchmarked.

The opt-in integration comparison test reports measured ratios and checks
correctness and valid measurements; it does not assert a fixed performance
threshold that would make ordinary test results depend on machine load.
