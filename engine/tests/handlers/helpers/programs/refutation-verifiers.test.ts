import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalTempDir } from "../../../fixtures/canonical-temp-dir";
import { buildContextPacket, encodeByteSection, type ContextPacket } from "../../../../src/core/context-packets";
import { currentProfileBindings, resolveAgentPolicy, type PiBinding } from "../../../../src/core/model-profiles";
import {
  parseAgentRosterSlot,
  type AgentRequestAuthority,
  type AgentRosterSlot,
  type MintedAgentRosterSlot,
} from "../../../../src/core/orchestration-contract";
import { parseRefutationPanelAuthority, type RefutationPanelAuthority } from "../../../../src/core/panel-authority";
import { parseWaveFindingId, type BriefFinding, type ReviewLens } from "../../../../src/core/review-panel";
import { prepareRefutationVerifiers, type RefutationVerifierPlan } from "../../../../src/handlers/helpers/programs/refutation-verifiers";
import { createRunDirectory, type RunDirHandle } from "../../../../src/orchestration/run-directory-handle";
import { RETIRED_REFUTATION_PI_BINDING as RETIRED } from "../../../fixtures/local-pi-binding";

/**
 * A refutation panel's verifier requests are minted from today's catalog only
 * when the panel has no record; a recorded panel is read back as history.
 */

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

function runDirectory(): RunDirHandle {
  const runsRoot = canonicalTempDir("loom-refutation-verifiers-");
  cleanup.push(runsRoot);
  const runDir = join(runsRoot, "run.refutation-verifiers");
  mkdirSync(runDir);
  const handle = createRunDirectory(runsRoot, runDir);
  if (!handle.ok) throw new Error(handle.error.message);
  return handle.value;
}

const findingId = parseWaveFindingId("T1:finding-1");
if (findingId === null) throw new Error("fixture finding id must parse");
const FINDINGS: readonly [BriefFinding] = [Object.freeze({
  id: findingId, taskId: "T1", agent: "code-reviewer", severity: "critical", file: null, line: null, claim: "a claim",
})];
const LENSES: readonly [ReviewLens, ReviewLens] = ["reproduction", "intent"];

function plan(handle: RunDirHandle, overrides: Partial<RefutationVerifierPlan> = {}): RefutationVerifierPlan {
  return {
    handle,
    label: "fixture-refutation",
    findings: FINDINGS,
    lenses: LENSES,
    packet: (lens, requestId, attempt) => {
      const section = encodeByteSection("fixture-refutation-authority", JSON.stringify({ lens, attempt }));
      if (!section.ok) throw new Error(section.error.message);
      const packet = buildContextPacket({
        requestId, role: "review-verifier-agent", requiredSkill: "none",
        outputContract: `Adjudicate through lens '${lens}'.`, fixedContext: [section.value], variableContext: [],
      });
      if (!packet.ok) throw new Error(packet.error.message);
      return packet.value;
    },
    ...overrides,
  };
}

/** `panel` as it would have been recorded with every verifier request on `pi`. */
function recordedOn(panel: RefutationPanelAuthority, pi: PiBinding, slots = panel.verifierRoster.orderedSlots): RefutationPanelAuthority {
  const rebind = (authority: AgentRequestAuthority) => ({ ...authority, harnessBinding: { ...authority.harnessBinding, pi } });
  const verifierSlots = slots.map(({ attempts }) => {
    const slot = parseAgentRosterSlot(rebind(attempts[0]), rebind(attempts[1]));
    if (!slot.ok) throw new Error(JSON.stringify(slot.error));
    return slot.value;
  });
  const parsed = parseRefutationPanelAuthority({
    runId: panel.runId, identityRunId: panel.identityRunId, findings: panel.findings, lenses: panel.lenses, verifierSlots,
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

const bindings = (slots: readonly AgentRosterSlot[]) =>
  slots.flatMap(({ attempts }) => attempts.map(({ harnessBinding }) => harnessBinding.pi));

describe("refutation verifier preparation", () => {
  it("mints every verifier request from today's catalog when the panel has no record", () => {
    const prepared = prepareRefutationVerifiers(plan(runDirectory()));
    expect(bindings(prepared.panel.authority.verifierRoster.orderedSlots))
      .toEqual(Array(4).fill(currentProfileBindings("refutation").pi));
    expect(prepared.inputs.map(({ authority }) => authority))
      .toEqual(prepared.panel.authority.verifierRoster.orderedSlots.map(({ attempts }) => attempts[0]));
    expect(prepared.retryInputs.map(({ input }) => input.authority))
      .toEqual(prepared.panel.authority.verifierRoster.orderedSlots.map(({ attempts }) => attempts[1]));
    expect(prepared.packets.map(({ digest }) => digest)).toEqual(prepared.inputs.map(({ authority }) => authority.contextDigest));
  });

  it("reads a recorded panel back as history instead of re-minting today's binding", () => {
    const handle = runDirectory();
    const recorded = recordedOn(prepareRefutationVerifiers(plan(handle)).panel.authority, RETIRED);
    const prepared = prepareRefutationVerifiers(plan(handle, { recorded }));
    expect(prepared.panel).toEqual({ kind: "recorded", authority: recorded });
    expect(bindings(prepared.panel.authority.verifierRoster.orderedSlots)).toEqual(Array(4).fill(RETIRED));
    expect(prepared.retryInputs.map(({ input }) => input.authority.harnessBinding.pi)).toEqual([RETIRED, RETIRED]);
  });

  it("refuses a record whose request differs from the panel's deterministic request", () => {
    const handle = runDirectory();
    const recorded = recordedOn(prepareRefutationVerifiers(plan(handle)).panel.authority, RETIRED);
    const drifted = plan(handle, {
      recorded,
      packet: (lens, requestId, attempt) => plan(handle).packet(lens, requestId, attempt === 1 ? 2 : 1),
    });
    expect(() => prepareRefutationVerifiers(drifted)).toThrow(/differs from the panel's deterministic request/);
  });

  it("issues an unrecorded panel as minted, routing every verifier request through the catalog's verifier policy", () => {
    const prepared = prepareRefutationVerifiers(plan(runDirectory()));
    expect(prepared.panel.kind).toBe("issued");
    if (prepared.panel.kind !== "issued") return;
    // The issued roster keeps its minted proof: a catalog profile on the local binding, by type.
    const minted: readonly MintedAgentRosterSlot[] = prepared.panel.authority.verifierRoster.orderedSlots;
    const policy = resolveAgentPolicy("review-verifier-agent");
    if (!policy.ok) throw new Error(policy.error.message);
    const verifierPolicy = policy.value;
    for (const request of minted.flatMap(({ attempts }) => attempts)) {
      expect(request.role).toBe("review-verifier-agent");
      expect(request.modelProfile).toBe(verifierPolicy.profile);
      expect(request.requiredSkill).toBe(verifierPolicy.requiredSkill);
      expect(request.harnessBinding).toEqual(currentProfileBindings(verifierPolicy.profile));
      // Golden bytes: the serialized verifier authority's binding, as every
      // Refutation Panel (standalone and Wave) issues it today.
      expect(JSON.stringify(request.harnessBinding)).toBe(
        '{"pi":{"harness":"pi","provider":"desktop-vllm","model":"glm-5.3-flash-spark-tp2-v14","thinking":"high"},' +
        '"claude":{"harness":"claude-code","model":"opus"}}',
      );
      expect(request.modelProfile).toBe("refutation");
    }
    expect(prepared.panel.authority.findings).toEqual(FINDINGS);
    expect(prepared.panel.authority.lenses).toEqual(LENSES);
  });

  it("issues the same panel a re-read of its own record parses, so issuance and history agree", () => {
    const handle = runDirectory();
    const issued = prepareRefutationVerifiers(plan(handle)).panel.authority;
    expect(prepareRefutationVerifiers(plan(handle, { recorded: issued })).panel).toEqual({ kind: "recorded", authority: issued });
  });

  it("names the catalog's own reasons when a verifier request cannot be minted", () => {
    const handle = runDirectory();
    const malformed = plan(handle, {
      // A forged packet: its digest is no Context Packet digest, so the catalog parse refuses it.
      packet: (lens, requestId, attempt) =>
        ({ ...plan(handle).packet(lens, requestId, attempt), digest: "not-a-digest" }) as unknown as ContextPacket,
    });
    const refusal = (): string => {
      try {
        prepareRefutationVerifiers(malformed);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("a verifier request with a malformed Context Packet digest must not mint");
    };
    // Both attempts' catalog violations are propagated verbatim, never collapsed
    // into a bare "failed to derive".
    const parsed = refusal().match(/^verifier slot (refutation-slot:[0-9a-f]+) cannot be minted: (.+)$/);
    expect(parsed).not.toBeNull();
    const reasons = parsed?.[2]?.split("; ") ?? [];
    expect(reasons.length).toBeGreaterThanOrEqual(2);
    expect(reasons.some((reason) => /digest/i.test(reason))).toBe(true);
    expect(reasons.every((reason) => reason.length > 0 && reason !== "roster slot: invalid")).toBe(true);
  });

  it("refuses a record that lacks one of the panel's verifier slots", () => {
    const handle = runDirectory();
    const oneLens = prepareRefutationVerifiers(plan(handle, { lenses: ["reproduction"] })).panel.authority;
    expect(() => prepareRefutationVerifiers(plan(handle, { recorded: recordedOn(oneLens, RETIRED) }))).toThrow(/lacks verifier request/);
  });
});
