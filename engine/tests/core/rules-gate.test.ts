/**
 * decideRulesGate — the pure core. Filesystem facts arrive through fake ports,
 * the session through a hand-built Claude Code transcript.
 */
import { describe, expect, it } from "vitest";
import { coveredInFull, decideRulesGate, renderGateBlock, type GatePorts } from "../../src/core/rules-gate";
import { parseTranscriptEvents } from "../../src/handlers/pre-tool-use/claude-transcript-events";

const RULES = "/rules";
const ARCH = "/rules/architecture.md";
const TS_RULES = "/rules/typescript-patterns.md";
const TARGET = "/repo/src/a.ts";

const files: Record<string, number> = { [ARCH]: 477, [TS_RULES]: 247, [TARGET]: 40 };
const ports: GatePorts = {
  canonicalPath: (raw) => raw,
  lineCount: (p) => files[p] ?? Number.POSITIVE_INFINITY,
  exists: (p) => p in files,
};

// --- transcript builders ---------------------------------------------------
const line = (o: unknown): string => JSON.stringify(o);
const toolUse = (messageId: string, id: string, name: string, input: Record<string, unknown>): string =>
  line({ type: "assistant", message: { id: messageId, content: [{ type: "tool_use", id, name, input }] } });
const text = (messageId: string, t: string): string =>
  line({ type: "assistant", message: { id: messageId, content: [{ type: "text", text: t }] } });
const result = (id: string, isError?: true): string =>
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, ...(isError ? { is_error: true } : {}) }] } });
const boundary = (): string => line({ type: "system", subtype: "compact_boundary" });
const read = (m: string, id: string, path: string, extra: Record<string, unknown> = {}): string[] => [
  toolUse(m, id, "Read", { file_path: path, ...extra }),
  result(id),
];
const skill = (m: string, id: string, name: string): string[] => [toolUse(m, id, "Skill", { skill: name }), result(id)];
const MARKER = text("mk", "LOOM: applying architecture.md — FC/IS: pure core");

const fullContext = (): string[] => [
  ...read("m1", "r1", ARCH),
  ...read("m2", "r2", TS_RULES),
  ...skill("m3", "s1", "loom:deepen"),
  ...skill("m4", "s2", "loom:distill"),
  ...read("m5", "r3", TARGET),
  MARKER,
];

const decide = (lines: readonly string[], pendingCallId = "edit-1") =>
  decideRulesGate({ target: TARGET, events: parseTranscriptEvents(lines.join("\n")), pendingCallId, rulesDir: RULES }, ports);

describe("decideRulesGate", () => {
  it("allows when rules, skills, target and marker are all in context", () => {
    expect(decide(fullContext())).toEqual({ kind: "allow" });
  });

  it("does not gate non-code targets", () => {
    const d = decideRulesGate({ target: "/repo/README.md", events: [], pendingCallId: undefined, rulesDir: RULES }, ports);
    expect(d).toEqual({ kind: "allow" });
  });

  it("lists every missing requirement on an empty transcript", () => {
    const d = decide([]);
    expect(d.kind).toBe("missing-context");
    if (d.kind !== "missing-context") return;
    expect(d.missing.map((r) => r.skillName ?? r.paths[0])).toEqual([ARCH, TS_RULES, "deepen", "distill", TARGET]);
  });

  it("rejects a partial read of a rule (limit skim)", () => {
    const lines = fullContext().filter((l) => !l.includes('"r1"'));
    const d = decide([...read("m1", "r1", ARCH, { limit: 60 }), ...lines]);
    expect(d.kind).toBe("missing-context");
  });

  it("accepts a rule read in complete offset slices", () => {
    const lines = fullContext().filter((l) => !l.includes('"r1"'));
    const d = decide([...read("a", "ra", ARCH, { offset: 1, limit: 300 }), ...read("b", "rb", ARCH, { offset: 301, limit: 300 }), ...lines]);
    expect(d).toEqual({ kind: "allow" });
  });

  it("rejects a read whose result errored", () => {
    const lines = fullContext().filter((l) => !l.includes('"r1"'));
    const d = decide([toolUse("m1", "r1", "Read", { file_path: ARCH }), result("r1", true), ...lines]);
    expect(d.kind).toBe("missing-context");
  });

  it("rejects a read with no result yet", () => {
    const lines = fullContext().filter((l) => !l.includes('"r1"'));
    expect(decide([toolUse("m1", "r1", "Read", { file_path: ARCH }), ...lines]).kind).toBe("missing-context");
  });

  it("does not count a read issued in the same assistant message as the gated call", () => {
    const lines = fullContext().filter((l) => !l.includes('"r3"'));
    const sameMessage = [...read("pending", "r3", TARGET), toolUse("pending", "edit-1", "Edit", { file_path: TARGET })];
    expect(decide([...lines, ...sameMessage]).kind).toBe("missing-context");
  });

  it("accepts a target created by an earlier successful Write", () => {
    const lines = fullContext().filter((l) => !l.includes('"r3"'));
    const d = decide([...lines, toolUse("w", "w1", "Write", { file_path: TARGET }), result("w1")]);
    expect(d).toEqual({ kind: "allow" });
  });

  it("accepts a skill loaded by the user's slash command", () => {
    const lines = fullContext().filter((l) => !l.includes('"s1"'));
    const command = line({ type: "user", message: { content: "<command-name>/loom:deepen</command-name>" } });
    expect(decide([command, ...lines])).toEqual({ kind: "allow" });
  });

  it("requires the adherence marker once everything else is in context", () => {
    expect(decide(fullContext().filter((l) => l !== MARKER))).toEqual({ kind: "missing-marker" });
  });

  it("rejects a marker that names no required rule or skill", () => {
    const vague = text("mk", "LOOM: applying good vibes");
    expect(decide([...fullContext().filter((l) => l !== MARKER), vague])).toEqual({ kind: "missing-marker" });
  });

  it("accepts the marker in the same assistant message as the gated call", () => {
    const lines = fullContext().filter((l) => l !== MARKER);
    expect(decide([...lines, text("pending", "LOOM: applying distill — one move at a time"), toolUse("pending", "edit-1", "Edit", { file_path: TARGET })])).toEqual({ kind: "allow" });
  });

  it("discards all evidence before the last compaction boundary", () => {
    const d = decide([...fullContext(), boundary()]);
    expect(d.kind).toBe("missing-context");
    expect(decide([...fullContext(), boundary(), ...fullContext()])).toEqual({ kind: "allow" });
  });

  it("ignores torn and non-object transcript lines", () => {
    expect(decide(["{\"type\":\"assist", "42", "null", ...fullContext()])).toEqual({ kind: "allow" });
  });

  it("matches the namespace-stripped skill name", () => {
    const events = parseTranscriptEvents(skill("m", "s", "loom:distill").join("\n"));
    expect(events.find((e) => e.kind === "skill")).toMatchObject({ name: "distill" });
  });
});

describe("coveredInFull", () => {
  it("covers a file read in one default-limit read", () => {
    expect(coveredInFull([[1, 2001]], 477)).toBe(true);
  });
  it("rejects a one-line gap", () => {
    expect(coveredInFull([[1, 10], [11, 478]], 477)).toBe(false);
  });
  it("rejects coverage short of the final line", () => {
    expect(coveredInFull([[1, 477]], 477)).toBe(false);
  });
  it("never covers an unreadable file", () => {
    expect(coveredInFull([[1, 2001]], Number.POSITIVE_INFINITY)).toBe(false);
  });
  it("treats an empty file as covered", () => {
    expect(coveredInFull([], 0)).toBe(true);
  });
});

describe("renderGateBlock", () => {
  it("names each missing requirement and the Skill tool for skills", () => {
    const d = decide([]);
    if (d.kind === "allow") throw new Error("expected a block");
    const out = renderGateBlock(d, "edit /repo/src/a.ts");
    expect(out).toContain(ARCH);
    expect(out).toContain("skill:deepen");
    expect(out).toContain("Skill tool");
  });
  it("shows the marker example for a missing marker", () => {
    expect(renderGateBlock({ kind: "missing-marker" }, "edit x")).toContain("LOOM: applying");
  });
});
