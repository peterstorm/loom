import { describe, expect, it } from "vitest";
import { buildPiAgentContent, normalizePiTools } from "../../../pi/agent-sync";

describe("Pi agent sync", () => {
  it("normalizes Claude Code tool names to Pi tool names", () => {
    expect(normalizePiTools(["Read", "Glob", "Grep", "Task", "Read"])).toEqual([
      "find",
      "grep",
      "read",
      "subagent",
    ]);
  });

  it("converts array frontmatter and preloads skills without breaking YAML frontmatter", () => {
    const rawAgent = `---
name: code-implementer-agent
description: Implementation agent
color: blue
skills:
  - code-implementer
tools:
  - Read
  - Glob
  - Grep
---

You are a code implementation specialist.
`;

    const content = buildPiAgentContent("code-implementer-agent.md", rawAgent, (name) =>
      name === "code-implementer" ? "# Code Implementer\n\nFollow FP/DDD." : null,
    );

    expect(content).toMatch(/^---\nname: "code-implementer-agent"\ndescription: "Implementation agent"\ntools: "find,grep,read"\n---/);
    expect(content).toContain("<!-- pi-loom-managed-agent: source=code-implementer-agent.md; do not edit directly. -->");
    expect(content).toContain("# Pi Preloaded Skills");
    expect(content).toContain("## Preloaded skill: code-implementer");
    expect(content).toContain("# Code Implementer");
    expect(content).toContain("You are a code implementation specialist.");
    expect(content.slice(0, content.indexOf("---", 4))).not.toContain("skills:");
  });
});
