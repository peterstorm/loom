import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAgentSkillPrompt, parseDeclaredSkills } from "../src/core/agent-skills";
import { IMPL_AGENTS } from "../src/core/agent-catalog-projections";
import { renderImplementationBrief, RULE_DOCUMENTS, type RuleDocument } from "../src/core/implementation-brief";
import { deriveTaskImplementationDispatch } from "../src/core/task-implementation-dispatch";
import { taskFixture } from "./fixtures/task-lifecycle";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf-8");

describe("implementation prompt required-skill contract", () => {
  const template = read("commands", "templates", "impl-agent-context.md");
  const rules: ReadonlyMap<RuleDocument, string> = new Map(RULE_DOCUMENTS.map((name) => [name, read("rules", name)] as const));
  const ownedImplementers = [...IMPL_AGENTS].sort()
    .filter((agent) => existsSync(join(ROOT, "agents", `${agent}.md`)));

  it("has explicit Skill, Verification Policy, and retry-context variables owned by the engine renderer", () => {
    expect(template).toContain("{required_skill}");
    expect(template).toContain("{verification_policy}");
    expect(template).toContain("{implementation_retry_context}");
    const runbook = read("commands", "loom.md");
    expect(runbook).toContain("helper orchestration brief");
    expect(runbook).toContain("never assemble one by hand");
  });

  it("covers multiple specialized implementation agents", () => {
    expect(ownedImplementers.length).toBeGreaterThanOrEqual(5);
  });

  for (const agent of ownedImplementers) {
    it(`${agent}'s engine-rendered brief satisfies its source-declared skill policy`, () => {
      const source = read("agents", `${agent}.md`);
      expect(parseDeclaredSkills(source).kind).not.toBe("unreadable");
      const task = taskFixture({ id: "T1", description: "contract", agent, wave: 1, depends_on: [], file_list: ["src/a.ts"] });
      const derivation = deriveTaskImplementationDispatch(task);
      if (derivation.kind !== "dispatch") throw new Error(`fixture must be owed a dispatch, got ${derivation.kind}`);
      const rendered = renderImplementationBrief({
        template, task, dispatch: derivation.dispatch, planFile: "plan.md",
        spec: { kind: "unavailable", reason: { kind: "no-spec-file" } }, rules,
      });
      if (!rendered.ok) throw new Error(rendered.error.message);
      expect(checkAgentSkillPrompt(source, rendered.value.prompt)).toEqual({ ok: true });
    });
  }
});
