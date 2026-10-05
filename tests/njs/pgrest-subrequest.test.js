import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createPostgresMock } from "../pgrest/mock.js";
import {
  startNginz,
  stopNginz,
  cleanupRuntime,
  TEST_URL,
  MOCK_PORTS,
  teardownModule,
  prepareMockPorts,
  testFetch,
} from "../harness.js";


const MODULE = "njs";

function setupPgMock() {
  const pgMock = createPostgresMock(MOCK_PORTS.POSTGRES);

  // Catch-all: any SELECT involving "users" returns 3 rows
  pgMock.setQueryHandler(/users/i, (query) => {
    if (/SELECT.*count\(\*\)/i.test(query)) {
      return { columns: ["count"], rows: [["3"]] };
    }
    // All other user queries return JSON-safe data
    return {
      columns: ["id", "name", "email", "status"],
      rows: [
        ["1", "Alice", "alice@test.com", "active"],
        ["2", "Bob", "bob@test.com", "active"],
        ["3", "Carol", "carol@test.com", "inactive"],
      ],
    };
  });

  // INSERT returns success
  pgMock.setQueryHandler(/INSERT INTO "public"."users"/i, () => ({
    columns: [],
    rows: [],
  }));

  pgMock.setQueryHandler(/SELECT p\.provolatile.*p\.proname\s*=\s*'add_them'/, () => ({
    columns: ["provolatile", "proretset", "rettype_is_composite", "has_variadic", "unnamed_count", "single_unnamed_kind", "variadic_param_name", "input_param_names", "match_rank", "input_types", "returns_void", "signature"],
    rows: [["i", "f", "f", "f", "0", "", "", "a,b", "0", '{"a":"integer","b":"integer"}', "f", "a => integer, b => integer"]],
  }));

  // Handle unrelated introspection queries with empty results.
  pgMock.setQueryHandler(/pg_constraint|pg_class|pg_attribute|pg_namespace|pg_type|information_schema/i, () => ({
    columns: ["dummy"],
    rows: [],
  }));

  pgMock.setQueryHandler(/add_them/i, () => ({
    columns: [{ name: "add_them", typeOid: 23 }],
    rows: [[3]],
  }));

  return pgMock;
}

// Keep reads, writes and RPC in one lifecycle to detect sequence regressions.
describe("njs pgrest subrequests", () => {
  let pgMock;

  beforeAll(async () => {
    await prepareMockPorts(MOCK_PORTS.POSTGRES);
    pgMock = setupPgMock();
    await startNginz("tests/njs/pgrest-subrequest.conf", MODULE);
  }, 30000);

  afterAll(async () => {
    await teardownModule(MODULE, [pgMock], [MOCK_PORTS.POSTGRES]);
  });

  test("subrequest GET /api/users returns array", async () => {
    const res = await testFetch(`/njs/pgrest/users`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(3);
    expect(body[0]).toHaveProperty("id");
    expect(body[0]).toHaveProperty("name");
  });

  test("subrequest GET /api/users with id filter and select", async () => {
    const res = await testFetch(`/njs/pgrest/users-filtered?id=1&select=id,name`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toHaveProperty("id");
    expect(body[0]).toHaveProperty("name");
  });

  test("subrequest POST /api/users creates a user", async () => {
    const res = await testFetch(`/njs/pgrest/users-create`, {
      method: "POST",
      body: JSON.stringify({ name: "Dave", email: "dave@test.com" }),
    });
    // pgrest returns 201 on successful POST
    expect(res.status).toBe(201);
  });

  test("subrequest RPC calls a function", async () => {
    const res = await testFetch(`/njs/pgrest/rpc?fn=add_them&a=1&b=2`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toBe(3);
  });

  test("subrequest PATCH /api/users updates a user", async () => {
    const res = await testFetch(`/njs/pgrest/users-update?id=1`, {
      method: "POST",
      body: JSON.stringify({ name: "Alice-Updated" }),
    });
    expect(res.status).toBe(204);
  });

  test("subrequest DELETE /api/users removes a user", async () => {
    const res = await testFetch(`/njs/pgrest/users-delete?id=3`, {
      method: "POST",
    });
    expect(res.status).toBe(204);
  });
});
