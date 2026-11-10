/**
 * The per-operation helpers' route traits come from ONE registry in
 * handler-routes: both route predicates (Pi runtime handshake, stdin
 * consumption) must agree with each helper's own operation table, and an
 * unknown operation must resolve the same way for every helper. This is the
 * one table-driven suite at that seam; the e2e stdin test keeps only the
 * process-level hang probes.
 *
 * Each operation table declares one trait per policy (skew, run-directory
 * writes, subagent authority), and each policy has exactly one reader. The
 * sets each reader derives are pinned here by name, so splitting the traits
 * apart changed no decision — and a future row edit that changes one is a
 * visible, deliberate diff.
 */
import { describe, expect, it } from "vitest";
import { piRuntimeHandshakeRequired, routeConsumesStdin } from "../../src/handler-routes";
import { ORCHESTRATION_OPERATIONS } from "../../src/handlers/helpers/orchestration-operations";
import {
  SECURITY_AUDIT_OPERATIONS,
  SECURITY_AUDIT_OPERATION_ORDER,
  securityAuditOperationWrites,
} from "../../src/handlers/helpers/security-audit-operations";
import { AUTHORITY_HELPER_OPERATIONS } from "../../src/handlers/pre-tool-use/subagent-authority-operations";

type RouteTraits = Readonly<{ input: "stdin" | "flags"; runtimeSkew: "available" | "handshake-required" }>;

const OPERATION_TABLES: ReadonlyArray<readonly [string, Readonly<Record<string, RouteTraits>>]> = [
  ["orchestration", ORCHESTRATION_OPERATIONS],
  ["security-audit", SECURITY_AUDIT_OPERATIONS],
];

const sorted = (names: Iterable<string>): readonly string[] => [...names].sort();

describe("operation helpers route by their own operation tables", () => {
  it.each(OPERATION_TABLES)("helper %s: every operation's handshake and stdin traits match its table", (helper, table) => {
    for (const [operation, traits] of Object.entries(table)) {
      expect(piRuntimeHandshakeRequired("helper", helper, [operation]), `${helper} ${operation}`)
        .toBe(traits.runtimeSkew === "handshake-required");
      expect(routeConsumesStdin("helper", helper, [operation]), `${helper} ${operation}`)
        .toBe(traits.input === "stdin");
    }
  });

  it.each(OPERATION_TABLES)("helper %s: an unknown, missing or inherited-name operation needs the handshake and reads no stdin", (helper) => {
    for (const extraArgs of [["no-such-operation"], [], ["toString"], ["constructor"]]) {
      expect(piRuntimeHandshakeRequired("helper", helper, extraArgs), extraArgs.join(" ")).toBe(true);
      expect(routeConsumesStdin("helper", helper, extraArgs), extraArgs.join(" ")).toBe(false);
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
    expect(piRuntimeHandshakeRequired("helper", "constructor", [])).toBe(false);
  });
});

describe("each policy reads its own trait, and the decisions are the ones the tables made before the split", () => {
  it("orchestration: the Pi handshake exempts exactly the read-only projections", () => {
    const exempt = Object.keys(ORCHESTRATION_OPERATIONS).filter((op) => !piRuntimeHandshakeRequired("helper", "orchestration", [op]));
    expect(sorted(exempt)).toEqual(["brief", "inspect", "status"]);
  });

  it("security-audit: the Pi handshake exempts exactly the read-only projections", () => {
    const exempt = SECURITY_AUDIT_OPERATION_ORDER.filter((op) => !piRuntimeHandshakeRequired("helper", "security-audit", [op]));
    expect(sorted(exempt)).toEqual(["findings", "nonce", "status"]);
  });

  it("security-audit: the run directory is prepared for exactly the writing operations", () => {
    expect(sorted(SECURITY_AUDIT_OPERATION_ORDER.filter(securityAuditOperationWrites))).toEqual(
      ["assign", "defer", "disposition", "merge-critic", "publish", "start", "submit", "verify"]);
  });

  it("a subagent may run exactly the read-only projections of each helper", () => {
    expect(sorted(AUTHORITY_HELPER_OPERATIONS["security-audit"].readOnly)).toEqual(["findings", "nonce", "status"]);
    expect(sorted(AUTHORITY_HELPER_OPERATIONS.orchestration.readOnly)).toEqual(["brief", "inspect", "status"]);
    expect(sorted(AUTHORITY_HELPER_OPERATIONS["security-audit"].known)).toEqual(sorted(Object.keys(SECURITY_AUDIT_OPERATIONS)));
    expect(sorted(AUTHORITY_HELPER_OPERATIONS.orchestration.known)).toEqual(sorted(Object.keys(ORCHESTRATION_OPERATIONS)));
  });

  it("the subagent split reads the subagent trait, not the skew trait", () => {
    for (const [helper, table] of [["security-audit", SECURITY_AUDIT_OPERATIONS], ["orchestration", ORCHESTRATION_OPERATIONS]] as const) {
      const readOnly = Object.entries(table).filter(([, traits]) => traits.subagent === "read-only").map(([name]) => name);
      expect(sorted(AUTHORITY_HELPER_OPERATIONS[helper].readOnly), helper).toEqual(sorted(readOnly));
    }
  });

  it("the run-directory derivation reads the run-directory trait, not the skew trait", () => {
    for (const operation of SECURITY_AUDIT_OPERATION_ORDER) {
      expect(securityAuditOperationWrites(operation), operation)
        .toBe(SECURITY_AUDIT_OPERATIONS[operation].runDirectory === "writes");
    }
  });
});
