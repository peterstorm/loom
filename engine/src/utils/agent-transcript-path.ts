/**
 * Where a subagent's transcript lives when the harness does not say.
 *
 * `SubagentStop.agent_transcript_path` is OPTIONAL, and Claude Code stopped
 * sending it. Everything downstream reads the transcript — task-id resolution,
 * review findings, spec-check findings — so an absent field is not a degraded
 * path but a silent no-op: task status is never written, findings are never
 * stored, and the run still reports healthy. That is the failure this module
 * exists to close.
 *
 * The file is on disk either way, at a location derivable from ids the payload
 * DOES carry:
 *
 *   <config>/projects/<project-slug>/<session_id>/subagents/agent-<agent_id>.jsonl
 *
 * `<config>` is `CLAUDE_CONFIG_DIR` or `~/.claude`; `<project-slug>` is the
 * project directory with every non-alphanumeric character replaced by `-`
 * (`/home/u/.dotfiles` → `-home-u--dotfiles`) — verified against a live
 * projects directory, not assumed. Slugs longer than SLUG_MAX get a hash
 * suffix this module cannot reproduce, so those resolve by prefix scan the way
 * the harness itself does.
 *
 * DERIVATION IS A FALLBACK, NEVER AN OVERRIDE. A harness that supplies an
 * existing `agent_transcript_path` is always believed, so Pi (whose transcripts
 * live nowhere near this layout) and any future harness keep working untouched.
 * Every candidate is probed explicitly: `ENOENT` means absent and permits
 * fallback; every other filesystem failure propagates so a lifecycle hook
 * cannot silently consume different bytes. A derivation that only misses still
 * returns null.
 */

import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseAgentId, parseSessionId } from "../machine/evidence";

/**
 * The harness truncates slugs at this length and appends a hash of the full
 * path. Loom cannot reproduce that hash, so `projectDirCandidates` switches to
 * a prefix scan past this boundary instead of guessing.
 */
const SLUG_MAX = 200;

const isMissingPathError = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

/** The project-directory → slug encoding, exactly as the harness writes it. */
export function projectSlug(projectDir: string): string {
  return projectDir.replace(/[^a-zA-Z0-9]/g, "-");
}

/** `<config>/projects`, honouring CLAUDE_CONFIG_DIR. */
function projectsRoot(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return join(configured ? configured : join(homedir(), ".claude"), "projects");
}

/**
 * The project directories whose slug might name the transcript's home.
 *
 * `SubagentStopInput` carries no `cwd`, so CLAUDE_PROJECT_DIR is the stated
 * answer and the process cwd is the fallback. The realpath form is tried too
 * because the harness slugs the resolved path: a session started through a
 * symlinked worktree would otherwise derive a slug no directory ever had.
 */
function candidateProjectDirs(): string[] {
  const stated = process.env.CLAUDE_PROJECT_DIR?.trim();
  const start = stated ? stated : process.cwd();
  const dirs = [start];
  try {
    const real = realpathSync(start);
    if (real !== start) dirs.push(real);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    // A gone project may still have a harness directory under its stated slug.
    // Diagnose the miss before retaining that one fallback candidate.
    process.stderr.write(
      `loom: cannot resolve transcript project directory ${start}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  return dirs;
}

/** Project directories a slug can name — one, or every hash-suffixed sibling. */
function projectDirCandidates(root: string, slug: string): string[] {
  if (slug.length <= SLUG_MAX) return [join(root, slug)];
  const prefix = `${slug.slice(0, SLUG_MAX)}-`;
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
      .map((e) => join(root, e.name));
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    process.stderr.write(
      `loom: cannot scan transcript projects root ${root} for prefix ${prefix}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return [];
  }
}

/**
 * Every subagent file named `suffix` for `<sessionId, agentId>`, in search
 * order, across every candidate project directory.
 *
 * The nested "for each candidate dir, for each project-dir candidate, join a
 * path" walk was written out twice — once to find a transcript, once to find a
 * metadata file — so the two searches could look in different places while
 * appearing to share a lookup rule. A generator keeps each caller's own
 * first-match-wins control flow without either re-deriving where to look.
 */
function* subagentFileCandidates(sessionId: string, agentId: string, suffix: string): Generator<string> {
  const root = projectsRoot();
  for (const dir of candidateProjectDirs()) {
    for (const projectDir of projectDirCandidates(root, projectSlug(dir))) {
      yield join(projectDir, sessionId, "subagents", `agent-${agentId}${suffix}`);
    }
  }
}

function derivedCandidateExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

/**
 * The on-disk transcript for `<sessionId, agentId>`, or null when nothing at
 * the derived location exists.
 *
 * Both ids are PARSED before they reach a path: they come from hook input, and
 * a `..` or a separator in either would address a file outside the session's
 * subagent directory. The same smart constructors already guard the evidence
 * ledger's file names, so one rejection rule covers both.
 */
export function deriveAgentTranscriptPath(sessionIdRaw: string, agentIdRaw: string): string | null {
  const sessionId = parseSessionId(sessionIdRaw);
  const agentId = parseAgentId(agentIdRaw);
  if (!sessionId || !agentId) return null;

  for (const path of subagentFileCandidates(sessionId, agentId, ".jsonl")) {
    if (derivedCandidateExists(path)) return path;
  }
  return null;
}

/** The fields of a SubagentStop payload that can name a transcript. */
export interface TranscriptLocator {
  readonly session_id?: string;
  readonly agent_id?: string;
  readonly agent_transcript_path?: string;
}

/**
 * The transcript this SubagentStop is about, or null when none can be found.
 *
 * Precedence is the whole point: a supplied path that exists WINS, and the
 * derivation is consulted only when the harness gave nothing or gave a path
 * that is no longer there.
 *
 * EVERY SubagentStop route goes through here, request-bound capture included.
 * Run authority says a reserved slot must be filled; it says nothing about where
 * the transcript is, and Claude Code stopped sending the field — a capture that
 * read `agent_transcript_path` directly saw "" and reported the Agent as having
 * produced no final payload, burning the slot for a harness omission. Routes
 * that must tell "no transcript found" apart from a capture failure report their
 * own refusal on the null (capture answers `transcript-locator`); the ones that
 * only degrade stay silent, as before.
 */
export function resolveAgentTranscriptPath(input: TranscriptLocator): string | null {
  const supplied = input.agent_transcript_path?.replace(/^~/, process.env.HOME ?? "~") ?? "";
  if (supplied) {
    try {
      lstatSync(supplied);
      return supplied;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      process.stderr.write(
        `loom: supplied agent transcript path ${supplied} is unavailable: ${error instanceof Error ? error.message : String(error)} — falling back to derived lookup\n`,
      );
    }
  }
  return deriveAgentTranscriptPath(input.session_id ?? "", input.agent_id ?? "");
}

/** The fields of a SubagentStop payload that can name an agent's role. */
export interface AgentTypeLocator {
  readonly session_id?: string;
  readonly agent_id?: string;
  readonly agent_type?: string;
}

/**
 * The agent type recorded beside the transcript, or null.
 *
 * The harness writes `agent-<agentId>.meta.json` next to the transcript, and
 * its `agentType` is the same namespaced value the payload would carry
 * (`loom:code-implementer-agent`). Unlike the `.active` roster — deleted by
 * cleanupSubagentFlag before the dispatcher's routing gates run — and unlike
 * the `.machine` binding, which exists only for machine-gated types, this file
 * survives and covers every agent.
 */
export function deriveAgentType(sessionIdRaw: string, agentIdRaw: string): string | null {
  const sessionId = parseSessionId(sessionIdRaw);
  const agentId = parseAgentId(agentIdRaw);
  if (!sessionId || !agentId) return null;

  for (const path of subagentFileCandidates(sessionId, agentId, ".meta.json")) {
    if (!derivedCandidateExists(path)) continue;
    try {
      const meta: unknown = JSON.parse(readFileSync(path, "utf-8"));
      const agentType = typeof meta === "object" && meta !== null && "agentType" in meta
        ? (meta as { agentType: unknown }).agentType
        : null;
      if (typeof agentType === "string" && agentType.trim() !== "") return agentType.trim();
    } catch (error) {
      // A metadata file we cannot parse names no role — say so, then keep
      // looking. Silence here reproduces the very defect this closes.
      process.stderr.write(
        `loom: cannot read agent metadata at ${path}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  return null;
}

/**
 * The agent type this SubagentStop is about, or "" when none can be found.
 *
 * Same precedence — and same reason — as `resolveAgentTranscriptPath`: a
 * supplied value WINS, derivation is consulted only when the harness sent
 * nothing. Claude Code stopped sending `agent_transcript_path`; it also does
 * not send `agent_type`, and EVERY SubagentStop route gates on that field.
 * Absent, the dispatcher categorises the run "unknown" and does nothing: an
 * implementation subagent's whole result — task status, test evidence,
 * files_modified — is discarded without a word, and the wave gate then reports
 * a finished task as never having run.
 *
 * Pi supplies the field and is therefore untouched by the fallback.
 */
export function resolveAgentType(input: AgentTypeLocator): string {
  const supplied = input.agent_type?.trim() ?? "";
  if (supplied) return supplied;
  return deriveAgentType(input.session_id ?? "", input.agent_id ?? "") ?? "";
}
