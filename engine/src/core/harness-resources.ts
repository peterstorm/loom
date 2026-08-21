import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { canonicalRecord, type DomainResult } from "./orchestration-contract";

/**
 * Why a harness resource could not be rendered.
 *
 * These are BOUNDARY refusals over untrusted input — an install path the
 * package-root token cannot safely represent, an agent file with no model
 * line. They are returned, not thrown: this is functional core, and a core
 * that signals by exception forces every caller into a try/catch the type
 * never asked for. The two shells that render resources still throw, because
 * an unrenderable resource is fatal THERE — but that is the shell's call.
 */
export type HarnessResourceError = Readonly<{
  kind: "harness-resource-rejected";
  message: string;
}>;

const rejected = <T>(message: string): DomainResult<T, HarnessResourceError> =>
  canonicalRecord({ ok: false, error: canonicalRecord({ kind: "harness-resource-rejected" as const, message }) });
const produced = <T>(value: T): DomainResult<T, HarnessResourceError> =>
  canonicalRecord({ ok: true, value });

/** Claude Code expands these tokens for plugin-owned markdown resources. */
const CLAUDE_PLUGIN_ROOT_PATTERN = /\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT\b/g;

/**
 * Lower a shared Loom markdown resource for Pi.
 *
 * Markdown is the harness-neutral source; package-root interpolation is an
 * adapter concern. Pi packages may live in a git clone, npm directory, Nix
 * store, or local checkout, so the only valid root is the extension module's
 * own package root — never cwd and never a Claude plugin cache scan.
 */
export function canonicalPackageRoot(packageRoot: string): DomainResult<string, HarnessResourceError> {
  if (!isAbsolute(packageRoot)) {
    return rejected(`Pi resource package root must be absolute, got ${JSON.stringify(packageRoot)}`);
  }
  const canonicalRoot = resolve(packageRoot);
  // One shared token appears in shell snippets, Markdown code spans, and tool
  // paths. Characters that change meaning in any of those contexts cannot be
  // represented by context-free substitution, so fail closed rather than turn
  // a valid-but-hostile install path into shell syntax.
  if (/[\x00-\x20\x7F"$`\\*?\[\]]/.test(canonicalRoot)) {
    return rejected(`Pi resource package root contains unsupported metacharacters: ${JSON.stringify(canonicalRoot)}`);
  }
  return produced(canonicalRoot);
}

/** Stable, frontmatter-safe identity stamped into generated Pi agents. */
export function packageRootBinding(packageRoot: string): DomainResult<string, HarnessResourceError> {
  const canonicalRoot = canonicalPackageRoot(packageRoot);
  return canonicalRoot.ok
    ? produced(Buffer.from(canonicalRoot.value, "utf-8").toString("base64url"))
    : canonicalRoot;
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
): DomainResult<string, HarnessResourceError> {
  const modelLine = /^model:\s*.*$/m;
  if (!modelLine.test(sourceAgent)) return rejected("agent has no explicit Claude model line");
  const binding = packageRootBinding(packageRoot);
  if (!binding.ok) return binding;
  const withBinding = sourceAgent.replace(
    modelLine,
    `model: ${exactModel}\nloom-package-root: ${binding.value}`,
  );
  const preloaded = skills.map(({ name, content }) => [
    "",
    `## Preloaded Loom Skill: ${name}`,
    "",
    content.trimEnd(),
  ].join("\n")).join("\n");
  const lowered = renderMarkdownForPi(withBinding + preloaded + (preloaded === "" ? "" : "\n"), packageRoot);
  if (!lowered.ok) return lowered;
  const digest = createHash("sha256").update(lowered.value).digest("hex");
  return produced(lowered.value.replace(
    /^loom-package-root:.*$/m,
    (line) => `${line}\nloom-agent-digest: ${digest}`,
  ));
}

export function renderMarkdownForPi(
  content: string,
  packageRoot: string,
): DomainResult<string, HarnessResourceError> {
  const canonicalRoot = canonicalPackageRoot(packageRoot);
  if (!canonicalRoot.ok) return canonicalRoot;
  const substituted = content.replace(CLAUDE_PLUGIN_ROOT_PATTERN, () => canonicalRoot.value);
  return CLAUDE_PLUGIN_ROOT_PATTERN.test(substituted)
    ? rejected("Pi resource rendering left an unresolved CLAUDE_PLUGIN_ROOT token")
    : produced(substituted);
}
