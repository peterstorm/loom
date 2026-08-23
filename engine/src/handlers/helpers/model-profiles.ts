import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { argumentValue } from "./cli-args";
import { parseFrontmatterFields } from "../../utils/frontmatter";
import type { HookHandler } from "../../types";
import {
  AGENT_POLICIES,
  LLM_PROFILES,
  lowerModelProfile,
  resolveAgentPolicy,
  resolveAgentProfile,
  validateAgentPolicyCatalog,
  validateAgentPolicyFrontmatter,
} from "../../core/model-profiles";
import { parseModelRef, resolveEffectivePiBinding, type ModelRef } from "../../core/model-routing";
import { renderPiAgentDefinitionWithBinding } from "../../utils/render-pi-agent";
import { activeAgentDir, buildPiRoutingContext } from "../../utils/model-routing-context";

const OPERATIONS = ["show", "agent", "validate", "render-pi"] as const;
const USAGE = `Usage: helper model-profiles <${OPERATIONS.join("|")}> [--agent <name> --agents-dir <dir> --package-root <dir> --output <dir> [--parent-model <provider/model>]]`;


const frontmatter = (content: string): Record<string, unknown> | null =>
  parseFrontmatterFields(content);

function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort();
}

/** Replace the directory entry atomically so a pre-existing symlink is never followed. */
function writePiAgent(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

const handler: HookHandler = async (_stdin, args) => {
  const operation = args[0];
  if (!operation || !(OPERATIONS as readonly string[]).includes(operation)) {
    return { kind: "error", message: USAGE };
  }

  if (operation === "show") {
    process.stdout.write(JSON.stringify({ profiles: LLM_PROFILES, agents: AGENT_POLICIES }, null, 2) + "\n");
    return { kind: "passthrough" };
  }

  if (operation === "agent") {
    const agent = argumentValue(args, "--agent");
    if (!agent) return { kind: "error", message: `${USAGE}\n--agent is required` };
    const policy = resolveAgentPolicy(agent);
    const profile = resolveAgentProfile(agent);
    if (!policy.ok) return { kind: "error", message: policy.error.message };
    if (!profile.ok) return { kind: "error", message: profile.error.message };
    process.stdout.write(JSON.stringify({
      agent: policy.value.agent,
      profile: policy.value.profile,
      claudeCode: lowerModelProfile(profile.value, "claude-code"),
      pi: lowerModelProfile(profile.value, "pi"),
    }, null, 2) + "\n");
    return { kind: "passthrough" };
  }

  const agentsDir = argumentValue(args, "--agents-dir") ?? join(process.cwd(), "agents");
  const files = markdownFiles(agentsDir);
  const expected = files.map((file) => basename(file, ".md"));
  const catalog = validateAgentPolicyCatalog(expected);
  const errors = catalog.ok ? [] : [...catalog.errors];
  for (const file of files) {
    const path = join(agentsDir, file);
    const parsed = frontmatter(readFileSync(path, "utf-8"));
    const validation = validateAgentPolicyFrontmatter(parsed);
    if (!validation.ok) errors.push(...validation.errors.map((error) => `${file}: ${error}`));
  }
  if (errors.length > 0) {
    return { kind: "error", message: `Model profile validation failed:\n${errors.map((error) => `  - ${error}`).join("\n")}` };
  }

  if (operation === "validate") {
    process.stdout.write(`Validated ${files.length} Loom agent model profiles.\n`);
    return { kind: "passthrough" };
  }

  const output = argumentValue(args, "--output");
  if (!output) return { kind: "error", message: `${USAGE}\n--output is required for render-pi` };
  const packageRoot = resolve(argumentValue(args, "--package-root") ?? dirname(agentsDir));

  // Routing: resolve each agent's effective binding from the routing policy +
  // the parent model. With no routing config (or a non-local parent) the
  // effective binding equals the declared one, so the render is byte-identical
  // to the un-routed output.
  const parentOverrideRaw = argumentValue(args, "--parent-model");
  let parentOverride: ModelRef | null = null;
  if (parentOverrideRaw !== null) {
    const parsed = parseModelRef(parentOverrideRaw);
    if (!parsed.ok) return { kind: "error", message: `invalid --parent-model: ${parsed.error.message}` };
    parentOverride = parsed.value;
  }
  const built = buildPiRoutingContext(process.env, activeAgentDir(), parentOverride);
  if (built.configError !== null) process.stdout.write(`warning: ${built.configError}\n`);
  const { parentRef, config } = built.context;

  mkdirSync(output, { recursive: true });
  for (const file of files) {
    const agent = basename(file, ".md");
    const content = readFileSync(join(agentsDir, file), "utf-8");
    const profile = resolveAgentProfile(agent);
    if (!profile.ok) return { kind: "error", message: profile.error.message };
    const declared = lowerModelProfile(profile.value, "pi");
    const effective = resolveEffectivePiBinding(declared, parentRef, config);
    writePiAgent(join(output, file), renderPiAgentDefinitionWithBinding(content, agent, packageRoot, effective));
  }
  process.stdout.write(`Rendered ${files.length} Pi agent definitions to ${output}.\n`);
  return { kind: "passthrough" };
};

export default handler;
