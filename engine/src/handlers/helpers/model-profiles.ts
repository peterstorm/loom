import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
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

const OPERATIONS = ["show", "agent", "validate", "render-pi"] as const;
const USAGE = `Usage: helper model-profiles <${OPERATIONS.join("|")}> [--agent <name> --agents-dir <dir> --output <dir>]`;

function arg(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 && typeof args[index + 1] === "string" ? args[index + 1]! : null;
}

function frontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const result: Record<string, unknown> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (field && field[2] !== "") result[field[1]!] = field[2]!;
  }
  return result;
}

function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort();
}

function renderPiAgent(content: string, agent: string): string {
  const profile = resolveAgentProfile(agent);
  if (!profile.ok) throw new Error(profile.error.message);
  const target = lowerModelProfile(profile.value, "pi");
  const exactModel = `${target.provider}/${target.model}:${target.thinking}`;
  const modelLine = /^model:\s*.*$/m;
  if (!modelLine.test(content)) throw new Error(`agent '${agent}' has no explicit Claude model line`);
  return content.replace(modelLine, `model: ${exactModel}`);
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
    const agent = arg(args, "--agent");
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

  const agentsDir = arg(args, "--agents-dir") ?? join(process.cwd(), "agents");
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

  const output = arg(args, "--output");
  if (!output) return { kind: "error", message: `${USAGE}\n--output is required for render-pi` };
  mkdirSync(output, { recursive: true });
  for (const file of files) {
    const agent = basename(file, ".md");
    const content = readFileSync(join(agentsDir, file), "utf-8");
    writePiAgent(join(output, file), renderPiAgent(content, agent));
  }
  process.stdout.write(`Rendered ${files.length} Pi agent definitions to ${output}.\n`);
  return { kind: "passthrough" };
};

export default handler;
