import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Create files only while a test is running, inside this project's test folder.
export function createTempDir(name) {
    return mkdtempSync(fileURLToPath(new URL(`./runtime-${name}-`, import.meta.url)));
}

// Match the shared harness: keep runtime files only when debugging is requested.
export function cleanupTempDir(directory) {
    if (!directory || process.env.KEEP_LOGS) return;
    rmSync(directory, { recursive: true, force: true });
}
