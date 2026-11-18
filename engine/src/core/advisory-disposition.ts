/**
 * Advisory dispositions (loom#213 Cause 4, ADR-0090): what the operator
 * decided about each advisory a Wave Gate raised, recorded on the TaskGraph so
 * it outlives the gate run that raised it.
 *
 * - `fixed`: the operator is fixing it; reviewers keep re-assessing it until
 *   its owner resolves it.
 * - `deferred` (with an optional target Wave or Task) and `dismissed`, each
 *   with a reason: not reissued to reviewers while the bytes the advisory
 *   anchors to stay the same (`issuedPriorFindings`).
 *
 * The list is append-only; the latest record for an advisory is its standing
 * decision. One constructor (`advisoryDisposition`) builds a record for the
 * operation and for the State File parser, so neither holds a value the other
 * would refuse. `advisoryDecisionTasks` is the one derivation of the Tasks a
 * Wave Gate counts advisories over, and `waveAdvisories` the one derivation of
 * their advisories: the decision request, the approval gate and the operation
 * all read both. Pure.
 */

import {
  ADVISORY_DECISIONS,
  type AdvisoryDecision,
  type AdvisoryDisposition,
  type AnchorDigest,
} from "./advisory-disposition-shape";
import { sha256Bytes, sha256Hex } from "./digest";
import { parseFindingId } from "./findings";
import type { DomainResult } from "./orchestration-contract";
import { hasExactKeys, isRecord } from "./plain-record";
import type { ReviewedArtifact } from "./reviewed-workspace";
import { parseTaskId } from "./task-id";
import type { Finding, Task, TaskGraph } from "../types";

export type { AdvisoryDecision, AdvisoryDisposition, AnchorDigest } from "./advisory-disposition-shape";

const isAdvisoryDecision = (raw: unknown): raw is AdvisoryDecision =>
  ADVISORY_DECISIONS.some((decision) => decision === raw);

/** The longest reason or target an operator may give. */
const MAX_DISPOSITION_TEXT_LENGTH = 500;

const freeze = Object.freeze;
const fail = (error: string) => freeze({ ok: false as const, error });
const succeed = <T>(value: T) => freeze({ ok: true as const, value });

/** Operator text: a trimmed, non-blank string of at most `MAX_DISPOSITION_TEXT_LENGTH` characters. */
function dispositionText(raw: unknown, label: string): DomainResult<string, string> {
  if (typeof raw !== "string") return fail(`${label} must be a string`);
  if (raw.trim().length === 0) return fail(`${label} must not be blank`);
  if (raw.trim() !== raw) return fail(`${label} must not start or end with whitespace`);
  if (raw.length > MAX_DISPOSITION_TEXT_LENGTH) return fail(`${label} is at most ${MAX_DISPOSITION_TEXT_LENGTH} characters`);
  return succeed(raw);
}

/** The anchor parser: a lower-case sha256 hex digest, or null. With `anchorDigest`, the only mint of `AnchorDigest`. */
const parseAnchorDigest = (raw: unknown): AnchorDigest | null =>
  typeof raw === "string" && /^[0-9a-f]{64}$/.test(raw) ? raw as AnchorDigest : null;

const hasTarget = (raw: unknown): boolean => raw !== null && raw !== undefined;

export type AdvisoryDispositionInput = Readonly<{
  wave: unknown;
  taskId: unknown;
  findingId: unknown;
  decision: unknown;
  reason: unknown;
  target: unknown;
  anchor: unknown;
}>;

/**
 * The one constructor: a positive Wave, a Task id, a Finding id, one of the
 * three decisions with a reason, a target only for a deferral, and an anchor
 * exactly when the decision suppresses reissue. Each variant is built in the
 * State File's field order.
 */
export function advisoryDisposition(input: AdvisoryDispositionInput): DomainResult<AdvisoryDisposition, string> {
  const { wave, decision } = input;
  if (typeof wave !== "number" || !Number.isSafeInteger(wave) || wave < 1) return fail("wave must be a positive integer");
  const taskId = parseTaskId(input.taskId, "taskId");
  if (!taskId.ok) return fail(taskId.error.errors.join("; "));
  const findingId = parseFindingId(input.findingId);
  if (findingId === null) return fail("findingId must be a Finding id (no colon or whitespace)");
  if (!isAdvisoryDecision(decision)) return fail(`decision must be one of ${ADVISORY_DECISIONS.join(", ")}`);
  const reason = dispositionText(input.reason, "reason");
  if (!reason.ok) return reason;
  const head = { schemaVersion: 1 as const, wave, taskId: taskId.value, findingId, decision, reason: reason.value };
  if (decision !== "deferred" && hasTarget(input.target)) return fail("target is only for a deferred advisory");
  if (decision === "fixed") {
    return input.anchor === null
      ? succeed(freeze({ ...head, decision, target: null, anchor: null }))
      : fail("a fixed advisory carries no anchor");
  }
  const anchor = parseAnchorDigest(input.anchor);
  if (anchor === null) return fail(`a ${decision} advisory needs the sha256 anchor of the bytes it was decided over`);
  if (decision === "dismissed" || !hasTarget(input.target)) return succeed(freeze({ ...head, decision, target: null, anchor }));
  const target = dispositionText(input.target, "target");
  return target.ok ? succeed(freeze({ ...head, decision, target: target.value, anchor })) : target;
}

/** An advisory's identity, as the advisory decision request names it: `<task>:<finding-id>`. */
const advisoryIdentity = (taskId: string, findingId: string): string => `${taskId}:${findingId}`;

/**
 * The Tasks whose advisories Wave `wave`'s gate counts: every Task of that
 * Wave, in graph order. The decision request, the approval gate and the
 * disposition operation all read this one set (ADR-0090). It needs no gate
 * registration, so the operation reads it alike while the gate is paused and
 * after it is abandoned. While a gate is live the set cannot move: add-task
 * and withdraw-task are refused under a live gate, and the decision's
 * membership check refuses a registration whose Tasks differ from it.
 */
export function advisoryDecisionTasks(graph: Pick<TaskGraph, "tasks">, wave: number): readonly Task[] {
  return freeze(graph.tasks.filter((task) => task.wave === wave));
}

/**
 * One advisory a Wave Gate's decision request issues: an advisory Finding of
 * a Task, or a Task's legacy advisory claim (a Task that predates stored
 * Findings), named `legacy-advisory-<n>`.
 */
export type WaveAdvisory = Readonly<{
  taskId: string;
  findingId: string;
  identity: string;
  /** The file the advisory names, or null when it names none. */
  file: string | null;
  subject: Readonly<{ kind: "finding"; finding: Finding }> | Readonly<{ kind: "legacy-claim"; claim: string }>;
}>;

/**
 * The advisories of `tasks`, in Task order: a Task's advisory Findings when
 * it stores Findings, otherwise its non-blank legacy advisory claims.
 */
export function waveAdvisories(
  tasks: readonly Pick<Task, "id" | "findings" | "advisory_findings">[],
): readonly WaveAdvisory[] {
  return freeze(tasks.flatMap((task): readonly WaveAdvisory[] => {
    if (task.findings !== undefined) {
      return task.findings.filter((finding) => finding.severity === "advisory").map((finding) => freeze({
        taskId: task.id,
        findingId: finding.id,
        identity: advisoryIdentity(task.id, finding.id),
        file: finding.file,
        subject: freeze({ kind: "finding" as const, finding }),
      }));
    }
    return (task.advisory_findings ?? []).filter((claim) => claim.trim() !== "").map((claim, index) => {
      const findingId = `legacy-advisory-${index + 1}`;
      return freeze({
        taskId: task.id,
        findingId,
        identity: advisoryIdentity(task.id, findingId),
        file: null,
        subject: freeze({ kind: "legacy-claim" as const, claim }),
      });
    });
  }));
}

/** The standing (latest) disposition of each advisory, by identity. */
export function standingDispositions(
  dispositions: readonly AdvisoryDisposition[] | undefined,
): ReadonlyMap<string, AdvisoryDisposition> {
  const standing = new Map<string, AdvisoryDisposition>();
  for (const disposition of dispositions ?? []) standing.set(advisoryIdentity(disposition.taskId, disposition.findingId), disposition);
  return standing;
}

/**
 * The bytes an advisory anchors to, as one sha256: its own file when that
 * file is one of the Task's reviewed artifacts (absent counts as its own
 * state), otherwise the Task's whole reviewed artifact set (each path with the
 * digest of its bytes, in artifact order). Computed alike from the workspace
 * an operator decided over and from the one a later gate reviews.
 */
export function anchorDigest(file: string | null, artifacts: readonly ReviewedArtifact[]): AnchorDigest {
  const digestOf = (artifact: ReviewedArtifact): string =>
    artifact.contentBase64 === null ? "absent" : sha256Bytes(Buffer.from(artifact.contentBase64, "base64"));
  const own = file === null ? undefined : artifacts.find(({ path }) => path === file);
  const material = own === undefined
    ? JSON.stringify(["task", artifacts.map((artifact) => [artifact.path, digestOf(artifact)])])
    : JSON.stringify(["file", own.path, digestOf(own)]);
  return sha256Hex(material) as AnchorDigest;
}

/**
 * The prior Findings a fresh review of `task` is issued over `artifacts`, its
 * reviewed bytes: every active Finding but an advisory whose standing
 * disposition is `deferred` or `dismissed` and whose anchor still matches
 * those bytes. The rule behind `waveReviewPriorFindings`, which every issuing
 * site reads. A Finding left out stays active on the Task, because a run
 * resolves only the priors it issued.
 */
export function issuedPriorFindings(
  task: Pick<Task, "id" | "findings">,
  dispositions: readonly AdvisoryDisposition[] | undefined,
  artifacts: readonly ReviewedArtifact[],
): readonly Finding[] {
  const findings = task.findings ?? [];
  const standing = standingDispositions(dispositions);
  return freeze(findings.filter((finding) => {
    if (finding.severity !== "advisory") return true;
    const decided = standing.get(advisoryIdentity(task.id, finding.id));
    if (decided === undefined || decided.decision === "fixed") return true;
    return decided.anchor !== anchorDigest(finding.file, artifacts);
  }));
}

/** The advisories of `tasks` (`waveAdvisories`) that have no standing disposition, as identities in Task order. */
export function undispositionedAdvisories(
  tasks: readonly Pick<Task, "id" | "findings" | "advisory_findings">[],
  dispositions: readonly AdvisoryDisposition[] | undefined,
): readonly string[] {
  const standing = standingDispositions(dispositions);
  return freeze(waveAdvisories(tasks).flatMap(({ identity }) => (standing.has(identity) ? [] : [identity])));
}

const DISPOSITION_FIELDS = ["schemaVersion", "wave", "taskId", "findingId", "decision", "reason", "target", "anchor"] as const;

/** `advisory_dispositions` as the State File holds it, each record through the one constructor. */
export function parseAdvisoryDispositions(raw: unknown): DomainResult<readonly AdvisoryDisposition[] | undefined, string> {
  if (raw === undefined) return succeed(undefined);
  if (!Array.isArray(raw)) return fail("advisory_dispositions must be an array when present");
  const entries: readonly unknown[] = raw;
  const parsed: AdvisoryDisposition[] = [];
  for (const [index, entry] of entries.entries()) {
    const label = `advisory_dispositions[${index}]`;
    if (!isRecord(entry)) return fail(`${label} must be an object`);
    if (!hasExactKeys(entry, DISPOSITION_FIELDS)) return fail(`${label} must have exactly ${DISPOSITION_FIELDS.join(", ")}`);
    if (entry.schemaVersion !== 1) return fail(`${label} has an unsupported schemaVersion`);
    const built = advisoryDisposition({
      wave: entry.wave, taskId: entry.taskId, findingId: entry.findingId, decision: entry.decision,
      reason: entry.reason, target: entry.target, anchor: entry.anchor,
    });
    if (!built.ok) return fail(`${label}: ${built.error}`);
    parsed.push(built.value);
  }
  return succeed(freeze(parsed));
}
