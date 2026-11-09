/**
 * The per-operation helpers' route traits come from ONE registry in
 * handler-routes: both route predicates (Pi runtime handshake, stdin
 * consumption) must agree with each helper's own operation table, and an
 * unknown operation must resolve the same way for every helper.
 */
import { describe, expect, it } from "vitest";
import { piRuntimeHandshakeRequired, routeConsumesStdin } from "../../src/handler-routes";
import { ORCHESTRATION_OPERATIONS } from "../../src/handlers/helpers/orchestration-operations";
import { SECURITY_AUDIT_OPERATIONS } from "../../src/handlers/helpers/security-audit-operations";

const OPERATION_TABLES: ReadonlyArray<readonly [string, Readonly<Record<string, Readonly<{ input: string; runtimeSkew: string }>>>]> = [
  ["orchestration", ORCHESTRATION_OPERATIONS],
  ["security-audit", SECURITY_AUDIT_OPERATIONS],
];

describe("operation helpers route by their own operation tables", () => {
  it.each(OPERATION_TABLES)("helper %s: every operation's handshake and stdin traits match its table", (helper, table) => {
    for (const [operation, traits] of Object.entries(table)) {
      expect(piRuntimeHandshakeRequired("helper", helper, [operation]), `${helper} ${operation}`)
        .toBe(traits.runtimeSkew !== "available");
      expect(routeConsumesStdin("helper", helper, [operation]), `${helper} ${operation}`)
        .toBe(traits.input === "stdin");
    }
  });

  it.each(OPERATION_TABLES)("helper %s: an unknown or missing operation needs the handshake and reads no stdin", (helper) => {
    for (const extraArgs of [["no-such-operation"], []]) {
      expect(piRuntimeHandshakeRequired("helper", helper, extraArgs)).toBe(true);
      expect(routeConsumesStdin("helper", helper, extraArgs)).toBe(false);
    }
  });

  it("judges every other route as a whole", () => {
    expect(routeConsumesStdin("pre-tool-use", "guard-state-file")).toBe(true);
    expect(routeConsumesStdin("helper", "set-phase", ["anything"])).toBe(true);
    expect(piRuntimeHandshakeRequired("helper", "set-phase", ["anything"])).toBe(true);
    // A handler named like an operation helper under another hook type is not one.
    expect(routeConsumesStdin("pre-tool-use", "orchestration", ["status"])).toBe(true);
    // An inherited property name is not a registry row.
    expect(routeConsumesStdin("helper", "constructor", [])).toBe(true);
  });
});
