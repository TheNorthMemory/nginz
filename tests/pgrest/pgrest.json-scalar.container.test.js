import { dockerCommand } from "../docker.js";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startNginz, stopNginz, cleanupRuntime, testFetch } from "../harness.js";

const MODULE = "pgrest";
const PG_CONTAINER = "pgrest-nginz-test";
const PG_PASSWORD = "nginz_test_pass";
const RUN_NAME = `pgrest_scalar_${process.pid}_${Date.now().toString(36)}`;
const LIMIT_ERROR = { message: "PostgreSQL response exceeds pgrest serialization limit" };

function psql(sql, database = "postgres") {
  const result = Bun.spawnSync([
    ...dockerCommand(), "exec", "-i", PG_CONTAINER,
    "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database,
  ], { stdin: Buffer.from(sql), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`PostgreSQL scalar fixture failed: ${result.stdout.toString()}${result.stderr.toString()}`);
  }
}

describe("pgrest scalar JSON with real PostgreSQL", () => {
  let configDir;
  let roleCreated = false;
  let databaseCreated = false;

  beforeAll(async () => {
    psql(`CREATE ROLE ${RUN_NAME} LOGIN PASSWORD '${PG_PASSWORD}';`);
    roleCreated = true;
    psql(`CREATE DATABASE ${RUN_NAME} OWNER ${RUN_NAME};`);
    databaseCreated = true;
    psql(`
      SET ROLE ${RUN_NAME};
      CREATE FUNCTION scalar_sized(bytes integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
        SELECT ('"' || repeat('x', bytes - 2) || '"')::jsonb;
      $$;
      CREATE FUNCTION scalar_large_sized(bytes integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
        SELECT scalar_sized(bytes);
      $$;
      CREATE FUNCTION scalar_large_json_sized(bytes integer) RETURNS json LANGUAGE sql STABLE AS $$
        SELECT ('"' || repeat('x', bytes - 2) || '"')::json;
      $$;
      CREATE FUNCTION scalar_large_small_json(bytes integer) RETURNS json LANGUAGE sql STABLE AS $$
        SELECT ('"' || repeat('🏒', 1023) || repeat('x', bytes - 4094) || '"')::json;
      $$;
      CREATE FUNCTION scalar_large_small_jsonb(bytes integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
        SELECT scalar_large_small_json(bytes)::jsonb;
      $$;
    `, RUN_NAME);

    // Stage this suite's config beside the other test runtimes. The unchanged
    // harness supplies the nginx prefix, including its logs and pid paths.
    configDir = mkdtempSync(join(process.cwd(), "tests", MODULE, "runtime-scalar-config-"));
    const configPath = join(configDir, "nginx.conf");
    const config = readFileSync(`tests/${MODULE}/nginx.json-scalar.conf`, "utf8")
      .replaceAll("host=127.0.0.1 port=15432 dbname=testdb user=postgres",
        `host=127.0.0.1 port=5432 dbname=${RUN_NAME} user=${RUN_NAME} password=${PG_PASSWORD}`)
      .replace("js_import scalar from json_scalar_subrequest.js;",
        `js_import scalar from ${join(process.cwd(), "tests", MODULE, "json_scalar_subrequest.js")};`);
    writeFileSync(configPath, config);
    await startNginz(configPath, MODULE);
  }, 30000);

  afterAll(async () => {
    try {
      await stopNginz();
      if (databaseCreated) psql(`DROP DATABASE ${RUN_NAME} WITH (FORCE);`);
    } finally {
      try {
        if (roleCreated) psql(`DROP ROLE ${RUN_NAME};`);
      } finally {
        if (configDir) rmSync(configDir, { recursive: true, force: true });
        cleanupRuntime(MODULE);
      }
    }
  }, 30000);

  for (const type of ["json", "jsonb"]) {
    test(`${type} accepts an exact 4 KB UTF-8 scalar`, async () => {
      const expected = `"${"🏒".repeat(1023)}xx"`;
      expect(Buffer.byteLength(expected)).toBe(4096);
      const response = await testFetch(`/rpc/scalar_large_small_${type}?bytes=4096`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe("4096");
      expect(await response.text()).toBe(expected);
    });

    test(`${type} rejects UTF-8 bytes over the bound despite fewer characters`, async () => {
      const expected = `"${"🏒".repeat(1023)}xxx"`;
      expect(Buffer.byteLength(expected)).toBe(4097);
      expect(expected.length).toBeLessThan(4096);
      const response = await testFetch(`/rpc/scalar_large_small_${type}?bytes=4097`);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual(LIMIT_ERROR);
    });

    test(`${type} returns a complete large scalar through njs`, async () => {
      const name = type === "json" ? "scalar_large_json_sized" : "scalar_large_sized";
      const response = await testFetch(`/subrequest/?fn=${name}&bytes=600000`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe("600000");
      expect(await response.text()).toBe(`"${"x".repeat(599998)}"`);
    });
  }

  for (const bytes of [65536, 2 * 1024 * 1024]) {
    test(`accepts the exact ${bytes} byte bound from PostgreSQL`, async () => {
      const name = bytes === 65536 ? "scalar_sized" : "scalar_large_sized";
      const response = await testFetch(`/rpc/${name}?bytes=${bytes}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe(String(bytes));
      expect(await response.text()).toBe(`"${"x".repeat(bytes - 2)}"`);
    });
  }

  test("njs propagates an oversized PostgreSQL result and recovers", async () => {
    const response = await testFetch("/subrequest/?fn=scalar_large_sized&bytes=2097153");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual(LIMIT_ERROR);
    const recovery = await testFetch("/subrequest/?fn=scalar_large_sized&bytes=1024");
    expect(recovery.status).toBe(200);
    expect(await recovery.text()).toBe(`"${"x".repeat(1022)}"`);
  });

  test("default PostgreSQL response bound is still 64 KB", async () => {
    const response = await testFetch("/rpc/scalar_sized?bytes=65537");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual(LIMIT_ERROR);
  });
});
