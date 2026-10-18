import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { executeRules } from "../../src/linter/executor";
import { loadRules } from "../../src/linter/loader";

/**
 * This repository's own project lint rules (INV-1: strict sampling is only ever preferred, never required;
 * INV-2/4/6/8: G4 slice 2's single-owner rules).
 * Each harness loads exactly ONE project rules directory (`PROJECT_RULES_DIR`
 * in engine/src/config.ts: `.pi/linter/rules` under Pi,
 * `.claude/linter/rules` under Claude Code), so each invariant must be present
 * in both — with one owner. `.claude/linter/rules` holds the canonical rule
 * files; every `.pi/linter/rules` entry is a byte-identical regular-file copy
 * of its canonical twin, and this suite fails the moment the two diverge. A
 * symlink would be the tighter tie, but registered remediation refuses to
 * install symlinked paths, so the copy plus this parity check is the owner.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const DEFAULT_RULES_DIR = join(REPO_ROOT, "lint-rules");
const CANONICAL = join(REPO_ROOT, ".claude/linter/rules");
const PI = join(REPO_ROOT, ".pi/linter/rules");

const ruleFiles = (dir: string): readonly string[] => readdirSync(dir).filter((name) => name.endsWith(".json")).sort();

describe("project lint rules: one source for both harnesses", () => {
  it("both harness directories carry the same rule set", () => {
    expect(ruleFiles(CANONICAL)).toContain("inv-1-no-strict-require-constraint.json");
    expect(ruleFiles(PI)).toEqual(ruleFiles(CANONICAL));
  });

  it("every Pi rule is a regular-file, byte-identical copy of its canonical Claude Code rule", () => {
    for (const name of ruleFiles(PI)) {
      expect(lstatSync(join(PI, name)).isFile(), name).toBe(true);
      expect(readFileSync(join(PI, name)), name).toEqual(readFileSync(join(CANONICAL, name)));
    }
  });

  it("loads the identical INV-1 rule under either harness", () => {
    const inv1 = (projectDir: string) => loadRules(DEFAULT_RULES_DIR, projectDir, "full", { includeProgrammatic: false })
      .find((rule) => rule.name === "inv-1-no-strict-require-constraint");
    const claude = inv1(CANONICAL);
    expect(claude).toMatchObject({ kind: "regex", enabled: true });
    expect(inv1(PI)).toEqual(claude);
  });
});

/**
 * The G4 slice 2 ownership rules (INV-2, INV-4, INV-6, INV-8), each run
 * through the production loader and executor under both harness directories:
 * the line it exists to refuse is refused outside its owner, the owner and
 * test files are exempt, and the owner's own sanctioned spelling passes.
 */
type OwnershipRow = Readonly<{
  rule: string;
  refused: string;
  allowed: string;
  owners: readonly string[];
}>;

const OWNERSHIP_RULES: readonly OwnershipRow[] = [
  {
    rule: "inv-2-one-test-file-classifier",
    refused: "const TEST_FILE_SUFFIXES = [\".test.ts\"];\nif (path.endsWith(\".spec.ts\")) return true;",
    allowed: "import { DEFAULT_TEST_FILE_SUFFIXES } from \"./test-file-classification\";",
    owners: ["engine/src/core/test-file-classification.ts"],
  },
  {
    rule: "inv-4-one-evidence-minting-rule",
    refused: "const facts = extractEvidence(call);\nregistry.appendEvidence(session, epoch, facts);",
    allowed: "return recordToolEvidence(decision, call, ports);",
    owners: ["engine/src/machine/extract-evidence.ts", "engine/src/machine/tool-evidence-recorder.ts"],
  },
  {
    rule: "inv-6-one-red-then-green-era-test",
    refused: [
      "if (manifest.testFiles === undefined) return \"not-owed\";",
      "const owed = m.testFiles !== null;",
      "if (undefined === manifest.testFiles) return;",
      "if (!manifest.testFiles) return;",
      "const declared = \"testFiles\" in manifest;",
      "const frozen = manifest?.testFiles;",
      "const files = manifest.testFiles ?? ENGINE_DEFAULT_TEST_FILES;",
      "const { testFiles } = graph.verification_manifest ?? {};",
      "const raw = manifest[\"testFiles\"];",
    ].join("\n"),
    allowed: "const era = frozenRedThenGreenEra(graph.verification_manifest);\nconst split = classifyTaskFiles(fileList, duty.testFiles);",
    owners: ["engine/src/core/proof-obligations.ts", "engine/src/core/verification-manifest.ts"],
  },
  {
    rule: "inv-8-sole-report-summary-constructor",
    refused: "return { total, failed, source } as TestReportSummary;\nreturn { total, failed, source } as ReportCounts;",
    allowed: "return parseReportSummary(total, failed, source, files);\nreturn parseReportCounts(total, failed, source);",
    owners: ["engine/src/core/structured-test-report.ts"],
  },
];

const noDeadline = (): void => undefined;

describe("project lint rules: the G4 slice 2 ownership rules refuse a second owner", () => {
  it.each(OWNERSHIP_RULES)("$rule refuses each line outside its owners, and spares its owners, test files and the sanctioned call", (row) => {
    for (const projectDir of [CANONICAL, PI]) {
      const rule = loadRules(DEFAULT_RULES_DIR, projectDir, "full", { includeProgrammatic: false })
        .find(({ name }) => name === row.rule);
      expect(rule, `${row.rule} under ${projectDir}`).toMatchObject({ kind: "regex", enabled: true });
      if (rule === undefined) return;
      const lint = (path: string, content: string): readonly number[] =>
        executeRules([rule], join(REPO_ROOT, path), content, noDeadline).map(({ line }) => line);

      const refusedLines = row.refused.split("\n").map((_line, index) => index + 1);
      expect(lint("engine/src/handlers/elsewhere.ts", row.refused)).toEqual(refusedLines);
      expect(lint("engine/src/handlers/elsewhere.ts", row.allowed)).toEqual([]);
      expect(lint("engine/tests/handlers/elsewhere.test.ts", row.refused)).toEqual([]);
      for (const owner of row.owners) expect(lint(owner, row.refused), owner).toEqual([]);
    }
  });
});
