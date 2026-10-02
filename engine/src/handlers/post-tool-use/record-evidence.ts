/**
 * PostToolUse handler: record-evidence
 *
 * Appends ground-truth evidence records (facts only, epoch-stamped) to the
 * session's ledger — the deterministic core observes what happened at
 * execution time, never the agent's narrative about it.
 *
 * Records ONLY when attribution is sound (attributeEvidence, evidence.ts):
 * a call carrying `agent_id` — Claude Code stamps it on every hook fired
 * inside a subagent — is credited to THAT agent's own binding line, so
 * parallel bound subagents in one session each record into their own epoch.
 * A call without `agent_id` (main agent, older harness) falls back to the
 * sole-active rule: exactly one machine binding and the roster is exactly the
 * bound agent. Everything else records nothing, with a stderr note —
 * commingled evidence is worse than no evidence, because the SubagentStop
 * resolver treats ledger data as high-trust.
 *
 * Never blocks: the PreToolUse gate fails closed on missing evidence, and
 * the SubagentStop resolver labels a bound-but-empty ledger as degraded —
 * so a broken recorder surfaces downstream instead of silently passing.
 */

import { resolve } from "node:path";
import { match } from "ts-pattern";
import type { HookHandler } from "../../types";
import { passthroughResult } from "../../types";
import {
  attributeEvidence,
  eventsForEpoch,
  type EvidenceAttribution,
  extractEvidence,
  findReport,
  fsSessionRegistry,
  parseCallerIdentity,
  parseSessionId,
  type SessionId,
  type SessionRegistry,
} from "../../machine";
import { passthroughDiagnostic } from "../../utils/hook-diagnostic";

/** Why a call recorded nothing, as the audit line the operator sees; null
 *  for an ungated session (nothing was ever bound, nothing was lost). */
function standDownNotice(
  sessionId: SessionId,
  attribution: Exclude<EvidenceAttribution, { kind: "caller" | "sole" }>,
): string | null {
  const reason = match(attribution)
    .with({ kind: "ungated" }, () => null)
    .with({ kind: "corrupt" }, () => "machine binding authority has malformed rows")
    .with({ kind: "caller-unparseable" }, ({ raw }) =>
      `caller agent_id ${JSON.stringify(raw)} is reserved or path-unsafe — it cannot own a binding`)
    .with({ kind: "caller-unbound" }, ({ agentId }) =>
      `caller ${agentId} has no machine binding line — evidence is never credited to another agent`)
    .with({ kind: "caller-ambiguous" }, ({ agentId, bindings }) =>
      `caller ${agentId} owns ${bindings} binding lines — its epoch is ambiguous`)
    .with({ kind: "contended" }, () =>
      "call carries no agent_id and attribution is unsound (contended or leaked binding)")
    .exhaustive();
  return reason === null ? null : `record-evidence: standing down for ${sessionId} — ${reason}; nothing recorded\n`;
}

interface RecordEvidenceInput {
  session_id?: string;
  /** Caller identity — set by Claude Code only inside a subagent. Untrusted:
   *  parsed by parseCallerIdentity, never used raw. */
  agent_id?: unknown;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  cwd?: string;
  /** Harness id of this tool call — stamped on ledger records as the
   *  idempotency key so a duplicated PostToolUse never double-counts. */
  tool_use_id?: string;
}

export const runRecordEvidence = async (
  stdin: string,
  registry: SessionRegistry = fsSessionRegistry,
) => {
  try {
    if (!stdin || stdin.trim() === "") return passthroughResult();
    const input: RecordEvidenceInput = JSON.parse(stdin);

    const toolName = input.tool_name;
    if (!input.session_id || !toolName) return passthroughResult();
    // Parse the session id once at this boundary. A present-but-unparseable id
    // can address no ledger file — say so (it may signal an attack or a bug)
    // and stand down, exactly as the old in-ledger throw+catch did.
    const sessionId = parseSessionId(input.session_id);
    if (sessionId === null) {
      return passthroughDiagnostic(`record-evidence: invalid session id ${JSON.stringify(input.session_id)} — nothing recorded\n`);
    }

    // Recorder activity keeps a live binding fresh (and reaps expired ones)
    // — no-op for ungated sessions (no binding file, no lock taken).
    await registry.refreshBindingActivity(sessionId);

    const attribution = attributeEvidence(
      parseCallerIdentity(input.agent_id),
      registry.readBindingAuthority(sessionId),
      registry.readActiveRoster(sessionId),
    );
    if (attribution.kind !== "caller" && attribution.kind !== "sole") {
      // Bound-but-unattributable: say so, like the gate does — a silently
      // standing-down recorder is indistinguishable from a broken one.
      // Ungated sessions (no live binding) stay quiet.
      const notice = standDownNotice(sessionId, attribution);
      if (notice !== null) process.stderr.write(notice);
      return passthroughResult();
    }
    const { binding } = attribution;

    const toolInput = input.tool_input ?? {};
    const cwd = input.cwd ?? process.cwd();

    const extracted = extractEvidence(
      toolName,
      toolInput,
      input.tool_response,
      (segment, stdout, currentCallWrites) => {
        // Cheap hardening against agent-authored report artifacts: an explicit
        // --outputFile path the agent wrote earlier this epoch must not vouch
        // as a report — findReport rejects it loudly. The veto set covers
        // Edit/Write/MultiEdit FileWrites, Bash-authored writes (redirect/
        // tee targets minted by extractShellWriteTargets) from PRIOR calls,
        // AND this very call's own write targets (currentCallWrites) — a
        // one-call `printf '{…}' > r.json; npx vitest --outputFile=r.json`
        // stages an artifact the persisted ledger cannot know about yet.
        // Known residual: writes with no static target in the command text —
        // cp/mv/dd of=, or a file authored by an interpreter
        // (`python -c 'open(...)'`) — mint nothing and can still stage an
        // artifact (documented in machines/README.md "known residuals").
        // Computed lazily here: this closure only runs for classified test
        // commands. The read-time resolve is a no-op for records minted
        // absolute (see below) and covers old relative-path records.
        const epochWrites = new Set([
          ...eventsForEpoch(registry.readEvidence(sessionId), binding.epoch).flatMap((e) =>
            e.kind === "FileWrite" ? [resolve(cwd, e.path)] : [],
          ),
          ...currentCallWrites.map((p) => resolve(cwd, p)),
        ]);
        // Call-scoped freshness: the PreToolUse stamp for THIS call orders
        // artifacts against the call start. No tool_use_id / no stamp →
        // null, and findReport fails closed on the artifact-backed sources.
        const callStartMs =
          input.tool_use_id !== undefined && input.tool_use_id !== ""
            ? registry.callStartFor(sessionId, input.tool_use_id)
            : null;
        return findReport(segment, cwd, stdout, { nowMs: Date.now(), callStartMs }, (absPath) =>
          epochWrites.has(absPath),
        );
      },
    );
    // Resolve FileWrite paths at MINT time, against THIS call's cwd: a later
    // reader's cwd may differ (the agent cd'd), and resolving a relative
    // redirect target against the wrong base would let a staged artifact
    // slip past the veto.
    const events = extracted.map((e) =>
      e.kind === "FileWrite" ? { ...e, path: resolve(cwd, e.path) } : e,
    );
    registry.appendEvidence(sessionId, binding.epoch, events, input.tool_use_id);

    return passthroughResult();
  } catch (e) {
    // Fail-open (never block) — but this catch wraps JSON.parse,
    // refreshBindingActivity, extractEvidence, readEvidence and appendEvidence,
    // so anything landing here is an UNEXPECTED handler exception (a
    // programming error or an fs-write failure), NOT one of the expected
    // no-evidence stand-downs above. Flag it as such so a genuine bug is
    // distinguishable from benign "nothing recorded" in the logs.
    return passthroughDiagnostic(`record-evidence: UNEXPECTED handler exception — evidence for this call may be lost (failing open): ${e instanceof Error ? e.message : String(e)}\n`);
  }
};

const handler: HookHandler = (stdin) => runRecordEvidence(stdin);

export default handler;
