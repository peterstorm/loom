import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { checkAgentSkillPrompt, parseDeclaredSkills } from "../../src/core/agent-skills";

const agent = (skills: string) => `---\nname: demo\nskills:\n${skills}\n---\nBody\n`;

describe("shared agent skill policy", () => {
  it("requires every declared skill in Claude and Pi spawn prompts", () => {
    const markdown = agent("  - architecture-tech-lead\n  - code-implementer");
    expect(checkAgentSkillPrompt(markdown, "Use architecture-tech-lead only.")).toEqual({
      ok: false,
      error: "spawn prompt omits required skill(s): code-implementer",
      missing: ["code-implementer"],
    });
    expect(checkAgentSkillPrompt(
      markdown,
      "Use architecture-tech-lead and code-implementer.",
    )).toEqual({ ok: true });
  });

  it("fails closed on unreadable frontmatter and empty prompts", () => {
    expect(checkAgentSkillPrompt("no frontmatter", "anything").ok).toBe(false);
    expect(checkAgentSkillPrompt(agent("  - code-implementer"), "").ok).toBe(false);
  });

  it("is total for arbitrary markdown and prompts", () => {
    fc.assert(fc.property(fc.string(), fc.string(), (markdown, prompt) => {
      expect(() => parseDeclaredSkills(markdown)).not.toThrow();
      expect(() => checkAgentSkillPrompt(markdown, prompt)).not.toThrow();
    }));
  });
});
