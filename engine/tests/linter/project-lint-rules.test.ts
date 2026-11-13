import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeRules } from "../../src/linter/executor";
import { loadRules } from "../../src/linter/loader";
import { handler as boundaryRule, underPrefix } from "../../src/linter/programmatic/no-cross-boundary-imports";
import {
  LOOM_BOUNDARIES,
  LOOM_BOUNDARY_OPTIONS,
  LOOM_RULES_DIR,
  REPO_ROOT,
  TYPESCRIPT_COMPILER_API_SEAMS,
} from "./loom-project-config";

/**
 * This repository's own project lint rules (INV-1: strict sampling is only ever preferred, never required;
 * INV-2/4/6/8: G4 slice 2's single-owner rules), read from its ONE rules
 * directory: both harnesses' edit hooks look the directory up the same way
 * (`projectRulesLayout`), so Claude Code and Pi enforce the same files.
 */

const DEFAULT_RULES_DIR = join(REPO_ROOT, "lint-rules");

describe("project lint rules: one directory for both harnesses", () => {
  it("the repository carries its rules once, in the Claude Code layout both harnesses read first", () => {
    expect(existsSync(LOOM_RULES_DIR)).toBe(true);
    expect(existsSync(join(REPO_ROOT, ".pi/linter/rules"))).toBe(false);
  });
});

/**
 * The G4 slice 2 ownership rules (INV-2, INV-4, INV-6, INV-8), each run
 * through the production loader and executor:
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
    const rule = loadRules(DEFAULT_RULES_DIR, LOOM_RULES_DIR, "full", { includeProgrammatic: false })
      .find(({ name }) => name === row.rule);
    expect(rule, row.rule).toMatchObject({ kind: "regex", enabled: true });
    if (rule === undefined) return;
    const lint = (path: string, content: string): readonly number[] =>
      executeRules([rule], join(REPO_ROOT, path), content, noDeadline, REPO_ROOT).map(({ line }) => line);

    const refusedLines = row.refused.split("\n").map((_line, index) => index + 1);
    expect(lint("engine/src/handlers/elsewhere.ts", row.refused)).toEqual(refusedLines);
    expect(lint("engine/src/handlers/elsewhere.ts", row.allowed)).toEqual([]);
    expect(lint("engine/tests/handlers/elsewhere.test.ts", row.refused)).toEqual([]);
    for (const owner of row.owners) expect(lint(owner, row.refused), owner).toEqual([]);
  });
});

/**
 * G5b INV-1 (ADR-0042, amended by ADR-0053): the TypeScript compiler API
 * enters engine code through exactly the seams granted the `typescript`
 * specifier in config.json's boundaries — the one declaration. The import
 * boundary rule enforces it: every file under `engine/src/` is governed
 * (`requireGovernance`), no boundary allows `typescript`, and a seam's grant is
 * exact, so a `typescript/...` subpath is refused even there.
 */
describe("project lint rules: the TypeScript compiler API enters only through its seams", () => {
  const PLAIN_IMPORT = "import ts from \"typescript\";";
  const SPELLINGS: readonly string[] = [
    PLAIN_IMPORT,
    "import type { SourceFile } from 'typescript';",
    "import \"typescript\";",
    "const ts = require(\"typescript\");",
    "const ts = await import(\"typescript\");",
  ];
  const SUBPATHS: readonly string[] = [
    "export * from \"typescript/lib/tsserverlibrary\";",
    "import 'typescript/lib/tsserverlibrary';",
  ];
  const refusedLines = (file: string, content: string): readonly number[] =>
    boundaryRule(content, file, LOOM_BOUNDARIES, LOOM_BOUNDARY_OPTIONS).map(({ line }) => line);

  it("G2 AD-6: the seams are exactly mutation-plan, import-graph and the skeleton ts-surface", () => {
    expect([...TYPESCRIPT_COMPILER_API_SEAMS].sort()).toEqual([
      "engine/src/core/owner-verification/import-graph.ts",
      "engine/src/core/owner-verification/mutation-plan.ts",
      "engine/src/core/skeleton/ts-surface.ts",
    ]);
  });

  it("no boundary allows typescript to every file it governs", () => {
    for (const boundary of LOOM_BOUNDARIES) {
      expect(boundary.allow.filter((prefix) => underPrefix("typescript", prefix) || underPrefix("typescript/lib/typescript", prefix)), boundary.module).toEqual([]);
    }
  });

  it.each([
    "engine/src/handlers/elsewhere.ts",
    "engine/src/orchestration/elsewhere.ts",
    "engine/src/linter/elsewhere.ts",
    "engine/src/core/skeleton/java-surface.ts",
    "engine/src/core/owner-verification/elsewhere.ts",
  ])("refuses every spelling of the edge, subpaths included, from %s", (file) => {
    const content = [...SPELLINGS, ...SUBPATHS].join("\n");
    expect(refusedLines(file, content)).toEqual(content.split("\n").map((_line, index) => index + 1));
  });

  it("refuses a new engine module no boundary governs, whatever it imports", () => {
    expect(refusedLines("engine/src/new-root-module.ts", PLAIN_IMPORT)).toEqual([1]);
  });

  it.each([...TYPESCRIPT_COMPILER_API_SEAMS])("admits the exact specifier, in every spelling, in the seam %s — and no subpath", (seam) => {
    expect(refusedLines(seam, SPELLINGS.join("\n"))).toEqual([]);
    expect(refusedLines(seam, SUBPATHS.join("\n"))).toEqual([1, 2]);
  });
});