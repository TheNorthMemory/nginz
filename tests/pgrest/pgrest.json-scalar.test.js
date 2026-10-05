import { createPostgresMock } from './mock.js';
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  startNginz,
  MOCK_PORTS,
  prepareMockPorts,
  teardownModule,
  testFetch,
} from "../harness.js";

const MODULE = "pgrest";
const DEFAULT_LIMIT = 64 * 1024;
const LARGE_LIMIT = 2 * 1024 * 1024;
const SMALL_LIMIT = 4 * 1024;
const LIMIT_ERROR = { message: "PostgreSQL response exceeds pgrest serialization limit" };
const VALUE = { team: "North", score: 0, active: true, optional: null, players: [1, 2] };
const JSON_TEXT = JSON.stringify(VALUE);

function sizedJson(bytes) {
  return `"${"x".repeat(bytes - 2)}"`;
}

function scalarResult(name, value, typeOid = 3802) {
  return { columns: [{ name, typeOid }], rows: [[value]] };
}

function setupPgMock() {
  const mock = createPostgresMock(MOCK_PORTS.POSTGRES);
  mock.setQueryHandler(/SELECT p\.provolatile, p\.proretset.*p\.proname\s*=\s*'(scalar_[^']+)'/, (query) => {
    const name = query.match(/p\.proname\s*=\s*'(scalar_[^']+)'/)[1];
    return {
      columns: ["provolatile", "proretset", "rettype_is_composite", "has_variadic", "unnamed_count", "single_unnamed_kind", "variadic_param_name", "input_param_names", "match_rank", "input_types", "returns_void", "signature"],
      rows: [["s", /_(no_rows|two_rows)$/.test(name) ? "t" : "f", name.endsWith("_two_columns") ? "t" : "f", "f", "0", "", "", name.endsWith("_sized") ? "bytes" : "", "0", '{"bytes":"integer"}', "f", ""]],
    };
  });
  mock.setQueryHandler(/^SELECT (scalar_\w+)\(bytes => '?(\d+)'?\)$/, (query) => {
    const [, name, bytes] = query.match(/^SELECT (scalar_\w+)\(bytes => '?(\d+)'?\)$/);
    return scalarResult(name, sizedJson(Number(bytes)), name.endsWith("_json_sized") ? 114 : 3802);
  });
  mock.setQueryHandler(/^SELECT (scalar_\w+)\(bytes => \(SELECT x.bytes FROM json_to_record\('/, query => {
    const name = query.match(/^SELECT (scalar_\w+)/)[1];
    const payload = JSON.parse(query.match(/json_to_record\('([^']+)'::json\)/)[1]);
    return scalarResult(name, sizedJson(payload.bytes));
  });
  mock.setQueryHandler(/^SELECT (?:\* FROM )?"?(scalar_\w+)"?\(\)$/, (query) => {
    const name = query.match(/^SELECT (?:\* FROM )?"?(scalar_\w+)"?\(\)$/)[1];
    if (name.endsWith("_sql_null")) return scalarResult(name, null);
    if (name.endsWith("_json_null")) return scalarResult(name, "null");
    if (name.endsWith("_array")) return scalarResult(name, '[0,true,null,{"nested":[1,2]}]');
    if (name.endsWith("_number")) return scalarResult(name, "42");
    if (name.endsWith("_boolean")) return scalarResult(name, "false");
    if (name.endsWith("_text")) return scalarResult(name, JSON_TEXT, 25);
    if (name.endsWith("_no_rows")) return { columns: [{ name, typeOid: 3802 }], rows: [] };
    if (name.endsWith("_two_rows")) return { columns: [{ name, typeOid: 3802 }], rows: [[JSON_TEXT], ["null"]] };
    if (name.endsWith("_two_columns")) return { columns: [{ name: "value", typeOid: 3802 }, "label"], rows: [[JSON_TEXT, "kept"]] };
    return scalarResult(name, JSON_TEXT, name.endsWith("_json") ? 114 : 3802);
  });
  mock.setQueryHandler(/^SELECT \* FROM scalar_table$/, () => scalarResult("value", JSON_TEXT));
  mock.setQueryHandler(/^SELECT \* FROM scalar_large_table$/, () => scalarResult("value", sizedJson(600000)));
  return mock;
}

async function expectScalar(path, expected, init) {
  const response = await testFetch(path, init);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(expected)));
  expect(await response.text()).toBe(expected);
}

async function expectLimitError(path, init) {
  const response = await testFetch(path, init);
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual(LIMIT_ERROR);
}

describe("pgrest scalar JSON response limits", () => {
  let pgMock;
  let runtimeDir;

  beforeAll(async () => {
    await prepareMockPorts(MOCK_PORTS.POSTGRES);
    pgMock = setupPgMock();
    runtimeDir = await startNginz(`tests/${MODULE}/nginx.json-scalar.conf`, MODULE);
  }, 30000);

  afterAll(async () => {
    await teardownModule(MODULE, [pgMock], [MOCK_PORTS.POSTGRES]);
  });

  for (const type of ["json", "jsonb"]) {
    test(`unwraps PostgreSQL ${type} without changing nested values`, async () => {
      await expectScalar(`/rpc/scalar_${type}`, JSON_TEXT);
    });
    test(`returns a complete 600 KB ${type} scalar with the larger bound`, async () => {
      const name = type === "json" ? "scalar_large_json_sized" : "scalar_large_sized";
      await expectScalar(`/rpc/${name}?bytes=600000`, sizedJson(600000));
    });
  }

  for (const [suffix, expected] of [
    ["sql_null", "null"],
    ["json_null", "null"],
    ["array", '[0,true,null,{"nested":[1,2]}]'],
    ["number", "42"],
    ["boolean", "false"],
  ]) {
    test(`preserves the ${suffix} scalar response`, async () => {
      await expectScalar(`/rpc/scalar_${suffix}`, expected);
    });
  }

  for (const bytes of [DEFAULT_LIMIT - 1, DEFAULT_LIMIT]) {
    test(`default bound accepts ${bytes} serialized bytes`, async () => {
      await expectScalar(`/rpc/scalar_sized?bytes=${bytes}`, sizedJson(bytes));
    });
  }

  test("default bound rejects one byte over 64 KB", async () => {
    await expectLimitError(`/rpc/scalar_sized?bytes=${DEFAULT_LIMIT + 1}`);
  });

  for (const bytes of [DEFAULT_LIMIT + 1, LARGE_LIMIT - 1, LARGE_LIMIT]) {
    test(`configured bound accepts ${bytes} serialized bytes`, async () => {
      await expectScalar(`/rpc/scalar_large_sized?bytes=${bytes}`, sizedJson(bytes));
    });
  }

  test("configured bound rejects one byte over 2 MB", async () => {
    await expectLimitError(`/rpc/scalar_large_sized?bytes=${LARGE_LIMIT + 1}`);
  });

  test("POST RPC uses the configured response bound", async () => {
    await expectScalar("/rpc/scalar_large_sized", sizedJson(600000), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bytes: 600000 }),
    });
  });

  test("nested location inherits scalar mode and the larger bound", async () => {
    await expectScalar("/rpc/scalar_large_inherited_sized?bytes=600000", sizedJson(600000));
  });

  test("nested location overrides its parent's bound", async () => {
    await expectScalar(`/rpc/scalar_large_small_sized?bytes=${SMALL_LIMIT}`, sizedJson(SMALL_LIMIT));
    await expectLimitError(`/rpc/scalar_large_small_sized?bytes=${SMALL_LIMIT + 1}`);
    await expectScalar(`/rpc/scalar_large_sized?bytes=${SMALL_LIMIT + 1}`, sizedJson(SMALL_LIMIT + 1));
  });

  test("minimum configured bound accepts exactly 512 bytes", async () => {
    await expectScalar("/rpc/scalar_large_minimum_sized?bytes=512", sizedJson(512));
  });

  test("minimum configured bound rejects 513 bytes", async () => {
    await expectLimitError("/rpc/scalar_large_minimum_sized?bytes=513");
  });

  for (const prefix of ["scalar_wrapped", "scalar_large_disabled"]) {
    test(`${prefix} preserves the ordinary wrapped response`, async () => {
      const name = `${prefix}_jsonb`;
      const response = await testFetch(`/rpc/${name}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([{ [name]: VALUE }]);
    });
    test(`${prefix} applies the configured bound to wrapped responses`, async () => {
      const response = await testFetch(`/rpc/${prefix}_sized?bytes=600000`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([{[`${prefix}_sized`]:JSON.parse(sizedJson(600000))}]);
    });
  }

  test("PostgreSQL text scalars are unwrapped and escaped", async () => {
    const name = "scalar_large_text";
    const response = await testFetch(`/rpc/${name}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(JSON_TEXT);
  });

  for (const [suffix, expected] of [
    ["no_rows", []],
    ["two_rows", [VALUE, null]],
    ["two_columns", [{ value: VALUE, label: "kept" }]],
  ]) {
    test(`${suffix} keeps the ordinary result shape`, async () => {
      const response = await testFetch(`/rpc/scalar_large_${suffix}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expected);
    });
  }

  test("single JSON table column is not treated as a scalar RPC", async () => {
    const response = await testFetch("/api/scalar_table");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ value: VALUE }]);
  });

  test("larger scalar bound does not increase the table response limit", async () => {
    await expectLimitError("/api/scalar_large_table");
  });

  for (const accept of ["text/xml", "text/plain", "application/octet-stream"]) {
    test(`${accept} negotiation retains its existing response format`, async () => {
      const response = await testFetch("/rpc/scalar_large_sized?bytes=1024", { headers: { Accept: accept } });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(accept);
      const body = await response.text();
      if (accept === "text/xml") {
        expect(body).toContain("<root>");
        expect(body).toContain("<scalar_large_sized>");
      } else {
        expect(body.trim()).toBe(sizedJson(1024));
      }
    });
  }

  test("CSV negotiation still returns a column header and encoded value", async () => {
    const response = await testFetch("/rpc/scalar_large_jsonb", { headers: { Accept: "text/csv" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(await response.text()).toBe(`scalar_large_jsonb\n"${JSON_TEXT.replaceAll('"', '""')}"\n`);
  });

  test("njs subrequest returns a complete 600 KB scalar", async () => {
    await expectScalar("/subrequest/?fn=scalar_large_sized&bytes=600000", sizedJson(600000));
  });

  test("njs subrequest propagates rejection and can subsequently succeed", async () => {
    await expectLimitError(`/subrequest/?fn=scalar_large_sized&bytes=${LARGE_LIMIT + 1}`);
    await expectScalar("/subrequest/?fn=scalar_large_sized&bytes=600000", sizedJson(600000));
  });

  test("repeated oversized responses do not exhaust the connection pool or kill workers", async () => {
    // More rejections than the default pool's 16 slots catches leaked busy slots.
    for (let i = 0; i < 20; i++) {
      await expectLimitError(`/rpc/scalar_large_sized?bytes=${LARGE_LIMIT + 1}`);
    }
    await expectScalar("/rpc/scalar_large_jsonb", JSON_TEXT);
    const log = readFileSync(join(runtimeDir, "logs", "error.log"), "utf8");
    expect(log).not.toMatch(/exited on signal|worker process .*exited with code [1-9]|alert.*(connection|request).*count/i);
  }, 15000);

  function checkConfig(directives, context = "location") {
    const configPath = join(runtimeDir, "scalar-config-test.conf");
    const location = context === "location" ? directives : "";
    const server = context === "server" ? directives : "";
    const http = context === "http" ? directives : "";
    writeFileSync(configPath, `daemon off;\nerror_log logs/error.log debug;\npid logs/nginx.pid;\nevents {}\nhttp {\n${http}\nserver {\nlisten 8888;\n${server}\nlocation /rpc/ {\npgrest_pass "host=127.0.0.1 port=15432 dbname=testdb user=postgres";\n${location}\n}\n}\n}\n`);
    const result = Bun.spawnSync(["./zig-out/bin/nginz", "-t", "-c", configPath, "-p", runtimeDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    // The nginz wrapper does not propagate nginx's config-test exit code.
    // Like the other modules, negative tests assert its failure diagnostics.
    return { exitCode: result.exitCode, output: `${result.stdout.toString()}\n${result.stderr.toString()}` };
  }

  for (const size of ["512", "4k", "64k", "2m", "16m"]) {
    test(`configuration accepts a ${size} scalar bound`, () => {
      const result = checkConfig(`pgrest_json_scalar on; pgrest_json_scalar_max_size ${size};`);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("test is successful");
    });
  }

  for (const size of ["0", "511", "16777217", "garbage", "-1"]) {
    test(`configuration rejects an invalid ${size} scalar bound`, () => {
      const result = checkConfig(`pgrest_json_scalar_max_size ${size};`);
      expect(result.output).toContain("pgrest_json_scalar_max_size");
      expect(result.output).toContain("test failed");
    });
  }

  for (const [directives, message] of [
    ["pgrest_json_scalar_max_size;", "invalid number of arguments"],
    ["pgrest_json_scalar_max_size 2m 4m;", "invalid number of arguments"],
    ["pgrest_json_scalar_max_size 2m; pgrest_json_scalar_max_size 4m;", "is duplicate"],
  ]) {
    test(`configuration rejects scalar bound ${message}: ${directives}`, () => {
      const result = checkConfig(directives);
      expect(result.output).toContain("test failed");
      expect(result.output).toContain(message);
    });
  }

  for (const context of ["server", "http"]) {
    test(`configuration rejects the scalar bound in ${context} context`, () => {
      const result = checkConfig("pgrest_json_scalar_max_size 2m;", context);
      expect(result.output).toContain("test failed");
      expect(result.output).toContain("directive is not allowed here");
    });
  }
});
