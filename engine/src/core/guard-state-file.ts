/**
 * Core: Guard state files from direct modification via Bash.
 * Harness-agnostic — no stdin parsing. Not pure: guardStateFile reads the
 * filesystem (existsSync); the decision core (guardStateFileDecision) is pure.
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
 * confined to the helper segment: a state-file write is vouched for ONLY when
 * it lives inside the single helper segment (a `helper … > active_task_graph.json`
 * output redirect). A write pattern in ANY non-helper segment blocks — this
 * covers both a co-located forge (`helper && sed -i … active_task_graph.json`)
 * and a variable-indirected one split across segments
 * (`helper && F=active_task_graph.json && sed -i … $F`). Command substitution
 * (`$(…)` / backticks) and process substitution (`<(…)` / `>(…)`) that
 * co-occur with a state-file write also block: their bodies execute
 * independently and are opaque to the segment splitter, so they can never be
 * vouched for by the enclosing helper.
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
 * Does any NON-helper segment of the command line carry a write pattern?
 * A helper invocation vouches only for its OWN segment: the sole legitimate
 * state-file write is a redirect of helper output confined to the helper
 * segment (`bun cli.ts helper set-phase > active_task_graph.json`). A write
 * in any other segment is untrusted — whether it names the state file itself
 * (`… && sed -i … active_task_graph.json`) or reaches it through a variable
 * bound in a sibling segment (`… && F=active_task_graph.json && sed -i … $F`),
 * where the literal and the write never share a segment. Combined with the
 * line-wide STATE_FILE check at the call site, both shapes block.
 */
function writeInNonHelperSegment(command: string): boolean {
  return splitCommandSegments(command).some(
    (segment) => !segmentInvokesHelper(segment) && WRITE_PATTERNS.test(segment)
  );
}

/**
 * Command substitution `$(…)` / backticks and process substitution
 * `<(…)` / `>(…)` embed a command that the shell executes independently; our
 * splitter treats the substitution body (inside quotes or a helper-argument
 * position) as opaque segment text, so a write it performs is invisible to
 * segment scoping. A helper never needs to write state through a substitution,
 * so its presence alongside a state-file write is treated as an escape.
 */
function hasCommandSubstitution(command: string): boolean {
  return (
    command.includes("$(") ||
    command.includes("`") ||
    command.includes("<(") ||
    command.includes(">(")
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

  // Allow whitelisted helper scripts — but the allow is confined to the helper
  // segment. When the line touches a state file AND carries a write, the write
  // is trusted ONLY if it lives inside the single helper segment (a redirect of
  // helper output). A write in any non-helper segment, or a command/process
  // substitution smuggling an independent write, escapes that confinement and
  // blocks. (Round 11 closed the SUBAGENT_DIR/MACHINES_DIR variant above;
  // round 12 the co-located task-graph variant; round 13 the command-
  // substitution and cross-segment-indirection variants; round 14 the
  // process-substitution variant.)
  if (commandInvokesWhitelistedHelper(command)) {
    const writesStateFile = STATE_FILE_PATTERNS.test(command) && WRITE_PATTERNS.test(command);
    if (writesStateFile && (writeInNonHelperSegment(command) || hasCommandSubstitution(command))) {
      return BLOCK;
    }
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
