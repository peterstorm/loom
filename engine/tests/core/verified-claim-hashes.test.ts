import { describe, expect, it } from "vitest";
import { parseSpec, type ParsedSpec } from "../../src/core/parse-spec";
import { parseArtifactDigest, type ArtifactDigest } from "../../src/core/orchestration-contract";
import { recordedAnchorHashes, type SpecIndexAvailability } from "../../src/core/requirement-coverage";
import { reanchorVerifiedClaims } from "../../src/core/verified-claim-hashes";
import type { Task, TaskGraph, WaveSpecCheckDocumentsAuthority } from "../../src/types";

const specSource = (fr1: string) => `# Feature: Re-anchoring

## User Scenarios

### US1: [P1] Verify claims

**Acceptance Scenarios:**
- AS-001: Given a passing Wave, When it completes, Then its claims name the verified text

## Functional Requirements

- FR-001: ${fr1}
- FR-002: System MUST keep later Waves' hashes untouched

## Out of Scope

- OOS-001: Re-verifying completed Waves

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Claim | A Requirement Completion Claim |
`;

const indexOf = (source: string): ParsedSpec => {
  const parsed = parseSpec(source);
  if (!parsed.ok) throw new Error("fixture specification must parse");
  return parsed.value;
};
const digest = (fill: string): ArtifactDigest => {
  const parsed = parseArtifactDigest(fill.repeat(64));
  if (!parsed.ok) throw new Error("fixture digest must parse");
  return parsed.value;
};

const claimed = indexOf(specSource("System MUST record hashes at claim time"));
const verified = indexOf(specSource("System MUST record the hashes a passing Wave verified"));
const REVIEWED = digest("a");
const reviewed: WaveSpecCheckDocumentsAuthority = {
  spec: { path: "spec.md", contentDigest: REVIEWED },
  plan: { path: null, contentDigest: null },
};
const indexed = (index: ParsedSpec, contentDigest: ArtifactDigest = REVIEWED): SpecIndexAvailability =>
  ({ kind: "indexed", path: "spec.md", contentDigest, index });

const task = (id: string, wave: number, anchors: readonly string[]): Task => ({
  id,
  wave,
  spec_anchors: anchors,
  spec_anchor_hashes: recordedAnchorHashes(claimed, anchors),
} as unknown as Task);
const graph = (tasks: readonly Task[]): TaskGraph => ({ tasks } as unknown as TaskGraph);

describe("reanchorVerifiedClaims", () => {
  const roster = graph([task("T1", 1, ["FR-001", "AS-001"]), task("T2", 2, ["FR-001"]), task("T3", 1, [])]);

  it("records the reviewed text's hashes on exactly the completed Wave's claims", () => {
    const reanchored = reanchorVerifiedClaims(roster, 1, reviewed, indexed(verified));
    expect(reanchored.tasks[0]?.spec_anchor_hashes).toEqual(recordedAnchorHashes(verified, ["FR-001", "AS-001"]));
    // A later Wave's claim keeps its claim-time hash: nothing verified it yet.
    expect(reanchored.tasks[1]).toBe(roster.tasks[1]);
    // A Task that claims nothing gains no hash map.
    expect(reanchored.tasks[2]).toBe(roster.tasks[2]);
  });

  it("returns the same graph when the verified text already matches the recorded hashes", () => {
    expect(reanchorVerifiedClaims(roster, 1, reviewed, indexed(claimed))).toBe(roster);
  });

  it("keeps a recorded hash for a claim the reviewed Spec Index does not define", () => {
    const unknown = graph([{ ...task("T1", 1, ["FR-001"]), spec_anchors: ["FR-001", "FR-404"],
      spec_anchor_hashes: { ...recordedAnchorHashes(claimed, ["FR-001"]), "FR-404": "f".repeat(64) } } as Task]);
    expect(reanchorVerifiedClaims(unknown, 1, reviewed, indexed(verified)).tasks[0]?.spec_anchor_hashes).toEqual({
      ...recordedAnchorHashes(verified, ["FR-001"]),
      "FR-404": "f".repeat(64),
    });
  });

  it.each<[string, WaveSpecCheckDocumentsAuthority | undefined, SpecIndexAvailability]>([
    ["no reviewed spec-check documents", undefined, indexed(verified)],
    ["an index parsed from bytes other than the reviewed ones", reviewed, indexed(verified, digest("b"))],
    ["a reviewed spec at another path", { ...reviewed, spec: { path: "other.md", contentDigest: REVIEWED } }, indexed(verified)],
    ["no Spec Index", reviewed, { kind: "unavailable", reason: { kind: "no-spec-file" } }],
  ])("re-anchors nothing with %s, because nothing proves what was verified", (_name, documents, specIndex) => {
    expect(reanchorVerifiedClaims(roster, 1, documents, specIndex)).toBe(roster);
  });
});
