import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { parseBenchmarkArgs } from '../../common/benchmark_cli.js';
import { ensureBuild, resetRuntimeDir, startNginz, stopNginz, getNginzPid } from '../../common/nginz.js';
import { getFreePort } from '../../common/system.js';
import { summarizeSamples, printSummary } from '../../common/report.js';
import { createRunArtifacts, writeJsonArtifact, captureEnvironmentArtifact, captureCommandArtifact,
    copyRuntimeLogs, writeManifest } from '../../common/artifacts.js';
import { startProfiling, stopProfiling } from '../../common/profiling.js';

const MODULE = 'wechat-notify';
const ARMS = ['native-njs', 'njs', 'native-echo'];
const APPID = 'wx0123456789abcdef';
const TOKEN = 'NotifyFixtureToken';
const KEY = Buffer.from('0123456789abcdef0123456789abcdef');
const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function fixture(size, appid = APPID) {
    const overhead = Buffer.byteLength(JSON.stringify({ Event: 'benchmark', text: '' }));
    const plaintext = Buffer.from(JSON.stringify({ Event: 'benchmark', text: 'x'.repeat(size - overhead) }));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(plaintext.length);
    const raw = Buffer.concat([randomBytes(16), length, plaintext, Buffer.from(appid)]);
    const padding = 32 - raw.length % 32;
    const cipher = createCipheriv('aes-256-cbc', KEY, KEY.subarray(0, 16));
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(Buffer.concat([raw, Buffer.alloc(padding, padding)])), cipher.final()]).toString('base64');
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = 'benchmark';
    const signature = createHash('sha1').update([TOKEN, timestamp, nonce, encrypted].sort().join('')).digest('hex');
    return { body: JSON.stringify({ Encrypt: encrypted }), query: new URLSearchParams({ timestamp, nonce, encrypt_type: 'aes', msg_signature: signature }).toString() };
}

async function measure(url, value, requests, concurrency) {
    const samples = [];
    let next = 0;
    const started = performance.now();
    await Promise.all(Array.from({ length: concurrency }, async () => {
        while (next++ < requests) {
            const before = performance.now();
            const reply = await fetch(url + '?' + value.query, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: value.body });
            const body = await reply.text();
            if (reply.status !== 200 || body !== 'success') throw new Error('benchmark correctness failure: ' + reply.status);
            samples.push({ latencyMs: performance.now() - before, payloadBytes: Buffer.byteLength(body), status: reply.status });
        }
    }));
    return summarizeSamples(samples, performance.now() - started);
}

export async function runComparison(overrides = {}) {
    const options = { requests: 1000, warmup: 100, rounds: 6, concurrency: [1, 8], sizes: [256, 2048, 32768],
        profile: 'snapshot', artifactTag: '', keepRuntime: false, ...overrides };
    if (!options.concurrency.length || !options.sizes.length) throw new Error('concurrency and size lists must not be empty');
    for (const value of [options.requests, options.warmup, options.rounds, ...options.concurrency, ...options.sizes]) {
        if (!Number.isSafeInteger(value) || value < 1) throw new Error('benchmark counts must be positive integers');
    }
    if (options.sizes.some(size => size < 64 || size > 32768)) throw new Error('plaintext size must be between 64 and 32768 bytes');
    const optimizeMode = process.env.ZIG_OPTIMIZE || 'ReleaseSmall';
    const artifacts = createRunArtifacts(resolve('perf', MODULE, 'benchmark', 'output'), MODULE, optimizeMode, options.artifactTag);
    const results = [], comparisons = [];
    let running = false;
    resetRuntimeDir(artifacts.runtimeDir);
    writeJsonArtifact(artifacts.environmentPath, captureEnvironmentArtifact(MODULE, { optimizeMode }));
    writeJsonArtifact(artifacts.commandPath, captureCommandArtifact('perf/wechat-notify/benchmark/run.js', options));
    try {
        const port = await getFreePort();
        const reference = resolve('perf', MODULE, 'reference.js');
        const fixtures = resolve('tests', MODULE, 'fixtures');
        const config = `daemon off;
worker_processes 1;
error_log logs/error.log warn;
pid logs/nginx.pid;
events { worker_connections 1024; }
http {
    access_log off;
    variables_hash_max_size 2048;
    variables_hash_bucket_size 128;
    client_body_temp_path client_temp;
    client_max_body_size 64k;
    client_body_buffer_size 64k;
    keepalive_timeout 15;
    keepalive_requests 1000000;
    js_engine qjs;
    js_import reference from "${reference}";
    wechat_notify_appid ${APPID};
    wechat_notify_token_file "${fixtures}/token";
    wechat_notify_aes_key_file "${fixtures}/aes-key";
    wechatpay_body_max_size 64k;
    server {
        listen 127.0.0.1:${port};
        location = /native-njs { wechat_notify_access on; js_content reference.native; }
        location = /njs { js_content reference.njs; }
        location = /native-echo { wechat_notify_access on; echozn "success"; }
        location / { echozn "ready"; }
    }
}`;
        const configPath = join(artifacts.runtimeDir, 'nginx.conf');
        writeFileSync(configPath, config);
        writeFileSync(join(artifacts.runDir, 'nginx.conf'), config);
        running = true;
        await startNginz(configPath, artifacts.runtimeDir, port, { resetRuntime: false });
        const base = 'http://127.0.0.1:' + port;
        // Validate equivalence before timing. Incorrect authentication must
        // never look like a performance improvement.
        for (const arm of ARMS) {
            await measure(base + '/' + arm, fixture(256), 1, 1);
            const badSignature = fixture(256);
            badSignature.query = badSignature.query.replace(/msg_signature=[^&]+/, 'msg_signature=' + '0'.repeat(40));
            for (const invalid of [fixture(256, 'wxwrongappid'), badSignature]) {
                const reply = await fetch(base + '/' + arm + '?' + invalid.query, { method: 'POST', body: invalid.body, headers: { 'Content-Type': 'application/json' } });
                await reply.text();
                if (reply.status !== 403) throw new Error('benchmark verification bypass: ' + arm);
            }
        }
        const master = getNginzPid();
        const children = readFileSync(`/proc/${master}/task/${master}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
        for (const size of options.sizes) {
            const value = fixture(size);
            for (const concurrency of options.concurrency) {
                for (let round = 0; round < options.rounds; round++) {
                    // Rotate every arm through each position to balance drift.
                    const order = ARMS.slice(round % ARMS.length).concat(ARMS.slice(0, round % ARMS.length));
                    for (const arm of order) {
                        await measure(base + '/' + arm, value, options.warmup, concurrency);
                        const profilingDir = join(artifacts.profilingDir, `${size}-c${concurrency}-r${round + 1}-${arm}`);
                        mkdirSync(profilingDir, { recursive: true });
                        const profile = await startProfiling({ mode: options.profile, pids: [master, ...children], profilingDir });
                        const summary = await measure(base + '/' + arm, value, options.requests, concurrency);
                        await stopProfiling(profile, profilingDir);
                        results.push({ service: arm, scenario: size + '-byte-json', plaintext_bytes: size,
                            envelope_bytes: Buffer.byteLength(value.body), concurrency, round: round + 1, summary });
                    }
                }
                const grouped = Object.fromEntries(ARMS.map(arm => {
                    const samples = results.filter(row => row.plaintext_bytes === size && row.concurrency === concurrency && row.service === arm);
                    return [arm, { median_rps: median(samples.map(row => row.summary.throughput_rps)),
                        median_p50_ms: median(samples.map(row => row.summary.latency_p50_ms)),
                        median_p95_ms: median(samples.map(row => row.summary.latency_p95_ms)) }];
                }));
                const comparison = { plaintext_bytes: size, envelope_bytes: Buffer.byteLength(value.body), concurrency, rounds: options.rounds,
                    arms: grouped, same_content_throughput_speedup: grouped['native-njs'].median_rps / grouped.njs.median_rps,
                    same_content_latency_speedup: grouped.njs.median_p50_ms / grouped['native-njs'].median_p50_ms,
                    native_echo_throughput_speedup: grouped['native-echo'].median_rps / grouped.njs.median_rps };
                comparisons.push(comparison);
                console.log(`${size} bytes, c=${concurrency}: native+njs ${comparison.same_content_throughput_speedup.toFixed(2)}x njs throughput; native+echo ${comparison.native_echo_throughput_speedup.toFixed(2)}x`);
            }
        }
        writeJsonArtifact(artifacts.benchmarkPath, { options, results, comparisons });
        writeManifest(artifacts, { status: 'complete', options, worker_processes: 1, comparison: 'same njs consumer; JSON safe-mode envelope' });
        printSummary(results.filter(row => row.round === 1));
        console.log('Benchmark artifacts: ' + artifacts.runDir);
        return { options, results, comparisons, artifacts };
    } catch (error) {
        writeJsonArtifact(artifacts.failurePath, { message: error.message });
        writeManifest(artifacts, { status: 'failed', options });
        throw error;
    } finally {
        if (running) await stopNginz();
        copyRuntimeLogs(artifacts.runtimeDir, artifacts.logsDir);
        if (!options.keepRuntime) rmSync(artifacts.runtimeDir, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        console.log('bun perf/wechat-notify/benchmark/run.js [--requests=1000] [--warmup=100] [--rounds=6] [--concurrency=1,8] [--profile=snapshot] [--keep-runtime]');
    } else {
        const args = process.argv.slice(2);
        const parsed = parseBenchmarkArgs(args);
        const options = { profile: parsed.profile, artifactTag: parsed.artifactTag, keepRuntime: parsed.keepRuntime };
        for (const [flag, key] of [['--requests=', 'requests'], ['--warmup=', 'warmup'], ['--concurrency=', 'concurrency']]) {
            if (args.some(arg => arg.startsWith(flag))) options[key] = parsed[key];
        }
        const rounds = args.find(arg => arg.startsWith('--rounds='));
        if (rounds) options.rounds = Number(rounds.split('=')[1]);
        ensureBuild();
        await runComparison(options);
    }
}
