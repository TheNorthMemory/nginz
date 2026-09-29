import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomBytes, createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { dockerCommand } from "../docker.js";
import { startNginz, stopNginz, cleanupRuntime, TEST_URL, stableFetch } from "../harness.js";

const MODULE = "pgrest-security";
const PG = "pgrest-nginz-test";
const RUN = "pgrest_security_" + randomBytes(6).toString("hex");
const AUTH = RUN + "_authenticator", USER = RUN + "_weapp", ANON = RUN + "_anon";
const SECRET = randomBytes(32).toString("hex"), PASSWORD = randomBytes(32).toString("hex");
const JSON_TYPE = "application/json", FORM_TYPE = "application/x-www-form-urlencoded";
const run = (command, options) => spawnSync(command[0], command.slice(1), options);

function sql(text, database = RUN) {
  const result = run([...dockerCommand(), "exec", "-i", PG, "psql", "-X", "-q", "-t", "-A", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1"], {
    input: text, encoding: "utf8", timeout: 30000,
  });
  if (result.status !== 0) throw new Error("Security fixture SQL failed: " + result.stderr);
  return result.stdout.trim();
}

function token(overrides = {}, secret = SECRET, header = { alg: "HS256", typ: "JWT" }) {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = encode(header) + "." + encode({
    iss: RUN, aud: "duell-api", sub: "duell", role: USER, appid: "wx1234567890abcdef", app: RUN,
    oid: "audit-owner", exp: now + 300, nbf: now - 5, ...overrides,
  });
  return unsigned + "." + createHmac("sha256", secret).update(unsigned).digest("base64url");
}

async function post(path, body, type = JSON_TYPE, jwt = token(), headers = {}) {
  return stableFetch(TEST_URL + path, {
    method: "POST", headers: { "Content-Type": type, ...(jwt ? { Authorization: "Bearer " + jwt } : {}), ...headers },
    body: type === JSON_TYPE ? JSON.stringify(body) : body,
  });
}

function expectUnchanged() {
  expect(sql("SELECT jsonb_agg(jsonb_build_array(id,value) ORDER BY id) FROM audit.items")).toBe('[[1, "first"], [2, "second"]]');
}

describe("pgrest SQL construction with real PostgreSQL and native JWT", () => {
  let directory, roles = false, database = false;
  beforeAll(async () => {
    const running = run([...dockerCommand(), "inspect", "--format", "{{.State.Running}}", PG], { encoding: "utf8" });
    if (running.status !== 0) throw new Error("The existing PostgreSQL test container is required");
    if (running.stdout.trim() !== "true") {
      const started = run([...dockerCommand(), "start", PG], { encoding: "utf8" });
      if (started.status !== 0) throw new Error(started.stderr);
    }
    sql(`CREATE ROLE ${USER} NOLOGIN; CREATE ROLE ${ANON} NOLOGIN;
      CREATE ROLE ${AUTH} LOGIN NOINHERIT PASSWORD '${PASSWORD}'; GRANT ${USER},${ANON} TO ${AUTH};`, "postgres");
    roles = true;
    sql(`CREATE DATABASE ${RUN};`, "postgres"); database = true;
    sql(`CREATE SCHEMA audit; REVOKE ALL ON SCHEMA audit FROM PUBLIC;
      CREATE FUNCTION audit.echo(ptext text DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(to_jsonb(ptext),'null'::jsonb); $$;
      CREATE FUNCTION audit.echo_table(ptext text) RETURNS TABLE(value text) LANGUAGE sql STABLE AS $$ SELECT ptext; $$;
      CREATE FUNCTION audit.whole(jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT $1; $$;
      CREATE FUNCTION audit.arrays(items text[]) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT to_jsonb(items); $$;
      CREATE FUNCTION audit.variadic_echo(VARIADIC items text[]) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT to_jsonb(items); $$;
      CREATE FUNCTION audit.named_json(data jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT data; $$;
      CREATE FUNCTION audit."Mixed Echo"("Mixed Arg" text) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT to_jsonb($1); $$;
      CREATE TABLE audit.items(id integer PRIMARY KEY,value text);
      INSERT INTO audit.items VALUES(1,'first'),(2,'second');
      CREATE TABLE audit.private_items(value text); INSERT INTO audit.private_items VALUES('private');
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA audit FROM PUBLIC;
      GRANT USAGE ON SCHEMA audit TO ${USER}; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA audit TO ${USER};
      GRANT SELECT,INSERT,UPDATE,DELETE ON audit.items TO ${USER};
      ALTER ROLE ${AUTH} SET standard_conforming_strings=off;`);
    directory = mkdtempSync(join(tmpdir(), "nginz-pgrest-security-"));
    const jwt = `jwt_secret "${SECRET}"; jwt_issuer ${RUN}; jwt_audience duell-api;
      jwt_require_claim sub eq duell; jwt_require_claim role eq ${USER}; jwt_require_claim appid eq wx1234567890abcdef;
      jwt_require_claim app eq ${RUN}; jwt_require_claim oid !eq ""; jwt_require_claim exp gt 0;
      jwt_validate_exp on; jwt_validate_sig on;`;
    const pg = `pgrest_pass "host=127.0.0.1 port=5432 dbname=${RUN} user=${AUTH} password=${PASSWORD} connect_timeout=3";
      pgrest_schemas audit; pgrest_pool_size 2; pgrest_json_scalar on; pgrest_jwt_secret "${SECRET}"; pgrest_anon_role ${ANON};`;
    const path = join(directory, "nginx.conf");
    writeFileSync(path, `daemon off; error_log logs/error.log debug; pid logs/nginx.pid;
      events { worker_connections 64; } http { access_log off; client_max_body_size 16k; client_body_buffer_size 16k;
        variables_hash_max_size 2048; variables_hash_bucket_size 128;
        server { listen 8888; jwt_secret off;
          location = /duell/profile { limit_except POST { deny all; } ${jwt} rewrite ^ /rpc/whole break; ${pg} }
          location = /carve/profile { limit_except POST { deny all; } ${jwt} rewrite ^ /rpc/echo break; ${pg} }
          location /rpc/ { ${jwt} ${pg} } location /api/ { ${jwt} ${pg} }
          location / { return 404; }
        } }`, { mode: 0o600 });
    await startNginz(path, MODULE);
  }, 30000);

  afterAll(async () => {
    try { await stopNginz(); }
    finally {
      try { if (database) sql(`DROP DATABASE ${RUN} WITH (FORCE);`, "postgres"); }
      finally {
        if (roles) sql(`DROP ROLE ${AUTH}; DROP ROLE ${USER}; DROP ROLE ${ANON};`, "postgres");
        if (directory) rmSync(directory, { recursive: true, force: true });
        cleanupRuntime(MODULE);
      }
    }
  }, 30000);

  for (const [label, jwt] of [
    ["missing JWT", null], ["wrong signing key", token({}, "incorrect-key")],
    ["wrong issuer", token({ iss: "other-app" })], ["wrong audience", token({ aud: "other-api" })],
    ["wrong app", token({ app: "other-app" })], ["wrong AppID", token({ appid: "wx2222222222222222" })],
    ["wrong subject", token({ sub: "other-product" })], ["wrong role", token({ role: AUTH })],
    ["missing owner", token({ oid: "" })], ["expired JWT", token({ exp: Math.floor(Date.now() / 1000) - 60 })],
    ["future JWT", token({ nbf: Math.floor(Date.now() / 1000) + 3600 })],
    ["unsigned algorithm", token({}, SECRET, { alg: "none" })],
  ]) {
    test(label + " cannot reach the fixed RPC", async () => {
      const response = await post("/duell/profile", { nickname: "safe" }, JSON_TYPE, jwt);
      expect(response.status).toBe(401); expectUnchanged();
    });
  }

  test("native JWT protects table routing too", async () => {
    const response = await stableFetch(TEST_URL + "/api/items", { headers: { Authorization: "Bearer " + token({}, "wrong") } });
    expect(response.status).toBe(401);
  });

  test("the authenticator cannot inherit application privileges or switch to unrelated roles", () => {
    expect(sql(`SELECT rolinherit FROM pg_roles WHERE rolname='${AUTH}'`)).toBe("f");
    expect(sql(`SELECT has_table_privilege('${USER}','audit.private_items','SELECT')`)).toBe("f");
    expect(sql(`SELECT pg_has_role('${AUTH}','postgres','MEMBER')`)).toBe("f");
  });

  test("SQL text in a bound string is returned literally", async () => {
    const value = "\\'; SELECT current_user; --";
    const response = await post("/carve/profile", { ptext: value });
    expect(response.status).toBe(200); expect(await response.json()).toBe(value);
  });

  for (const value of [1, true, null, "bound", ["array"], { nested: "JSON" }]) {
    test("JSON argument-name injection is rejected for " + JSON.stringify(value), async () => {
      const response = await post("/carve/profile", { ["ptext => current_user) --"]: value });
      expect(response.status).toBe(400); expect(await response.json()).toEqual({ code: "invalid_rpc_parameters" });
      expectUnchanged();
    });
  }

  test("table-returning RPCs also reject argument-name injection", async () => {
    const response = await post("/rpc/echo_table", { ["ptext => current_user) --"]: 1 });
    expect(response.status).toBe(400); expectUnchanged();
  });

  test("unknown and duplicate named arguments fail closed", async () => {
    expect((await post("/rpc/echo", { unknown: 1 })).status).toBe(400);
    expect((await post("/rpc/echo", "ptext=one&ptext=two", FORM_TYPE)).status).toBe(400);
  });

  test("an injected expression cannot change the database JWT context", async () => {
    const response = await post("/carve/profile", { ["ptext => set_config('request.jwt','forged',false)) --"]: 1 });
    expect(response.status).toBe(400); expectUnchanged();
  });

  test("a whole JSON body preserves SQL-looking keys as data", async () => {
    const value = { ["jsonb_build_object('injected',current_user)) --"]: 1 };
    const response = await post("/duell/profile", value);
    expect(response.status).toBe(200); expect(await response.json()).toEqual(value);
  });

  test("form input cannot bypass an unnamed JSON RPC", async () => {
    const form = new URLSearchParams({ ["jsonb_build_object('injected',current_user)) --"]: "1" }).toString();
    const response = await post("/duell/profile", form, FORM_TYPE);
    expect(response.status).toBe(415); expectUnchanged();
  });

  test("whole JSON RPCs preserve arrays of objects used by app commands", async () => {
    const value = { teams: [{ name: "Lions" }, { name: "Tigers" }], nested: { actions: [{ points: 2 }] } };
    const response = await post("/duell/profile", value);
    expect(response.status).toBe(200); expect(await response.json()).toEqual(value);
  });

  test("whole JSON RPCs use binding instead of the named argument parser's 4 KB limit", async () => {
    const value = { payload: "x".repeat(5000) };
    const response = await post("/duell/profile", value);
    expect(response.status).toBe(200); expect(await response.json()).toEqual(value);
  });

  test("valid named form arguments work and remain literal", async () => {
    const value = "\\'; SELECT current_user; --";
    const response = await post("/rpc/echo", new URLSearchParams({ ptext: value }).toString(), FORM_TYPE);
    expect(response.status).toBe(200); expect(await response.json()).toBe(value);
  });

  test("malformed and excessive form arguments fail closed", async () => {
    expect((await post("/rpc/echo", "ptext=%ZZ", FORM_TYPE)).status).toBe(400);
    expect((await post("/rpc/echo", Array.from({ length: 17 }, () => "ptext=value").join("&"), FORM_TYPE)).status).toBe(400);
  });

  test("generated arrays escape quotes and backslashes with non-standard SQL strings", async () => {
    const items = ["\\'); UPDATE audit.items SET value='injected'; --", "O'Reilly", "back\\slash", "中文"];
    const response = await post("/rpc/arrays", { items });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(items); expectUnchanged();
  });

  test("variadic form values remain data with non-standard SQL strings", async () => {
    const items = ["\\'); UPDATE audit.items SET value='injected'; --", "second"];
    const form = items.map(value => new URLSearchParams({ items: value }).toString()).join("&");
    const response = await post("/rpc/variadic_echo", form, FORM_TYPE);
    expect(response.status).toBe(200); expect(await response.json()).toEqual(items); expectUnchanged();
  });

  test("mixed-case function and argument names are safely quoted", async () => {
    const response = await post("/rpc/Mixed%20Echo", { "Mixed Arg": "literal" });
    expect(response.status).toBe(200); expect(await response.json()).toBe("literal");
  });

  test("single-object preference keeps the whole payload bound", async () => {
    const value = { nickname: "safe", nested: { ["data => current_user) --"]: 1 } };
    const response = await post("/rpc/named_json", value, JSON_TYPE, token(), { Prefer: "params=single-object" });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(value);
  });

  test("an overflowing first parameter cannot fall back to inline SQL", async () => {
    const response = await post("/duell/profile", { value: "x".repeat(9000) }, JSON_TYPE, token(), { Prefer: "params=single-object" });
    expect(response.status).toBe(400); expectUnchanged();
  });

  test("table names cannot contribute SQL expressions", async () => {
    const name = "items WHERE false UNION SELECT 99,'injected'--";
    const response = await stableFetch(TEST_URL + "/api/" + encodeURIComponent(name), { headers: { Authorization: "Bearer " + token() } });
    expect(response.status).toBeGreaterThanOrEqual(400); expectUnchanged();
  });

  for (const method of ["POST", "PATCH"]) {
    test(method + " column names cannot contribute SQL statements", async () => {
      const name = method === "POST" ? "id) VALUES (999); UPDATE audit.items SET value='injected'; --" : "value='injected'; --";
      const response = await stableFetch(TEST_URL + "/api/items", {
        method, headers: { Authorization: "Bearer " + token(), "Content-Type": JSON_TYPE }, body: JSON.stringify({ [name]: 1 }),
      });
      expect(response.status).toBeGreaterThanOrEqual(400); expectUnchanged();
    });
  }

  test("bulk and conflict column names cannot contribute SQL statements", async () => {
    const name = "id) VALUES (999); UPDATE audit.items SET value='injected'; --";
    const bulk = await post("/api/items", [{ [name]: 1 }]);
    expect(bulk.status).toBeGreaterThanOrEqual(400); expectUnchanged();
    const conflict = "id) DO UPDATE SET value='injected'; --";
    const response = await post("/api/items?on_conflict=" + encodeURIComponent(conflict), { id: 3, value: "safe" }, JSON_TYPE, token(), { Prefer: "resolution=merge-duplicates" });
    expect(response.status).toBeGreaterThanOrEqual(400); expectUnchanged();
  });

  test("valid named and unnamed calls still work after rejected requests", async () => {
    const named = await post("/carve/profile", { ptext: "safe" });
    expect(named.status).toBe(200); expect(await named.json()).toBe("safe");
    const unnamed = await post("/duell/profile", { nickname: "safe" });
    expect(unnamed.status).toBe(200); expect(await unnamed.json()).toEqual({ nickname: "safe" });
    expectUnchanged();
  });
});
