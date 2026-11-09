/**
 * Pi `tool_call` gates over audit authority (ADR-0065), both reading bash
 * through the shared core (`core/subagent-authority`):
 *
 *  1. `piSubagentAuthorityDecision` — the Pi twin of the Claude Code
 *     `guard-subagent-authority` hook (D6): a subagent's `bash` call may not
 *     change audit or orchestration authority. The decision is the shared core
 *     over the same observed context Claude Code builds
 *     (`observeSubagentAuthorityContext`), so the two harnesses refuse one
 *     command identically. Only the caller signal differs: Pi runs each
 *     subagent as its own process, so the gate is active only in a process
 *     carrying the explicit subagent environment marker (`subagent-process.ts`).
 *
 *  2. `piParentVerifyWitnessDecision` — the PARENT's `helper security-audit
 *     verify --from <run>` is checked before it runs. The in-process Trusted
 *     Review Witness is consulted first (every captured verifier slot
 *     witnessed by THIS session with identical authority and bytes,
 *     `result.json` the replay of that evidence); when it cannot prove the run
 *     — a run captured before this process restarted, or by another session —
 *     the import is proven from the PERSISTED capture attestations exactly as
 *     `verify --from` proves it (ADR-0065, amended: the attestation is the
 *     authority on both harnesses). Only a run neither proof accepts — a
 *     forged or rewritten transcript, an altered `result.json` — is blocked.
 *
 * The extension's `tool_call` guard chain calls both for every `bash` call,
 * under its fail-closed crash handling (a throw here blocks the call, naming
 * the guard). Malformed bash input blocks too.
 */

import { isAbsolute } from "node:path";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
  observeSubagentAuthorityContext,
  subagentAuthorityBlock,
} from "../engine/src/handlers/pre-tool-use/guard-subagent-authority";
import { securityAuditVerifyInvocations, type SecurityAuditVerifyInvocation } from "../engine/src/core/subagent-authority";
import { argumentValue } from "../engine/src/handlers/helpers/cli-args";
import { verificationRunsRoot } from "../engine/src/handlers/helpers/security-audit-run";
import { proveVerificationSource, readVerificationSource } from "../engine/src/handlers/helpers/security-verification-proofs";
import { parseRunDirectoryReference } from "../engine/src/orchestration/run-directory-handle";
import { registeredSecurityAuditRuns } from "../engine/src/orchestration/security-audit-run-registry";
import { currentPiProcessRole, isPiSubagent, type PiProcessRole } from "./subagent-process";
import { piBashCommand } from "./tool-input";
import type { TrustedReviewWitnesses } from "./trusted-review-witness";

type PiGateContext = Pick<ExtensionContext, "cwd" | "sessionManager">;
type PiBlock = Readonly<{ block: true; reason: string }>;
type PiBashEvent = Pick<ToolCallEvent, "toolName" | "input">;

/** The block for one Pi tool call, or undefined when this gate has no opinion. */
export function piSubagentAuthorityDecision(
  event: PiBashEvent,
  ctx: PiGateContext,
  role: PiProcessRole = currentPiProcessRole(),
  readRuns: () => readonly string[] = registeredSecurityAuditRuns,
): PiBlock | undefined {
  if (!isPiSubagent(role) || event.toolName !== "bash") return undefined;
  const command = piBashCommand(event.input);
  if (command === null) {
    return { block: true, reason: "guard-subagent-authority: malformed Pi bash input — failing closed" };
  }
  const block = subagentAuthorityBlock(command, observeSubagentAuthorityContext(ctx.cwd, readRuns));
  return block === null ? undefined : { block: true, reason: block };
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The verification run one invocation imports, `null` when it imports none
 *  (no `--out`/`--from`, or a run reference the CLI itself refuses), or the
 *  reason it cannot be placed without trusting the shell's runtime state. */
function importedRun(invocation: SecurityAuditVerifyInvocation):
  | Readonly<{ kind: "run"; out: string; from: string; runsRoot: string; runDirectory: string }>
  | Readonly<{ kind: "unplaceable"; reason: string }>
  | null {
  if (invocation.kind === "unresolved") return { kind: "unplaceable", reason: invocation.reason };
  const out = argumentValue(invocation.args, "--out");
  const from = argumentValue(invocation.args, "--from");
  if (out === null || from === null) return null;
  // The CLI resolves relative paths against its own cwd, which the line itself
  // may change; the status-printed command is absolute, so require that.
  if (!isAbsolute(out)) return { kind: "unplaceable", reason: `--out ${JSON.stringify(out)} is relative; spell it as the absolute audit run directory` };
  if (!isAbsolute(from) && from.includes("/")) {
    return { kind: "unplaceable", reason: `--from ${JSON.stringify(from)} is a relative path; pass the run name or its absolute directory` };
  }
  const reference = parseRunDirectoryReference(verificationRunsRoot(out), from);
  return reference.ok ? { kind: "run", out, from, runsRoot: reference.value.runsRoot, runDirectory: reference.value.runDirectory } : null;
}

const witnessBlock = (segment: string, reason: string): PiBlock => ({
  block: true,
  reason: [
    "BLOCKED by loom security-verification witness (ADR-0065): this Pi session cannot prove the ballots this command imports.",
    reason,
    `Offending segment: ${JSON.stringify(segment)}`,
    "On Pi, `security-audit verify --from` imports only a verification run whose every verifier capture this session witnessed in-process.",
    "Start a fresh verification run (`security-audit status` prints its command), spawn its verifiers from this session, then import it.",
  ].join("\n"),
});

/**
 * Why an import may not run, or null. The PERSISTED capture attestation is the
 * authority on both harnesses (ADR-0065, amended): the witness this session
 * holds is consulted first, and when it cannot prove the run — a run captured
 * before this Pi process restarted, or by another session — the import is
 * proven the way `verify --from` itself proves it: `result.json` replayed
 * byte for byte from the run's evidence, and every ballot backed by its
 * harness's attestation. Only a run neither proof accepts is blocked, so a
 * restart no longer strands a correctly captured run.
 */
async function importRefusal(
  witnesses: Pick<TrustedReviewWitnesses, "verifySecurityVerification">,
  sessionId: string,
  run: Extract<ReturnType<typeof importedRun>, { kind: "run" }>,
): Promise<string | null> {
  let witnessed: string;
  try {
    await witnesses.verifySecurityVerification({ sessionId, runsRoot: run.runsRoot, runDirectory: run.runDirectory });
    return null;
  } catch (error) {
    witnessed = describe(error);
  }
  const source = readVerificationSource(run.out, run.from);
  const persisted = source.ok ? await proveVerificationSource(source.value) : source;
  return persisted.ok ? null : `${witnessed}; and its persisted capture attestations do not prove it either: ${persisted.error}`;
}

/**
 * The block for a PARENT `bash` call that imports a security-verification run
 * this session did not witness, or undefined. Inert in a subagent process —
 * there the authority gate refuses `verify` outright.
 */
export async function piParentVerifyWitnessDecision(
  event: PiBashEvent,
  ctx: PiGateContext,
  witnesses: Pick<TrustedReviewWitnesses, "verifySecurityVerification">,
  role: PiProcessRole = currentPiProcessRole(),
): Promise<PiBlock | undefined> {
  if (isPiSubagent(role) || event.toolName !== "bash") return undefined;
  const command = piBashCommand(event.input);
  if (command === null) return { block: true, reason: "security-verification witness: malformed Pi bash input — failing closed" };
  const sessionId = ctx.sessionManager.getSessionId() ?? "";
  for (const invocation of securityAuditVerifyInvocations(command, observeSubagentAuthorityContext(ctx.cwd))) {
    const run = importedRun(invocation);
    if (run === null) continue;
    if (run.kind === "unplaceable") return witnessBlock(invocation.segment, run.reason);
    const refusal = await importRefusal(witnesses, sessionId, run);
    if (refusal !== null) return witnessBlock(invocation.segment, refusal);
  }
  return undefined;
}
