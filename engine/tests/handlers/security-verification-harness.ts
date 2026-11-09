/**
 * The one way a handler test obtains a ballot (ADR-0065, amended): through the
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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { subagentDir } from "../../src/config";
import { orchestrationHandler, type Emission } from "../../src/handlers/helpers/orchestration";
import { resolveEmissionEnvironment } from "../../src/utils/emission-environment";
import { recordClaudeSpawnCorrelation } from "../../src/handlers/post-tool-use/record-orchestration-spawn";
import { captureClaudeResult } from "../../src/handlers/subagent-stop/capture-orchestration-result";
import { parseRegisteredSecurityVerificationProgram, type SecurityVerificationStart } from "../../src/core/security-verification";
import { parentAnnouncement, FIXTURE_CLAUDE_CODE_SESSION_ID } from "../fixtures/facade-parent";
import type { Run } from "./security-audit-harness";

export type Plan = Readonly<{
  runsRoot: string; run: string; input: SecurityVerificationStart; command: string; importCommand: string; awaitingBallots: number;
}>;

export type SpawnTask = Readonly<{
  authority: { requestId: string; slotId: string; attempt: 1 | 2; role: string; program: string; modelProfile: string };
  task: string;
}>;
export type Action = Readonly<{ kind: string; requests?: readonly SpawnTask[]; outcome?: unknown; diagnostic?: { kind: string; message: string } }>;

/** The verification run `status --json` names, or null when none is owed. */
export async function verificationPlan(run: Run): Promise<Plan | null> {
  const status = await run.invoke(["status", "--json"]);
  if (!status.ok) throw new Error(`status: ${status.error}`);
  return (JSON.parse(run.stdout()) as { verification: Plan | null }).verification;
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
  return { action: JSON.parse(printed.join("")) as Action, error: null };
}

export async function startVerification(plan: Plan): Promise<Action> {
  const started = await facade(["start", "security-verification", "--runs-root", plan.runsRoot, "--run", plan.run], JSON.stringify(plan.input));
  if (started.action === null) throw new Error(`start: ${started.error}`);
  return started.action;
}

export const resumeVerification = (plan: Plan) => facade(["resume", "--runs-root", plan.runsRoot, "--run", plan.run]);

let nativeOrdinal = 0;

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
): Promise<Readonly<{ ok: boolean; message: string }>> {
  const agentId = `verifier-${++nativeOrdinal}`;
  const correlated = await recordClaudeSpawnCorrelation({
    session_id: FIXTURE_CLAUDE_CODE_SESSION_ID,
    tool_name: "Agent",
    tool_input: { subagent_type: `loom:${role}`, prompt: request.task },
    tool_response: { agent_id: agentId },
  }, subagentDir());
  if (correlated.kind === "error") return { ok: false, message: String(correlated.message) };
  const transcripts = join(subagentDir(), "test-transcripts");
  mkdirSync(transcripts, { recursive: true });
  const transcript = join(transcripts, `${agentId}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: finalText }] } })}\n`);
  const outcome = await captureClaudeResult({ session_id: FIXTURE_CLAUDE_CODE_SESSION_ID, agent_id: agentId, agent_type: role, agent_transcript_path: transcript },
    plan.runsRoot, join(plan.runsRoot, plan.run));
  return outcome.kind === "captured" ? { ok: true, message: "captured" } : { ok: false, message: JSON.stringify(outcome) };
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
