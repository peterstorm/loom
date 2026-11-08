/**
 * Binds `commands/security-audit.md` to the operation table it describes, on the
 * model of `spec-check-command-contract.test.ts`.
 *
 * The command file is a hand-written mirror of a typed table `tsc` cannot see
 * and no other test reads. Every drift it can carry is a real defect an operator
 * meets at run time: an operation the command names that the program does not
 * declare (a hard error, because the set is closed), an operation the program
 * declares that the command never mentions (a capability nobody reaches), an
 * `input` column that disagrees with the traits table (a flags-only operation
 * invoked with a payload that is then silently ignored), or a claim that a
 * read-only projection survives a runtime skew when its traits say otherwise.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SECURITY_AUDIT_OPERATIONS,
  parseSecurityAuditOperation,
  securityAuditOperationWrites,
} from "../../src/handlers/helpers/security-audit-operations";

const command = readFileSync(new URL("../../../commands/security-audit.md", import.meta.url), "utf8");

/** One row of the command's operation table: `| `op` | input | … |`. */
type Row = Readonly<{ operation: string; input: string }>;

const tableRows = (): readonly Row[] =>
  command
    .split("\n")
    .flatMap((line) => {
      const match = /^\|\s*`([a-z-]+)`\s*\|\s*([a-z]+)\s*\|/.exec(line);
      return match === null ? [] : [{ operation: match[1] ?? "", input: match[2] ?? "" }];
    });

describe("commands/security-audit.md", () => {
  it("names only operations the program declares", () => {
    expect(tableRows().length).toBeGreaterThan(0);
    for (const row of tableRows()) {
      // The operation set is CLOSED: an undeclared name is not a typo in the
      // docs, it is a command that exits with "unknown operation".
      expect(parseSecurityAuditOperation(row.operation), row.operation).toBe(row.operation);
    }
  });

  it("names every operation the program declares, exactly once", () => {
    const named = tableRows().map((row) => row.operation);
    expect(new Set(named).size).toBe(named.length);
    expect(named.sort()).toEqual(Object.keys(SECURITY_AUDIT_OPERATIONS).sort());
  });

  it("declares, for each operation, the input the traits table declares", () => {
    for (const row of tableRows()) {
      expect(row.input, row.operation).toBe(SECURITY_AUDIT_OPERATIONS[row.operation as keyof typeof SECURITY_AUDIT_OPERATIONS].input);
      expect(["stdin", "flags"]).toContain(row.input);
    }
  });

  it("tells the operator which projections survive a runtime skew", () => {
    const available = Object.entries(SECURITY_AUDIT_OPERATIONS)
      .filter(([, traits]) => traits.runtimeSkew === "available")
      .map(([operation]) => operation)
      .sort();
    // The command says "`status` and `findings` stay available while the Pi
    // runtime is skewed". If the traits change, that sentence is wrong, and an
    // operator recovering from a skew is exactly who reads it.
    expect(available).toEqual(["findings", "status"]);
    for (const operation of available) {
      expect(command, operation).toContain(`\`${operation}\``);
    }
    for (const operation of Object.keys(SECURITY_AUDIT_OPERATIONS)) {
      if (available.includes(operation)) continue;
      expect(securityAuditOperationWrites(operation as keyof typeof SECURITY_AUDIT_OPERATIONS), operation).toBe(true);
    }
  });

  it("names the run directory as the argument every operation takes", () => {
    expect(command).toContain("--out <run-dir>");
    expect(command).toContain("the run directory is the whole record");
  });

  it("draws the line the ADR draws: the audit never patches", () => {
    // An audit that patches cannot keep its coverage claims checkable, so the
    // handoff is `/review-and-fix` and the command has to say so.
    expect(command).toContain("never patches");
    expect(command).toContain("/review-and-fix");
    expect(command).toContain("standalone-disposition");
    expect(securityAuditOperationWrites("disposition")).toBe(true);
    expect(securityAuditOperationWrites("status")).toBe(false);
    expect(securityAuditOperationWrites("findings")).toBe(false);
  });
});
