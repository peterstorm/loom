import { accessSync, constants as fsConstants, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDeclaredSkills } from "../core/agent-skills";
import { renderPiAgentResource, type PreloadedSkill } from "../core/harness-resources";
import { lowerModelProfile, resolveAgentProfile } from "../core/model-profiles";
import {
  resolveEffectivePiBinding,
  type EffectivePiBinding,
  type ModelRef,
  type ModelRoutingConfig,
} from "../core/model-routing";

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

/** Render the Pi body from an exact `provider/model:thinking` model line. */
function renderWithExactModel(
  sourceAgent: string,
  agent: string,
  packageRoot: string,
  exactModel: string,
): string {
  const result = renderPiAgentResource(sourceAgent, exactModel, packageRoot, preloadedSkills(sourceAgent, packageRoot));
  // The core returns the refusal; this shell is where an unrenderable agent
  // becomes fatal, alongside the sibling throws already here.
  if (!result.ok) throw new Error(result.error.message);
  const rendered = result.value;
  const frontmatterEnd = rendered.indexOf("\n---\n", 4);
  if (frontmatterEnd < 0) throw new Error(`rendered Pi agent '${agent}' has no frontmatter boundary`);
  const bodyStart = frontmatterEnd + "\n---\n".length;
  return `${rendered.slice(0, bodyStart)}<!-- LOOM_PI_AGENT_ID:${agent} -->\n${rendered.slice(bodyStart)}`;
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
  return renderWithExactModel(sourceAgent, agent, packageRoot, `${target.provider}/${target.model}:${target.thinking}`);
}

/** Render the Pi definition with an explicit (possibly routed) binding. */
export function renderPiAgentDefinitionWithBinding(
  sourceAgent: string,
  agent: string,
  packageRoot: string,
  binding: EffectivePiBinding,
): string {
  return renderWithExactModel(sourceAgent, agent, packageRoot, `${binding.provider}/${binding.model}:${binding.thinking}`);
}

export function expectedPiAgentDefinition(agent: string, packageRoot: string): string {
  return renderPiAgentDefinition(
    readFileSync(join(packageRoot, "agents", `${agent}.md`), "utf-8"),
    agent,
    packageRoot,
  );
}

export function expectedPiAgentDefinitionWithBinding(
  agent: string,
  packageRoot: string,
  binding: EffectivePiBinding,
): string {
  return renderPiAgentDefinitionWithBinding(
    readFileSync(join(packageRoot, "agents", `${agent}.md`), "utf-8"),
    agent,
    packageRoot,
    binding,
  );
}

/**
 * The spawn-boundary routing context a caller observes: the parsed config (or
 * null when absent/unusable) and the parent session's model ref (or null when
 * unknown). The pure policy decides whether a child inherits the parent model.
 */
export type PiRoutingContext = Readonly<{
  config: ModelRoutingConfig | null;
  parentRef: ModelRef | null;
}>;

export type PiAgentFileValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/**
 * Prove the file Pi will execute is a Loom render for the current routing
 * context: byte-for-byte the declared render, or — when the routing policy
 * authorizes inheritance for the observed parent model — the routed render.
 * Both are Loom-computed from trusted inputs; anything else is a mismatch.
 */
export function validatePiAgentDefinitionFile(
  path: string,
  agent: string,
  packageRoot: string,
  routing: PiRoutingContext | null = null,
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

  if (actual.equals(Buffer.from(expected, "utf-8"))) return { ok: true };

  if (routing !== null) {
    const routed = routedPiAgentDefinitionIfAuthorized(agent, packageRoot, routing);
    if (!routed.ok) return routed;
    if (routed.value !== null && actual.equals(Buffer.from(routed.value, "utf-8"))) return { ok: true };
  }

  return {
    ok: false,
    error: `generated agent ${path} differs from active package ${packageRoot}`,
  };
}

/**
 * The routed render for an agent, or null when the policy does not authorize
 * inheriting the parent model (no config, no parent, non-local parent, or a
 * `declared` rule). Rendering failures remain distinct from "not authorized"
 * so the spawn boundary can report the concrete recovery cause.
 */
function routedPiAgentDefinitionIfAuthorized(
  agent: string,
  packageRoot: string,
  routing: PiRoutingContext,
): Readonly<{ ok: true; value: string | null }> | Readonly<{ ok: false; error: string }> {
  const profile = resolveAgentProfile(agent);
  if (!profile.ok) {
    return { ok: false, error: `cannot resolve routed agent '${agent}': ${profile.error.message}` };
  }
  const declaredBinding = lowerModelProfile(profile.value, "pi");
  const effective = resolveEffectivePiBinding(declaredBinding, routing.parentRef, routing.config);
  if (effective.provider === declaredBinding.provider && effective.model === declaredBinding.model) {
    return { ok: true, value: null };
  }
  try {
    return { ok: true, value: expectedPiAgentDefinitionWithBinding(agent, packageRoot, effective) };
  } catch (error) {
    return {
      ok: false,
      error: `cannot render routed agent '${agent}': ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
