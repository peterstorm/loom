/**
 * Core: Guard state files from direct modification via Bash.
 * Pure function — no stdin parsing.
 *
 * The helper whitelist is anchored to an ACTUAL helper invocation, not a
 * substring: the command is split into quote-aware simple-command segments
 * (the same splitter the evidence classifier uses), and a segment counts as
 * a helper invocation only when it has the documented shape
 * `bun <path>/cli.ts helper <whitelisted-name> [args]`. A helper name inside
 * an echo argument, a comment, or a file path can therefore never bypass the
 * guard. Writes into SUBAGENT_DIR / MACHINES_DIR are blocked BEFORE the
 * helper allow — even a legitimate helper invocation must not smuggle a
 * forged append to `<session>.evidence.jsonl` or an `rm` of a machine
 * definition on the same command line. The helper allow itself is
 * segment-scoped: a non-helper segment on the same line that writes the
 * task graph or review-invocations blocks too.
 */

import { existsSync } from "node:fs";
import type { HookResult } from "../types";
import {
  TASK_GRAPH_PATH,
  WHITELISTED_HELPERS,
  STATE_FILE_PATTERNS,
  WRITE_PATTERNS,
  PROTECTED_DIR_PATTERNS,
} from "../config";
import { splitCommandSegments, stripComment, stripEnvPrefix } from "../machine/extract-evidence";

const BLOCK: HookResult = {
  kind: "block",
  message: [
    "BLOCKED: Write to state file not allowed during loom workflow.",
    "State is managed by hooks and helper scripts only.",
    "Read access (jq, cat) is allowed.",
  ].join("\n"),
};

/** Strip one layer of surrounding quotes from a token (`"…"` / `'…'`). */
function unquote(token: string): string {
  const first = token[0];
  if ((first === '"' || first === "'") && token.endsWith(first) && token.length >= 2) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * Does this simple-command segment ACTUALLY invoke a whitelisted helper?
 * The only documented invocation shape is `bun <path>/cli.ts helper <name>`
 * — matched token-by-token at the segment HEAD (after comment/env-prefix
 * stripping), so a helper name appearing anywhere else in the segment
 * (echo argument, comment, path component) never matches.
 */
function segmentInvokesHelper(segment: string): boolean {
  const tokens = stripEnvPrefix(stripComment(segment).trim())
    .split(/\s+/)
    .filter((t) => t !== "")
    .map(unquote);
  const head = tokens[0] ?? "";
  const headBase = head.slice(head.lastIndexOf("/") + 1);
  if (headBase !== "bun") return false;
  const cli = tokens[1] ?? "";
  if (cli !== "cli.ts" && !cli.endsWith("/cli.ts")) return false;
  if (tokens[2] !== "helper") return false;
  return (WHITELISTED_HELPERS as readonly string[]).includes(tokens[3] ?? "");
}

/** Quote-aware: does ANY segment of the command line invoke a whitelisted helper? */
export function commandInvokesWhitelistedHelper(command: string): boolean {
  return splitCommandSegments(command).some(segmentInvokesHelper);
}

/**
 * Does any NON-helper segment of the command line carry a state-file write?
 * The helper allow is segment-scoped, not line-wide: a real helper invocation
 * must not vouch for the OTHER segments on its line. Helpers legitimately
 * write the task graph, so a redirect inside the helper segment itself stays
 * allowed — but `bun cli.ts helper set-phase execute && sed -i … active_task_graph.json`
 * blocks, because the forging segment is not a helper invocation.
 */
function nonHelperSegmentWritesStateFile(command: string): boolean {
  return splitCommandSegments(command).some(
    (segment) =>
      !segmentInvokesHelper(segment) &&
      STATE_FILE_PATTERNS.test(segment) &&
      WRITE_PATTERNS.test(segment)
  );
}

/**
 * The pure guard decision (no fs) — exported so tests exercise the REAL
 * logic instead of a simulation. guardStateFile wraps it with the
 * task-graph-exists check.
 */
export function guardStateFileDecision(command: string): HookResult {
  if (!command) return { kind: "allow" };

  // Ledger / binding / machine-definition writes are never whitelisted —
  // checked FIRST so a helper-shaped command line cannot carry a forged
  // write into SUBAGENT_DIR or MACHINES_DIR past the allow below.
  if (PROTECTED_DIR_PATTERNS.test(command) && WRITE_PATTERNS.test(command)) {
    return BLOCK;
  }

  // Allow whitelisted helper scripts — only on an actual invocation segment,
  // and only for that segment: any other segment on the same line that both
  // references a guarded state file and matches a write pattern blocks
  // (round 11 closed the SUBAGENT_DIR/MACHINES_DIR variant above; this closes
  // the task-graph / review-invocations variant).
  if (commandInvokesWhitelistedHelper(command)) {
    if (nonHelperSegmentWritesStateFile(command)) return BLOCK;
    return { kind: "allow" };
  }

  // Only inspect commands that reference state files
  if (!STATE_FILE_PATTERNS.test(command)) return { kind: "allow" };

  // Block write patterns
  if (WRITE_PATTERNS.test(command)) return BLOCK;

  return { kind: "allow" };
}

export function guardStateFile(command: string): HookResult {
  if (!existsSync(TASK_GRAPH_PATH)) return { kind: "allow" };
  return guardStateFileDecision(command);
}
