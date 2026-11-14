/**
 * `inferStarterConfig` (`linter/starter-config.ts`): what `lint-project
 * --init` turns on from a project's layout. The spawned script is covered in
 * `lint-project-cli.test.ts`; this pins the pure decision.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { importPrefix, inferStarterConfig, TYPESCRIPT_LAYERS, type ProjectLayout } from "../../src/linter/starter-config";
import { OPT_IN_CONFIG_KEYS, parseProjectConfig, type ProgrammaticConfig } from "../../src/linter/programmatic/config";
import { coverageGaps, lintCoverage } from "../../src/linter/lint-coverage";

const layout = (overrides: Partial<ProjectLayout> = {}): ProjectLayout => ({
  files: [],
  languages: { typescript: true, java: false },
  importsOf: new Map(),
  hasPlans: false,
  ...overrides,
});

const parsed = (document: Readonly<Record<string, unknown>>): ProgrammaticConfig => {
  const result = parseProjectConfig(document, "config.json");
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const LAYERED = layout({
  files: ["src/domain/order.ts", "src/orchestrator/place.ts", "src/infra/pg.ts", "README.md", "docs/a.md"],
  importsOf: new Map([
    ["src/domain/order.ts", []],
    ["src/orchestrator/place.ts", ["../domain/order"]],
    ["src/infra/pg.ts", ["../domain/order", "pg", "node:crypto"]],
  ]),
  hasPlans: true,
});

describe("importPrefix", () => {
  const layers = TYPESCRIPT_LAYERS.map(({ dir }) => dir);
  it("reduces each specifier to the prefix a boundary allows it by", () => {
    expect(importPrefix("src/infra/pg.ts", "node:crypto", layers)).toBe("node:");
    expect(importPrefix("src/infra/pg.ts", "bun:test", layers)).toBe("bun:");
    expect(importPrefix("src/infra/pg.ts", "pg", layers)).toBe("pg");
    expect(importPrefix("src/infra/pg.ts", "lodash/fp", layers)).toBe("lodash");
    expect(importPrefix("src/infra/pg.ts", "@aws-sdk/client-s3/dist", layers)).toBe("@aws-sdk/client-s3");
    expect(importPrefix("src/infra/pg.ts", "../domain/order", layers)).toBe("src/domain/");
    expect(importPrefix("src/infra/pg.ts", "../shared/ids/uuid", layers)).toBe("src/shared/");
    expect(importPrefix("src/infra/pg.ts", "../index", layers)).toBe("src/index");
  });
});

describe("inferStarterConfig", () => {
  it("turns every family on for a layered project with documents", () => {
    const inference = inferStarterConfig(null, null, LAYERED);
    expect(inference.inferred).toEqual([...OPT_IN_CONFIG_KEYS]);
    expect(inference.uninferred).toEqual([]);
    expect(inference.notes).toEqual([]);
    expect(inference.document).toMatchObject({
      maxFunctionLines: 50,
      pureModules: ["src/domain/"],
      requireGovernance: ["src/"],
      docReferences: {
        govern: [expect.objectContaining({ path: "docs/" }), expect.objectContaining({ path: "README.md" })],
        plans: [expect.objectContaining({ path: ".claude/plans/" })],
        sourceRoots: ["src"],
      },
    });
    expect(inference.document.boundaries).toEqual([
      expect.objectContaining({ module: "src/domain/", allow: ["src/domain/"], deny: ["src/orchestrator/", "src/infra/"] }),
      expect.objectContaining({ module: "src/orchestrator/", allow: ["src/domain/", "src/orchestrator/"], deny: ["src/infra/"] }),
      expect.objectContaining({ module: "src/infra/", allow: ["node:", "pg", "src/domain/", "src/infra/"], deny: ["src/orchestrator/"] }),
    ]);
    // The loader accepts what --init writes, and nothing is left a gap.
    expect(coverageGaps(lintCoverage(parsed(inference.document)))).toEqual([]);
  });

  it("leaves out a deny an import already breaks, and says so", () => {
    const broken = layout({ ...LAYERED, importsOf: new Map([...LAYERED.importsOf, ["src/domain/order.ts", ["../infra/pg"]]]) });
    const inference = inferStarterConfig(null, null, broken);
    expect(inference.document.boundaries).toContainEqual(expect.objectContaining({ module: "src/domain/", deny: ["src/orchestrator/"] }));
    expect(inference.notes).toEqual([
      "boundaries: src/domain/ already imports src/infra/, so that deny is left out — move those imports behind a port, then add \"src/infra/\" to its deny list",
    ]);
  });

  it("does not govern src/ when a source file lies outside every layer", () => {
    const inference = inferStarterConfig(null, null, layout({ ...LAYERED, files: [...LAYERED.files, "src/index.ts"] }));
    expect(inference.inferred).not.toContain("requireGovernance");
    expect(inference.uninferred).toContainEqual({ key: "requireGovernance", why: "the boundaries do not govern every source file under src/" });
  });

  it("names each family it cannot infer, with why, and writes none of them", () => {
    const inference = inferStarterConfig(null, null, layout({ files: ["lib/a.ts"] }));
    expect(inference.inferred).toEqual([]);
    expect(inference.uninferred.map(({ key }) => key)).toEqual([...OPT_IN_CONFIG_KEYS]);
    expect(inference.document).toEqual({ maxFunctionLines: 50, excludeFromMaxLines: [".test.ts", ".spec.ts"] });
  });

  it("a Java project gets its functional-core roots at any package depth", () => {
    const inference = inferStarterConfig(null, null, layout({
      languages: { typescript: false, java: true },
      files: ["app/src/main/java/com/shop/domain/model/Order.java"],
    }));
    expect(inference.document).toEqual({ maxFunctionLines: 40, excludeFromMaxLines: [".test.java", "Test.java"], pureModules: ["domain/model/"] });
  });

  it("judges governance against the project's own boundaries too", () => {
    const stored = { boundaries: [{ module: "src/", allow: ["src/"], deny: [] }] };
    const inference = inferStarterConfig(stored, parsed(stored), layout({ files: ["src/a.ts"] }));
    expect(inference.document.requireGovernance).toEqual(["src/"]);
    expect(inference.document.boundaries).toEqual(stored.boundaries);
  });

  it("property: a configured or declined family is never touched, and the stored fields are kept", () => {
    const decisionArb = fc.constantFrom("configured", "declined", "gap");
    fc.assert(fc.property(fc.tuple(decisionArb, decisionArb, decisionArb, decisionArb), (decisions) => {
      const configured: Readonly<Record<string, unknown>> = {
        boundaries: [{ module: "lib/", allow: ["lib/"], deny: [] }],
        pureModules: ["lib/core/"],
        requireGovernance: ["lib/"],
        docReferences: { govern: [{ path: "NOTES.md", reason: "kept" }] },
      };
      const stored: Record<string, unknown> = { maxFunctionLines: 70, declined: [] as unknown[] };
      OPT_IN_CONFIG_KEYS.forEach((key, index) => {
        if (decisions[index] === "configured") stored[key] = configured[key];
        if (decisions[index] === "declined") (stored.declined as unknown[]).push({ key, reason: "decided" });
      });
      const inference = inferStarterConfig(stored, parsed(stored), LAYERED);
      OPT_IN_CONFIG_KEYS.forEach((key, index) => {
        if (decisions[index] !== "gap") {
          expect(inference.document[key]).toEqual(stored[key]);
          expect(inference.inferred).not.toContain(key);
        }
      });
      expect(inference.document.maxFunctionLines).toBe(70);
      expect(inference.document.declined).toEqual(stored.declined);
      // Whatever was written, the loader accepts.
      expect(() => parsed(inference.document)).not.toThrow();
    }));
  });

  it("property: inferring again over the result infers nothing (idempotent)", () => {
    fc.assert(fc.property(fc.subarray(LAYERED.files as string[]), fc.boolean(), (files, hasPlans) => {
      const first = inferStarterConfig(null, null, layout({ ...LAYERED, files, hasPlans }));
      const second = inferStarterConfig(first.document, parsed(first.document), layout({ ...LAYERED, files, hasPlans }));
      expect(second.inferred).toEqual([]);
      expect(second.document).toEqual(first.document);
    }));
  });
});
