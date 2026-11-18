/**
 * Choosing a fresh Wave Gate start's reviewer roster per Task (ADR-0094):
 * each reviewed Task the start does not carry is issued the roles its change
 * since its Review Basis needs, and the narrowed reviews are frozen into the
 * registration.
 *
 * The shell reads each Task's basis Review Packets from the basis run's Run
 * Directory and observes the current reviewed workspace; this module proves
 * the packets are the basis's, builds the before/after view and asks the
 * Change Class classifier and the role table (core/review-change.ts).
 * Anything unproven is a full review.
 *
 * Pure: no I/O.
 */
import type { Task, TaskGraph } from "../types";
import { BASE_WAVE_REVIEW_AGENTS, type WaveReviewRoster } from "./agent-catalog-projections";
import type { ContextPacket } from "./context-packets";
import { CONTRACT_SURFACE_ROLES, CONTRACT_SURFACE_SECTION, renderContractSurfaceSection } from "./contract-surface-section";
import type { CurrentAcceptedReviewAuthority } from "./findings-shape";
import { canonicalStructuralEquals, isNonEmpty, type DomainResult, type NonEmpty } from "./orchestration-contract";
import { OWNER_MAP_ROLES, OWNER_MAP_SECTION, renderOwnerMapSection } from "./owner-verification/owner-map";
import { frozenRedThenGreenEra } from "./proof-obligations";
import {
  classifyReviewChange,
  selectReviewRoles,
  type ReviewChange,
  type ReviewChangeSide,
  type ReviewContextFacts,
  type ReviewedFile,
  type ReviewFileContent,
  type SectionFact,
} from "./review-change";
import { basisAuthorityOf, reviewBasisOf } from "./review-narrowing";
import { admitReviewedWorkspace, type ReviewedWorkspaceObservation } from "./reviewed-workspace";
import { DEFAULT_TEST_FILE_SUFFIXES } from "./test-file-classification";
import { parseWaveFrozenSource, WAVE_FROZEN_SOURCE_SECTION, type WaveFrozenSource } from "./wave-frozen-source";
import type { NarrowedTaskReview } from "./wave-gate-program";
import {
  derivedWaveTaskReview,
  readWaveReviewContext,
  taskReviewScope,
  waveReviewPriorFindings,
  waveReviewStanding,
  type DerivedWaveTaskReview,
  type WaveReviewTaskAuthority,
} from "./wave-review-authority";

/**
 * What the shell read of one Task's basis: the Review Packets of the basis
 * run that name the basis Review Packet, by role, with the frozen source, the
 * Task context and the plan file they present, and the owner-map and
 * contract-surface sections of the roles that are owed them.
 */
export type BasisPacketView = Readonly<{
  runId: string;
  packetId: string;
  roles: readonly string[];
  frozenSource: WaveFrozenSource;
  task: WaveReviewTaskAuthority;
  planFile: string | null;
  /** The owner-map section an owner-map role's packet carried, or null when it carried none. */
  ownerMap: string | null;
  /** The contract-surface section a contract-surface role's packet carried, or null when it carried none. */
  contractSurface: string | null;
}>;

/** The shell's read of one basis, or why it could not read it. */
export type BasisObservation = DomainResult<BasisPacketView, string>;

/** One Review Packet the shell read from a basis run, with the role its request named. */
export type BasisPacket = Readonly<{ role: string; packet: ContextPacket }>;

/** A packet section's text, or null when the packet has no such section; refuses bytes that are not UTF-8. */
function sectionText(packet: ContextPacket, label: string): string | null {
  const section = packet.fixedContext.find((candidate) => candidate.label === label);
  return section === undefined
    ? null
    : new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(section.bytes));
}

/**
 * The view of `taskId`'s basis from the Review Packets `packets` of run
 * `runId`: those whose Wave review authority names `taskId` and the basis
 * Review Packet `packetId`. Refused when none does, when they disagree about
 * what they present, or when a section cannot be read.
 */
export function basisPacketView(
  runId: string,
  packetId: string,
  taskId: string,
  packets: readonly BasisPacket[],
): BasisObservation {
  const refuse = (error: string): BasisObservation => ({ ok: false, error: `basis run ${runId}: ${error}` });
  try {
    const mine = packets.flatMap(({ role, packet }) => {
      const context = readWaveReviewContext([packet], packet.digest);
      if (context.kind !== "loaded" || context.value.task === null || context.value.taskRun?.taskId !== taskId ||
          context.value.packetId !== packetId) return [];
      return [{ role, packet, task: context.value.task, planFile: context.value.planFile }];
    });
    const [first] = mine;
    if (first === undefined) return refuse(`holds no Review Packet ${packetId} of Task ${taskId}`);
    if (mine.some(({ task, planFile }) => !canonicalStructuralEquals({ ...task, priorFindings: [] }, { ...first.task, priorFindings: [] }) ||
        planFile !== first.planFile)) {
      return refuse(`its Review Packets of Task ${taskId} disagree`);
    }
    const sourceText = sectionText(first.packet, WAVE_FROZEN_SOURCE_SECTION);
    if (sourceText === null) return refuse(`its Review Packet of Task ${taskId} carries no frozen source`);
    const raw: unknown = JSON.parse(sourceText);
    const frozenSource = parseWaveFrozenSource(raw);
    if (!frozenSource.ok) return refuse(frozenSource.error);
    const owed = (roles: readonly string[], label: string): string | null =>
      mine.flatMap(({ role, packet }) => (roles.includes(role) ? [sectionText(packet, label)] : [])).find((text) => text !== null) ?? null;
    return { ok: true, value: Object.freeze({
      runId,
      packetId,
      roles: Object.freeze(mine.map(({ role }) => role)),
      frozenSource: frozenSource.value,
      task: first.task,
      planFile: first.planFile,
      ownerMap: owed(OWNER_MAP_ROLES, OWNER_MAP_SECTION),
      contractSurface: owed(CONTRACT_SURFACE_ROLES, CONTRACT_SURFACE_SECTION),
    }) };
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
}

/** Why a reviewed Task is issued its whole derived roster. */
export type FullRosterReason =
  | Readonly<{ kind: "fresh-review" }>
  | Readonly<{ kind: "no-basis" }>
  | Readonly<{ kind: "review-unsettled" }>
  | Readonly<{ kind: "workspace-unobserved" }>
  | Readonly<{ kind: "basis-unreadable"; error: string }>
  | Readonly<{ kind: "basis-mismatch"; detail: string }>
  | Readonly<{ kind: "change"; change: ReviewChange }>;

/**
 * The roster one reviewed Task is issued, and why: carried (none), its whole
 * derived roster with the reason, or narrowed, with the review the
 * registration freezes. The start's report and its registration are both
 * read from these choices, so they cannot disagree.
 */
export type TaskRosterChoice =
  | Readonly<{ taskId: string; kind: "carried" }>
  | Readonly<{ taskId: string; kind: "full"; roster: WaveReviewRoster; reason: FullRosterReason }>
  | Readonly<{ taskId: string; kind: "narrowed"; review: NarrowedTaskReview }>;

/** A start's roster plan: one choice per reviewed registered Task, in registration order. */
export type ReviewRolesPlan = readonly TaskRosterChoice[];

/** The narrowed reviews a start's plan freezes into its registration; undefined when none narrows. */
export function narrowedReviewsOf(plan: ReviewRolesPlan): NonEmpty<NarrowedTaskReview> | undefined {
  const narrowed = plan.flatMap((choice) => (choice.kind === "narrowed" ? [choice.review] : []));
  return isNonEmpty(narrowed) ? Object.freeze(narrowed) : undefined;
}

/** What decides whether a start reads a Task's basis: the Tasks it carries, and `--fresh-review`. */
export type BasisReadOptions = Readonly<{ carried: ReadonlySet<string>; freshReview: boolean }>;

/**
 * Whether a start consults `task`'s Review Basis (ADR-0094), the one rule the
 * shell's packet reads and the plan both follow:
 * - `carried`: the Successor Carry carries the Task, so it is never narrowed;
 * - `full`: it is reviewed in full without reading a basis, and why;
 * - `consult`: the basis whose packets decide its roster.
 */
export type BasisRead =
  | Readonly<{ kind: "carried" }>
  | Readonly<{ kind: "full"; reason: Extract<FullRosterReason, { kind: "fresh-review" | "review-unsettled" | "no-basis" }> }>
  | Readonly<{ kind: "consult"; basis: CurrentAcceptedReviewAuthority }>;

/** The one basis-read predicate (see `BasisRead`). */
export function basisReadOf(task: Task, options: BasisReadOptions): BasisRead {
  if (options.carried.has(task.id)) return Object.freeze({ kind: "carried" });
  if (options.freshReview) return Object.freeze({ kind: "full", reason: Object.freeze({ kind: "fresh-review" }) });
  if (task.review_run !== undefined) return Object.freeze({ kind: "full", reason: Object.freeze({ kind: "review-unsettled" }) });
  const basis = reviewBasisOf(task);
  return basis === undefined
    ? Object.freeze({ kind: "full", reason: Object.freeze({ kind: "no-basis" }) })
    : Object.freeze({ kind: "consult", basis });
}

export type ReviewRolesInput = BasisReadOptions & Readonly<{
  graph: TaskGraph;
  taskIds: readonly string[];
  workspaces: readonly ReviewedWorkspaceObservation[];
  /** Each consulted Task's basis as the shell read it (`basisReadOf`). */
  bases: ReadonlyMap<string, BasisObservation>;
}>;

const full = (task: Task, roster: WaveReviewRoster, reason: FullRosterReason): TaskRosterChoice =>
  Object.freeze({ taskId: task.id, kind: "full", roster, reason: Object.freeze(reason) });

/** A file's content as the view holds it, from observed bytes. */
function observedContent(contentBase64: string | null): ReviewFileContent {
  if (contentBase64 === null) return Object.freeze({ kind: "absent" });
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(contentBase64, "base64"));
    return Object.freeze({ kind: "text", text });
  } catch {
    return Object.freeze({ kind: "binary", base64: contentBase64 });
  }
}

/** A frozen-source file as the view holds it. */
function frozenFile(file: WaveFrozenSource["files"][number]): ReviewedFile {
  switch (file.kind) {
    case "absent": return Object.freeze({ path: file.path, content: Object.freeze({ kind: "absent" }) });
    case "text": return Object.freeze({ path: file.path, content: Object.freeze({ kind: "text", text: file.content }) });
    case "binary": return Object.freeze({ path: file.path, content: Object.freeze({ kind: "binary", base64: file.contentBase64 }) });
    default: return assertNever(file);
  }
}

function assertNever(value: never): never {
  throw new Error(`unknown frozen source file ${JSON.stringify(value)}`);
}

/**
 * One section as the basis presents it: observed when a role owed it was
 * issued in the basis run, or, when no such role was, absent by construction
 * if the basis was a narrowing of the base five (whose derivation carried no
 * architecture lens, so neither section); otherwise unobservable.
 */
function basisSection(
  view: BasisPacketView,
  roles: readonly string[],
  text: string | null,
  basis: CurrentAcceptedReviewAuthority,
): SectionFact {
  if (view.roles.some((role) => roles.includes(role))) return Object.freeze({ kind: "observed", text });
  return canonicalStructuralEquals(basis.narrowing?.from, BASE_WAVE_REVIEW_AGENTS)
    ? Object.freeze({ kind: "observed", text: null })
    : Object.freeze({ kind: "unobserved" });
}

/** The before side: the basis's frozen bytes and the context its packets presented. */
function beforeSide(view: BasisPacketView, basis: CurrentAcceptedReviewAuthority): ReviewChangeSide {
  const context: ReviewContextFacts = {
    description: view.task.description,
    agent: view.task.agent,
    planContext: view.task.planContext,
    specAnchors: view.task.specAnchors,
    specContributions: view.task.specContributions,
    declaredFiles: view.task.declaredFiles,
    planFile: view.planFile,
    ownerMap: basisSection(view, OWNER_MAP_ROLES, view.ownerMap, basis),
    contractSurface: basisSection(view, CONTRACT_SURFACE_ROLES, view.contractSurface, basis),
  };
  return Object.freeze({ files: Object.freeze(view.frozenSource.files.map(frozenFile)), context: Object.freeze(context) });
}

/** The after side: the observed bytes and the context the Task's packets would present now. */
function afterSide(graph: TaskGraph, task: Task, review: DerivedWaveTaskReview, workspace: ReviewedWorkspaceObservation): ReviewChangeSide {
  const planFile = graph.plan_file ?? null;
  const context: ReviewContextFacts = {
    description: task.description,
    agent: task.agent,
    planContext: task.plan_context ?? null,
    specAnchors: task.spec_anchors ?? [],
    specContributions: task.spec_contributions ?? [],
    declaredFiles: task.file_list ?? [],
    planFile,
    ownerMap: Object.freeze({
      kind: "observed",
      text: isNonEmpty(review.ownerMap) && planFile !== null ? renderOwnerMapSection(planFile, review.ownerMap) : null,
    }),
    contractSurface: Object.freeze({
      kind: "observed",
      text: isNonEmpty(review.contractSurfaces) ? renderContractSurfaceSection(planFile, review.contractSurfaces) : null,
    }),
  };
  const files = workspace.artifacts.map(({ path, contentBase64 }) => Object.freeze({ path, content: observedContent(contentBase64) }));
  return Object.freeze({ files: Object.freeze(files), context: Object.freeze(context) });
}

/**
 * The test-file suffixes a change is classified by: the graph's frozen
 * Test-File Classification, or the engine default for a graph frozen without one.
 */
function testFileSuffixesOf(graph: TaskGraph): readonly string[] {
  const era = frozenRedThenGreenEra(graph.verification_manifest);
  return era.kind === "owed-if-new-tests" ? era.testFiles.suffixes : DEFAULT_TEST_FILE_SUFFIXES;
}

/** Why `view` is not the basis `basis` names for `task`, or null. */
function basisMismatch(task: Task, basis: CurrentAcceptedReviewAuthority, view: BasisPacketView): string | null {
  if (view.runId !== basis.run_id || view.packetId !== basis.packet_id) return "the packets read are not the basis Review Packet";
  if (view.frozenSource.taskId !== task.id || view.task.id !== task.id) return "the basis packets name another Task";
  if (view.frozenSource.workspaceHeadSha !== basis.head_sha) return "the basis frozen source is not the accepted head";
  return canonicalStructuralEquals(view.frozenSource.files.map(({ path }) => path), basis.scope)
    ? null
    : "the basis frozen source is not the accepted scope";
}

/** The roster a consulted Task is issued from its read basis, and why. */
function consultedChoice(
  input: ReviewRolesInput,
  task: Task,
  review: DerivedWaveTaskReview,
  basis: CurrentAcceptedReviewAuthority,
): TaskRosterChoice {
  const { graph } = input;
  const derived = review.roster;
  const read = input.bases.get(task.id);
  if (read === undefined) return full(task, derived, { kind: "no-basis" });
  if (!read.ok) return full(task, derived, { kind: "basis-unreadable", error: read.error });
  const mismatch = basisMismatch(task, basis, read.value);
  if (mismatch !== null) return full(task, derived, { kind: "basis-mismatch", detail: mismatch });
  const observation = input.workspaces.find(({ taskId }) => taskId === task.id);
  const workspace = observation === undefined ? null : admitReviewedWorkspace(task.id, taskReviewScope(task), observation);
  if (workspace === null || !workspace.ok) return full(task, derived, { kind: "workspace-unobserved" });
  const change = classifyReviewChange(beforeSide(read.value, basis), afterSide(graph, task, review, workspace.value), testFileSuffixesOf(graph));
  const owners = waveReviewPriorFindings(graph, task, workspace.value.artifacts, "fresh").findings.map(({ agent }) => agent);
  const selection = selectReviewRoles(derived, change, owners);
  if (selection.kind === "whole") return full(task, derived, { kind: "change", change });
  return Object.freeze({ taskId: task.id, kind: "narrowed", review: Object.freeze({
    taskId: task.id, roster: selection.roster, from: derived, change: selection.change, basis: basisAuthorityOf(basis),
  }) });
}

/**
 * The roster plan of a fresh start: for each reviewed registered Task, carried
 * (no roster), its whole derived roster with why, or the roles its change
 * needs. A Task exempt from Wave review contributes nothing.
 */
export function planReviewRoles(input: ReviewRolesInput): ReviewRolesPlan {
  return Object.freeze(input.taskIds.flatMap((taskId): readonly TaskRosterChoice[] => {
    const task = input.graph.tasks.find(({ id }) => id === taskId);
    if (task === undefined || waveReviewStanding(task).kind === "exempt") return [];
    const read = basisReadOf(task, input);
    if (read.kind === "carried") return [Object.freeze({ taskId, kind: "carried" })];
    const review = derivedWaveTaskReview(input.graph, 2, task);
    if (review.kind !== "roster") return [];
    return [read.kind === "full" ? full(task, review.roster, read.reason) : consultedChoice(input, task, review, read.basis)];
  }));
}
