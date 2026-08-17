import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_REQUIRED_SKILLS } from "../../src/core/orchestration-contract";
import { checkAgentSkillPrompt, parseDeclaredSkills } from "../../src/core/agent-skills";
import { requiredSkillMarker } from "../../src/handlers/helpers/programs/helpers";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const skillRequiringRoles = Object.entries(AGENT_REQUIRED_SKILLS)
  .filter((entry): entry is [string, string] => entry[1] !== null);

/**
 * AGENT_REQUIRED_SKILLS is a policy table with two consumers that can drift
 * from it silently: the skills/ directory (a required Skill that doesn't exist
 * loads nothing) and the agent frontmatter (Pi inlines DECLARED skills into
 * the rendered definition — a required-but-undeclared Skill is required on
 * paper and absent at runtime). These tests turn both couplings into proofs.
 */
describe("every required Skill exists and is declared by its agent", () => {
  it("has at least one skill-requiring role (a vacuous pass would prove nothing)", () => {
    expect(skillRequiringRoles.length).toBeGreaterThan(0);
  });

  it.each(skillRequiringRoles)("role %s's required Skill '%s' exists on disk", (_role, skill) => {
    // Skills live in two homes: directory skills (skills/<name>/SKILL.md) and
    // command-backed skills (commands/<name>.md, e.g. specify/clarify).
    const homes = [
      join(REPO_ROOT, "skills", skill, "SKILL.md"),
      join(REPO_ROOT, "commands", `${skill}.md`),
    ];
    expect(
      homes.some((path) => existsSync(path)),
      `required Skill '${skill}' must exist as skills/${skill}/SKILL.md or commands/${skill}.md`,
    ).toBe(true);
  });

  it.each(skillRequiringRoles)("agents/%s.md declares its required Skill '%s' in frontmatter", (role, skill) => {
    const markdown = readFileSync(join(REPO_ROOT, "agents", `${role}.md`), "utf-8");
    const declared = parseDeclaredSkills(markdown);
    expect(declared.kind, `agents/${role}.md frontmatter must be parseable`).toBe("skills");
    if (declared.kind !== "skills") return;
    expect(declared.names, `agents/${role}.md must declare '${skill}'`).toContain(skill);
  });
});

/**
 * Pi's spawn gate (`checkAgentSkillPrompt`) blocks any loom-agent spawn whose
 * task text never names a frontmatter-declared Skill. Engine-issued task text
 * is generic ("Read the immutable context packet …"), so the ONLY thing that
 * makes a skill-preloading reviewer spawnable is the LOOM_REQUIRED_SKILL
 * marker. This executes the real gate against the real agent files with the
 * exact task shape the engine renders.
 */
describe("requiredSkillMarker satisfies the harness skill-prompt gate", () => {
  it("renders nothing without a required Skill and one marker line with one", () => {
    expect(requiredSkillMarker(null)).toBe("");
    expect(requiredSkillMarker("distill")).toBe("LOOM_REQUIRED_SKILL: distill\n");
  });

  // The blocks above already proved every skill-requiring role has an agent
  // file that declares its Skill, so both gate outcomes can be asserted
  // unconditionally: the generic task must FAIL the gate (the marker is
  // load-bearing, not decorative) and the marked task must pass it.
  it.each(skillRequiringRoles)(
    "an engine-shaped task for %s passes checkAgentSkillPrompt only with the marker",
    (role, skill) => {
      const markdown = readFileSync(join(REPO_ROOT, "agents", `${role}.md`), "utf-8");
      const task = (marker: string): string =>
        `LOOM_REQUEST_ID: run-x:review:1\nLOOM_CONTEXT_DIGEST: 0f\nLOOM_CONTEXT_PATH: /tmp/contexts/0f.json\n${marker}` +
        "Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required reviewer result.";
      const bare = checkAgentSkillPrompt(markdown, task(""));
      expect(bare.ok, `the generic task must not already satisfy the gate for ${role}`).toBe(false);
      if (!bare.ok) expect(bare.missing).toContain(skill);
      expect(checkAgentSkillPrompt(markdown, task(requiredSkillMarker(skill))).ok, `marker must satisfy the gate for ${role}`).toBe(true);
    },
  );
});
