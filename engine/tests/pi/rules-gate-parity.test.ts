/**
 * One scenario matrix, two harness adapters, ONE decision. Each scenario is a
 * harness-neutral list of steps rendered both as a Claude Code transcript
 * (JSONL → claude-transcript-events) and as Pi context entries
 * (→ piContextEvents). Both must reach the same `GateDecision` from the shared
 * core — drift in either adapter fails here.
 */
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { decideRulesGate, type GatePorts, type GateDecision } from "../../src/core/rules-gate";
import { parseTranscriptEvents } from "../../src/handlers/pre-tool-use/claude-transcript-events";
import { piContextEvents } from "../../../pi/rules-gate";

const DIRS = { rulesDir: "/rules", skillsDir: "/skills" };
const ARCH = "/rules/architecture.md";
const TS_RULES = "/rules/typescript-patterns.md";
const DEEPEN_SKILL = "/skills/deepen/SKILL.md";
const DISTILL_SKILL = "/skills/distill/SKILL.md";
const TARGET = "/repo/src/a.ts";
const files: Record<string, number> = { [ARCH]: 477, [TS_RULES]: 247, [DEEPEN_SKILL]: 215, [DISTILL_SKILL]: 120, [TARGET]: 40 };
const ports: GatePorts = {
  canonicalPath: (raw) => raw,
  lineCount: (p) => files[p] ?? Number.POSITIVE_INFINITY,
  exists: (p) => p in files,
};

type Step =
  | { kind: "read"; path: string; offset?: number; limit?: number; failed?: true; pending?: true }
  | { kind: "skill"; name: string }
  | { kind: "write"; path: string }
  | { kind: "text"; text: string }
  | { kind: "slash"; name: string }
  | { kind: "shell"; command: string; failed?: true }
  | { kind: "compact" };

const MARKER: Step = { kind: "text", text: "LOOM: applying architecture.md — FC/IS: pure core" };
const FULL: Step[] = [
  { kind: "read", path: ARCH }, { kind: "read", path: TS_RULES },
  { kind: "skill", name: "loom:deepen" }, { kind: "skill", name: "loom:distill" },
  { kind: "read", path: TARGET }, MARKER,
];
const SHELL_MARKER = ": 'LOOM: applying architecture.md — FC/IS: pure core'";
const without =(steps: Step[], pred: (s: Step) => boolean): Step[] => steps.filter((s) => !pred(s));

// --- Claude Code rendering -------------------------------------------------
const claudeJsonl = (steps: Step[]): string =>
  steps.flatMap((s, i): string[] => {
    const id = `c${i}`;
    const msg = (content: unknown[]): string => JSON.stringify({ type: "assistant", message: { id: `m${i}`, content } });
    const res = (isError?: true): string =>
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, ...(isError ? { is_error: true } : {}) }] } });
    switch (s.kind) {
      case "read": {
        const input = { file_path: s.path, ...(s.offset ? { offset: s.offset } : {}), ...(s.limit ? { limit: s.limit } : {}) };
        return [msg([{ type: "tool_use", id, name: "Read", input }]), ...(s.pending ? [] : [res(s.failed)])];
      }
      case "skill": return [msg([{ type: "tool_use", id, name: "Skill", input: { skill: s.name } }]), res()];
      case "write": return [msg([{ type: "tool_use", id, name: "Write", input: { file_path: s.path } }]), res()];
      case "text": return [msg([{ type: "text", text: s.text }])];
      case "slash": return [JSON.stringify({ type: "user", message: { content: `<command-name>/${s.name}</command-name>` } })];
      case "shell": return [msg([{ type: "tool_use", id, name: "Bash", input: { command: s.command } }]), res(s.failed)];
      case "compact": return [JSON.stringify({ type: "system", subtype: "compact_boundary" })];
    }
  }).join("\n");

// --- Pi rendering ----------------------------------------------------------
const piEntries = (steps: Step[]): SessionEntry[] => {
  const lastCompact = steps.map((s) => s.kind).lastIndexOf("compact");
  return steps.slice(lastCompact + 1).flatMap((s, i): unknown[] => {
    const id = `p${i}`;
    const asst = (content: unknown[]) => ({ type: "message", id: `e${i}`, message: { role: "assistant", content } });
    const res = (isError?: true) => ({ type: "message", id: `r${i}`, message: { role: "toolResult", toolCallId: id, isError: isError === true } });
    switch (s.kind) {
      case "read": {
        const args = { path: s.path, ...(s.offset ? { offset: s.offset } : {}), ...(s.limit ? { limit: s.limit } : {}) };
        return [asst([{ type: "toolCall", id, name: "read", arguments: args }]), ...(s.pending ? [] : [res(s.failed)])];
      }
      // In Pi the skill arrives as a <skill> block in a user message.
      case "skill": return [{ type: "message", id: `u${i}`, message: { role: "user", content: `<skill name="${s.name.split(":").pop()}" location="/x/SKILL.md">…</skill>` } }];
      case "write": return [asst([{ type: "toolCall", id, name: "write", arguments: { path: s.path } }]), res()];
      case "text": return [asst([{ type: "text", text: s.text }])];
      case "slash": return [{ type: "message", id: `u${i}`, message: { role: "user", content: `<skill name="${s.name.split(":").pop()}" location="/x/SKILL.md">…</skill>` } }];
      case "shell": return [asst([{ type: "toolCall", id, name: "bash", arguments: { command: s.command } }]), res(s.failed)];
      case "compact": return [];
    }
  }) as SessionEntry[];
};

const claudeDecision = (steps: Step[]): GateDecision =>
  decideRulesGate({ target: TARGET, events: parseTranscriptEvents(claudeJsonl(steps)), pendingCallId: "edit-1", dirs: DIRS }, ports);
const piDecision = (steps: Step[]): GateDecision =>
  decideRulesGate({ target: TARGET, events: piContextEvents(piEntries(steps)), pendingCallId: "edit-1", dirs: DIRS }, ports);

const scenarios: ReadonlyArray<readonly [string, Step[], GateDecision["kind"]]> = [
  ["full context", FULL, "allow"],
  ["empty context", [], "missing-context"],
  ["partial rule read", [{ kind: "read", path: ARCH, limit: 60 }, ...without(FULL, (s) => s.kind === "read" && s.path === ARCH)], "missing-context"],
  ["rule read in complete slices", [{ kind: "read", path: ARCH, offset: 1, limit: 300 }, { kind: "read", path: ARCH, offset: 301, limit: 300 }, ...without(FULL, (s) => s.kind === "read" && s.path === ARCH)], "allow"],
  ["failed rule read", [{ kind: "read", path: ARCH, failed: true }, ...without(FULL, (s) => s.kind === "read" && s.path === ARCH)], "missing-context"],
  ["rule read with no result yet", [{ kind: "read", path: ARCH, pending: true }, ...without(FULL, (s) => s.kind === "read" && s.path === ARCH)], "missing-context"],
  ["target created by earlier write", [{ kind: "write", path: TARGET }, ...without(FULL, (s) => s.kind === "read" && s.path === TARGET)], "allow"],
  // Pi has no Skill tool: reading the SKILL.md in full is how a Pi agent loads a skill.
  ["skills via full SKILL.md reads", [{ kind: "read", path: DEEPEN_SKILL }, { kind: "read", path: DISTILL_SKILL }, ...without(FULL, (s) => s.kind === "skill")], "allow"],
  ["skill via SKILL.md read in complete slices", [{ kind: "read", path: DEEPEN_SKILL, offset: 1, limit: 100 }, { kind: "read", path: DEEPEN_SKILL, offset: 101, limit: 200 }, ...without(FULL, (s) => s.kind === "skill" && s.name === "loom:deepen")], "allow"],
  ["partial SKILL.md read", [{ kind: "read", path: DEEPEN_SKILL, limit: 40 }, ...without(FULL, (s) => s.kind === "skill" && s.name === "loom:deepen")], "missing-context"],
  ["skill via slash command", [{ kind: "slash", name: "loom:deepen" }, ...without(FULL, (s) => s.kind === "skill" && s.name === "loom:deepen")], "allow"],
  ["missing marker", without(FULL, (s) => s === MARKER), "missing-marker"],
  ["marker names no rule", [...without(FULL, (s) => s === MARKER), { kind: "text", text: "LOOM: applying good vibes" }], "missing-marker"],
  ["marker via completed shell command", [...without(FULL, (s) => s === MARKER), { kind: "shell", command: SHELL_MARKER }], "allow"],
  ["marker via failed shell command", [...without(FULL, (s) => s === MARKER), { kind: "shell", command: SHELL_MARKER, failed: true }], "missing-marker"],
  ["evidence before compaction is discarded", [...FULL, { kind: "compact" }], "missing-context"],
  ["evidence re-established after compaction", [...FULL, { kind: "compact" }, ...FULL], "allow"],
];

describe("rules gate — Claude Code and Pi adapters agree", () => {
  it.each(scenarios)("%s", (_name, steps, expected) => {
    const claude = claudeDecision(steps);
    const pi = piDecision(steps);
    expect(claude.kind).toBe(expected);
    expect(pi).toEqual(claude);
  });
});
