import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

/** Claude Code expands this token for plugin-owned markdown resources. */
export const CLAUDE_PLUGIN_ROOT_TOKEN = "${CLAUDE_PLUGIN_ROOT}";

const CLAUDE_PLUGIN_ROOT_PATTERN = /\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT\b/g;

/**
 * Lower a shared Loom markdown resource for Pi.
 *
 * Markdown is the harness-neutral source; package-root interpolation is an
 * adapter concern. Pi packages may live in a git clone, npm directory, Nix
 * store, or local checkout, so the only valid root is the extension module's
 * own package root — never cwd and never a Claude plugin cache scan.
 */
export function canonicalPackageRoot(packageRoot: string): string {
  if (!isAbsolute(packageRoot)) {
    throw new Error(`Pi resource package root must be absolute, got ${JSON.stringify(packageRoot)}`);
  }
  const canonicalRoot = resolve(packageRoot);
  // One shared token appears in shell snippets, Markdown code spans, and tool
  // paths. Characters that change meaning in any of those contexts cannot be
  // represented by context-free substitution, so fail closed rather than turn
  // a valid-but-hostile install path into shell syntax.
  if (/[\x00-\x20\x7F"$`\\*?\[\]]/.test(canonicalRoot)) {
    throw new Error(`Pi resource package root contains unsupported metacharacters: ${JSON.stringify(canonicalRoot)}`);
  }
  return canonicalRoot;
}

/** Stable, frontmatter-safe identity stamped into generated Pi agents. */
export function packageRootBinding(packageRoot: string): string {
  return Buffer.from(canonicalPackageRoot(packageRoot), "utf-8").toString("base64url");
}

export interface PreloadedSkill {
  readonly name: string;
  readonly content: string;
}

/** Produce the exact Pi agent file, including preloaded skills and an integrity stamp. */
export function renderPiAgentResource(
  sourceAgent: string,
  exactModel: string,
  packageRoot: string,
  skills: readonly PreloadedSkill[],
): string {
  const modelLine = /^model:\s*.*$/m;
  if (!modelLine.test(sourceAgent)) throw new Error("agent has no explicit Claude model line");
  const binding = packageRootBinding(packageRoot);
  const withBinding = sourceAgent.replace(
    modelLine,
    `model: ${exactModel}\nloom-package-root: ${binding}`,
  );
  const preloaded = skills.map(({ name, content }) => [
    "",
    `## Preloaded Loom Skill: ${name}`,
    "",
    content.trimEnd(),
  ].join("\n")).join("\n");
  const lowered = renderMarkdownForPi(withBinding + preloaded + (preloaded === "" ? "" : "\n"), packageRoot);
  const digest = createHash("sha256").update(lowered).digest("hex");
  return lowered.replace(
    /^loom-package-root:.*$/m,
    (line) => `${line}\nloom-agent-digest: ${digest}`,
  );
}

export function renderMarkdownForPi(content: string, packageRoot: string): string {
  const canonicalRoot = canonicalPackageRoot(packageRoot);
  const rendered = content.replace(CLAUDE_PLUGIN_ROOT_PATTERN, canonicalRoot);
  if (CLAUDE_PLUGIN_ROOT_PATTERN.test(rendered)) {
    throw new Error("Pi resource rendering left an unresolved CLAUDE_PLUGIN_ROOT token");
  }
  return rendered;
}
