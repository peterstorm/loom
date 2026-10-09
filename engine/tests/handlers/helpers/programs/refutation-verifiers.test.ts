import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalTempDir } from "../../../fixtures/canonical-temp-dir";
import { buildContextPacket, encodeByteSection } from "../../../../src/core/context-packets";
import { currentProfileBindings, type PiBinding } from "../../../../src/core/model-profiles";
import { parseAgentRosterSlot, type AgentRequestAuthority, type AgentRosterSlot } from "../../../../src/core/orchestration-contract";
import { parseRefutationPanelAuthority, type RefutationPanelAuthority } from "../../../../src/core/panel-authority";
import { decideRefutationVerifiers, type RefutationVerifierPlan } from "../../../../src/core/refutation-verifiers";
import { parseWaveFindingId, type BriefFinding, type ReviewLens } from "../../../../src/core/review-panel";
import { publicationFile, refutationBatchEffectId } from "../../../../src/handlers/helpers/programs/durable-requests";
import { prepareRefutationVerifiers } from "../../../../src/handlers/helpers/programs/refutation-verifiers";
import { publishLegacyInitialBatch } from "../../../../src/handlers/helpers/programs/request-publication";
import { createRunDirectory, type RunDirHandle } from "../../../../src/orchestration/run-directory-handle";
import { RETIRED_REFUTATION_PI_BINDING as RETIRED } from "../../../fixtures/local-pi-binding";

/**
 * The shell step reads the panel's record — the checkpoint the caller holds,
 * else the published attempt-1 receipt — and hands it to the pure decision
 * (tests/core/refutation-verifiers.test.ts covers the decision itself).
 */

const LABEL = "fixture-refutation";
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

const PANEL: Omit<RefutationVerifierPlan, "runId"> = {
  findings: FINDINGS,
  lenses: LENSES,
  packet: (lens, requestId, attempt) => {
    const section = encodeByteSection("fixture-refutation-authority", JSON.stringify({ lens, attempt }));
    return section.ok
      ? buildContextPacket({
          requestId, role: "review-verifier-agent", requiredSkill: "none",
          outputContract: `Adjudicate through lens '${lens}'.`, fixedContext: [section.value], variableContext: [],
        })
      : section;
  },
};

/** `panel` as it would have been recorded with every verifier request on `pi`. */
function recordedOn(panel: RefutationPanelAuthority, pi: PiBinding): RefutationPanelAuthority {
  const rebind = (authority: AgentRequestAuthority) => ({ ...authority, harnessBinding: { ...authority.harnessBinding, pi } });
  const verifierSlots = panel.verifierRoster.orderedSlots.map(({ attempts }) => {
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

/** Publish `panel`'s attempt-1 batch under the fixture label, as a program's first emission does. */
async function publishAttemptOne(handle: RunDirHandle, panel: RefutationPanelAuthority): Promise<void> {
  const prepared = decideRefutationVerifiers({ ...PANEL, runId: handle.runId }, { kind: "checkpointed-panel", panel });
  if (!prepared.ok) throw new Error(prepared.error.message);
  const published = await publishLegacyInitialBatch(handle, prepared.value.inputs, prepared.value.packets, LABEL);
  if (!published.ok) throw new Error(published.message);
}

describe("prepareRefutationVerifiers: the record the shell reads", () => {
  it("mints the panel when it has neither a checkpoint nor a published receipt", () => {
    const prepared = prepareRefutationVerifiers({ handle: runDirectory(), label: LABEL, checkpointed: null }, PANEL);
    expect(bindings(prepared.refutationAuthority.verifierRoster.orderedSlots))
      .toEqual(Array(4).fill(currentProfileBindings("refutation").pi));
  });

  it("reads a published attempt-1 receipt as the panel's record when no checkpoint is held", async () => {
    const handle = runDirectory();
    const minted = prepareRefutationVerifiers({ handle, label: LABEL, checkpointed: null }, PANEL);
    const recorded = recordedOn(minted.refutationAuthority, RETIRED);
    await publishAttemptOne(handle, recorded);

    const prepared = prepareRefutationVerifiers({ handle, label: LABEL, checkpointed: null }, PANEL);

    expect(prepared.refutationAuthority).toEqual(recorded);
    expect(bindings(prepared.refutationAuthority.verifierRoster.orderedSlots)).toEqual(Array(4).fill(RETIRED));
  });

  it("prefers the checkpointed panel to the receipt: the checkpoint is the earliest record of issuance", async () => {
    const handle = runDirectory();
    const minted = prepareRefutationVerifiers({ handle, label: LABEL, checkpointed: null }, PANEL).refutationAuthority;
    await publishAttemptOne(handle, minted);
    const checkpoint = recordedOn(minted, RETIRED);

    const prepared = prepareRefutationVerifiers({ handle, label: LABEL, checkpointed: checkpoint }, PANEL);

    expect(prepared.refutationAuthority).toEqual(checkpoint);
  });

  it("refuses to mint over a receipt it cannot read", () => {
    const handle = runDirectory();
    const ids = prepareRefutationVerifiers({ handle, label: LABEL, checkpointed: null }, PANEL).inputs
      .map(({ authority }) => authority.requestId);
    const effectId = refutationBatchEffectId(LABEL, ids);
    if (!effectId.ok) throw new Error(effectId.error.message);
    const path = join(handle.runDirectory, "artifacts", publicationFile(effectId.value));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{not json");

    expect(() => prepareRefutationVerifiers({ handle, label: LABEL, checkpointed: null }, PANEL))
      .toThrow(/durable publication receipt is invalid JSON/);
  });

  it("throws the decision's refusal at the shell boundary", () => {
    const handle = runDirectory();
    expect(() => prepareRefutationVerifiers({ handle, label: LABEL, checkpointed: null }, {
      ...PANEL, packet: () => ({ ok: false, error: { message: "no packet today" } }),
    })).toThrow("no packet today");
  });
});
