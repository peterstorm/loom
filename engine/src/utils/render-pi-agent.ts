import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDeclaredSkills } from "../core/agent-skills";
import { renderPiAgentResource, type PreloadedSkill } from "../core/harness-resources";
import { lowerModelProfile, resolveAgentProfile } from "../core/model-profiles";

function skillPath(packageRoot: string, skill: string): string | null {
  const candidates = [
    join(packageRoot, "skills", skill, "SKILL.md"),
    join(packageRoot, "commands", `${skill}.md`),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

function preloadedSkills(sourceAgent: string, packageRoot: string): readonly PreloadedSkill[] {
  const declared = parseDeclaredSkills(sourceAgent);
  if (declared.kind === "unreadable") throw new Error(declared.reason);
  if (declared.kind === "none") return [];
  return declared.names.map((name) => {
    const path = skillPath(packageRoot, name);
    if (!path) throw new Error(`agent requires missing Loom skill '${name}'`);
    return Object.freeze({ name, content: readFileSync(path, "utf-8") });
  });
}

/** Render the exact Pi definition from one source agent and its owning package. */
export function renderPiAgentDefinition(
  sourceAgent: string,
  agent: string,
  packageRoot: string,
): string {
  const profile = resolveAgentProfile(agent);
  if (!profile.ok) throw new Error(profile.error.message);
  const target = lowerModelProfile(profile.value, "pi");
  const exactModel = `${target.provider}/${target.model}:${target.thinking}`;
  return renderPiAgentResource(
    sourceAgent,
    exactModel,
    packageRoot,
    preloadedSkills(sourceAgent, packageRoot),
  );
}

export function expectedPiAgentDefinition(agent: string, packageRoot: string): string {
  return renderPiAgentDefinition(
    readFileSync(join(packageRoot, "agents", `${agent}.md`), "utf-8"),
    agent,
    packageRoot,
  );
}

export type PiAgentFileValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/** Prove the file Pi will execute is byte-for-byte the active package render. */
export function validatePiAgentDefinitionFile(
  path: string,
  agent: string,
  packageRoot: string,
): PiAgentFileValidation {
  let actual: string;
  try {
    actual = readFileSync(path, "utf-8");
  } catch (error) {
    return {
      ok: false,
      error: `cannot read generated agent ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let expected: string;
  try {
    expected = expectedPiAgentDefinition(agent, packageRoot);
  } catch (error) {
    return {
      ok: false,
      error: `cannot render active agent '${agent}': ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return actual === expected
    ? { ok: true }
    : {
        ok: false,
        error: `generated agent ${path} differs from active package ${packageRoot}`,
      };
}
