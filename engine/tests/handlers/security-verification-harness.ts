/**
 * The one way a handler test obtains a ballot (ADR-0067, amended): through the
 * real verification program and Claude Code's native capture path. `status`
 * names the run, `helper orchestration start security-verification` issues
 * its verifier spawns, the PostToolUse correlator and the SubagentStop capture
 * deliver each verifier's transcript (writing the capture attestation), and
 * `verify --from` imports the bound ballots.
 *
 * A ballot written straight into `verdicts.json` is never authority — the
 * audit re-proves every cached ballot before counting it — so tests whose
 * subject is adjudication, publication or the run lifecycle drive this
 * harness instead of placing ballots by hand.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { subagentDir } from "../../src/config";
import { orchestrationHandler, type Emission } from "../../src/handlers/helpers/orchestration";
import { resolveEmissionEnvironment } from "../../src/utils/emission-environment";
import { recordClaudeSpawnCorrelation } from "../../src/handlers/post-tool-use/record-orchestration-spawn";
import { captureClaudeResult } from "../../src/handlers/subagent-stop/capture-orchestration-result";
import { isWireRecord } from "../../src/core/security-audit-contract";
import { parseRegisteredSecurityVerificationProgram, parseSecurityVerificationStart, type SecurityVerificationStart } from "../../src/core/security-verification";
import { parentAnnouncement, FIXTURE_CLAUDE_CODE_SESSION_ID } from "../fixtures/facade-parent";
import { deliverClaudeSubagentStop } from "../fixtures/claude-native-capture";
import type { FacadeAction } from "../../src/handlers/helpers/programs/program-result";
import type { Run } from "./security-audit-run-seam";

export type Plan = Readonly<{
  runsRoot: string; run: string; input: SecurityVerificationStart; command: string; importCommand: string; awaitingBallots: number;
  retiredRuns: readonly Readonly<{ run: string; reason: string }>[];
}>;

export type SpawnTask = Readonly<{
  authority: { requestId: string; slotId: string; attempt: 1 | 2; role: string; program: string; modelProfile: string };
  task: string;
}>;
/** The action a façade invocation printed, read loosely — but its `kind` is
 *  the real façade action vocabulary, so a comparison against a kind the
 *  program cannot emit does not compile. */
export type Action = Readonly<{ kind: FacadeAction["kind"]; requests?: readonly SpawnTask[]; outcome?: unknown; diagnostic?: { kind: string; message: string } }>;

// --- Reading what the helpers print ---
// `status --json` and a façade action are OUTPUT: the engine has no reader for
// either, so the harness narrows them itself and names what it could not read.

const isString = (value: unknown): value is string => typeof value === "string";
const isListOf = <T>(value: unknown, isEntry: (entry: unknown) => entry is T): value is readonly T[] =>
  Array.isArray(value as unknown) && (value as readonly unknown[]).every(isEntry);
const isAbsentOr = <T>(value: unknown, isPresent: (present: unknown) => present is T): value is T | undefined =>
  value === undefined || isPresent(value);

const FACADE_ACTION_KINDS: Readonly<Record<FacadeAction["kind"], true>> = { "spawn-batch": true, "await-user": true, blocked: true, done: true };
const isActionKind = (value: unknown): value is FacadeAction["kind"] => isString(value) && Object.hasOwn(FACADE_ACTION_KINDS, value);

const isRetiredRun = (value: unknown): value is Plan["retiredRuns"][number] =>
  isWireRecord(value) && isString(value.run) && isString(value.reason);

const isSpawnAuthority = (value: unknown): value is SpawnTask["authority"] =>
  isWireRecord(value) && isString(value.requestId) && isString(value.slotId) && (value.attempt === 1 || value.attempt === 2) &&
  isString(value.role) && isString(value.program) && isString(value.modelProfile);

const isSpawnTask = (value: unknown): value is SpawnTask =>
  isWireRecord(value) && isSpawnAuthority(value.authority) && isString(value.task);

const isDiagnostic = (value: unknown): value is NonNullable<Action["diagnostic"]> =>
  isWireRecord(value) && isString(value.kind) && isString(value.message);

const isAction = (value: unknown): value is Action =>
  isWireRecord(value) && isActionKind(value.kind) &&
  isAbsentOr(value.requests, (requests): requests is readonly SpawnTask[] => isListOf(requests, isSpawnTask)) &&
  isAbsentOr(value.diagnostic, isDiagnostic);

/** The `verification` member of a `status --json` document: the owed run, its
 *  start input parsed by the program's own start parser, or null when none is owed. */
function planOf(status: unknown): Plan | null {
  if (!isWireRecord(status)) throw new Error("status --json printed no object");
  const { verification } = status;
  if (verification === null) return null;
  if (!isWireRecord(verification)) throw new Error("status --json names no verification member");
  const { runsRoot, run, input, command, importCommand, awaitingBallots, retiredRuns } = verification;
  const start = parseSecurityVerificationStart(input);
  if (!start.ok) throw new Error(`status --json printed a start input the program refuses: ${start.error}`);
  if (!isString(runsRoot) || !isString(run) || !isString(command) || !isString(importCommand) ||
      typeof awaitingBallots !== "number" || !isListOf(retiredRuns, isRetiredRun)) {
    throw new Error(`status --json printed a malformed verification plan: ${JSON.stringify(verification)}`);
  }
  return { runsRoot, run, input: start.value, command, importCommand, awaitingBallots, retiredRuns };
}

/** The verification run `status --json` names, or null when none is owed. */
export async function verificationPlan(run: Run): Promise<Plan | null> {
  const status = await run.invoke(["status", "--json"]);
  if (!status.ok) throw new Error(`status: ${status.error}`);
  return planOf(JSON.parse(run.stdout()));
}

/** One façade invocation under a Claude Code parent, returning the action it printed. */
export async function facade(args: readonly string[], stdin = ""): Promise<Readonly<{ action: Action | null; error: string | null }>> {
  const printed: string[] = [];
  const emission: Emission = {
    environment: resolveEmissionEnvironment({ env: parentAnnouncement("claude-code", FIXTURE_CLAUDE_CODE_SESSION_ID), bindingDir: subagentDir() }),
    routeGateFacts: () => { throw new Error("a Claude Code parent's batch is never route-gated"); },
    probe: async () => ({ kind: "refused", reason: "unused" }),
    output: { stdout: (text) => { printed.push(text); }, stderr: () => undefined },
  };
  const result = await orchestrationHandler(() => emission)(stdin, [...args]);
  if (result?.kind === "error") return { action: null, error: String(result.message) };
  const action: unknown = JSON.parse(printed.join(""));
  if (!isAction(action)) throw new Error(`the façade printed no action: ${printed.join("")}`);
  return { action, error: null };
}

export async function startVerification(plan: Plan): Promise<Action> {
  const started = await facade(["start", "security-verification", "--runs-root", plan.runsRoot, "--run", plan.run], JSON.stringify(plan.input));
  if (started.action === null) throw new Error(`start: ${started.error}`);
  return started.action;
}

export const resumeVerification = (plan: Plan) => facade(["resume", "--runs-root", plan.runsRoot, "--run", plan.run]);

let nativeOrdinal = 0;

/** One delivery's outcome: captured, or refused WITH the reason — a capture
 *  carries no message, a refusal always does (the shape `Invocation` has). */
export type Delivery =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; message: string }>;

/**
 * Deliver one verifier spawn through Claude Code's native capture path: the
 * PostToolUse correlator (the harness's own `agent_id` and `subagent_type`,
 * resolved through the session binding the façade published), then the
 * SubagentStop capture of the transcript the agent wrote.
 */
export async function deliver(
  plan: Plan,
  request: SpawnTask,
  finalText: string,
  role = "security-verifier-agent",
): Promise<Delivery> {
  const agentId = `verifier-${++nativeOrdinal}`;
  const correlated = await recordClaudeSpawnCorrelation({
    session_id: FIXTURE_CLAUDE_CODE_SESSION_ID,
    tool_name: "Agent",
    tool_input: { subagent_type: `loom:${role}`, prompt: request.task },
    tool_response: { agent_id: agentId },
  }, subagentDir());
  if (correlated.kind === "error") return { ok: false, message: String(correlated.message) };
  const outcome = await deliverClaudeSubagentStop({ sessionId: FIXTURE_CLAUDE_CODE_SESSION_ID, agentId, agentType: role,
    transcriptDirectory: join(subagentDir(), "test-transcripts"), finalTexts: [finalText] },
  (stop) => captureClaudeResult(stop, plan.runsRoot, join(plan.runsRoot, plan.run)));
  return outcome.kind === "captured" ? { ok: true } : { ok: false, message: JSON.stringify(outcome) };
}

export const verifierResult = (verdicts: readonly Record<string, unknown>[]): string =>
  JSON.stringify({ schemaVersion: 1, kind: "security-verification-result", verdicts });

export type VoteOverrides = Readonly<{ vote?: "critical" | "advisory"; reason?: string; missingFact?: string | null }>;

export const vote = (fingerprint: string, overrides: VoteOverrides = {}) => ({
  fingerprint, vote: "critical", reason: "The bound parameter is absent on the pinned revision; the payload returns the admin row.",
  missingFact: null, ...overrides,
});

/** Run the verification the audit owes to `done`: start, deliver every
 *  brief's answer (`answer` votes per fingerprint), resume. */
export async function verifiedRun(run: Run, answer: (fingerprint: string) => VoteOverrides = () => ({})): Promise<Plan> {
  const plan = await verificationPlan(run);
  if (plan === null) throw new Error("the audit owes no verification run");
  const batch = await startVerification(plan);
  for (const request of batch.requests ?? []) {
    const fingerprints = briefFingerprints(plan, request);
    const delivered = await deliver(plan, request, verifierResult(fingerprints.map((fingerprint) => vote(fingerprint, answer(fingerprint)))));
    if (!delivered.ok) throw new Error(delivered.message);
  }
  const resumed = await resumeVerification(plan);
  if (resumed.action?.kind !== "done") throw new Error(`resume: ${resumed.error ?? JSON.stringify(resumed.action)}`);
  return plan;
}

/** The fingerprints of one request's brief, read from its registration. */
function briefFingerprints(plan: Plan, request: SpawnTask): readonly string[] {
  const program = parseRegisteredSecurityVerificationProgram(JSON.parse(readFileSync(join(plan.runsRoot, plan.run, "program.json"), "utf8")));
  if (!program.ok) throw new Error(program.error);
  const brief = program.value.briefs.find((candidate) => candidate.slotId === request.authority.slotId);
  if (brief === undefined) throw new Error(`no brief for ${request.authority.slotId}`);
  return brief.fingerprints;
}

/** Verify every owed claim through the real program and import it — the
 *  only way a test audit obtains a countable ballot. */
export async function verifyWith(run: Run, answer: (fingerprint: string) => VoteOverrides = () => ({})): Promise<Plan> {
  const plan = await verifiedRun(run, answer);
  const imported = await run.invoke(["verify", "--from", plan.run]);
  if (!imported.ok) throw new Error(`verify --from: ${imported.error}`);
  return plan;
}
