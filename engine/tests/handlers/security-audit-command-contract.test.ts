/**
 * Binds the operations table in `docs/security-audit.md` — the one table, which
 * `commands/security-audit.md` points at — to the operation table it describes,
 * on the model of `spec-check-command-contract.test.ts`.
 *
 * The doc's table is a hand-written mirror of a typed table `tsc` cannot see
 * and no other test reads. Every drift it can carry is a real defect an operator
 * meets at run time: an operation the table names that the program does not
 * declare (a hard error, because the set is closed), an operation the program
 * declares that the table never mentions (a capability nobody reaches), an
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
import { describeMarkdownError, markdown, orFail, sectionOf, tableWithColumns, tablesOf, type Table } from "../support/markdown";

const command = readFileSync(new URL("../../../commands/security-audit.md", import.meta.url), "utf8");
const operatorGuide = readFileSync(new URL("../../../docs/security-audit.md", import.meta.url), "utf8");

/** One row of an operation table: `| `op` | input … | … |`. The input cell
 *  starts with `stdin` or `flags`; the operator guide follows it with the
 *  payload keys or flag names, which this binding does not read. A cell that
 *  does not have that shape is kept whole, so the assertions below name it. */
type Row = Readonly<{ operation: string; input: string }>;

/** An operation cell: one code span holding an operation-shaped name. */
const OPERATION_CELL = /^`([a-z-]+)`$/;

/** The rows of the guide's operations table: the one table in its Operations section with an Operation and an Input column. */
const tableRows = (): readonly Row[] => {
  const section = orFail(sectionOf(markdown("docs/security-audit.md", operatorGuide), "Operations"), describeMarkdownError);
  return orFail(tableWithColumns(section, ["Operation", "Input"]), describeMarkdownError).rows.map(({ cells }) => ({
    operation: OPERATION_CELL.exec(cells.Operation)?.[1] ?? cells.Operation,
    input: /^[a-z]+\b/.exec(cells.Input)?.[0] ?? cells.Input,
  }));
};

/** A table that lists operations: it has an Operation column, or its first column names one. */
const isOperationsTable = (table: Table): boolean =>
  table.columns.includes("Operation")
  || table.rows.some(({ cells }) => OPERATION_CELL.test(cells[table.columns[0] ?? ""] ?? ""));

// The operator guide is where an operator reads what each operation takes and
// refuses; it owns the ONE operations table. The operation set is CLOSED, so an
// undeclared name is not a typo in the docs — it is a command that exits
// "unknown operation" — and an operation missing from the table is a capability
// (or a refusal set) nobody documented.
describe("the operations table of docs/security-audit.md", () => {
  it("names every operation the program declares, exactly once, and no other", () => {
    const rows = tableRows();
    expect(rows.length).toBeGreaterThan(0);
    const named = rows.map((row) => row.operation);
    expect(new Set(named).size).toBe(named.length);
    expect([...named].sort()).toEqual(Object.keys(SECURITY_AUDIT_OPERATIONS).sort());
    for (const row of rows) expect(parseSecurityAuditOperation(row.operation), row.operation).toBe(row.operation);
  });

  it("declares, for each operation, the input the traits table declares", () => {
    for (const row of tableRows()) {
      expect(["stdin", "flags"]).toContain(row.input);
      expect(row.input, row.operation).toBe(SECURITY_AUDIT_OPERATIONS[row.operation as keyof typeof SECURITY_AUDIT_OPERATIONS].input);
    }
  });

  it("tells the operator which projections survive a runtime skew", () => {
    const available = Object.entries(SECURITY_AUDIT_OPERATIONS)
      .filter(([, traits]) => traits.runtimeSkew === "available")
      .map(([operation]) => operation)
      .sort();
    // The guide says "`status`, `findings` and `nonce` are read-only … and stay
    // available while the Pi runtime is skewed". If the traits change, that
    // sentence is wrong, and an operator recovering from a skew is exactly who
    // reads it.
    expect(available).toEqual(["findings", "nonce", "status"]);
    const prose = operatorGuide.replace(/\s+/g, " ");
    expect(prose).toContain("`status`, `findings` and `nonce` are read-only");
    expect(prose).toContain("stay available while the Pi runtime is skewed");
    for (const operation of Object.keys(SECURITY_AUDIT_OPERATIONS)) {
      if (available.includes(operation)) continue;
      expect(securityAuditOperationWrites(operation as keyof typeof SECURITY_AUDIT_OPERATIONS), operation).toBe(true);
    }
  });
});

describe("commands/security-audit.md", () => {
  it("keeps no operations table of its own and points at the guide's", () => {
    // One owner per fact: a second table is a second place to drift. The
    // command is the parent's entry point, so it must send the parent to the
    // table the block above binds.
    const tables = orFail(tablesOf(markdown("commands/security-audit.md", command)), describeMarkdownError);
    expect(tables.filter(isOperationsTable)).toEqual([]);
    expect(command).toContain("docs/security-audit.md");
    expect(command).toContain("skills/security-audit/SKILL.md");
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
