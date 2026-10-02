/**
 * rules-gate handler — the shell around the pure core: payload parsing,
 * subagent/escape-hatch exemptions, fail-closed behaviour, and the real
 * filesystem adapter (symlink resolution, line counting) against temp files.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import handler, { filesystemPorts, gateDirs } from "../../../src/handlers/pre-tool-use/rules-gate";
import { REQUIRED_SKILLS } from "../../../src/core/rules-gate";

let dir: string;
let rules: string;
let skills: string;
let target: string;
let transcript: string;

const line = (o: unknown): string => JSON.stringify(o);
const use = (m: string, id: string, name: string, input: Record<string, unknown>): string =>
  line({ type: "assistant", message: { id: m, content: [{ type: "tool_use", id, name, input }] } });
const ok = (id: string): string =>
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id }] } });

const skillTool = (): string[] => [
  use("m3", "s1", "Skill", { skill: "loom:deepen" }), ok("s1"),
  use("m4", "s2", "Skill", { skill: "loom:distill" }), ok("s2"),
];
const skillFileReads = (): string[] => [
  use("m3", "s1", "Read", { file_path: join(skills, "deepen", "SKILL.md") }), ok("s1"),
  use("m4", "s2", "Read", { file_path: join(skills, "distill", "SKILL.md") }), ok("s2"),
];

const fullTranscript = (skillLoads: () => string[] = skillTool): string => [
  use("m1", "r1", "Read", { file_path: join(rules, "architecture.md") }), ok("r1"),
  use("m2", "r2", "Read", { file_path: join(rules, "typescript-patterns.md") }), ok("r2"),
  ...skillLoads(),
  use("m5", "r3", "Read", { file_path: target }), ok("r3"),
  line({ type: "assistant", message: { id: "m6", content: [{ type: "text", text: "LOOM: applying architecture.md — pure core" }] } }),
].join("\n");

const payload = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    session_id: "s", tool_name: "Edit", tool_input: { file_path: target }, tool_use_id: "edit-1",
    transcript_path: transcript, cwd: dir, ...over,
  });

const savedEnv = { gate: process.env["LOOM_GATE"], rules: process.env["LOOM_RULES_DIR"], skills: process.env["LOOM_SKILLS_DIR"] };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rules-gate-"));
  rules = join(dir, "rules");
  mkdirSync(rules);
  writeFileSync(join(rules, "architecture.md"), "a\nb\nc\n");
  writeFileSync(join(rules, "typescript-patterns.md"), "x\ny\n");
  skills = join(dir, "skills");
  for (const name of ["deepen", "distill"]) {
    mkdirSync(join(skills, name), { recursive: true });
    writeFileSync(join(skills, name, "SKILL.md"), `# ${name}\nstep one\nstep two\n`);
  }
  target = join(dir, "src.ts");
  writeFileSync(target, "export const a = 1;\n");
  transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, fullTranscript());
  process.env["LOOM_RULES_DIR"] = rules;
  process.env["LOOM_SKILLS_DIR"] = skills;
  delete process.env["LOOM_GATE"];
});
afterEach(() => {
  delete process.env["LOOM_GATE"];
  writeFileSync(transcript, fullTranscript());
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of [["LOOM_GATE", savedEnv.gate], ["LOOM_RULES_DIR", savedEnv.rules], ["LOOM_SKILLS_DIR", savedEnv.skills]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe("rules-gate handler", () => {
  it("passes a code edit when the full context is in the transcript", async () => {
    expect((await handler(payload(), [])).kind).toBe("passthrough");
  });

  it("blocks a code edit on an empty transcript and names the missing rule", async () => {
    writeFileSync(transcript, "");
    const r = await handler(payload(), []);
    expect(r.kind).toBe("block");
    expect(r.kind === "block" && r.message).toContain("architecture.md");
  });

  it("passes when the skills were loaded by full Reads of their SKILL.md instead of the Skill tool", async () => {
    writeFileSync(transcript, fullTranscript(skillFileReads));
    expect((await handler(payload(), [])).kind).toBe("passthrough");
  });

  it("names the Skill tool and the SKILL.md read alternative in a Claude Code block", async () => {
    writeFileSync(transcript, "");
    const r = await handler(payload(), []);
    expect(r.kind === "block" && r.message).toContain(`invoke the Skill tool with "deepen", or Read ${join(skills, "deepen", "SKILL.md")} in full`);
  });

  it("passes non-code targets and non-mutating tools without reading the transcript", async () => {
    writeFileSync(transcript, "");
    expect((await handler(payload({ tool_input: { file_path: join(dir, "notes.md") } }), [])).kind).toBe("passthrough");
    expect((await handler(payload({ tool_name: "Read" }), [])).kind).toBe("passthrough");
    expect((await handler(payload({ tool_name: "Bash", tool_input: { command: "ls -la" } }), [])).kind).toBe("passthrough");
  });

  it("gates a Bash redirect into a code file", async () => {
    writeFileSync(transcript, "");
    const r = await handler(payload({ tool_name: "Bash", tool_input: { command: `echo x > ${target}` } }), []);
    expect(r.kind).toBe("block");
    expect(r.kind === "block" && r.message).toContain("mutate code files via bash");
  });

  it("exempts subagents", async () => {
    writeFileSync(transcript, "");
    expect((await handler(payload({ agent_id: "agent-1" }), [])).kind).toBe("passthrough");
  });

  it("honours LOOM_GATE=off", async () => {
    writeFileSync(transcript, "");
    process.env["LOOM_GATE"] = "off";
    expect((await handler(payload(), [])).kind).toBe("passthrough");
  });

  it("fails closed on malformed input, a missing transcript_path, and an unreadable transcript", async () => {
    expect((await handler("not json", [])).kind).toBe("block");
    expect((await handler(payload({ transcript_path: undefined }), [])).kind).toBe("block");
    const r = await handler(payload({ transcript_path: join(dir, "missing.jsonl") }), []);
    expect(r.kind).toBe("block");
    expect(r.kind === "block" && r.message).toContain("failing closed");
  });
});

describe("gateDirs", () => {
  it("honours LOOM_RULES_DIR and LOOM_SKILLS_DIR", () => {
    expect(gateDirs()).toEqual({ rulesDir: rules, skillsDir: skills });
  });

  it("defaults to the package's own rules/ and skills/, which ship every required SKILL.md", () => {
    const saved = [process.env["LOOM_RULES_DIR"], process.env["LOOM_SKILLS_DIR"]] as const;
    delete process.env["LOOM_RULES_DIR"];
    delete process.env["LOOM_SKILLS_DIR"];
    try {
      const { rulesDir, skillsDir } = gateDirs();
      const ports = filesystemPorts(dir);
      expect(ports.exists(join(rulesDir, "architecture.md"))).toBe(true);
      // Without these files a Pi agent (no Skill tool) could never satisfy the gate.
      for (const skill of REQUIRED_SKILLS) expect(ports.exists(join(skillsDir, skill, "SKILL.md")), skill).toBe(true);
    } finally {
      process.env["LOOM_RULES_DIR"] = saved[0];
      process.env["LOOM_SKILLS_DIR"] = saved[1];
    }
  });
});

describe("filesystemPorts", () => {
  it("resolves relative paths against cwd and follows symlinks", () => {
    const link = join(dir, "link.ts");
    symlinkSync(target, link);
    const p = filesystemPorts(dir);
    expect(p.canonicalPath("link.ts")).toBe(p.canonicalPath(target));
  });

  it("counts lines without the trailing newline and reports unreadable files as infinite", () => {
    const p = filesystemPorts(dir);
    expect(p.lineCount(join(rules, "architecture.md"))).toBe(3);
    expect(p.lineCount(join(dir, "nope"))).toBe(Number.POSITIVE_INFINITY);
  });
});
