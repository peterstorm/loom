/**
 * Binds `commands/security-audit.md` — and the authoritative operations table in
 * `docs/security-audit.md` — to the operation table they describe, on the model
 * of `spec-check-command-contract.test.ts`.
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
const operatorGuide = readFileSync(new URL("../../../docs/security-audit.md", import.meta.url), "utf8");

/** One row of an operation table: `| `op` | input … | … |`. The input cell
 *  starts with `stdin` or `flags`; the operator guide follows it with the
 *  payload keys or flag names, which this binding does not read. */
type Row = Readonly<{ operation: string; input: string }>;

const tableRows = (document: string): readonly Row[] =>
  document
    .split("\n")
    .flatMap((line) => {
      const match = /^\|\s*`([a-z-]+)`\s*\|\s*([a-z]+)\b[^|]*\|/.exec(line);
      return match === null ? [] : [{ operation: match[1] ?? "", input: match[2] ?? "" }];
    });

// The operator guide is where an operator reads what each operation refuses,
// the command file is the parent's runbook: both tables are held to ONE rule.
// The operation set is CLOSED, so an undeclared name is not a typo in the docs
// — it is a command that exits "unknown operation" — and an operation missing
// from a table is a capability (or a refusal set) nobody documented.
describe.each([
  ["docs/security-audit.md", operatorGuide],
  ["commands/security-audit.md", command],
] as const)("the operations table of %s", (_name, document) => {
  it("names every operation the program declares, exactly once, and no other", () => {
    const rows = tableRows(document);
    expect(rows.length).toBeGreaterThan(0);
    const named = rows.map((row) => row.operation);
    expect(new Set(named).size).toBe(named.length);
    expect([...named].sort()).toEqual(Object.keys(SECURITY_AUDIT_OPERATIONS).sort());
    for (const row of rows) expect(parseSecurityAuditOperation(row.operation), row.operation).toBe(row.operation);
  });

  it("declares, for each operation, the input the traits table declares", () => {
    for (const row of tableRows(document)) {
      expect(["stdin", "flags"]).toContain(row.input);
      expect(row.input, row.operation).toBe(SECURITY_AUDIT_OPERATIONS[row.operation as keyof typeof SECURITY_AUDIT_OPERATIONS].input);
    }
  });
});

describe("commands/security-audit.md", () => {
  it("tells the operator which projections survive a runtime skew", () => {
    const available = Object.entries(SECURITY_AUDIT_OPERATIONS)
      .filter(([, traits]) => traits.runtimeSkew === "available")
      .map(([operation]) => operation)
      .sort();
    // The command says "`status`, `findings` and `nonce` stay available while
    // the Pi runtime is skewed". If the traits change, that sentence is wrong,
    // and an operator recovering from a skew is exactly who reads it.
    expect(available).toEqual(["findings", "nonce", "status"]);
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
    expect(securityAuditOperationWrites("nonce")).toBe(false);
  });

  it("tells the parent how a hunter's receipt gets its nonce", () => {
    // A hunter cannot compute the nonce its receipt is bound to; the command is
    // the parent's runbook, so it must name the operation that prints it.
    expect(command).toContain("security-audit nonce --out");
    expect(operatorGuide).toContain("security-audit nonce --out");
  });
});
