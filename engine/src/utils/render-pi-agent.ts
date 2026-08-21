import { accessSync, constants as fsConstants, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDeclaredSkills } from "../core/agent-skills";
import { renderPiAgentResource, type PreloadedSkill } from "../core/harness-resources";
import { lowerModelProfile, resolveAgentProfile } from "../core/model-profiles";

function skillPath(packageRoot: string, skill: string): string | null {
  const candidates = [
    join(packageRoot, "skills", skill, "SKILL.md"),
    join(packageRoot, "commands", `${skill}.md`),
  ];
  for (const path of candidates) {
    try {
      accessSync(path, fsConstants.F_OK);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`cannot inspect Loom skill candidate ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return null;
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
  const result = renderPiAgentResource(
    sourceAgent,
    exactModel,
    packageRoot,
    preloadedSkills(sourceAgent, packageRoot),
  );
  // The core returns the refusal; this shell is where an unrenderable agent
  // becomes fatal, alongside the sibling throws already here.
  if (!result.ok) throw new Error(result.error.message);
  const rendered = result.value;
  const frontmatterEnd = rendered.indexOf("\n---\n", 4);
  if (frontmatterEnd < 0) throw new Error(`rendered Pi agent '${agent}' has no frontmatter boundary`);
  const bodyStart = frontmatterEnd + "\n---\n".length;
  return `${rendered.slice(0, bodyStart)}<!-- LOOM_PI_AGENT_ID:${agent} -->\n${rendered.slice(bodyStart)}`;
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
  let actual: Buffer;
  try {
    actual = readFileSync(path);
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

  return actual.equals(Buffer.from(expected, "utf-8"))
    ? { ok: true }
    : {
        ok: false,
        error: `generated agent ${path} differs from active package ${packageRoot}`,
      };
}
