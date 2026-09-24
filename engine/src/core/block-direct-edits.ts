/**
 * Core: Block Edit/Write/MultiEdit from the MAIN agent during loom orchestration.
 * Harness-agnostic — no stdin parsing. Pure GIVEN ITS PORTS: every read it needs
 * (the task graph's existence, the session's active roster) arrives as an
 * injected function, so the decision itself performs no I/O.
 */

import { posix } from "node:path";
import type { HookResult } from "../types";
import { IMPL_AGENTS } from "../config";
import { PANEL_ARTIFACT_WRITERS, SPEC_ARTIFACT_ROOT } from "./artifact-write-scope";
import {
  parseGrantedAgentId,
  parseSessionId,
  type AgentId,
  type AgentType,
  type SessionId,
} from "../machine/evidence";

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "edit", "write", "multi_edit"]);

/** One row of a session's `.active` roster: who is running, and as what role. */
export type ActiveRosterEntry = Readonly<{ agentId: AgentId; agentType: AgentType | null }>;

/**
 * Port: the session's active-subagent roster, or `null` when no active subagent
 * can be PROVEN — an absent flag file and an unreadable one both answer `null`,
 * because neither proves a subagent is running and this gate fails closed.
 *
 * A port rather than a direct read because the roster lives in the machine's
 * filesystem shell (`machine/ledger`), and `engine/src/core/` may not import the
 * shell — its allowlist denies `machine/ledger` by omission. Taking the read as
 * a parameter is the same move `taskGraphExists` below, `SpawnAdmissionPorts`,
 * and `validate-phase-order`'s `ArtifactProbe` already make; it also lets the
 * roster-authorization branch be exercised with plain arrays instead of real
 * files under SUBAGENT_DIR.
 *
 * The parameter is a BRANDED SessionId, parsed by this module before the port
 * is ever called, so an adapter interpolating it into a path is path-safe by
 * construction — the same guarantee `ledger.ts`'s `sessionScopedPath` provides.
 */
export type ActiveRosterProbe = (sessionId: SessionId) => readonly ActiveRosterEntry[] | null;

/**
 * Two admissions, not one: an agent whose id is an implementation-role id
 * (`IMPL_AGENTS`), or one holding a minted Pi write grant. Review agents and
 * refutation verifiers match neither and stay read-only.
 *
 * Write-grant agent IDs are minted by the Pi write-grant system, which verifies
 * the grant's token digest, binding MAC, expiry, agent identity, Task ID, and
 * cwd before minting — then BURNS the record, so nothing downstream can re-run
 * that verification. The identity is therefore recognised by namespace, and the
 * namespace is what has to be exclusive: `parseGrantedAgentId` is the only
 * constructor that admits it, and `parseReportedAgentId` — the only constructor
 * applied to harness-reported ids on their way onto the `.active` roster this
 * function reads — refuses it. A self-reported id shaped like a grant identity
 * therefore never reaches here. The prefix test that used to stand in for this
 * had no such boundary: it accepted whatever the roster's identity column held.
 */
function isWriteAuthorizedAgent(agentId: string): boolean {
  return IMPL_AGENTS.has(agentId) || parseGrantedAgentId(agentId) !== null;
}

/**
 * No roster reader supplied — answer `null`, i.e. "cannot prove a subagent is
 * running", which falls through to block. There is deliberately NO filesystem
 * default here: a default that read the shell would put the import this port
 * exists to remove straight back into the functional core. Callers that need
 * the real roster pass `activeRosterProbe` from
 * `handlers/pre-tool-use/block-direct-edits`.
 */
const noActiveRoster: ActiveRosterProbe = () => null;

/** Repo-relative spec-artifact target: normalized here so a `..` segment
 *  cannot reassemble into an escape after the prefix test. Targets arrive
 *  from the caller's shell already resolved against the session cwd and made
 *  repo-relative; a path that escapes the repo or does not live under the
 *  spec artifact root fails this check and stays blocked. */
function inSpecArtifactRoot(targetPath: string): boolean {
  const normalized = posix.normalize(targetPath);
  return normalized === SPEC_ARTIFACT_ROOT || normalized.startsWith(`${SPEC_ARTIFACT_ROOT}/`);
}

/**
 * REQUIRED arming port: the task-graph existence probe, named at every call
 * site — no import-frozen default stands in for it. The lazy-arming doctrine
 * (commit 6f4a1452): a default frozen at module load made the gate's arming
 * depend on the checkout and silently disarmed on a fresh one; production
 * callers inject `pathExistsFailClosed(taskGraphPath())`, tests inject their
 * own. Fail-closed semantics stay the caller's (`pathExistsFailClosed` — ENOENT
 * is the only absent answer).
 */
export function shouldBlockDirectEdit(
  toolName: string,
  sessionId: string,
  taskGraphExists: () => boolean,
  readActiveRoster: ActiveRosterProbe = noActiveRoster,
  targetPaths: readonly string[] = [],
): HookResult {
  if (!taskGraphExists()) return { kind: "allow" };
  if (!FILE_TOOLS.has(toolName)) return { kind: "allow" };

  // Session ids come from hook input and name files under SUBAGENT_DIR —
  // parse before the port is handed one. An unparseable id means the
  // subagent-active check cannot be made safely: fail closed (block),
  // since allowing would open direct edits on malformed input.
  const parsed = parseSessionId(sessionId);
  if (parsed === null) {
    return {
      kind: "block",
      message: `BLOCKED: invalid session id ${JSON.stringify(sessionId)} — cannot verify an active subagent; direct edits stay blocked during loom orchestration.`,
    };
  }

  // Allow if an IMPLEMENTATION subagent is active. Review agents and verifiers
  // are read-only and must never receive write capability, even when active.
  //
  // Authorize by ROLE first. On Claude Code `agent_id` is an opaque handle
  // (`a339f6fd51d78b179`), so testing it against IMPL_AGENTS — which holds
  // agent-type NAMES — could never match, and every implementation subagent
  // was blocked by the guard that exists to let it through. The roster's type
  // column is the role it is serving.
  const roster = readActiveRoster(parsed);
  if (roster !== null && roster.some(({ agentId, agentType }) =>
    // agentType covers Claude Code; the id fallback covers Pi's `pi-grant-`
    // capability tokens and any roster written before the type column existed.
    (agentType !== null && IMPL_AGENTS.has(agentType)) || isWriteAuthorizedAgent(agentId))) {
    return { kind: "allow" };
  }

  // Phase-artifact writes: panel artifact writers (interviewer, designer) are
  // granted writes scoped to the spec artifact root. Their run contracts
  // promise this capability — the panel templates instruct writing the run's
  // interview digest and one candidate per lens under the panel-runs dir —
  // and a spawn that proceeds without it fails confusingly at its first
  // write. Targets arrive repo-relative from the caller's shell, so a `..`
  // segment or an outside-the-repo path cannot be proven in-scope here and
  // stays blocked. Judges are deliberately absent from
  // PANEL_ARTIFACT_WRITERS: their prompts name candidate paths to READ, and
  // this admission must not let a compromised judge rewrite candidate files
  // the finalizer reads verbatim.
  if (roster !== null &&
      roster.some(({ agentType }) => agentType !== null && PANEL_ARTIFACT_WRITERS.has(agentType)) &&
      targetPaths.length > 0 &&
      targetPaths.every(inSpecArtifactRoot)) {
    return { kind: "allow" };
  }
  // No roster, or only review/verifier and read-only panel agents active — block.

  return {
    kind: "block",
    message: [
      "BLOCKED: Direct edits not allowed during loom orchestration.",
      "",
      "Use the subagent tool with appropriate agent for implementation:",
      "  - code-implementer-agent for production code",
      "  - ts-test-agent for tests",
      "  - frontend-agent for UI components",
      "",
      "This ensures proper phase sequencing and review gates.",
    ].join("\n"),
  };
}
