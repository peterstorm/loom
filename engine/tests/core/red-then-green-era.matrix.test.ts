/**
 * INV-6 matrix: whether a TaskGraph owes `red-then-green` is decided only by
 * `redThenGreenEra(graph.verification_manifest)`, from the presence of the
 * frozen `testFiles`.
 *
 * Rows (a)–(d) are the four post-feature freeze cases (AD-4). Each is frozen
 * through population (`populateTaskGraph`, with the manifest the
 * `populate-task-graph` shell hands it: the freezer's output over the source
 * bytes, or `defaultVerificationManifest()` when the source file is absent),
 * and then loaded through the production State File parser. Every row carries
 * `testFiles` with its expected suffix source, so no post-feature TaskGraph
 * reads as pre-feature.
 *
 * The derivation sites (population, the state-file-wire obligation-match
 * check, revalidation) and the pre-feature rows (e) and (f) are pinned in
 * `proof-obligations-red-then-green.test.ts`; the reconcile site in
 * `i6-settlement.matrix.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { parseSpec } from "../../src/core/parse-spec";
import { parseArtifactDigest } from "../../src/core/orchestration-contract";
import {
  parseAuthoredTaskRoster,
  populateTaskGraph,
  type AuthoredTask,
} from "../../src/core/task-graph-population";
import type { FrozenStopCheckManifestFields, FrozenTestFiles } from "../../src/core/affected-stop-check-types";
import { ENGINE_DEFAULT_TEST_FILES } from "../../src/core/test-file-classification";
import {
  defaultVerificationManifest,
  freezeVerificationManifest,
  type FrozenVerificationManifest,
} from "../../src/core/verification-manifest";
import type { TaskGraph } from "../../src/types";
import { protectedGraphFixture } from "../fixtures/task-lifecycle";

const parsedSpec = parseSpec(`# Feature: Era

## User Scenarios

### US1: [P1] Populate

**Acceptance Scenarios:**
- AS-001: Given Tasks, When population runs, Then the manifest is frozen

## Functional Requirements

- FR-001: System MUST freeze the verification manifest at population

## Out of Scope

- OOS-001: Nothing

## Appendix: Glossary

| Term | Definition |
|------|------------|
| TaskGraph | Protected orchestration state |
`);
function required<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>, what: string): T {
  if (!result.ok) throw new Error(`era fixture ${what} must parse`);
  return result.value;
}

const SPEC_INDEX = Object.freeze({
  kind: "indexed" as const,
  path: "spec.md",
  contentDigest: required(parseArtifactDigest("a".repeat(64)), "digest"),
  index: required(parsedSpec, "specification"),
});

const authoredTask: AuthoredTask = Object.freeze({
  id: "T1",
  description: "implement T1",
  agent: "code-implementer-agent",
  wave: 1,
  depends_on: Object.freeze([]),
  spec_anchors: Object.freeze(["FR-001"]),
  spec_contributions: Object.freeze([]),
  verification_policy: Object.freeze({
    regression: Object.freeze({ kind: "required" as const }),
    new_tests: Object.freeze({ kind: "required" as const }),
  }),
  file_list: Object.freeze(["src/ledger.ts", "tests/ledger.test.ts"]),
});

const ROSTER = required(parseAuthoredTaskRoster([authoredTask]), "roster");

/** Population with the manifest the populate-task-graph shell froze, loaded back through the State File parser. */
function populated(verificationManifest: FrozenVerificationManifest): TaskGraph {
  const existing: TaskGraph = {
    current_phase: "decompose",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: "spec.md",
    plan_file: "plan.md",
    tasks: [],
    wave_gates: {},
  };
  const result = populateTaskGraph(existing, {
    planTitle: "Era plan",
    validatedPlanFile: "plan.md",
    authoredSpecFile: "spec.md",
    tasks: ROSTER,
    verificationManifest,
    specIndex: SPEC_INDEX,
    observedSpecFile: "spec.md",
    force: false,
    proofBoundary: { kind: "absent", cause: "fixture: no Git repository root" },
    contracts: [],
  });
  if (!result.ok) throw new Error(`population refused: ${result.error.message}`);
  return protectedGraphFixture(JSON.parse(JSON.stringify(result.value.state)));
}

/** The `.loom/verification-manifest.json` bytes, frozen as population freezes them. */
function fromSource(document: Readonly<Record<string, unknown>>): FrozenVerificationManifest {
  const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    kind: "loom-verification-manifest", checks: [], ...document,
  })));
  if (!frozen.ok) throw new Error(frozen.error.errors.join("; "));
  return frozen.value;
}

const testFilesOf = (graph: TaskGraph): FrozenTestFiles | undefined =>
  (graph.verification_manifest as (FrozenVerificationManifest & FrozenStopCheckManifestFields) | undefined)?.testFiles;

type EraRow = Readonly<{ row: string; manifest: () => FrozenVerificationManifest; testFiles: FrozenTestFiles }>;

const POST_FEATURE_ROWS: readonly EraRow[] = [
  {
    row: "(a) an operator schema-2 manifest with testFileSuffixes",
    manifest: () => fromSource({ schemaVersion: 2, testFileSuffixes: [".spec.ts", ".it.ts"] }),
    testFiles: { source: "operator-manifest", suffixes: [".spec.ts", ".it.ts"] },
  },
  {
    row: "(b) an operator schema-2 manifest without testFileSuffixes",
    manifest: () => fromSource({ schemaVersion: 2 }),
    testFiles: ENGINE_DEFAULT_TEST_FILES,
  },
  {
    row: "(c) an operator schema-1 manifest",
    manifest: () => fromSource({ schemaVersion: 1 }),
    testFiles: ENGINE_DEFAULT_TEST_FILES,
  },
  {
    row: "(d) no manifest file (ENOENT freezes defaultVerificationManifest())",
    manifest: () => defaultVerificationManifest(),
    testFiles: ENGINE_DEFAULT_TEST_FILES,
  },
];

describe("INV-6: every post-feature freeze path carries testFiles", () => {
  it.each(POST_FEATURE_ROWS)("FR-014: $row freezes testFiles through population with the expected suffix source", ({ manifest, testFiles }) => {
    const frozen = manifest();
    const graph = populated(frozen);

    expect(graph.verification_manifest).toEqual(frozen);
    expect(testFilesOf(graph)).toEqual(testFiles);
  });
});
