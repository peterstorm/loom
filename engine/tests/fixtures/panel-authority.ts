/**
 * The persistent panels' publication authority, minted through the real
 * issuance machinery and never asserted: canonical roster slots, the exact
 * semantic verifier roster, and spawn requests issued through the initial
 * batch publication reconciler. The expected receipt is the one
 * `prepareInitialBatchPublicationIntent` derives, so the receipt wire format
 * and its publication digest live in production code only — a receipt-format
 * change reaches every panel suite through this one module.
 *
 * The roster and authority builders are pure. Issuing publications needs a
 * trusted registration store, so that state lives behind
 * `createPanelPublications()`: each suite (or test) creates its own store with
 * its own resolver and effect-id sequence, so no registration leaks across
 * suites and no identity value depends on suite execution order.
 */
import { createHash } from "node:crypto";
import {
  deriveRefutationVerifierBinding,
  parseArchitecturePanelAuthority,
  parseRefutationPanelAuthority,
  type ArchitecturePanelAuthority,
  type RefutationPanelAuthority,
} from "../../src/core/panel-authority";
import {
  createAtomicInitialPublicationClaimPort,
  createInitialBatchPublicationReconciler,
  createInitialPublicationEffectPort,
  createPublicationAuthorityResolver,
  parseAgentRequestAuthority,
  parseAgentRosterSlot,
  parseContextDigest,
  parseEffectId,
  parseOrchestrationRunId,
  parseRequestId,
  parseSlotId,
  prepareInitialBatchPublicationIntent,
  spawnBatchAction,
  type AgentRequestAuthority,
  type AgentRosterSlot,
  type NonEmpty,
  type OrchestrationRunId,
  type PublicationAuthorityResolver,
  type SpawnRequest,
  type TrustedPublicationRegistrationLoader,
} from "../../src/core/orchestration-contract";
import { parseWaveFindingId, type BriefFinding, type ReviewLens, type WaveFindingId } from "../../src/core/review-panel";
import { value } from "./parse-result";
import { LOCAL_PI_BINDING } from "./local-pi-binding";

const hexDigest = (seed: string): string => createHash("sha256").update(seed).digest("hex");

export const PANEL_HARNESS_BINDINGS = {
  pi: LOCAL_PI_BINDING,
  claude: { harness: "claude-code", model: "opus" },
} as const;

type PanelProgram = "architecture-panel" | "refutation-panel";
type PanelRole = "arch-designer-agent" | "arch-judge-agent" | "review-verifier-agent";

const bytes = (raw: unknown): readonly number[] => [...new TextEncoder().encode(JSON.stringify(raw))];
const registrationKey = ({ runId, effectId }: Readonly<{ runId: string; effectId: string }>) => `${runId}\u0000${effectId}`;

/** One ordinal panel request authority: `<runId>:<stage>:<slot>:<attempt>`. */
export function panelRequestAuthority(
  runId: OrchestrationRunId,
  stage: string,
  slotIndex: number,
  attempt: 1 | 2,
  program: PanelProgram,
  role: PanelRole,
): AgentRequestAuthority {
  const profile = role === "arch-designer-agent" ? "panel-design" : role === "arch-judge-agent" ? "panel-judge" : "refutation";
  return value(parseAgentRequestAuthority({
    runId,
    requestId: value(parseRequestId(`${runId}:${stage}:${slotIndex}:${attempt}`)),
    slotId: value(parseSlotId(`${stage}:${slotIndex}`)),
    program,
    role,
    attempt,
    modelProfile: profile,
    harnessBinding: PANEL_HARNESS_BINDINGS,
    requiredSkill: role === "arch-designer-agent" ? "architecture-tech-lead" : null,
    contextDigest: value(parseContextDigest(hexDigest(`${runId}:${stage}:${slotIndex}:${attempt}:context`))),
    outputSlot: `transcripts/${stage}-${slotIndex}-attempt-${attempt}.json`,
  }));
}

/** One ordinal roster slot with both semantic attempts. */
export function panelRosterSlot(
  runId: OrchestrationRunId,
  stage: string,
  slotIndex: number,
  program: PanelProgram,
  role: PanelRole,
): AgentRosterSlot {
  return value(parseAgentRosterSlot(
    panelRequestAuthority(runId, stage, slotIndex, 1, program, role),
    panelRequestAuthority(runId, stage, slotIndex, 2, program, role),
  ));
}

/** The refutation roster: identities are SEMANTIC, derived from the run, the
 *  lens and the exact finding set (the derivation every producer uses), so
 *  reordering lenses or findings cannot relabel issued verifier requests. */
export function semanticVerifierSlots(
  runId: OrchestrationRunId,
  lenses: readonly string[],
  findingIds: NonEmpty<WaveFindingId>,
): AgentRosterSlot[] {
  return lenses.map((lens) => {
    const binding = value(deriveRefutationVerifierBinding(runId, lens as ReviewLens, findingIds));
    const attempts = ([1, 2] as const).map((attempt, index) =>
      value(parseAgentRequestAuthority({
        runId,
        requestId: binding.requestIds[index],
        slotId: binding.slotId,
        program: "refutation-panel",
        role: "review-verifier-agent",
        attempt,
        modelProfile: "refutation",
        harnessBinding: PANEL_HARNESS_BINDINGS,
        requiredSkill: null,
        contextDigest: value(parseContextDigest(hexDigest(`${runId}:${binding.slotId}:${attempt}:context`))),
        outputSlot: `transcripts/${binding.slotId}-attempt-${attempt}.json`,
      })));
    return value(parseAgentRosterSlot(attempts[0]!, attempts[1]!));
  });
}

export type ArchitecturePanelFixture = Readonly<{
  authority: ArchitecturePanelAuthority;
  /** The issued attempt-1 candidate requests, in roster order. */
  candidates: readonly SpawnRequest[];
  /** The issued attempt-1 judge requests, in roster order. */
  judges: readonly SpawnRequest[];
}>;

const waveId = (raw: string): WaveFindingId => {
  const parsed = parseWaveFindingId(raw);
  if (parsed === null) throw new Error(`invalid test wave finding id: ${raw}`);
  return parsed;
};

/** The two critical Findings the refutation fixtures vote on by default. */
export const PANEL_FIXTURE_FINDINGS: readonly [BriefFinding, BriefFinding] = [
  { id: waveId("T1:code-reviewer-1"), taskId: "T1", agent: "code-reviewer", severity: "critical", file: "src/a.ts", line: 10, claim: "first claim" },
  { id: waveId("T2:security-agent-1"), taskId: "T2", agent: "security-agent", severity: "critical", file: "src/b.ts", line: 20, claim: "second claim" },
];

export type RefutationPanelFixture = Readonly<{
  authority: RefutationPanelAuthority;
  /** The issued attempt-1 verifier requests, in lens order. */
  requests: readonly SpawnRequest[];
}>;

/** One private publication store: the trusted registrations its resolver
 *  reads, the batches it issued, and the panels issued through it. */
export type PanelPublications = Readonly<{
  /** Resolves every publication this store's `issuePanelRequests` registered. */
  resolver: PublicationAuthorityResolver;
  /**
   * Issue one batch through the real initial publication reconciler and
   * register its receipt in this store. The receipt is exactly the one the
   * prepared intent expects, so nothing here restates the receipt format.
   */
  issuePanelRequests: (requests: readonly AgentRequestAuthority[]) => readonly SpawnRequest[];
  /**
   * Run `body` while the trusted registration behind `request` holds the
   * bytes `rewrite` derives from its registered receipt, restoring the
   * original afterwards: the publication identity still resolves, but the
   * authority behind it has moved.
   */
  withRewrittenPanelRegistration: <T>(
    request: SpawnRequest,
    rewrite: (receipt: Readonly<Record<string, unknown>>) => unknown,
    body: () => T,
  ) => T;
  /** A two-candidate, two-judge architecture panel with both stages issued. */
  architecturePanelFixture: (runId: string) => ArchitecturePanelFixture;
  /** A refutation panel over `findings` with one semantic verifier per lens, issued. */
  refutationPanelFixture: (
    runId: string,
    lenses: readonly ReviewLens[],
    findings?: readonly [BriefFinding, ...BriefFinding[]],
  ) => RefutationPanelFixture;
}>;

/** A fresh publication store with its own registrations and effect-id
 *  sequence — one per suite (or per test that needs isolation). */
export function createPanelPublications(): PanelPublications {
  const registrations = new Map<string, readonly number[]>();
  let publicationSequence = 0;
  const registrationLoader: TrustedPublicationRegistrationLoader = (lookup) => {
    const found = registrations.get(registrationKey(lookup));
    return found === undefined
      ? { ok: false, error: { kind: "publication-authority-unavailable", message: "not registered" } }
      : { ok: true, value: found };
  };

  const issuePanelRequests = (requests: readonly AgentRequestAuthority[]): readonly SpawnRequest[] => {
    publicationSequence += 1;
    const effectId = value(parseEffectId(`effect:panel-fixture:${publicationSequence}`));
    const runId = requests[0]!.runId;
    const rawRequests = requests.map((authority) => ({
      authority,
      context: { digest: authority.contextDigest, slot: `contexts/${authority.contextDigest}.json` },
    }));
    const intent = value(prepareInitialBatchPublicationIntent(runId, effectId, rawRequests));
    const receipt = {
      schemaVersion: 1,
      kind: "batch-published",
      effectId: intent.identity.effectId,
      runId: intent.identity.runId,
      requestIds: intent.requestIds,
      contextDigests: intent.contextDigests,
      issuedRequests: intent.issuedRequests,
      publicationDigest: intent.identity.publicationDigest,
    };
    const reconcile = createInitialBatchPublicationReconciler(
      createInitialPublicationEffectPort(() => ({ ok: true, value: bytes(receipt) })),
      createAtomicInitialPublicationClaimPort((request) => ({
        ok: true,
        value: { schemaVersion: 1, kind: "initial-publication-claimed", key: request.key, identity: request.identity },
      })),
    );
    const action = value(spawnBatchAction(value(reconcile(intent)), rawRequests));
    registrations.set(registrationKey(receipt), bytes(receipt));
    return action.requests;
  };

  const withRewrittenPanelRegistration = <T>(
    request: SpawnRequest,
    rewrite: (receipt: Readonly<Record<string, unknown>>) => unknown,
    body: () => T,
  ): T => {
    const key = registrationKey({ runId: request.issuance.runId, effectId: request.issuance.effectId });
    const original = registrations.get(key);
    if (original === undefined) throw new Error(`no registration for ${key}`);
    registrations.set(key, bytes(rewrite(JSON.parse(new TextDecoder().decode(Uint8Array.from(original))) as Record<string, unknown>)));
    try {
      return body();
    } finally {
      registrations.set(key, original);
    }
  };

  const architecturePanelFixture = (runId: string): ArchitecturePanelFixture => {
    const run = value(parseOrchestrationRunId(runId));
    const candidateSlots = [1, 2].map((slot) => panelRosterSlot(run, "candidate", slot, "architecture-panel", "arch-designer-agent"));
    const judgeSlots = [1, 2].map((slot) => panelRosterSlot(run, "judge", slot, "architecture-panel", "arch-judge-agent"));
    const authority = value(parseArchitecturePanelAuthority({
      runId: run,
      candidateLenses: ["simplicity-first", "type-driven-fp"],
      judgeCriteria: ["simplicity", "pure functional core"],
      candidateSlots,
      judgeSlots,
    }));
    return {
      authority,
      candidates: issuePanelRequests(candidateSlots.map(({ attempts }) => attempts[0])),
      judges: issuePanelRequests(judgeSlots.map(({ attempts }) => attempts[0])),
    };
  };

  const refutationPanelFixture = (
    runId: string,
    lenses: readonly ReviewLens[],
    findings: readonly [BriefFinding, ...BriefFinding[]] = PANEL_FIXTURE_FINDINGS,
  ): RefutationPanelFixture => {
    const run = value(parseOrchestrationRunId(runId));
    const findingIds = findings.map(({ id }) => id) as unknown as NonEmpty<WaveFindingId>;
    const slots = semanticVerifierSlots(run, lenses, findingIds);
    const authority = value(parseRefutationPanelAuthority({
      runId: run,
      findings,
      lenses,
      verifierSlots: slots,
    }));
    return { authority, requests: issuePanelRequests(slots.map(({ attempts }) => attempts[0])) };
  };

  return Object.freeze({
    resolver: createPublicationAuthorityResolver(registrationLoader),
    issuePanelRequests,
    withRewrittenPanelRegistration,
    architecturePanelFixture,
    refutationPanelFixture,
  });
}
