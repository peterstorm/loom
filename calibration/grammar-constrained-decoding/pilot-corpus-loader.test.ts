import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workloadCorpusLoader } from "./pilot-corpus-loader";
import { corpusCases, fixtures, REPO_ROOT } from "./pilot-test-fixtures";
import type { WorkloadFixtures } from "./pilot-workload";

/**
 * The filesystem adapter of the window's corpus port, over a real directory:
 * the retained corpus loads, and an unreadable or invalid corpus is a
 * refusal naming the checkout-relative path — never a throw.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A checkout root holding `corpus.json` with the given text (or none), and fixtures naming it. */
function checkout(corpusText: string | null): Readonly<{ root: string; fixtures: WorkloadFixtures }> {
  const root = mkdtempSync(join(tmpdir(), "loom-pilot-corpus-"));
  roots.push(root);
  if (corpusText !== null) writeFileSync(join(root, "corpus.json"), corpusText);
  return { root, fixtures: { ...fixtures, reviewer: { ...fixtures.reviewer, corpus: "corpus.json" } } };
}

describe("workload corpus loader", () => {
  it("loads the retained corpus the workload fixtures name", () => {
    expect(workloadCorpusLoader(REPO_ROOT, fixtures)()).toEqual({ ok: true, value: corpusCases });
  });

  it("refuses an unreadable corpus, naming it relative to the checkout", () => {
    const { root, fixtures: named } = checkout(null);
    const loaded = workloadCorpusLoader(root, named)();
    expect(loaded).toEqual({ ok: false, error: expect.stringMatching(/^cannot read corpus\.json: ENOENT: no such file or directory/) });
  });

  it("refuses a corpus that is not JSON, listing the parse problem", () => {
    const { root, fixtures: named } = checkout("{ not json");
    expect(workloadCorpusLoader(root, named)()).toEqual({
      ok: false,
      error: expect.stringMatching(/^invalid corpus corpus\.json:\n {2}- calibration corpus is not valid JSON: /),
    });
  });

  it("refuses an invalid corpus, listing every problem", () => {
    const { root, fixtures: named } = checkout(JSON.stringify({ schema_version: 99, cases: [] }));
    expect(workloadCorpusLoader(root, named)()).toEqual({
      ok: false,
      error: "invalid corpus corpus.json:\n  - calibration corpus.schema_version must equal 1\n  - calibration corpus.cases must be a non-empty array",
    });
  });

  it("reads nothing until the port is invoked", () => {
    const { root, fixtures: named } = checkout(null);
    const load = workloadCorpusLoader(root, named);
    writeFileSync(join(root, "corpus.json"), JSON.stringify({ schema_version: 99, cases: [] }));
    expect(load()).toMatchObject({ ok: false, error: expect.stringContaining("schema_version must equal 1") });
  });
});
