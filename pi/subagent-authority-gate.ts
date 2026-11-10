/**
 * The Pi `bash` authority decision (ADR-0067): ONE `tool_call` gate over audit
 * authority, dispatching on this process's role (`subagent-process.ts`) and
 * reading bash through the shared core (`core/subagent-authority`):
 *
 *  - SUBAGENT — refused outright. The Pi twin of the Claude Code
 *    `guard-subagent-authority` hook (D6): a subagent's `bash` call may not
 *    change audit or orchestration authority. The decision is the shared core
 *    over the same observed context Claude Code builds
 *    (`observeSubagentAuthorityContext`), so the two harnesses refuse one
 *    command identically. Only the caller signal differs: Pi runs each
 *    subagent as its own process, so the role comes from the process's Loom
 *    environment marker.
 *
 *  - PARENT — proof-checked. The parent's `helper security-audit verify --from
 *    <run>` is checked before it runs, against the one authority both
 *    harnesses share (ADR-0067, amended): the run's PERSISTED capture
 *    attestations, proven exactly as `verify --from` proves them
 *    (`proveVerificationSource`) — `result.json` replayed byte for byte from
 *    the run's evidence, every ballot backed by its capture attestation. A
 *    forged or rewritten transcript, or an altered `result.json`, is blocked;
 *    a correctly captured run imports whichever process or session captured
 *    it. An invocation the gate cannot place without trusting the shell's
 *    runtime state is blocked rather than guessed.
 *
 * The extension's `tool_call` guard chain calls `piBashAuthorityDecision` once
 * per `bash` call, under its fail-closed crash handling (a throw here blocks
 * the call, naming the guard). Malformed bash input blocks in either role.
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
import { currentPiProcessRole, type PiProcessRole } from "./subagent-process";
import { piBashCommand } from "./tool-input";

type PiGateContext = Pick<ExtensionContext, "cwd">;
type PiBlock = Readonly<{ block: true; reason: string }>;
type PiBashEvent = Pick<ToolCallEvent, "toolName" | "input">;

const block = (reason: string): PiBlock => ({ block: true, reason });

/** A subagent's command: refused when it changes audit or orchestration authority. */
function subagentAuthorityRefusal(command: string, cwd: string, readRuns: () => readonly string[]): PiBlock | undefined {
  const refusal = subagentAuthorityBlock(command, observeSubagentAuthorityContext(cwd, readRuns));
  return refusal === null ? undefined : block(refusal);
}

/** What one `verify` invocation imports: nothing (no `--out`/`--from`, or a
 *  run reference the CLI itself refuses), the run it names, or the reason it
 *  cannot be placed without trusting the shell's runtime state. */
type ImportedRun =
  | Readonly<{ kind: "not-an-import" }>
  | Readonly<{ kind: "unplaceable"; reason: string }>
  | Readonly<{ kind: "run"; out: string; from: string }>;

function importedRun(invocation: SecurityAuditVerifyInvocation): ImportedRun {
  if (invocation.kind === "unresolved") return { kind: "unplaceable", reason: invocation.reason };
  const out = argumentValue(invocation.args, "--out");
  const from = argumentValue(invocation.args, "--from");
  if (out === null || from === null) return { kind: "not-an-import" };
  // The CLI resolves relative paths against its own cwd, which the line itself
  // may change; the status-printed command is absolute, so require that.
  if (!isAbsolute(out)) return { kind: "unplaceable", reason: `--out ${JSON.stringify(out)} is relative; spell it as the absolute audit run directory` };
  if (!isAbsolute(from) && from.includes("/")) {
    return { kind: "unplaceable", reason: `--from ${JSON.stringify(from)} is a relative path; pass the run name or its absolute directory` };
  }
  return parseRunDirectoryReference(verificationRunsRoot(out), from).ok ? { kind: "run", out, from } : { kind: "not-an-import" };
}

const importBlock = (segment: string, reason: string): PiBlock => block([
  "BLOCKED by loom security-verification import proof (ADR-0067): this Pi session cannot prove the ballots this command imports.",
  reason,
  `Offending segment: ${JSON.stringify(segment)}`,
  "`security-audit verify --from` imports only a verification run whose result.json replays from its captured evidence and whose every ballot matches its capture attestation.",
  "Start a fresh verification run (`security-audit status` prints its command), spawn its verifiers from this session, then import it.",
].join("\n"));

/** Why the named run may not be imported, or null: the persisted proof
 *  `verify --from` itself runs, so the gate and the CLI cannot disagree. */
async function importRefusal(run: Extract<ImportedRun, { kind: "run" }>): Promise<string | null> {
  const source = readVerificationSource(run.out, run.from);
  const proven = source.ok ? await proveVerificationSource(source.value) : source;
  return proven.ok ? null : proven.error;
}

/** The refusal of one invocation, or null when it imports nothing or a run
 *  its persisted attestations prove. */
async function invocationRefusal(invocation: SecurityAuditVerifyInvocation): Promise<string | null> {
  const imported = importedRun(invocation);
  switch (imported.kind) {
    case "not-an-import":
      return null;
    case "unplaceable":
      return imported.reason;
    case "run":
      return importRefusal(imported);
    default: {
      const unreachable: never = imported;
      return unreachable;
    }
  }
}

/** A parent's command: refused when it imports a security-verification run its
 *  persisted capture attestations do not prove. */
async function parentImportRefusal(command: string, cwd: string): Promise<PiBlock | undefined> {
  for (const invocation of securityAuditVerifyInvocations(command, observeSubagentAuthorityContext(cwd))) {
    const refusal = await invocationRefusal(invocation);
    if (refusal !== null) return importBlock(invocation.segment, refusal);
  }
  return undefined;
}

/** The fail-closed block for bash input whose command cannot be read, named
 *  after the half of the decision that could not judge it. */
const malformedBashBlock = (role: PiProcessRole): PiBlock => block(role.kind === "subagent"
  ? "guard-subagent-authority: malformed Pi bash input — failing closed"
  : "security-verification import proof: malformed Pi bash input — failing closed");

/**
 * The bash authority decision for one Pi tool call, or undefined when the call
 * passes: a subagent is refused any authority change; a parent's
 * `verify --from` import must be proven by persisted attestations. Tools other
 * than `bash` are not this gate's concern.
 */
export async function piBashAuthorityDecision(
  event: PiBashEvent,
  ctx: PiGateContext,
  role: PiProcessRole = currentPiProcessRole(),
  readRuns: () => readonly string[] = registeredSecurityAuditRuns,
): Promise<PiBlock | undefined> {
  if (event.toolName !== "bash") return undefined;
  const command = piBashCommand(event.input);
  if (command === null) return malformedBashBlock(role);
  switch (role.kind) {
    case "subagent":
      return subagentAuthorityRefusal(command, ctx.cwd, readRuns);
    case "parent":
      return parentImportRefusal(command, ctx.cwd);
    default: {
      const unreachable: never = role;
      return unreachable;
    }
  }
}

