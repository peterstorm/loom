/**
 * The one composition of an issued request's task text: the instruction its
 * program, role and attempt select, and the Task/Wave binding line the capture
 * matcher re-derives from the child's echoed task.
 *
 * `renderSpawnTaskText` (spawn-task-text.ts) writes the authority markers, the
 * packet path and the delivery bootstrap, and takes the instruction from its
 * caller. That made the instruction a fact of whichever code path happened to
 * emit the request, and the paths disagreed: an attempt-1 Wave request read
 * "complete the exact Wave review request" from collection and "emit only the
 * required reviewer result" from initial publication, and only publication
 * appended the Task binding. A re-emitted request therefore lost the binding
 * its capture matcher requires (`pi/reserved-results.ts`) — the fugue-dags
 * wave-gate failure the echo-binding suite records.
 *
 * Here both facts are functions of the request authority and its durable
 * context, so issuance and any later re-render cannot disagree about them.
 * Pure module: no I/O, no clock, no randomness.
 */
import { match } from "ts-pattern";
import type { AgentRequestAuthority } from "./orchestration-contract";
import { REVIEWER_RESULT_INSTRUCTION } from "./spawn-task-text";
import { VERIFICATION_BRIEF_SECTION, VERIFICATION_RESULT_KIND } from "./security-verification";

/** The attempt-2 Wave reviewer instruction: the packet is re-read, and the child
 *  is told which slot it retries rather than that it starts fresh. */
const WAVE_RETRY_INSTRUCTION =
  "Read the immutable context packet at LOOM_CONTEXT_PATH, then retry the exact current Wave Review Packet slot.";

/** The attempt-2 Wave spec-check instruction; the spec-check slot is not a Task review. */
const SPEC_CHECK_RETRY_INSTRUCTION =
  "Read the immutable context packet at LOOM_CONTEXT_PATH, then retry the exact current Wave spec-check slot.";

/** The Refutation Panel instruction: the verifier completes the pending lens request. */
const REFUTATION_INSTRUCTION =
  "Read the immutable context packet at LOOM_CONTEXT_PATH, then complete the exact pending Refutation Panel request.";

/** The security verifier's instruction: its authority sections are read whole
 *  and its verdict is the only admissible final message (ADR-0067). */
const SECURITY_VERIFIER_INSTRUCTION =
  `Read your brief with LOOM_CONTEXT_SECTION_COMMAND --section ${VERIFICATION_BRIEF_SECTION}, try to refute ` +
  `every candidate in it, and make your FINAL message exactly one ${VERIFICATION_RESULT_KIND} JSON object.`;

const SPEC_CHECK_ROLE = "spec-check-invoker" as const;

/**
 * The instruction an issued request's child reads, selected only by facts the
 * request authority already carries. Total over the program vocabulary: a new
 * program is a compile error here, not a request that silently inherits the
 * reviewer sentence.
 */
export function issuedRequestInstruction(authority: AgentRequestAuthority): string {
  return match(authority)
    .with({ program: "security-verification" }, () => SECURITY_VERIFIER_INSTRUCTION)
    .with({ program: "refutation-panel" }, () => REFUTATION_INSTRUCTION)
    .with({ program: "wave-gate", role: SPEC_CHECK_ROLE, attempt: 2 }, () => SPEC_CHECK_RETRY_INSTRUCTION)
    .with({ program: "wave-gate", attempt: 2 }, () => WAVE_RETRY_INSTRUCTION)
    .with({ program: "wave-gate" }, () => REVIEWER_RESULT_INSTRUCTION)
    .with({ program: "standalone-review" }, () => REVIEWER_RESULT_INSTRUCTION)
    .with({ program: "architecture-panel" }, () => REVIEWER_RESULT_INSTRUCTION)
    .exhaustive();
}

/**
 * Which subject an issued Wave request reviews, as the child must echo it: the
 * Task it reviews, or — for the spec-check slot, which reviews no Task — the
 * Wave whose documents it checks. Every other program reviews a scope, not a
 * bound subject, and carries no binding.
 */
export type IssuedTaskBinding =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "task"; taskId: string }>
  | Readonly<{ kind: "spec-check"; wave: number }>;

/** The one writer of the binding line. `extractTaskId` (`utils/extract-task-id.ts`)
 *  reads `Task T1` back out of the child's echo, and the capture matcher refuses
 *  a reviewer result whose task names no Task, so the line is load-bearing. */
export function taskBindingLine(binding: IssuedTaskBinding): string {
  return match(binding)
    .with({ kind: "none" }, () => "")
    .with({ kind: "task" }, ({ taskId }) => `\nReview Task ${taskId}.`)
    .with({ kind: "spec-check" }, ({ wave }) => `\nSpec-check Wave ${wave}.`)
    .exhaustive();
}

/** The complete task text: the render, then the subject binding it reviews. */
export function withTaskBinding(rendered: string, binding: IssuedTaskBinding): string {
  return rendered + taskBindingLine(binding);
}
