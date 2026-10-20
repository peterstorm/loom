/**
 * Red-Then-Green Status: where one Task stands on I6, the red-then-green
 * proof obligation, projected from a parsed TaskGraph and what the shell
 * observed of the Task's live attempt, and rendered as lines.
 *
 * Two pure, total steps (FR-006): `redThenGreenStatusView` projects the
 * inputs into a closed view, and `renderRedThenGreenStatus` prints that view
 * through the exported text constants. No I/O, no clock, no throw over any
 * TaskGraph the State File parser admits.
 *
 * Nothing here re-derives settlement's answers (FR-005):
 * - whether the Task owes I6 is `redThenGreenDuty`, the one function
 *   settlement, the stored-evidence reconcile and the brief ask;
 * - the test/implementation split is `classifyTaskFiles` (INV-2), handed the
 *   classification only the `owed` duty arm carries (INV-6);
 * - the live judgment is `judgeRedThenGreen`, called exactly as settlement
 *   calls it for a Claude Code attempt (never Pi-structured evidence);
 * - gaps are spelled by `redThenGreenFailureKind`.
 * The not-owed reason only explains a `not-owed` duty; it never decides one.
 */

import { match, P } from "ts-pattern";
import type { TaskGraph, Task, TaskStatus } from "../types";
import { redThenGreenDuty } from "./implementation-application";
import type { NonEmpty } from "./orchestration-contract";
import { redThenGreenEra, type ProofFailure, type ProofObligationResult } from "./proof-obligations";
import { judgeRedThenGreen, redThenGreenFailureKind } from "./red-then-green";
import type { Evidence } from "../machine/types";
import type {
  RedThenGreenGap,
  RedThenGreenObservation,
  RunRef,
  TestFileClassification,
} from "./red-then-green-types";
import { UNKNOWN_TASK_PREFIX } from "./stop-check-plan-types";
import { classifyTaskFiles } from "./test-file-classification";
import type { FrozenVerificationManifest } from "./verification-manifest";
import { COVERED_BY_ACCEPTANCE_CONTRACT, taskVerificationPolicy, type NewTestWaiverReason } from "./verification-policy";

// --- Inputs ---

/** What the shell observed of the Task's live attempt. */
export type RedThenGreenLiveInput =
  /** Pi: the live-attempt port is never asked. */
  | Readonly<{ kind: "not-observable" }>
  | Readonly<{ kind: "no-live-attempt" }>
  /** The live-attempt evidence port could not decide which attempt is live. */
  | Readonly<{ kind: "uninspectable"; reason: string }>
  /** An attempt is live, but its epoch cannot be judged: its ledger or the repository root is unreadable. */
  | Readonly<{ kind: "unreadable"; reason: string }>
  /** A live attempt's read epoch, with the root it is judged against: no root travels without a readable ledger. */
  | Readonly<{ kind: "live"; events: readonly Evidence[]; repositoryRoot: string }>;

export type RedThenGreenStatusInput = Readonly<{
  graph: TaskGraph;
  taskId: string;
  live: RedThenGreenLiveInput;
}>;

// --- The view ---

/** Why a `not-owed` duty is not owed: the first that applies, in this order. */
export type NotOwedReason =
  | Readonly<{ kind: "predates-i6" }>
  | Readonly<{ kind: "claimant" }>
  | Readonly<{ kind: "new-tests-waived"; reason: NewTestWaiverReason }>
  /** For totality only: INV-6's load check makes it unreachable for a parsed graph. */
  | Readonly<{ kind: "no-obligation-in-proof" }>;

export type DutyView =
  | Readonly<{ kind: "owed"; classification: TestFileClassification }>
  | Readonly<{ kind: "not-owed"; reason: NotOwedReason }>
  /** `redThenGreenDuty`'s `classification-unfrozen` and `proof-unfrozen`, with their reason. */
  | Readonly<{ kind: "undeterminable"; reason: string }>;

export type LiveView =
  | Readonly<{ kind: "not-observable" }>
  | Readonly<{ kind: "no-live-attempt" }>
  | Readonly<{ kind: "uninspectable"; reason: string }>
  | Readonly<{ kind: "unreadable"; reason: string }>
  /** A live attempt whose duty is not `owed` (not owed or undeterminable): there is nothing to judge it by. */
  | Readonly<{ kind: "not-judged" }>
  | Readonly<{ kind: "judged"; observation: RedThenGreenObservation }>;

export type StoredView =
  /** `legacy_missing_proof`: the Task carries no frozen Proof. */
  | Readonly<{ kind: "no-proof" }>
  /** The frozen Proof owes no red-then-green. */
  | Readonly<{ kind: "no-obligation" }>
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "satisfied"; red: RunRef; implementationWrite: string; green: RunRef }>
  /** `redThenGreenFailureKind(gap)`, or `proof:<kind>` for any other failure. */
  | Readonly<{ kind: "failed"; failureKind: string }>;

export type RedThenGreenStatusView =
  | Readonly<{ kind: "unknown-task"; taskId: string }>
  | Readonly<{
      kind: "task";
      taskId: string;
      wave: number;
      status: TaskStatus;
      duty: DutyView;
      live: LiveView;
      stored: StoredView;
    }>;

export type RedThenGreenStatusRendering =
  | Readonly<{ kind: "rendered"; lines: NonEmpty<string> }>
  | Readonly<{ kind: "unknown-task"; taskId: string; message: string }>;

// --- Fixed text: every phrase has one spelling, shared with the handler and the docs ---

export const RTG_OWES = "owes I6";
export const RTG_NOT_OWED = "I6 not owed";
export const RTG_UNDETERMINABLE = "I6 undeterminable";
/** `new-tests-waived` is followed by `: <waiver reason>`. */
export const NOT_OWED_REASON_TEXT: Readonly<Record<NotOwedReason["kind"], string>> = Object.freeze({
  "predates-i6": "TaskGraph predates I6",
  claimant: "claimant (acceptance contract)",
  "new-tests-waived": "new tests waived",
  "no-obligation-in-proof": "the frozen Proof carries no red-then-green obligation",
});

export const TEST_FILES_HEADING = "test files:";
export const IMPLEMENTATION_FILES_HEADING = "implementation files:";
export const NO_TEST_FILES = "test files: none";
export const NO_IMPLEMENTATION_FILES = "implementation files: none";

export const LIVE_PREFIX = "live attempt:";
export const LIVE_NONE = `${LIVE_PREFIX} none`;
export const LIVE_NOT_OBSERVABLE = "live attempt not observable on this harness";
export const LIVE_UNINSPECTABLE = "uninspectable";
export const LIVE_UNREADABLE = "unreadable";
export const LIVE_NOT_JUDGED = "not judged (no I6 obligation to judge it by)";

export const STORED_PREFIX = "stored:";
export const STORED_NO_PROOF = "no proof (legacy)";
export const STORED_NO_OBLIGATION = "no red-then-green obligation";
export const STORED_PENDING = "pending";

/** The judgment or stored result that names all three facts, live or stored. */
export const SHOWN = "shown";
export const RED_STEP = "red";
export const IMPLEMENTATION_WRITE_STEP = "first implementation write";
export const GREEN_STEP = "green";
export const UNTRUSTED_ONLY_SUFFIX = " (untrusted runs only)";

const DETAIL = " — ";
const INDENT = "  ";

// --- Projection ---

const freeze = <const T extends object>(value: T): Readonly<T> => Object.freeze(value);

const PREDATES_I6: NotOwedReason = freeze({ kind: "predates-i6" });
const CLAIMANT: NotOwedReason = freeze({ kind: "claimant" });
const NO_OBLIGATION_IN_PROOF: NotOwedReason = freeze({ kind: "no-obligation-in-proof" });
const NOT_JUDGED: LiveView = freeze({ kind: "not-judged" });
const NO_PROOF: StoredView = freeze({ kind: "no-proof" });
const NO_OBLIGATION: StoredView = freeze({ kind: "no-obligation" });
const STORED_PENDING_VIEW: StoredView = freeze({ kind: "pending" });

function notOwedReason(task: Task, manifest: FrozenVerificationManifest | undefined): NotOwedReason {
  if (redThenGreenEra(manifest) === "not-owed") return PREDATES_I6;
  return match(taskVerificationPolicy(task).newTests)
    .returnType<NotOwedReason>()
    .with({ kind: "waived", reason: COVERED_BY_ACCEPTANCE_CONTRACT }, () => CLAIMANT)
    .with({ kind: "waived" }, ({ reason }) => freeze({ kind: "new-tests-waived", reason }))
    .with({ kind: "required" }, () => NO_OBLIGATION_IN_PROOF)
    .exhaustive();
}

function dutyView(task: Task, manifest: FrozenVerificationManifest | undefined): DutyView {
  return match(redThenGreenDuty(task, manifest))
    .returnType<DutyView>()
    .with({ kind: "owed" }, (owed) =>
      // The same arguments settlement classifies by, so a Task that creates its module is judged by FR-007a.
      freeze({ kind: "owed", classification: classifyTaskFiles(task.file_list ?? [], owed.testFiles, task.artifact_baseline) }))
    .with({ kind: "not-owed" }, () => freeze({ kind: "not-owed", reason: notOwedReason(task, manifest) }))
    .with({ kind: P.union("classification-unfrozen", "proof-unfrozen") }, ({ reason }) =>
      freeze({ kind: "undeterminable", reason }))
    .exhaustive();
}

function liveView(live: RedThenGreenLiveInput, duty: DutyView): LiveView {
  return match(live)
    .returnType<LiveView>()
    .with({ kind: P.union("not-observable", "no-live-attempt", "uninspectable", "unreadable") }, (passthrough) => passthrough)
    .with({ kind: "live" }, ({ events, repositoryRoot }) =>
      duty.kind === "owed"
        // A Claude Code attempt's evidence is never Pi-structured, as in settlement.
        ? freeze({ kind: "judged", observation: judgeRedThenGreen(events, duty.classification, repositoryRoot, false) })
        : NOT_JUDGED)
    .exhaustive();
}

/** The receipt failure kind settlement mints for one Proof failure. */
const storedFailureKind = (failure: ProofFailure): string =>
  failure.kind === "red-then-green-unproven" ? redThenGreenFailureKind(failure.gap) : `proof:${failure.kind}`;

/** The red-then-green result's stored view, or undefined for any other result. */
const redThenGreenResult = (result: ProofObligationResult): StoredView | undefined =>
  match(result)
    .returnType<StoredView | undefined>()
    .with({ state: "pending", obligation: { kind: "red-then-green" } }, () => STORED_PENDING_VIEW)
    .with({ state: "failed", obligation: { kind: "red-then-green" } }, ({ failure }) =>
      freeze({ kind: "failed", failureKind: storedFailureKind(failure) }))
    .with({ state: "satisfied", obligation: { kind: "red-then-green" }, evidence: { kind: "red-then-green" } }, ({ evidence }) =>
      freeze({ kind: "satisfied", red: evidence.red, implementationWrite: evidence.implementationWrite, green: evidence.green }))
    .otherwise(() => undefined);

/** The Proof's `results` hold each obligation's latest evaluation, so a
 *  retry-pending Task (pending with a failed Proof) shows its latest gap. */
function storedView(task: Task): StoredView {
  // Only the `legacy_missing_proof` lifecycle arm carries no Proof.
  if (task.proof === undefined) return NO_PROOF;
  return task.proof.results.map(redThenGreenResult).find((view) => view !== undefined) ?? NO_OBLIGATION;
}

export function redThenGreenStatusView({ graph, taskId, live }: RedThenGreenStatusInput): RedThenGreenStatusView {
  const task = graph.tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined) return freeze({ kind: "unknown-task", taskId });
  const duty = dutyView(task, graph.verification_manifest);
  return freeze({
    kind: "task",
    taskId,
    wave: task.wave,
    status: task.status,
    duty,
    live: liveView(live, duty),
    stored: storedView(task),
  });
}

// --- Rendering ---

type KnownTaskView = Extract<RedThenGreenStatusView, { kind: "task" }>;

const notOwedText = (reason: NotOwedReason): string =>
  reason.kind === "new-tests-waived"
    ? `${NOT_OWED_REASON_TEXT[reason.kind]}: ${reason.reason}`
    : NOT_OWED_REASON_TEXT[reason.kind];

const headerLine = ({ taskId, wave, status, duty }: KnownTaskView): string =>
  `${taskId} (Wave ${wave}, ${status}): ${match(duty)
    .returnType<string>()
    .with({ kind: "owed" }, () => RTG_OWES)
    .with({ kind: "not-owed" }, ({ reason }) => `${RTG_NOT_OWED}${DETAIL}${notOwedText(reason)}`)
    .with({ kind: "undeterminable" }, ({ reason }) => `${RTG_UNDETERMINABLE}${DETAIL}${reason}`)
    .exhaustive()}`;

const fileSection = (heading: string, none: string, files: readonly string[]): readonly string[] =>
  files.length === 0 ? [none] : [heading, ...files.map((file) => `${INDENT}${file}`)];

/** The files section appears only when the duty is owed. */
const fileLines = (duty: DutyView): readonly string[] =>
  duty.kind === "owed"
    ? [
        ...fileSection(TEST_FILES_HEADING, NO_TEST_FILES, duty.classification.testFiles),
        ...fileSection(IMPLEMENTATION_FILES_HEADING, NO_IMPLEMENTATION_FILES, duty.classification.implementationFiles),
      ]
    : [];

const shownLines = (
  prefix: string,
  shown: Readonly<{ red: RunRef; implementationWrite: string; green: RunRef }>,
): readonly string[] => [
  `${prefix} ${SHOWN}`,
  `${INDENT}${RED_STEP} #${shown.red.index} ${shown.red.command}`,
  `${INDENT}${IMPLEMENTATION_WRITE_STEP} ${shown.implementationWrite}`,
  `${INDENT}${GREEN_STEP} #${shown.green.index} ${shown.green.command}`,
];

const gapText = (gap: RedThenGreenGap): string =>
  `${redThenGreenFailureKind(gap)}${match(gap)
    .with({ untrustedOnly: true }, () => UNTRUSTED_ONLY_SUFFIX)
    .otherwise(() => "")}`;

const liveLines = (live: LiveView): readonly string[] =>
  match(live)
    .returnType<readonly string[]>()
    .with({ kind: "not-observable" }, () => [LIVE_NOT_OBSERVABLE])
    .with({ kind: "no-live-attempt" }, () => [LIVE_NONE])
    .with({ kind: "uninspectable" }, ({ reason }) => [`${LIVE_PREFIX} ${LIVE_UNINSPECTABLE}${DETAIL}${reason}`])
    .with({ kind: "unreadable" }, ({ reason }) => [`${LIVE_PREFIX} ${LIVE_UNREADABLE}${DETAIL}${reason}`])
    .with({ kind: "not-judged" }, () => [`${LIVE_PREFIX} ${LIVE_NOT_JUDGED}`])
    .with({ kind: "judged", observation: { kind: "shown" } }, ({ observation }) => shownLines(LIVE_PREFIX, observation))
    .with({ kind: "judged", observation: { kind: "unproven" } }, ({ observation }) => [`${LIVE_PREFIX} ${gapText(observation.gap)}`])
    .exhaustive();

const storedLines = (stored: StoredView): readonly string[] =>
  match(stored)
    .returnType<readonly string[]>()
    .with({ kind: "no-proof" }, () => [`${STORED_PREFIX} ${STORED_NO_PROOF}`])
    .with({ kind: "no-obligation" }, () => [`${STORED_PREFIX} ${STORED_NO_OBLIGATION}`])
    .with({ kind: "pending" }, () => [`${STORED_PREFIX} ${STORED_PENDING}`])
    .with({ kind: "satisfied" }, (satisfied) => shownLines(STORED_PREFIX, satisfied))
    .with({ kind: "failed" }, ({ failureKind }) => [`${STORED_PREFIX} ${failureKind}`])
    .exhaustive();

/**
 * The lines, in order: the header, the files section (owed duty only), the
 * live-attempt section, then the stored result. An unknown Task id is not
 * rendered: it carries the shared `No task <id> in the TaskGraph` refusal.
 */
export function renderRedThenGreenStatus(input: RedThenGreenStatusInput): RedThenGreenStatusRendering {
  return match(redThenGreenStatusView(input))
    .returnType<RedThenGreenStatusRendering>()
    .with({ kind: "unknown-task" }, ({ taskId }) =>
      freeze({ kind: "unknown-task", taskId, message: `${UNKNOWN_TASK_PREFIX} ${taskId} in the TaskGraph` }))
    .with({ kind: "task" }, (view) => {
      const lines: [string, ...string[]] = [
        headerLine(view),
        ...fileLines(view.duty),
        ...liveLines(view.live),
        ...storedLines(view.stored),
      ];
      return freeze({ kind: "rendered", lines: Object.freeze(lines) });
    })
    .exhaustive();
}
