import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Derived-and-verified doc facts: every volatile count docs/feature-guard-map.md
// states is derived here from the tree at test time, so a change that moves a
// number breaks this test instead of waiting for the next human audit.
// Counts use the newline convention (wc -l) so the stamped figures stay
// comparable with the earlier recorded verdicts.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function walk(relDir: string): string[] {
  const out: string[] = [];
  const step = (absDir: string): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) step(abs);
      else out.push(abs);
    }
  };
  step(join(repoRoot, relDir));
  return out.map((abs) => posix.relative(repoRoot, abs).split("\\").join("/"));
}

const lineCount = (repoPath: string): number =>
  (readFileSync(join(repoRoot, repoPath), "utf8").match(/\n/g) ?? []).length;

const sumLines = (paths: readonly string[]): number => paths.reduce((n, f) => n + lineCount(f), 0);

const kOf = (lines: number): string => (lines / 1000).toFixed(1);

const srcFiles = walk("engine/src").filter((f) => f.endsWith(".ts"));
const srcLines = sumLines(srcFiles);

const testTs = walk("engine/tests").filter((f) => f.endsWith(".ts"));
const testTsLines = sumLines(testTs);
const engineTestFiles = testTs.filter((f) => f.endsWith(".test.ts"));
const calProbes = [...walk("calibration"), ...walk("probes")].filter((f) => /\.test\.(ts|mjs)$/.test(f));
const executed = engineTestFiles.length + calProbes.length;

const perDirTestFiles = Object.fromEntries(
  ["core", "handlers", "pi", "linter", "orchestration", "utils", "machine", "acceptance", "security"].map((dir) => [
    dir,
    walk(join("engine/tests", dir)).filter((f) => f.endsWith(".test.ts")).length,
  ]),
);

const docsMd = walk("docs").filter((f) => f.endsWith(".md"));
const adrCount = docsMd.filter((f) => f.startsWith("docs/adr/ADR-")).length;
const commandsMd = walk("commands").filter((f) => f.endsWith(".md"));
const waveModules = readdirSync(join(repoRoot, "engine/src/core")).filter((f) => f.startsWith("wave-"));
const extLines = lineCount("pi/extension.ts");
const rulesLines = readdirSync(join(repoRoot, "rules"))
  .filter((f) => f.endsWith(".md"))
  .reduce((n, f) => n + lineCount(posix.join("rules", f)), 0);

const guardMap = readFileSync(join(repoRoot, "docs/feature-guard-map.md"), "utf8");
const guardMapRows = guardMap.split("\n");
const layoutRow = (label: string): string => {
  const line = guardMapRows.find((l) => l.startsWith(`| \`${label}/\` |`));
  expect(line, `layout row for ${label}`).toBeDefined();
  return line as string;
};

describe("feature-guard-map derived facts", () => {
  it("the §2 layout table's size cells match the tree", () => {
    expect(layoutRow("agents")).toContain(`| ${walk("agents").filter((f) => f.endsWith(".md")).length} files |`);
    expect(layoutRow("skills")).toContain(`| ${walk("skills").length} files |`);
    expect(layoutRow("commands")).toContain(`| ${commandsMd.length} files |`);
    expect(layoutRow("rules")).toContain(`| ${rulesLines} lines |`);
    expect(layoutRow("references")).toContain(`| ${walk("references").length} files |`);
    expect(layoutRow("lint-rules")).toContain(`| ${walk("lint-rules").length} files |`);
    expect(layoutRow("machines")).toContain(`| ${walk("machines").length} files |`);
    expect(layoutRow("hooks")).toContain(`| ${walk("hooks").length} files |`);
    expect(layoutRow("probes")).toContain(`| ${walk("probes").length} files |`);
    expect(layoutRow("scripts")).toContain(`| ${readdirSync(join(repoRoot, "scripts")).length} files |`);
    expect(layoutRow("calibration")).toContain(`| ${walk("calibration").length} files |`);
    expect(layoutRow("artifacts/tests")).toContain(
      `| ${readdirSync(join(repoRoot, "artifacts/tests")).filter((f) => f.endsWith(".sh")).length} scripts |`,
    );
    expect(layoutRow("docs")).toContain(`${docsMd.length} docs incl. **${adrCount} ADRs**`);
  });

  it("the engine row matches the tree", () => {
    const engineRow = layoutRow("engine");
    expect(engineRow).toContain(`${srcFiles.length} src files / ~${kOf(srcLines)}k lines TS`);
    expect(engineRow).toContain(`${testTs.length} TS files / ~${kOf(testTsLines)}k lines`);
    expect(engineRow).toContain(
      `${executed} test files are executed (${engineTestFiles.length} under \`engine/tests/\`, ` +
        `${calProbes.length} under \`calibration/\` and \`probes/\`)`,
    );
  });

  it("the pi row matches the tree", () => {
    const piFiles = walk("pi").filter((f) => f.endsWith(".ts"));
    expect(layoutRow("pi")).toContain(`${piFiles.length} modules / ${kOf(sumLines(piFiles))}k lines`);
  });

  it("§7's suite inventory matches the tree", () => {
    const flattened = guardMap.split("\n").map((l) => l.trim()).join(" ");
    expect(flattened).toContain(`${executed} executed test files / ~${kOf(testTsLines)}k lines`);
    expect(flattened).toContain(
      `core ${perDirTestFiles.core} test files, handlers ${perDirTestFiles.handlers}, pi ${perDirTestFiles.pi}, ` +
        `linter ${perDirTestFiles.linter}, orchestration ${perDirTestFiles.orchestration}, utils ${perDirTestFiles.utils}, ` +
        `machine ${perDirTestFiles.machine}, acceptance ${perDirTestFiles.acceptance}, security ${perDirTestFiles.security}`,
    );
    expect(flattened).toContain(`and ${calProbes.length} under \`calibration/\` and \`probes/\``);
  });

  it("§9 and the catalog cite the derived ADR and wave-module counts", () => {
    expect(guardMap).toContain(`the ADR index table (${adrCount} ADRs)`);
    expect(guardMap).toContain(`wave-* (${waveModules.length} modules)`);
  });

  it("Appendix C pins extension.ts's line count", () => {
    expect(guardMap).toContain(`extension.ts (registration shell, ${extLines} ln)`);
  });
});
