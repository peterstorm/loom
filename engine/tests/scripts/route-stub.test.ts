/**
 * The façade smoke's route stub (`scripts/route-stub.ts`): its port
 * announcement is parsed, so a malformed line fails the stub's start naming
 * that line rather than surfacing later as an opaque route-probe failure.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseRouteStubPort, startRouteStub } from "../../../scripts/route-stub";

const refusal = (line: string): string =>
  `route stub announced ${JSON.stringify(line)} instead of its TCP port (an integer in 1..65535)`;

describe("parseRouteStubPort", () => {
  it("admits exactly the TCP ports 1..65535, as the stub prints them (property)", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 65_535 }), (port) => {
      expect(parseRouteStubPort(String(port))).toEqual({ ok: true, value: port });
    }));
  });

  it.each(["", "NaN", "0", "65536", "99999", "-1", "+80", "080", "80.0", "8e3", " 80", "80 ", "80\r", "0x50", "listening on 80"])(
    "refuses %j, naming the line it got",
    (line) => {
      expect(parseRouteStubPort(line)).toEqual({ ok: false, error: refusal(line) });
    },
  );

  it("refuses every line that is not a canonical decimal port (property)", () => {
    fc.assert(fc.property(fc.string(), (line) => {
      const canonical = /^[1-9][0-9]*$/.test(line) && Number(line) <= 65_535;
      expect(parseRouteStubPort(line).ok).toBe(canonical);
    }));
  });
});

describe("startRouteStub", () => {
  it("serves exactly the named model at GET /v1/models on the port it announced, until stopped", async () => {
    const stub = await startRouteStub("stub-model");
    try {
      expect(parseRouteStubPort(String(stub.port)).ok).toBe(true);
      const listed = await fetch(`http://127.0.0.1:${stub.port}/v1/models`);
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({ object: "list", data: [{ id: "stub-model", object: "model" }] });
      expect((await fetch(`http://127.0.0.1:${stub.port}/elsewhere`)).status).toBe(404);
    } finally {
      stub.stop();
    }
  });
});
