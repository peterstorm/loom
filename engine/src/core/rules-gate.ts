/**
 * Rules gate — the Loom rules/skills must be IN CONTEXT before code is written.
 *
 * One decision for every harness (Claude Code hook, Pi extension). Functional
 * core: the session's evidence as harness-neutral `TranscriptEvent`s and a
 * handful of filesystem facts go in, a `GateDecision` comes out. All I/O is
 * behind `GatePorts`; each harness adapter owns it.
 *
 * Four checks, in order:
 *  1. RULES/SKILLS IN CONTEXT — a completed `Read` of each required rule, and a
 *     completed `Skill` call (or a user slash command) for each required skill.
 *     A read issued in the SAME assistant message as the gated call does not
 *     count: the model generated the code without having seen the file.
 *  2. FULL READS ONLY — a read with `limit` covers only [offset, offset+limit).
 *     Coverage across all completed reads must reach end of file.
 *  3. TARGET FILE KNOWN — an existing target must have been fully read, or
 *     written by this session earlier (search before writing).
 *  4. ADHERENCE STATED — an assistant text `LOOM: applying <rule|skill> — <how>`
 *     naming a required rule or skill. The gate proves the marker exists; the
 *     substance is part of the work and is judged in review.
 *
 * Evidence is whatever survives the LAST compaction boundary — after compaction
 * the rules are out of the model's context, so they must be read and stated again.
 *
 * The gate proves context and articulation, never genuine adherence.
 */

import { extname, join } from "node:path";
import { CODE_EXTENSIONS } from "./bash-code-mutation";

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Rule required before ANY code edit. */
export const ALWAYS_REQUIRED_RULES: readonly string[] = ["architecture.md"];

/** Language rule required per target-file extension. */
const EXTENSION_TO_RULE: Readonly<Record<string, string>> = {
  ".ts": "typescript-patterns.md",
  ".tsx": "typescript-patterns.md",
  ".js": "typescript-patterns.md",
  ".jsx": "typescript-patterns.md",
  ".mjs": "typescript-patterns.md",
  ".cjs": "typescript-patterns.md",
  ".mts": "typescript-patterns.md",
  ".cts": "typescript-patterns.md",
  ".java": "java-patterns.md",
  ".rs": "rust-patterns.md",
};

/** Skills the orchestrator must have loaded before implementing code. */
export const REQUIRED_SKILLS: readonly string[] = ["deepen", "distill"];

/** The Read tool truncates output at this many lines. */
export const READ_TOOL_MAX_LINES = 2000;

const ADHERENCE_RE = /\bLOOM:\s*applying\b/i;
const RULE_NAME_RE =
  /\b(architecture|typescript-patterns|java-patterns|rust-patterns|property-testing|deepen|distill)\b/i;
const ADHERENCE_WINDOW = 300;

// ---------------------------------------------------------------------------
// Transcript events — the harness-neutral evidence vocabulary (each harness adapter maps into it)
// ---------------------------------------------------------------------------

export type TranscriptEvent =
  | Readonly<{ kind: "read"; callId: string; messageId: string; path: string; offset: number; limit: number }>
  | Readonly<{ kind: "write"; callId: string; messageId: string; path: string }>
  | Readonly<{ kind: "skill"; callId: string; messageId: string; name: string }>
  | Readonly<{ kind: "other-call"; callId: string; messageId: string }>
  | Readonly<{ kind: "result"; callId: string; ok: boolean }>
  | Readonly<{ kind: "text"; messageId: string; text: string }>
  | Readonly<{ kind: "skill-command"; name: string }>;

// ---------------------------------------------------------------------------
// Ports — every filesystem fact the decision needs
// ---------------------------------------------------------------------------

export type GatePorts = Readonly<{
  /** Absolute, symlink-resolved form of a raw path (~, relative-to-cwd, realpath). */
  canonicalPath: (raw: string) => string;
  /** Number of lines in the file; `Infinity` when unreadable (coverage can never complete). */
  lineCount: (canonical: string) => number;
  exists: (canonical: string) => boolean;
}>;

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export type Evidence = Readonly<{
  fullyReadPaths: ReadonlySet<string>;
  writtenPaths: ReadonlySet<string>;
  loadedSkills: ReadonlySet<string>;
  adherenceStated: boolean;
}>;

type LineRange = readonly [start: number, endExclusive: number];

/** True when half-open line ranges cover every line 1..lineCount. */
export function coveredInFull(ranges: readonly LineRange[], lineCount: number): boolean {
  if (lineCount === Number.POSITIVE_INFINITY) return false;
  if (lineCount <= 0) return true;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let nextUncovered = 1;
  for (const [start, end] of sorted) {
    if (start > nextUncovered) return false;
    nextUncovered = Math.max(nextUncovered, end);
  }
  return nextUncovered > lineCount;
}

const statesAdherence = (text: string): boolean => {
  const marker = ADHERENCE_RE.exec(text);
  return marker !== null && RULE_NAME_RE.test(text.slice(marker.index, marker.index + ADHERENCE_WINDOW));
};

/**
 * What the model can currently see. `pendingMessageId` is the assistant message
 * carrying the gated call: reads and skill loads issued in it do not count.
 */
export function collectEvidence(
  events: readonly TranscriptEvent[],
  ports: GatePorts,
  pendingMessageId: string | undefined,
): Evidence {
  const completed = new Set(events.flatMap((e) => (e.kind === "result" && e.ok ? [e.callId] : [])));
  const counts = (e: { callId: string; messageId: string }): boolean =>
    completed.has(e.callId) && e.messageId !== pendingMessageId;

  const rangesByPath = new Map<string, readonly LineRange[]>();
  for (const e of events) {
    if (e.kind !== "read" || !counts(e)) continue;
    const path = ports.canonicalPath(e.path);
    rangesByPath.set(path, [...(rangesByPath.get(path) ?? []), [e.offset, e.offset + e.limit]]);
  }

  return {
    fullyReadPaths: new Set(
      [...rangesByPath].filter(([path, ranges]) => coveredInFull(ranges, ports.lineCount(path))).map(([path]) => path),
    ),
    writtenPaths: new Set(
      events.flatMap((e) => (e.kind === "write" && completed.has(e.callId) ? [ports.canonicalPath(e.path)] : [])),
    ),
    loadedSkills: new Set(
      events.flatMap((e) =>
        e.kind === "skill-command" ? [e.name] : e.kind === "skill" && counts(e) ? [e.name] : [],
      ),
    ),
    adherenceStated: events.some((e) => e.kind === "text" && statesAdherence(e.text)),
  };
}

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

export type Requirement = Readonly<{
  /** Canonical paths; ANY one fully-read path satisfies the requirement. */
  paths: readonly string[];
  /** A loaded skill of this name also satisfies the requirement. */
  skillName?: string;
  /** A prior successful write to the path also satisfies the requirement. */
  writable?: boolean;
  why: string;
}>;

export function requirementsFor(targetPath: string, rulesDir: string, ports: GatePorts): readonly Requirement[] {
  const ext = extname(targetPath).toLowerCase();
  if (!CODE_EXTENSIONS.has(ext)) return [];

  const ruleRequirement = (rule: string, why: string): readonly Requirement[] => {
    const path = ports.canonicalPath(join(rulesDir, rule));
    return ports.exists(path) ? [{ paths: [path], why }] : [];
  };
  const languageRule = EXTENSION_TO_RULE[ext];
  const target = ports.canonicalPath(targetPath);

  return [
    ...ALWAYS_REQUIRED_RULES.flatMap((rule) => ruleRequirement(rule, `rule ${rule} — required for all code (CLAUDE.md)`)),
    ...(languageRule === undefined ? [] : ruleRequirement(languageRule, `rule ${languageRule} — language patterns for ${ext} files`)),
    ...REQUIRED_SKILLS.map((skill): Requirement => ({
      // Skills are plugin-provided: the Skill tool is the only way to load one,
      // so the requirement names no file path.
      paths: [],
      skillName: skill,
      why: `skill "${skill}" — CLAUDE.md: load Loom skills when implementing code (invoke it with the Skill tool)`,
    })),
    ...(ports.exists(target)
      ? [{
          paths: [target],
          writable: true,
          why: "target file in context — the file being edited must have been read in full (or written earlier this session) before it is changed",
        } satisfies Requirement]
      : []),
  ];
}

const isSatisfied = (r: Requirement, evidence: Evidence): boolean =>
  (r.writable === true && r.paths.some((p) => evidence.writtenPaths.has(p))) ||
  r.paths.some((p) => evidence.fullyReadPaths.has(p)) ||
  (r.skillName !== undefined && evidence.loadedSkills.has(r.skillName));

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type GateDecision =
  | Readonly<{ kind: "allow" }>
  | Readonly<{ kind: "missing-context"; missing: readonly Requirement[] }>
  | Readonly<{ kind: "missing-marker" }>;

export type GateQuery = Readonly<{
  /** Raw path the gated call would write. */
  target: string;
  /** The evidence the model can currently see, in the harness-neutral vocabulary. */
  events: readonly TranscriptEvent[];
  /** `tool_use_id` of the gated call, to exclude evidence from its own message. */
  pendingCallId: string | undefined;
  rulesDir: string;
}>;

/** The assistant message that carries tool call `callId`, if it is in the transcript yet. */
type ToolCallEvent = Exclude<TranscriptEvent, { kind: "result" | "text" | "skill-command" }>;
const isToolCall = (e: TranscriptEvent): e is ToolCallEvent =>
  e.kind !== "result" && e.kind !== "text" && e.kind !== "skill-command";

const messageIdOfCall = (events: readonly TranscriptEvent[], callId: string | undefined): string | undefined =>
  events.filter(isToolCall).find((e) => e.callId === callId)?.messageId;

export function decideRulesGate(query: GateQuery, ports: GatePorts): GateDecision {
  const requirements = requirementsFor(query.target, query.rulesDir, ports);
  if (requirements.length === 0) return { kind: "allow" };

  const evidence = collectEvidence(query.events, ports, messageIdOfCall(query.events, query.pendingCallId));
  const missing = requirements.filter((r) => !isSatisfied(r, evidence));
  if (missing.length > 0) return { kind: "missing-context", missing };
  return evidence.adherenceStated ? { kind: "allow" } : { kind: "missing-marker" };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const requirementLine = (r: Requirement, index: number): string =>
  `  ${index + 1}. ${r.paths[0] ?? `skill:${r.skillName ?? "?"}`}   (${r.why})`;

export function renderGateBlock(decision: Exclude<GateDecision, { kind: "allow" }>, action: string): string {
  return decision.kind === "missing-context"
    ? `BLOCKED by loom-rules-gate: you are about to ${action}, but the required Loom rules/skills are not in your current context.\n` +
        `Load each of these (rules with the Read tool, skills with the Skill tool), THEN retry the same operation:\n` +
        decision.missing.map(requirementLine).join("\n") +
        `\nNotes: loads must have completed before this operation (one in the same message does not count). ` +
        `Partial reads (with a \`limit\`) do NOT count — the file must be covered in full; ` +
        `use \`offset\` reads for files longer than ${READ_TOOL_MAX_LINES} lines. ` +
        `If the target file exists and you have not read it fully, read it first. ` +
        `Evidence resets at context compaction.`
    : `BLOCKED by loom-rules-gate: no adherence marker in context for ${action}.\n` +
        `State in a short text line which rule/skill applies to this change and the specific principle it honors, e.g.:\n` +
        `  LOOM: applying architecture.md — FC/IS: extraction stays pure, Either at the boundary\n` +
        `(must name at least one of: architecture, typescript-patterns, java-patterns, rust-patterns, ` +
        `property-testing, deepen, distill — then retry). Once per context window is enough.`;
}
