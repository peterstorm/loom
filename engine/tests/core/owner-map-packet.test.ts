/**
 * The owner-map section and second-copy rule (plan AD-9; FR-022..FR-026).
 *
 * Two layers:
 * - `renderOwnerMapSection` / `SECOND_COPY_RULE`, the pure renderer in
 *   `core/owner-verification/owner-map.ts`.
 * - Wave review issuance (`prepareWaveReviewBatch`), which appends the section
 *   as a fixed (digest-bound) section only under every AD-9 condition, and
 *   leaves every other packet byte-identical (SC-005).
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WAVE_REVIEW_AGENTS } from "../../src/core/agent-catalog-projections";
import type { ContextPacket } from "../../src/core/context-packets";
import { parseOrchestrationRunId } from "../../src/core/orchestration-contract";
import {
  OWNER_MAP_ROLES,
  isOwnerMapRole,
  OWNER_MAP_SECTION,
  SECOND_COPY_RULE,
  renderOwnerMapSection,
} from "../../src/core/owner-verification/owner-map";
import type { OwnerObligation } from "../../src/core/owner-verification/types";
import { CURRENT_REVIEWER_PROTOCOL } from "../../src/core/reviewer-contract";
import {
  prepareWaveReviewBatch,
  type WaveRequestBatch,
  type WaveReviewRegistrationAuthority,
} from "../../src/core/wave-review-authority";
import { observeWaveSpecCheckDocuments } from "../../src/orchestration/wave-spec-check-documents";
import { parseTaskGraph } from "../../src/state-manager";
import type { TaskGraph } from "../../src/types";
import { LOOM_PACKAGE_ROOT } from "../../src/utils/loom-package-root";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { observedWorkspace } from "../fixtures/reviewed-workspace";
import { taskFixture } from "../fixtures/task-lifecycle";
import { ADMISSION, ADMISSION_FEE_TABLE_STAMP, FEE_TABLE, someParagraph } from "../fixtures/owner-families";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const PLAN_FILE = ".claude/plans/2026-10-22-owner-map.md";

const STAMP = ADMISSION_FEE_TABLE_STAMP;

describe("renderOwnerMapSection — the pure owner map", () => {
  it("AS-022: lists every given Invariant's id, title, owner, siblings with notes, matrix test and statement, in order", () => {
    const text = renderOwnerMapSection(PLAN_FILE, [ADMISSION, FEE_TABLE]);
    for (const value of [
      ADMISSION.invariant, ADMISSION.title, ADMISSION.owner, ADMISSION.matrixTest, ADMISSION.statement!,
      "src/rules/sibling-a.ts", "admits members", "src/rules/sibling-b.ts",
      FEE_TABLE.invariant, FEE_TABLE.title, FEE_TABLE.owner, FEE_TABLE.matrixTest,
    ]) expect(text).toContain(value);
    expect(text.indexOf(ADMISSION.invariant)).toBeLessThan(text.indexOf(FEE_TABLE.invariant));
    expect(text).toContain("**Sibling entry points:** none");
  });

  it("AS-023: cites `<plan file>#INV-N` per Invariant as the violated contract and carries the second-copy rule verbatim", () => {
    const text = renderOwnerMapSection(PLAN_FILE, [ADMISSION, FEE_TABLE]);
    expect(text).toContain(`${PLAN_FILE}#INV-1`);
    expect(text).toContain(`${PLAN_FILE}#INV-4`);
    expect(text).toContain(SECOND_COPY_RULE);
    expect(someParagraph(SECOND_COPY_RULE, /outside/i, /owner module/i, /violated contract/i, /<plan file>#INV-N/)).toBe(true);
  });

  it("FR-025: rates a diverging copy critical with the diverging input as consequence, an identical copy advisory", () => {
    expect(someParagraph(SECOND_COPY_RULE, /\bcritical\b/i, /diverg/i, /diverging input/i, /consequence/i)).toBe(true);
    expect(someParagraph(SECOND_COPY_RULE, /\badvisory\b/i, /behaviorally identical/i)).toBe(true);
  });

  it("FR-026: states that the Refutation Panel and the existing severity rules apply unchanged", () => {
    expect(someParagraph(SECOND_COPY_RULE, /Refutation Panel/, /severity rules/i, /unchanged/i)).toBe(true);
  });

  it("is deterministic: the same obligations render the same bytes", () => {
    expect(renderOwnerMapSection(PLAN_FILE, [ADMISSION])).toBe(renderOwnerMapSection(PLAN_FILE, [ADMISSION]));
    expect(renderOwnerMapSection(PLAN_FILE, [ADMISSION])).not.toBe(renderOwnerMapSection(PLAN_FILE, [FEE_TABLE]));
  });

  it("names exactly the two owner-map reviewer roles", () => {
    expect([...OWNER_MAP_ROLES]).toEqual(["code-reviewer", "architecture-tech-lead"]);
  });
});

// ---------------------------------------------------------------------------
// Wave review issuance
// ---------------------------------------------------------------------------

function projectWithPlan(): string {
  const root = canonicalTempDir("loom-owner-map-unit-");
  cleanup.push(root);
  mkdirSync(join(root, ".claude", "plans"), { recursive: true });
  writeFileSync(join(root, PLAN_FILE), "# Plan: owner map\n");
  return root;
}

function graphOf(fileList: readonly string[], stamp: readonly OwnerObligation[] | undefined): TaskGraph {
  const parsed = parseTaskGraph({
    spec_trace_version: 2, current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
    spec_file: null, plan_file: PLAN_FILE, wave_gates: {},
    ...(stamp === undefined ? {} : { owner_obligations: stamp }),
    tasks: [taskFixture({
      id: "T1", description: "Reviewed Task", agent: "code-implementer-agent", wave: 1,
      status: "implemented", depends_on: [], spec_anchors: [], spec_contributions: [],
      file_list: [...fileList], files_modified: [...fileList],
    })],
  });
  if (!parsed.ok) throw new Error(`fixture graph rejected: ${String(parsed.error)}`);
  return parsed.value;
}

const registrationOf = (schemaVersion: 1 | 2): WaveReviewRegistrationAuthority => ({
  kind: "wave-gate",
  input: { wave: 1 },
  taskIds: ["T1"],
  authorityDigest: "a".repeat(64),
  ...(schemaVersion === 2
    ? { schemaVersion: 2 as const, reviewerProtocol: CURRENT_REVIEWER_PROTOCOL }
    : { schemaVersion: 1 as const }),
});

function issue(root: string, graph: TaskGraph, schemaVersion: 1 | 2 = 2): WaveRequestBatch {
  const runId = parseOrchestrationRunId("run.owner-map-unit");
  if (!runId.ok) throw new Error(runId.error.message);
  const files = graph.tasks[0]!.file_list ?? [];
  const documents = observeWaveSpecCheckDocuments({
    specFile: null,
    planFile: PLAN_FILE,
    projectBoundary: Object.freeze({ kind: "state-layout" as const, root }),
  });
  const workspace = [observedWorkspace("T1", files, files.map((path) => ({ path, bytes: Buffer.from(`// ${path}\n`) })))];
  const batch = prepareWaveReviewBatch(runId.value, registrationOf(schemaVersion), graph, 1, workspace, documents);
  if (!batch.ok) throw new Error(`issuance refused: ${batch.error.message}`);
  return batch.value;
}

const ownerMapOf = (packet: ContextPacket): string | null => {
  const section = packet.fixedContext.find(({ label }) => label === OWNER_MAP_SECTION);
  return section === undefined ? null : Buffer.from(section.bytes).toString("utf8");
};

const packetsByRole = (batch: WaveRequestBatch): ReadonlyMap<string, ContextPacket> =>
  new Map(batch.subjects.map((subject, index) => [subject.role, batch.packets[index]!] as const));

/** The packet digests of a batch, which are the requests' retry identity. */
const digests = (batch: WaveRequestBatch): readonly string[] => batch.packets.map(({ digest }) => digest);

describe("Wave review issuance — the owner-map fixed section (AD-9)", () => {
  it("AS-022: the code-reviewer packet of a Task changing a sibling carries the touched Invariant only", () => {
    const batch = issue(projectWithPlan(), graphOf(["src/rules/sibling-a.ts"], STAMP));
    const text = ownerMapOf(packetsByRole(batch).get("code-reviewer")!);
    expect(text).toBe(renderOwnerMapSection(PLAN_FILE, [ADMISSION]));
  });

  it("AS-022: a Task that only writes the matrix test touches the family (any role), so the section is issued", () => {
    const batch = issue(projectWithPlan(), graphOf([FEE_TABLE.matrixTest], STAMP));
    expect(ownerMapOf(packetsByRole(batch).get("code-reviewer")!)).toBe(renderOwnerMapSection(PLAN_FILE, [FEE_TABLE]));
  });

  it("AS-025: the section is inside the packet digest — a changed obligation changes the packet identity", () => {
    const root = projectWithPlan();
    const before = packetsByRole(issue(root, graphOf([ADMISSION.owner], STAMP))).get("code-reviewer")!;
    const after = packetsByRole(issue(root, graphOf([ADMISSION.owner], [{ ...ADMISSION, title: "Renamed" }, FEE_TABLE])))
      .get("code-reviewer")!;
    expect(after.digest).not.toBe(before.digest);
  });

  it("AS-024: a Task touching no owned family issues byte-identical packets to a graph without the stamp (SC-005)", () => {
    const root = projectWithPlan();
    const stamped = issue(root, graphOf(["src/other.ts"], STAMP));
    const unstamped = issue(root, graphOf(["src/other.ts"], undefined));
    expect(stamped.packets.every((packet) => ownerMapOf(packet) === null)).toBe(true);
    expect(digests(stamped)).toEqual(digests(unstamped));
    expect(JSON.stringify(stamped.requests)).toBe(JSON.stringify(unstamped.requests));
  });

  it("AS-024: an empty stamp issues no section and byte-identical packets", () => {
    const root = projectWithPlan();
    expect(digests(issue(root, graphOf([ADMISSION.owner], [])))).toEqual(digests(issue(root, graphOf([ADMISSION.owner], undefined))));
  });

  it("AS-024: a graph without owner_obligations issues no section, even for a Task changing an owner", () => {
    const batch = issue(projectWithPlan(), graphOf([ADMISSION.owner], undefined));
    expect(batch.packets.every((packet) => ownerMapOf(packet) === null)).toBe(true);
  });

  it("AS-026: the other reviewer roles' packets carry no owner-map section and are unchanged", () => {
    const root = projectWithPlan();
    const stamped = packetsByRole(issue(root, graphOf([ADMISSION.owner], STAMP)));
    const unstamped = packetsByRole(issue(root, graphOf([ADMISSION.owner], undefined)));
    const others = WAVE_REVIEW_AGENTS.filter((role) => !isOwnerMapRole(role));
    expect(others.length).toBeGreaterThan(0);
    for (const role of others) {
      expect(ownerMapOf(stamped.get(role)!)).toBeNull();
      expect(stamped.get(role)!.digest).toBe(unstamped.get(role)!.digest);
    }
    for (const role of ["silent-failure-hunter", "pr-test-analyzer", "comment-analyzer", "type-design-analyzer", "code-simplifier"]) {
      expect(isOwnerMapRole(role)).toBe(false);
    }
    expect(ownerMapOf(stamped.get("code-reviewer")!)).not.toBeNull();
  });

  it("AS-024: the spec-check subject's packet carries no owner-map section and is unchanged", () => {
    const root = projectWithPlan();
    const stamped = packetsByRole(issue(root, graphOf([ADMISSION.owner], STAMP))).get("spec-check-invoker")!;
    const unstamped = packetsByRole(issue(root, graphOf([ADMISSION.owner], undefined))).get("spec-check-invoker")!;
    expect(ownerMapOf(stamped)).toBeNull();
    expect(stamped.digest).toBe(unstamped.digest);
  });

  it("refuses issuance when a Task touches owned Invariants but the stamped graph names no plan_file to cite", () => {
    const root = projectWithPlan();
    const runId = parseOrchestrationRunId("run.owner-map-unit");
    if (!runId.ok) throw new Error(runId.error.message);
    const graph: TaskGraph = { ...graphOf([ADMISSION.owner], STAMP), plan_file: null };
    const documents = observeWaveSpecCheckDocuments({
      specFile: null,
      planFile: null,
      projectBoundary: Object.freeze({ kind: "state-layout" as const, root }),
    });
    const workspace = [observedWorkspace("T1", [ADMISSION.owner], [{ path: ADMISSION.owner, bytes: Buffer.from("// owner\n") }])];
    const batch = prepareWaveReviewBatch(runId.value, registrationOf(2), graph, 1, workspace, documents);
    expect(batch.ok).toBe(false);
    if (batch.ok) return;
    expect(batch.error.message).toBe("Task T1 touches owned Invariants but the stamped TaskGraph records no plan_file to cite");
  });

  it("AS-024: a schema-1 registration issues no owner-map section and byte-identical packets", () => {
    const root = projectWithPlan();
    const stamped = issue(root, graphOf([ADMISSION.owner], STAMP), 1);
    const unstamped = issue(root, graphOf([ADMISSION.owner], undefined), 1);
    expect(stamped.packets.every((packet) => ownerMapOf(packet) === null)).toBe(true);
    expect(digests(stamped)).toEqual(digests(unstamped));
  });
});

describe("AS-027: standalone review never sees the owner map", () => {
  const STANDALONE_BUILDERS = [
    "engine/src/core/standalone-review.ts",
    "engine/src/handlers/helpers/programs/standalone-requests.ts",
    "engine/src/core/context-packets.ts",
  ];

  it.each(STANDALONE_BUILDERS)("AS-027: %s imports nothing from core/owner-verification/", (path) => {
    const source = readFileSync(join(LOOM_PACKAGE_ROOT, path), "utf8");
    const specifiers = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((specifier) => specifier.includes("owner-verification"))).toEqual([]);
  });
});
