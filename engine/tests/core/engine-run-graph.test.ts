/**
 * The TaskGraph's `test_evidence` field at the State File load boundary, and
 * the Task mutation check's test files (loom#198).
 */

import { describe, expect, it } from "vitest";
import { parseTaskGraph } from "../../src/state-file-wire";
import { taskMutationDuty } from "../../src/core/task-mutation-check";
import { graphFixture, taskFixture } from "../fixtures/task-lifecycle";
import { mutationManifest } from "../fixtures/task-mutation";

const MANIFEST = mutationManifest();
const wire = (testEvidence: unknown) => JSON.parse(JSON.stringify({
  ...graphFixture([]),
  verification_manifest: MANIFEST,
  ...(testEvidence === undefined ? {} : { test_evidence: testEvidence }),
})) as unknown;

describe("test_evidence at the load boundary", () => {
  it("loads an operator adoption as its parsed, frozen value", () => {
    const raw = { kind: "engine-run", manifestDigest: MANIFEST.manifestDigest, adoptedBy: "operator", reason: "mocha runner" };
    const parsed = parseTaskGraph(wire(raw));
    expect(parsed.ok && parsed.value.test_evidence).toEqual(raw);
    expect(parsed.ok && Object.isFrozen(parsed.value.test_evidence)).toBe(true);
  });

  it("loads a graph without the field as one that admits every run", () => {
    const parsed = parseTaskGraph(wire(undefined));
    expect(parsed.ok && parsed.value.test_evidence).toBeUndefined();
  });

  it("refuses a mode bound to another manifest", () => {
    const parsed = parseTaskGraph(wire({ kind: "engine-run", manifestDigest: "f".repeat(64), adoptedBy: "population" }));
    expect(parsed).toMatchObject({ ok: false, error: expect.stringContaining("does not match the frozen Verification Manifest") });
  });
});

describe("the Task mutation check runs the Task's own tests", () => {
  const IMPL = "src/ledger.ts";
  const TEST = "src/ledger.test.ts";
  const graph = (files: readonly string[]) => ({
    ...graphFixture([taskFixture({ id: "T1", description: "T1", agent: "code-implementer-agent", wave: 1, depends_on: [], file_list: [...files], spec_anchors: [], spec_contributions: [] })]),
    verification_manifest: MANIFEST,
  });

  it("names the declared test files the runner is handed", () => {
    expect(taskMutationDuty(graph([IMPL, TEST]), "T1")).toMatchObject({ kind: "owed", mutable: [IMPL], tests: [TEST] });
  });

  it("names none when the Task declares no test, so the mutated file is handed instead", () => {
    expect(taskMutationDuty(graph([IMPL]), "T1")).toMatchObject({ kind: "owed", tests: [] });
  });
});
