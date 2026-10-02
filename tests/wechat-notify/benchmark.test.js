import { test, expect } from 'bun:test';
import { runComparison } from '../../perf/wechat-notify/benchmark/run.js';

// Timing is opt-in. Correctness never depends on one implementation winning.
const comparisonTest = process.env.WECHAT_NOTIFY_BENCHMARK === '1' ? test : test.skip;
comparisonTest('reports native versus njs verification/decryption with identical content processing', async () => {
    const report = await runComparison({ requests: 200, warmup: 20, rounds: 3, concurrency: [1], sizes: [256, 2048], profile: 'none', artifactTag: 'comparison-test' });
    expect(report.comparisons).toHaveLength(2);
    expect(report.results).toHaveLength(18);
    for (const row of report.results) expect(row.summary.success_total).toBe(row.summary.requests_total);
    for (const row of report.comparisons) {
        expect(Number.isFinite(row.same_content_throughput_speedup)).toBe(true);
        expect(row.same_content_throughput_speedup).toBeGreaterThan(0);
        expect(row.arms['native-njs'].median_p50_ms).toBeGreaterThan(0);
        expect(row.arms.njs.median_p50_ms).toBeGreaterThan(0);
    }
}, 30000);
