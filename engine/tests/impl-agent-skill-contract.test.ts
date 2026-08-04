import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAgentSkillPrompt, parseDeclaredSkills } from "../src/core/agent-skills";
import { IMPL_AGENTS } from "../src/config";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf-8");

describe("implementation prompt required-skill contract", () => {
  const template = read("commands", "templates", "impl-agent-context.md");
  const ownedImplementers = [...IMPL_AGENTS].sort()
    .filter((agent) => existsSync(join(ROOT, "agents", `${agent}.md`)));

  it("has an explicit required-skill substitution owned by the Loom runbook", () => {
    expect(template).toContain("{required_skill}");
    expect(read("commands", "loom.md")).toContain("`{required_skill}`");
  });

  it("covers multiple specialized implementation agents", () => {
    expect(ownedImplementers.length).toBeGreaterThanOrEqual(5);
  });

  for (const agent of ownedImplementers) {
    it(`${agent} can satisfy its source-declared skill policy`, () => {
      const source = read("agents", `${agent}.md`);
      const declared = parseDeclaredSkills(source);
      expect(declared.kind).not.toBe("unreadable");
      const required = declared.kind === "skills" ? declared.names.join(", ") : "none";
      const prompt = template.replace("{required_skill}", required);
      expect(checkAgentSkillPrompt(source, prompt)).toEqual({ ok: true });
    });
  }
});
