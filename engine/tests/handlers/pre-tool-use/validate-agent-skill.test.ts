import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
    expect(parseSkillsFromFrontmatter(path)).toEqual(["brainstorming"]);
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
    expect(parseSkillsFromFrontmatter(path)).toEqual(["code-implementer", "architecture-tech-lead"]);
  });

  it("returns empty for no skills field", () => {
    const path = writeAgent("test", [
      "---",
      "name: test-agent",
      "model: sonnet",
      "---",
    ].join("\n"));
    expect(parseSkillsFromFrontmatter(path)).toEqual([]);
  });

  it("returns empty for no frontmatter", () => {
    const path = writeAgent("test", "Just a body\nNo frontmatter here");
    expect(parseSkillsFromFrontmatter(path)).toEqual([]);
  });

  it("returns empty for nonexistent file", () => {
    expect(parseSkillsFromFrontmatter("/tmp/nonexistent-agent-file.md")).toEqual([]);
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
    expect(parseSkillsFromFrontmatter(path)).toEqual([]);
  });

  it("parses skills with trailing whitespace", () => {
    const path = writeAgent("test", [
      "---",
      "name: test-agent",
      "skills:",
      "  - brainstorming  ",
      "---",
    ].join("\n"));
    expect(parseSkillsFromFrontmatter(path)).toEqual(["brainstorming"]);
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
