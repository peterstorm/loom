import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import validateAgentSkill, {
  parseSkillsFromFrontmatter,
  promptReferencesSkill,
  VALIDATED_AGENTS,
} from "../../../src/handlers/pre-tool-use/validate-agent-skill";
import { TASK_GRAPH_PATH } from "../../../src/config";

const TMP = "/tmp/loom-skill-test-" + process.pid;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

function writeAgent(name: string, frontmatter: string): string {
  const path = join(TMP, `${name}.md`);
  writeFileSync(path, frontmatter);
  return path;
}

describe("parseSkillsFromFrontmatter", () => {
  it("parses single skill", () => {
    const path = writeAgent("test", [
      "---",
      "name: test-agent",
      "model: sonnet",
      "skills:",
      "  - brainstorming",
      "---",
      "",
      "Body text",
    ].join("\n"));
    expect(parseSkillsFromFrontmatter(path)).toEqual({ kind: "skills", names: ["brainstorming"] });
  });

  it("parses multiple skills", () => {
    const path = writeAgent("test", [
      "---",
      "name: test-agent",
      "model: sonnet",
      "skills:",
      "  - code-implementer",
      "  - architecture-tech-lead",
      "---",
    ].join("\n"));
    expect(parseSkillsFromFrontmatter(path)).toEqual({
      kind: "skills",
      names: ["code-implementer", "architecture-tech-lead"],
    });
  });

  it("parses the flow-style skills list too", () => {
    // `skills: [a, b]` is valid YAML and used to parse as "declares no skills",
    // which the handler reads as "nothing to enforce" and allows the spawn.
    const path = writeAgent("test", [
      "---",
      "name: test-agent",
      'skills: [brainstorming, "code-implementer"]',
      "---",
    ].join("\n"));
    expect(parseSkillsFromFrontmatter(path)).toEqual({
      kind: "skills",
      names: ["brainstorming", "code-implementer"],
    });
  });

  it("parses a CRLF file the same as an LF one", () => {
    const path = writeAgent("test", [
      "---",
      "name: test-agent",
      "skills:",
      "  - brainstorming",
      "---",
    ].join("\r\n"));
    expect(parseSkillsFromFrontmatter(path)).toEqual({ kind: "skills", names: ["brainstorming"] });
  });

  it("reports 'none' for a readable agent that declares no skills", () => {
    const path = writeAgent("test", [
      "---",
      "name: test-agent",
      "model: sonnet",
      "---",
    ].join("\n"));
    expect(parseSkillsFromFrontmatter(path)).toEqual({ kind: "none" });
  });

  it("reports 'unreadable' — not 'none' — for a file with no frontmatter", () => {
    // The distinction the union exists for. Both used to be `[]`, and `[]` means
    // "nothing to enforce, allow the spawn" on a fail-closed route.
    const path = writeAgent("test", "Just a body\nNo frontmatter here");
    expect(parseSkillsFromFrontmatter(path).kind).toBe("unreadable");
  });

  it("reports 'unreadable' for a nonexistent file", () => {
    expect(parseSkillsFromFrontmatter("/tmp/nonexistent-agent-file.md").kind).toBe("unreadable");
  });

  it("handles tools field without skills", () => {
    const path = writeAgent("test", [
      "---",
      "name: some-agent",
      "model: sonnet",
      "tools:",
      "  - Skill",
      "  - Bash",
      "---",
    ].join("\n"));
    expect(parseSkillsFromFrontmatter(path)).toEqual({ kind: "none" });
  });

  it("parses skills with trailing whitespace", () => {
    const path = writeAgent("test", [
      "---",
      "name: test-agent",
      "skills:",
      "  - brainstorming  ",
      "---",
    ].join("\n"));
    expect(parseSkillsFromFrontmatter(path)).toEqual({ kind: "skills", names: ["brainstorming"] });
  });
});

describe("promptReferencesSkill", () => {
  it("matches skill name in prose", () => {
    expect(promptReferencesSkill(
      "Follow the process from the preloaded brainstorming skill.",
      "brainstorming",
    )).toBe(true);
  });

  it("matches /skill-name pattern", () => {
    expect(promptReferencesSkill(
      "Use /architecture-tech-lead for design.",
      "architecture-tech-lead",
    )).toBe(true);
  });

  it("matches skill name in template context", () => {
    expect(promptReferencesSkill(
      "You are an implementation specialist. Use the code-implementer skill patterns.",
      "code-implementer",
    )).toBe(true);
  });

  it("case-insensitive matching", () => {
    expect(promptReferencesSkill(
      "Follow the BRAINSTORMING process.",
      "brainstorming",
    )).toBe(true);
  });

  it("returns false when skill not mentioned", () => {
    expect(promptReferencesSkill(
      "Implement the feature following FP patterns.",
      "brainstorming",
    )).toBe(false);
  });

  it("returns false for empty prompt", () => {
    expect(promptReferencesSkill("", "brainstorming")).toBe(false);
  });

  it("matches partial word (skill name embedded)", () => {
    // "nextjs-frontend-design" contains the substring
    expect(promptReferencesSkill(
      "Use nextjs-frontend-design patterns.",
      "nextjs-frontend-design",
    )).toBe(true);
  });
});

describe("validate-agent-skill — integration scenarios", () => {
  it("enforces skill policy for the panel designer", () => {
    expect(VALIDATED_AGENTS.has("arch-designer-agent")).toBe(true);
    expect(promptReferencesSkill("Use the architecture-tech-lead skill.", "architecture-tech-lead")).toBe(true);
    expect(promptReferencesSkill("Design a panel candidate.", "architecture-tech-lead")).toBe(false);
  });

  it("blocks a namespaced panel designer spawn that omits architecture-tech-lead", async () => {
    const createdGraph = !existsSync(TASK_GRAPH_PATH);
    const previousRoot = process.env.CLAUDE_PLUGIN_ROOT;
    if (createdGraph) {
      mkdirSync(dirname(TASK_GRAPH_PATH), { recursive: true });
      writeFileSync(TASK_GRAPH_PATH, "{}");
    }
    process.env.CLAUDE_PLUGIN_ROOT = REPO_ROOT;
    try {
      const result = await validateAgentSkill(JSON.stringify({
        tool_name: "Task",
        tool_input: { subagent_type: "loom:arch-designer-agent", prompt: "Design one panel candidate." },
      }), []);
      expect(result.kind).toBe("block");
      if (result.kind === "block") expect(result.message).toContain("architecture-tech-lead");
    } finally {
      if (previousRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = previousRoot;
      if (createdGraph) rmSync(TASK_GRAPH_PATH, { force: true });
    }
  });

  it("allows a namespaced panel designer spawn with its declared skill", async () => {
    const createdGraph = !existsSync(TASK_GRAPH_PATH);
    const previousRoot = process.env.CLAUDE_PLUGIN_ROOT;
    if (createdGraph) {
      mkdirSync(dirname(TASK_GRAPH_PATH), { recursive: true });
      writeFileSync(TASK_GRAPH_PATH, "{}");
    }
    process.env.CLAUDE_PLUGIN_ROOT = REPO_ROOT;
    try {
      const result = await validateAgentSkill(JSON.stringify({
        tool_name: "Task",
        tool_input: {
          subagent_type: "loom:arch-designer-agent",
          prompt: "Use the architecture-tech-lead skill to design one panel candidate.",
        },
      }), []);
      expect(result.kind).toBe("allow");
    } finally {
      if (previousRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = previousRoot;
      if (createdGraph) rmSync(TASK_GRAPH_PATH, { force: true });
    }
  });

  it("BLOCKS a spawn whose agent file cannot be read — fail closed, not open", async () => {
    // The polarity bug: every parse failure returned `[]`, and `[]` means
    // "declares no skills, nothing to enforce, allow". On a route that is in
    // FAIL_CLOSED_ROUTES — in a handler that already blocks on malformed stdin
    // precisely so a spawn cannot slip through — an unreadable agent file was
    // the one input that let a Task run without its required skill.
    // CLAUDE_PLUGIN_ROOT points somewhere with no agents/ directory, so the
    // resolver finds the repo copy and we shadow it with a broken one.
    const createdGraph = !existsSync(TASK_GRAPH_PATH);
    const previousRoot = process.env.CLAUDE_PLUGIN_ROOT;
    if (createdGraph) {
      mkdirSync(dirname(TASK_GRAPH_PATH), { recursive: true });
      writeFileSync(TASK_GRAPH_PATH, "{}");
    }
    mkdirSync(join(TMP, "agents"), { recursive: true });
    writeFileSync(join(TMP, "agents", "arch-designer-agent.md"), "no frontmatter at all\n");
    process.env.CLAUDE_PLUGIN_ROOT = TMP;
    try {
      const result = await validateAgentSkill(JSON.stringify({
        tool_name: "Task",
        tool_input: {
          subagent_type: "loom:arch-designer-agent",
          prompt: "Use the architecture-tech-lead skill to design one panel candidate.",
        },
      }), []);
      expect(result.kind).toBe("block");
      if (result.kind === "block") {
        expect(result.message).toContain("cannot determine which skills");
        expect(result.message).toContain("failing closed");
      }
    } finally {
      if (previousRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = previousRoot;
      if (createdGraph) rmSync(TASK_GRAPH_PATH, { force: true });
    }
  });

  it("SAYS SO when it cannot find the agent file at all, instead of allowing in silence", async () => {
    // The sibling of the branch above, with the opposite polarity and the same
    // uncertainty: `resolveAgentPath` returning null means we cannot determine
    // which skills the agent requires either. Blocking would break installs
    // that legitimately define agents outside the four searched paths, so this
    // one allows — but it used to allow with NOTHING on stderr, so a panel
    // designer spawning without its preloaded architecture-tech-lead skill was
    // indistinguishable from one that passed the check. This branch widened
    // when the PR added ARCH_PANEL_AGENTS and REVIEW_PANEL_AGENTS to
    // VALIDATED_AGENTS.
    const createdGraph = !existsSync(TASK_GRAPH_PATH);
    const previousRoot = process.env.CLAUDE_PLUGIN_ROOT;
    const previousHome = process.env.HOME;
    if (createdGraph) {
      mkdirSync(dirname(TASK_GRAPH_PATH), { recursive: true });
      writeFileSync(TASK_GRAPH_PATH, "{}");
    }
    // A plugin root and a HOME that both hold no agents/ directory, so every
    // candidate path misses. (The git-root candidate resolves to this repo,
    // which has agents/ — so use a name no agent file exists for, but which IS
    // in VALIDATED_AGENTS.)
    const empty = mkdtempSync(join(tmpdir(), "loom-no-agents-"));
    process.env.CLAUDE_PLUGIN_ROOT = empty;
    process.env.HOME = empty;
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const result = await validateAgentSkill(JSON.stringify({
        tool_name: "Task",
        tool_input: { subagent_type: "loom:dotfiles-agent", prompt: "do the thing" },
      }), []);
      expect(result.kind, "allowing is correct; silence was not").toBe("allow");
      const note = written.join("");
      expect(note).toContain("no agent file found");
      expect(note).toContain("skill enforcement SKIPPED");
      expect(note).toContain("loom:dotfiles-agent");
    } finally {
      spy.mockRestore();
      if (previousRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = previousRoot;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(empty, { recursive: true, force: true });
      if (createdGraph) rmSync(TASK_GRAPH_PATH, { force: true });
    }
  });

  it("brainstorm-agent prompt with brainstorming → pass", () => {
    const prompt = "You are an exploration specialist. Follow the process from the preloaded brainstorming skill.";
    expect(promptReferencesSkill(prompt, "brainstorming")).toBe(true);
  });

  it("architecture-agent prompt with architecture-tech-lead → pass", () => {
    const prompt = "Follow the review process from the preloaded architecture-tech-lead skill.";
    expect(promptReferencesSkill(prompt, "architecture-tech-lead")).toBe(true);
  });

  it("code-implementer-agent prompt missing skill → fail", () => {
    const prompt = "Implement the feature using FP patterns and DDD.";
    expect(promptReferencesSkill(prompt, "code-implementer")).toBe(false);
  });

  it("frontend-agent prompt with nextjs-frontend-design → pass", () => {
    const prompt = "Follow the patterns from the preloaded nextjs-frontend-design skill.";
    expect(promptReferencesSkill(prompt, "nextjs-frontend-design")).toBe(true);
  });

  it("security-agent prompt with security-expert → pass", () => {
    const prompt = "Follow the guidance from the preloaded security-expert skill.";
    expect(promptReferencesSkill(prompt, "security-expert")).toBe(true);
  });
});
