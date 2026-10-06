/**
 * The persistent panel's canonical verdict parsers fail closed when their
 * parse throws, and keep the thrown class in the diagnostic, so a code
 * regression stays distinguishable from merely malformed input. A BigInt score
 * in an in-memory durable judge event drives the throw: JSON cannot serialize
 * it, so the canonical re-serialization before `parseJudgeVerdict` throws a
 * TypeError. The publication authority is minted through the real reconciler,
 * as in `panel-verdict-fold.test.ts`.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseArchitecturePanelAuthority } from "../../src/core/panel-authority";
import {
  panelRequestIdentity,
  parsePersistentArchitecturePanelEvent,
  startPersistentArchitecturePanel,
  submitArchitectureCandidateResult,
} from "../../src/core/persistent-panel";
import {
  createAtomicInitialPublicationClaimPort,
  createInitialBatchPublicationReconciler,
  createInitialPublicationEffectPort,
  createPublicationAuthorityResolver,
  parseAgentRequestAuthority,
  parseAgentRosterSlot,
  parseBatchPublishedReceipt,
  parseContextDigest,
  parseEffectId,
  parseOrchestrationRunId,
  parseRequestId,
  parseSlotId,
  prepareInitialBatchPublicationIntent,
  spawnBatchAction,
  type AgentRequestAuthority,
  type OrchestrationRunId,
  type SpawnRequest,
  type TrustedPublicationRegistrationLoader,
} from "../../src/core/orchestration-contract";

const hexDigest = (seed: string): string => createHash("sha256").update(seed).digest("hex");
const bindings = {
  pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
  claude: { harness: "claude-code", model: "opus" },
} as const;

function parsed<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result)}`);
  return result.value;
}

const registrations = new Map<string, readonly number[]>();
const bytes = (value: unknown): readonly number[] => [...new TextEncoder().encode(JSON.stringify(value))];
const key = ({ runId, effectId }: Readonly<{ runId: string; effectId: string }>) => `${runId}\u0000${effectId}`;
const loader: TrustedPublicationRegistrationLoader = (lookup) => {
  const found = registrations.get(key(lookup));
  return found === undefined
    ? { ok: false, error: { kind: "publication-authority-unavailable", message: "not registered" } }
    : { ok: true, value: found };
};
const resolver = createPublicationAuthorityResolver(loader);

function authorityFor(runId: OrchestrationRunId, stage: "candidate" | "judge", slotIndex: number, attempt: 1 | 2): AgentRequestAuthority {
  const designer = stage === "candidate";
  return parsed(parseAgentRequestAuthority({
    runId,
    requestId: parsed(parseRequestId(`${runId}:${stage}:${slotIndex}:${attempt}`)),
    slotId: parsed(parseSlotId(`${stage}:${slotIndex}`)),
    program: "architecture-panel",
    role: designer ? "arch-designer-agent" : "arch-judge-agent",
    attempt,
    modelProfile: designer ? "panel-design" : "panel-judge",
    harnessBinding: bindings,
    requiredSkill: designer ? "architecture-tech-lead" : null,
    contextDigest: parsed(parseContextDigest(hexDigest(`${runId}:${stage}:${slotIndex}:${attempt}:context`))),
    outputSlot: `transcripts/${stage}-${slotIndex}-attempt-${attempt}.json`,
  }));
}

const rosterSlot = (runId: OrchestrationRunId, stage: "candidate" | "judge", slotIndex: number) =>
  parsed(parseAgentRosterSlot(authorityFor(runId, stage, slotIndex, 1), authorityFor(runId, stage, slotIndex, 2)));

let sequence = 0;
function issue(requests: readonly AgentRequestAuthority[]): readonly SpawnRequest[] {
  sequence += 1;
  const effectId = parsed(parseEffectId(`effect:thrown-cause:${sequence}`));
  const runId = requests[0]!.runId;
  const rawRequests = requests.map((authority) => ({
    authority,
    context: { digest: authority.contextDigest, slot: `contexts/${authority.contextDigest}.json` },
  }));
  const published = {
    schemaVersion: 1,
    kind: "batch-published",
    effectId,
    runId,
    requestIds: requests.map(({ requestId }) => requestId),
    contextDigests: requests.map(({ contextDigest }) => contextDigest),
    issuedRequests: requests.map((authority) => ({
      authority,
      context: { digest: authority.contextDigest, slot: { kind: "fixed-artifact-slot", path: `contexts/${authority.contextDigest}.json` } },
    })),
  };
  const rawReceipt = { ...published, publicationDigest: hexDigestOfJson(published) };
  const receipt = parsed(parseBatchPublishedReceipt(rawReceipt));
  const intent = parsed(prepareInitialBatchPublicationIntent(runId, effectId, rawRequests));
  const reconcile = createInitialBatchPublicationReconciler(
    createInitialPublicationEffectPort(() => ({ ok: true, value: bytes(rawReceipt) })),
    createAtomicInitialPublicationClaimPort((request) => ({
      ok: true,
      value: { schemaVersion: 1, kind: "initial-publication-claimed", key: request.key, identity: request.identity },
    })),
  );
  const action = parsed(spawnBatchAction(parsed(reconcile(intent)), rawRequests));
  registrations.set(key(receipt), bytes(receipt));
  return action.requests;
}

function hexDigestOfJson(value: unknown): string {
  return createHash("sha256").update(new TextEncoder().encode(JSON.stringify(value))).digest("hex");
}

function awaitingJudges() {
  const runId = parsed(parseOrchestrationRunId("run.thrown-cause.arch"));
  const candidateSlots = [rosterSlot(runId, "candidate", 1), rosterSlot(runId, "candidate", 2)];
  const judgeSlots = [rosterSlot(runId, "judge", 1), rosterSlot(runId, "judge", 2)];
  const authority = parsed(parseArchitecturePanelAuthority({
    runId,
    candidateLenses: ["simplicity-first", "type-driven-fp"],
    judgeCriteria: ["simplicity", "pure functional core"],
    candidateSlots,
    judgeSlots,
  }));
  const candidates = issue(candidateSlots.map(({ attempts }) => attempts[0]));
  const judges = issue(judgeSlots.map(({ attempts }) => attempts[0]));
  let step = startPersistentArchitecturePanel(authority);
  for (const index of [1, 0]) {
    step = parsed(submitArchitectureCandidateResult(step.state, resolver, panelRequestIdentity(candidates[index]!), {
      lens: authority.candidateLenses[index],
      candidate: authority.candidateIds[index],
      artifact: `# candidate ${index + 1}`,
    }));
  }
  return { state: step.state, authority, judge: judges[0]! };
}

describe("persistent panel canonical judge parse", () => {
  it("keeps the thrown class when the canonical judge parse throws", () => {
    const { state, authority, judge } = awaitingJudges();
    const event = (score: unknown) => ({
      schemaVersion: 1,
      type: "architecture-judge-accepted",
      request: panelRequestIdentity(judge),
      value: {
        criterion: authority.judgeCriteria[0],
        entries: authority.candidateIds.map((candidate, index) => ({
          candidate, score: index === 0 ? score : 8, fatalFlaw: null, strongestIdea: `idea ${index + 1}`,
        })),
      },
    });

    expect(parsePersistentArchitecturePanelEvent(state, event(9), resolver).ok).toBe(true);

    const thrown = parsePersistentArchitecturePanelEvent(state, event(9n), resolver);
    expect(thrown.ok).toBe(false);
    if (thrown.ok) throw new Error("unreachable");
    expect(thrown.error.kind).toBe("request-binding-mismatch");
    expect(thrown.error.message).toBe("judge result could not be safely parsed (TypeError)");
  });
});
