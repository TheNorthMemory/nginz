import { describe, test, expect } from "bun:test";
import { PostgresMock } from "./postgres.js";

describe("PostgreSQL mock response transport", () => {
  test("partial and zero writes preserve complete frames in protocol order", () => {
    const mock = new PostgresMock();
    const accepted = [];
    const capacities = [3, 0, 2];
    let writeCalls = 0;
    const socket = { write(data) {
      writeCalls++;
      const count = Math.min(capacities.shift() ?? data.length, data.length);
      accepted.push(data.subarray(0, count));
      return count;
    } };
    mock.sendQueryResult(socket, [{ name: "value", typeOid: 3802 }], [['"payload"']]);
    mock.write(socket, Buffer.from([0x5a, 0, 0, 0, 5, 0x49]));
    expect(writeCalls).toBe(1);
    for (let drain = 0; drain < 3; drain++) {
      socket.pgWriteBlocked = false;
      mock.flushWrites(socket);
    }
    expect(socket.pgPendingWrites.length).toBe(0);
    const wire = Buffer.concat(accepted);
    const frames = [];
    for (let offset = 0; offset < wire.length;) {
      const length = wire.readInt32BE(offset + 1);
      expect(offset + length + 1).toBeLessThanOrEqual(wire.length);
      frames.push({ type: String.fromCharCode(wire[offset]),
        body: wire.subarray(offset + 5, offset + length + 1) });
      offset += length + 1;
    }
    expect(frames.map(frame => frame.type)).toEqual(["T", "D", "C", "Z"]);
    expect(frames[1].body.readInt16BE(0)).toBe(1);
    expect(frames[1].body.readInt32BE(2)).toBe(9);
    expect(frames[1].body.subarray(6).toString()).toBe('"payload"');
    expect(frames[2].body.toString()).toBe("SELECT 1\0");
    expect(frames[3].body.toString()).toBe("I");
  });

  test("a closed socket discards pending frames without retrying writes", () => {
    const mock = new PostgresMock();
    let writeCalls = 0;
    const socket = { write() { writeCalls++; return -1; } };
    mock.sendQueryResult(socket, ["value"], [["discarded"]]);
    mock.write(socket, Buffer.from([0x5a, 0, 0, 0, 5, 0x49]));
    mock.flushWrites(socket);
    expect(writeCalls).toBe(1);
    expect(socket.pgPendingWrites).toEqual([]);
    expect(socket.pgWriteClosed).toBe(true);
  });
});
