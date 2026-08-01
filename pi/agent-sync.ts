import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

type AgentFrontmatter = Readonly<{
  name: string;
  description: string;
  model?: string;
  tools: readonly string[];
  skills: readonly string[];
}>;

export type AgentSyncResult = Readonly<{
  written: readonly string[];
  skipped: readonly string[];
  conflicts: readonly string[];
  errors: readonly string[];
}>;

const MANAGED_MARKER = "<!-- pi-loom-managed-agent";

const TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  bash: "bash",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "find",
  find: "find",
  ls: "ls",
  task: "subagent",
  subagent: "subagent",
};

const yamlString = (value: string): string => JSON.stringify(value);

const stripYamlQuotes = (value: string): string => {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const parseFrontmatterBlock = (raw: string): { frontmatter: string; body: string } => {
  if (!raw.startsWith("---\n")) {
    throw new Error("agent file must start with YAML frontmatter");
  }

  const end = raw.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error("agent file has unterminated YAML frontmatter");
  }

  const bodyStart = raw.indexOf("\n", end + 4);
  return {
    frontmatter: raw.slice(4, end),
    body: bodyStart === -1 ? "" : raw.slice(bodyStart + 1),
  };
};

const parseScalar = (frontmatter: string, key: string): string | undefined => {
  const match = frontmatter.match(new RegExp(`^${key}:[^\\S\\r\\n]*(.*)$`, "m"));
  if (!match) return undefined;
  const raw = match[1]?.trim() ?? "";
  return raw === "" ? undefined : stripYamlQuotes(raw);
};

const parseStringList = (frontmatter: string, key: string): readonly string[] => {
  const scalar = parseScalar(frontmatter, key);
  if (scalar) {
    return scalar
      .split(",")
      .map((item) => stripYamlQuotes(item).trim())
      .filter(Boolean);
  }

  const lines = frontmatter.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  if (start === -1) return [];

  const values: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+-\s+/.test(line)) break;
    values.push(stripYamlQuotes(line.replace(/^\s+-\s+/, "").trim()));
  }
  return values.filter(Boolean);
};

const parseAgentFrontmatter = (rawFrontmatter: string): AgentFrontmatter => {
  const name = parseScalar(rawFrontmatter, "name");
  const description = parseScalar(rawFrontmatter, "description");

  if (!name) throw new Error("agent frontmatter missing required name");
  if (!description) throw new Error(`agent ${name} frontmatter missing required description`);

  return {
    name,
    description,
    model: parseScalar(rawFrontmatter, "model"),
    tools: parseStringList(rawFrontmatter, "tools"),
    skills: parseStringList(rawFrontmatter, "skills"),
  };
};

export const normalizePiTools = (tools: readonly string[]): readonly string[] => {
  const normalized = tools
    .map((tool) => TOOL_NAME_MAP[tool.trim().toLowerCase()] ?? tool.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(normalized)].sort();
};

const renderPiFrontmatter = (agent: AgentFrontmatter): string => {
  const tools = normalizePiTools(agent.tools);
  const lines = [
    "---",
    `name: ${yamlString(agent.name)}`,
    `description: ${yamlString(agent.description)}`,
  ];

  if (agent.model) lines.push(`model: ${yamlString(agent.model)}`);
  if (tools.length > 0) lines.push(`tools: ${yamlString(tools.join(","))}`);

  lines.push("---");
  return `${lines.join("\n")}\n`;
};

const renderPreloadedSkills = (
  skillNames: readonly string[],
  readSkillContent: (name: string) => string | null,
): string => {
  if (skillNames.length === 0) return "";

  const sections = skillNames.map((name) => {
    const content = readSkillContent(name);
    if (!content) {
      return `## Missing preloaded skill: ${name}\n\nLoom could not find this skill in the package. Continue only if the task does not require it.`;
    }
    return `## Preloaded skill: ${name}\n\n${content.trim()}`;
  });

  return [
    "# Pi Preloaded Skills",
    "",
    "Pi's stock subagent extension ignores Claude Code's `skills:` frontmatter. Loom preloads those skills here so the agent has the same context in Pi.",
    "",
    ...sections,
    "",
    "---",
    "",
  ].join("\n");
};

export const buildPiAgentContent = (
  sourceFileName: string,
  rawAgent: string,
  readSkillContent: (name: string) => string | null,
): string => {
  const { frontmatter, body } = parseFrontmatterBlock(rawAgent);
  const agent = parseAgentFrontmatter(frontmatter);
  const preloadedSkills = renderPreloadedSkills(agent.skills, readSkillContent);

  return [
    renderPiFrontmatter(agent).trimEnd(),
    `${MANAGED_MARKER}: source=${sourceFileName}; do not edit directly. -->`,
    "",
    preloadedSkills.trimEnd(),
    body.trimStart(),
  ]
    .filter((part) => part.length > 0)
    .join("\n\n") + "\n";
};

const readBundledSkillContent = (packageRoot: string, skillName: string): string | null => {
  const candidates = [
    join(packageRoot, "skills", skillName, "SKILL.md"),
    join(packageRoot, "commands", skillName, "SKILL.md"),
    join(packageRoot, "commands", `${skillName}.md`),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  return null;
};

const shouldOverwriteExistingAgent = (existing: string, rawSource: string, force: boolean): boolean => {
  if (force) return true;
  if (existing.includes(MANAGED_MARKER)) return true;
  return existing === rawSource;
};

export const syncBundledAgents = (
  agentDir: string,
  packageRoot: string,
  options: { force?: boolean } = {},
): AgentSyncResult => {
  const sourceDir = join(packageRoot, "agents");
  const targetDir = join(agentDir, "agents");
  const written: string[] = [];
  const skipped: string[] = [];
  const conflicts: string[] = [];
  const errors: string[] = [];

  mkdirSync(targetDir, { recursive: true, mode: 0o700 });

  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "README.md") continue;

    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);

    try {
      const rawSource = readFileSync(sourcePath, "utf8");
      const desired = buildPiAgentContent(entry.name, rawSource, (skillName) => readBundledSkillContent(packageRoot, skillName));

      if (existsSync(targetPath)) {
        const existing = readFileSync(targetPath, "utf8");
        if (existing === desired) {
          skipped.push(entry.name);
          continue;
        }

        const stat = lstatSync(targetPath);
        if (stat.isSymbolicLink()) unlinkSync(targetPath);
        else if (!shouldOverwriteExistingAgent(existing, rawSource, options.force ?? false)) {
          conflicts.push(entry.name);
          continue;
        }
      }

      writeFileSync(targetPath, desired, { encoding: "utf8", mode: 0o600 });
      written.push(entry.name);
    } catch (error) {
      errors.push(`${basename(sourcePath)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { written, skipped, conflicts, errors };
};
