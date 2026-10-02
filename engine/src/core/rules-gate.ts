/**
 * Rules gate — the Loom rules/skills must be IN CONTEXT before code is written.
 *
 * One decision for every harness (Claude Code hook, Pi extension). Functional
 * core: the session's evidence as harness-neutral `TranscriptEvent`s and a
 * handful of filesystem facts go in, a `GateDecision` comes out. All I/O is
 * behind `GatePorts`; each harness adapter owns it.
 *
 * Four checks, in order:
 *  1. RULES/SKILLS IN CONTEXT — a completed `Read` of each required rule, and
 *     for each required skill either a completed `Skill` call / user skill
 *     command, OR a full read of the skill's own `SKILL.md`. The read path is
 *     what makes the requirement satisfiable on Pi, which has no Skill tool.
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
 * The gate proves context and articulation, never genuine adherence. The block
 * text names the loading mechanism of the harness that asked (`GateHarness`).
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

/** Where the gate's required material lives: `<rulesDir>/<rule>` and `<skillsDir>/<skill>/SKILL.md`. */
export type GateDirs = Readonly<{ rulesDir: string; skillsDir: string }>;

/**
 * One thing that must be in context. Each kind names exactly the evidence that
 * satisfies it — paths are canonical (`GatePorts.canonicalPath`).
 */
export type Requirement =
  /** A rule file, read in full. */
  | Readonly<{ kind: "rule"; path: string; why: string }>
  /** A skill, loaded by the harness (Skill tool / skill command) or by a full
   *  read of `skillFile` — `null` when the SKILL.md is not on disk. */
  | Readonly<{ kind: "skill"; name: string; skillFile: string | null; why: string }>
  /** The existing file being changed, read in full or written earlier this session. */
  | Readonly<{ kind: "target"; path: string; why: string }>;

export function requirementsFor(targetPath: string, dirs: GateDirs, ports: GatePorts): readonly Requirement[] {
  const ext = extname(targetPath).toLowerCase();
  if (!CODE_EXTENSIONS.has(ext)) return [];

  const existing = (raw: string): string | null => {
    const path = ports.canonicalPath(raw);
    return ports.exists(path) ? path : null;
  };
  const ruleRequirement = (rule: string, why: string): readonly Requirement[] => {
    const path = existing(join(dirs.rulesDir, rule));
    return path === null ? [] : [{ kind: "rule", path, why }];
  };
  const languageRule = EXTENSION_TO_RULE[ext];
  const target = existing(targetPath);

  return [
    ...ALWAYS_REQUIRED_RULES.flatMap((rule) => ruleRequirement(rule, `rule ${rule} — required for all code (CLAUDE.md)`)),
    ...(languageRule === undefined ? [] : ruleRequirement(languageRule, `rule ${languageRule} — language patterns for ${ext} files`)),
    ...REQUIRED_SKILLS.map((name): Requirement => ({
      kind: "skill",
      name,
      skillFile: existing(join(dirs.skillsDir, name, "SKILL.md")),
      why: `skill "${name}" — CLAUDE.md: load Loom skills when implementing code`,
    })),
    ...(target === null
      ? []
      : [{
          kind: "target",
          path: target,
          why: "target file in context — the file being edited must have been read in full (or written earlier this session) before it is changed",
        } satisfies Requirement]),
  ];
}

const isSatisfied = (r: Requirement, evidence: Evidence): boolean => {
  switch (r.kind) {
    case "rule":
      return evidence.fullyReadPaths.has(r.path);
    case "skill":
      return evidence.loadedSkills.has(r.name) || (r.skillFile !== null && evidence.fullyReadPaths.has(r.skillFile));
    case "target":
      return evidence.writtenPaths.has(r.path) || evidence.fullyReadPaths.has(r.path);
  }
};

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
  dirs: GateDirs;
}>;

/** The assistant message that carries tool call `callId`, if it is in the transcript yet. */
type ToolCallEvent = Exclude<TranscriptEvent, { kind: "result" | "text" | "skill-command" }>;
const isToolCall = (e: TranscriptEvent): e is ToolCallEvent =>
  e.kind !== "result" && e.kind !== "text" && e.kind !== "skill-command";

const messageIdOfCall = (events: readonly TranscriptEvent[], callId: string | undefined): string | undefined =>
  events.filter(isToolCall).find((e) => e.callId === callId)?.messageId;

export function decideRulesGate(query: GateQuery, ports: GatePorts): GateDecision {
  const requirements = requirementsFor(query.target, query.dirs, ports);
  if (requirements.length === 0) return { kind: "allow" };

  const evidence = collectEvidence(query.events, ports, messageIdOfCall(query.events, query.pendingCallId));
  const missing = requirements.filter((r) => !isSatisfied(r, evidence));
  if (missing.length > 0) return { kind: "missing-context", missing };
  return evidence.adherenceStated ? { kind: "allow" } : { kind: "missing-marker" };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The harness asking: decides which loading mechanism the block text names. */
export type GateHarness = "claude-code" | "pi";

type HarnessVocabulary = Readonly<{
  /** How rules (and SKILL.md files) are loaded. */
  readTool: string;
  /** The ways this harness loads a skill, given its SKILL.md path when on disk. */
  loadSkill: (name: string, skillFile: string | null) => string;
}>;

const VOCABULARY: Readonly<Record<GateHarness, HarnessVocabulary>> = {
  "claude-code": {
    readTool: "the Read tool",
    loadSkill: (name, skillFile) =>
      `invoke the Skill tool with "${name}"${skillFile === null ? "" : `, or Read ${skillFile} in full`}`,
  },
  pi: {
    // Pi has no Skill tool: the agent reads SKILL.md itself; only the user can run `/skill:<name>`.
    readTool: "the read tool",
    loadSkill: (name, skillFile) =>
      skillFile === null
        ? `ask the user to run /skill:${name}`
        : `read ${skillFile} in full (or ask the user to run /skill:${name})`,
  },
};

const requirementLine = (vocabulary: HarnessVocabulary) => (r: Requirement, index: number): string => {
  const subject = r.kind === "skill" ? `skill:${r.name} — ${vocabulary.loadSkill(r.name, r.skillFile)}` : r.path;
  return `  ${index + 1}. ${subject}   (${r.why})`;
};

export function renderGateBlock(
  decision: Exclude<GateDecision, { kind: "allow" }>,
  action: string,
  harness: GateHarness,
): string {
  const vocabulary = VOCABULARY[harness];
  return decision.kind === "missing-context"
    ? `BLOCKED by loom-rules-gate: you are about to ${action}, but the required Loom rules/skills are not in your current context.\n` +
        `Load each of these (rules with ${vocabulary.readTool}; skills as listed), THEN retry the same operation:\n` +
        decision.missing.map(requirementLine(vocabulary)).join("\n") +
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
