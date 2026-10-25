/**
 * CT-2 acceptance: the engine-issued owner-map section and the second-copy
 * rule, through Wave review issuance (`prepareWaveReviewBatch`).
 *
 * Every testcase issues a real schema-2 Wave review batch over a TaskGraph that
 * carries the population stamp `owner_obligations` (plan AD-2), with a real plan
 * file read through the production document observer. The reviewed Task changes
 * a sibling entry point of INV-1 only, so INV-1 is the one owned Invariant whose
 * family it touches. The section is located by its byte-section label,
 * the imported `OWNER_MAP_SECTION` (plan AD-9).
 *
 * Roles: FR-022 names code-reviewer and architecture-tech-lead. Wave issuance
 * builds a packet for every role of the Task's own roster; a Task touching an
 * owned family is issued `OWNER_MAPPED_WAVE_REVIEW_AGENTS`, so both roles are
 * issued (ADR-0047). Each testcase checks every issued packet whose role is one
 * of the two, and AS-022 requires both packets to be issued.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextPacket } from "../../src/core/context-packets";
import { parseOrchestrationRunId } from "../../src/core/orchestration-contract";
import { OWNER_MAP_SECTION } from "../../src/core/owner-verification/owner-map";
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
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { ownerObligation } from "../fixtures/owner-obligation";
import { CLOCK, FEES, FEES_CLOCK_PLAN_FILE, FEES_CLOCK_PLAN_TEXT, someParagraph } from "../fixtures/owner-families";
import { observedWorkspace } from "../fixtures/reviewed-workspace";
import { taskFixture } from "../fixtures/task-lifecycle";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** The two reviewer roles FR-022 owes the owner map. */
const OWNER_MAP_ROLES: readonly string[] = ["code-reviewer", "architecture-tech-lead"];

/** The plan path exactly as the TaskGraph records it: the citation reviewers must use. */
const PLAN_FILE = FEES_CLOCK_PLAN_FILE;

/** The reviewed Task changes INV-1's first sibling, so INV-1's family is touched and INV-2's is not. */
const REVIEWED_FILE = FEES.siblings[0].path;

/** A project holding the plan file the graph names; returns its root. */
function projectWithPlan(): string {
  const root = canonicalTempDir("loom-owner-map-packet-");
  cleanup.push(root);
  mkdirSync(join(root, ".claude", "plans"), { recursive: true });
  writeFileSync(join(root, PLAN_FILE), FEES_CLOCK_PLAN_TEXT);
  return root;
}

/** A Wave 1 graph whose one Task changes INV-1's sibling, stamped with `obligations`. */
function stampedGraph(obligations: readonly OwnerObligation[]): TaskGraph {
  const parsed = parseTaskGraph({
    spec_trace_version: 2, current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
    spec_file: null, plan_file: PLAN_FILE, wave_gates: {},
    owner_obligations: obligations,
    tasks: [taskFixture({
      id: "T1", description: "Quote endpoint", agent: "code-implementer-agent", wave: 1,
      status: "implemented", depends_on: [], spec_anchors: [], spec_contributions: [],
      file_list: [REVIEWED_FILE], files_modified: [REVIEWED_FILE],
    })],
  });
  if (!parsed.ok) throw new Error(`owner-map fixture graph rejected: ${String(parsed.error)}`);
  return parsed.value;
}

const registration: WaveReviewRegistrationAuthority = {
  schemaVersion: 2,
  reviewerProtocol: CURRENT_REVIEWER_PROTOCOL,
  kind: "wave-gate",
  input: { wave: 1 },
  taskIds: ["T1"],
  authorityDigest: "a".repeat(64),
};

/** Issue the real Wave review batch for `graph` from the project at `root`. */
function issue(root: string, graph: TaskGraph): WaveRequestBatch {
  const runId = parseOrchestrationRunId("run.owner-map-packet");
  if (!runId.ok) throw new Error(runId.error.message);
  const documents = observeWaveSpecCheckDocuments({
    specFile: null,
    planFile: PLAN_FILE,
    projectBoundary: Object.freeze({ kind: "state-layout" as const, root }),
  });
  const workspace = [observedWorkspace("T1", [REVIEWED_FILE], [
    { path: REVIEWED_FILE, bytes: Buffer.from("export const quote = (n: number) => Math.round(n * 1.2);\n") },
  ])];
  const batch = prepareWaveReviewBatch(runId.value, registration, graph, 1, workspace, documents);
  if (!batch.ok) throw new Error(`Wave review issuance refused: ${batch.error.message}`);
  return batch.value;
}

/** The issued packets of the owner-map roles: one per role, both issued for a Task touching an owned family. */
function ownerMapRolePackets(batch: WaveRequestBatch): readonly ContextPacket[] {
  const packets = batch.subjects.flatMap((subject, index) =>
    OWNER_MAP_ROLES.includes(subject.role) && subject.taskId === "T1" ? [batch.packets[index]!] : []);
  expect(packets.map(({ role }) => role)).toEqual(OWNER_MAP_ROLES);
  return packets;
}

/** The owner-map section of `packet`, which must be one of its fixed (digest-bound) sections. */
function ownerMapSection(packet: ContextPacket) {
  const section = packet.fixedContext.find(({ label }) => label === OWNER_MAP_SECTION);
  expect(section, `the ${packet.role} packet carries no engine-issued "${OWNER_MAP_SECTION}" fixed section`).toBeDefined();
  return section!;
}

const ownerMapText = (packet: ContextPacket): string =>
  Buffer.from(ownerMapSection(packet).bytes).toString("utf8");


describe("owner-map section in Wave review packets (CT-2)", () => {
  it("AS-022: FR-022: the code-reviewer packet of a Task touching an owned family lists that Invariant's id, title, owner, siblings, matrix test and statement", () => {
    const batch = issue(projectWithPlan(), stampedGraph([FEES, CLOCK]));

    for (const packet of ownerMapRolePackets(batch)) {
      const text = ownerMapText(packet);
      expect(text).toContain(FEES.invariant);
      expect(text).toContain(FEES.title);
      expect(text).toContain(FEES.owner);
      for (const sibling of FEES.siblings) {
        expect(text).toContain(sibling.path);
        expect(text).toContain(sibling.note);
      }
      expect(text).toContain(FEES.matrixTest);
      expect(text).toContain(FEES.statement);
      // Only the Invariants whose family the reviewed Task touches.
      expect(text).not.toContain(CLOCK.invariant);
      expect(text).not.toContain(CLOCK.owner);
    }
  });

  it("FR-022: AS-023: the owner-map section carries the second-copy rule, citing the plan file and Invariant as the violated contract", () => {
    const batch = issue(projectWithPlan(), stampedGraph([FEES, CLOCK]));

    for (const packet of ownerMapRolePackets(batch)) {
      const text = ownerMapText(packet);
      // A predicate implemented outside the owner module is a finding…
      expect(someParagraph(text, /outside/i, /owner module/i)).toBe(true);
      // …citing `<plan file>#INV-N` as the violated contract.
      expect(text).toContain(`${PLAN_FILE}#${FEES.invariant}`);
      expect(someParagraph(text, /violated contract/i)).toBe(true);
    }
  });

  it("FR-025: AS-023: the second-copy rule rates a diverging copy critical with the diverging input as its consequence, and an identical copy advisory", () => {
    const batch = issue(projectWithPlan(), stampedGraph([FEES]));

    for (const packet of ownerMapRolePackets(batch)) {
      const text = ownerMapText(packet);
      expect(someParagraph(text, /\bcritical\b/i, /diverg/i)).toBe(true);
      expect(someParagraph(text, /diverging input/i, /consequence/i)).toBe(true);
      expect(someParagraph(text, /\badvisory\b/i, /identical/i)).toBe(true);
      expect(text).toContain(`${PLAN_FILE}#${FEES.invariant}`);
    }
  });

  it("AS-025: FR-023: the owner map is inside the packet digest, so a changed owner map changes the packet's identity", () => {
    const root = projectWithPlan();
    const before = issue(root, stampedGraph([FEES]));
    const after = issue(root, stampedGraph([ownerObligation({ ...FEES, statement: `${FEES.statement} Discounts included.` })]));

    const beforePackets = ownerMapRolePackets(before);
    const afterPackets = ownerMapRolePackets(after);
    expect(afterPackets.length).toBe(beforePackets.length);
    for (const [index, packet] of beforePackets.entries()) {
      const changed = afterPackets[index]!;
      const beforeSection = ownerMapSection(packet);
      const afterSection = ownerMapSection(changed);
      expect(Buffer.from(afterSection.bytes).toString("utf8")).toContain("Discounts included.");
      expect(afterSection.digest).not.toBe(beforeSection.digest);
      // The packet digest — the request's retry identity — covers the section.
      expect(changed.digest).not.toBe(packet.digest);
    }
    // Nothing else moved: the batch epoch is the same reviewed Wave.
    expect(after.batchEpoch).toBe(before.batchEpoch);
  });
});
