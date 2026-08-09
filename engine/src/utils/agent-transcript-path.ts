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
 * Every step is guarded by `existsSync` and the whole thing returns null rather
 * than throwing: a derivation that misses must land on the behaviour we already
 * had, never crash a lifecycle hook.
 */

import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseAgentId, parseSessionId } from "../machine/evidence";

/**
 * The harness truncates slugs at this length and appends a hash of the full
 * path. Loom cannot reproduce that hash, so `projectDirCandidates` switches to
 * a prefix scan past this boundary instead of guessing.
 */
const SLUG_MAX = 200;

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
    // Unresolvable (gone, or permission-denied): keep the stated fallback, but
    // preserve the filesystem cause so a missing transcript is diagnosable.
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
    process.stderr.write(
      `loom: cannot scan transcript projects root ${root} for prefix ${prefix}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return [];
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

  const root = projectsRoot();
  for (const dir of candidateProjectDirs()) {
    for (const projectDir of projectDirCandidates(root, projectSlug(dir))) {
      const path = join(projectDir, sessionId, "subagents", `agent-${agentId}.jsonl`);
      if (existsSync(path)) return path;
    }
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
 * that is no longer there. Every SubagentStop handler that reads a transcript
 * goes through here, so "which harnesses can loom record status on" has one
 * answer instead of one per handler.
 */
export function resolveAgentTranscriptPath(input: TranscriptLocator): string | null {
  const supplied = input.agent_transcript_path?.replace(/^~/, process.env.HOME ?? "~") ?? "";
  if (supplied) {
    try {
      lstatSync(supplied);
      return supplied;
    } catch (error) {
      process.stderr.write(
        `loom: supplied agent transcript path ${supplied} is unavailable: ${error instanceof Error ? error.message : String(error)} — falling back to derived lookup\n`,
      );
    }
  }
  return deriveAgentTranscriptPath(input.session_id ?? "", input.agent_id ?? "");
}
