/**
 * The one YAML-frontmatter field reader the agent-definition paths share.
 *
 * `model-profiles`'s `frontmatter()` and `validate-agent-model`'s
 * `modelFrontmatter()` each carried their own copy of this regex pair. Both
 * read the SAME files — the agent definitions whose `model`/`model-profile`
 * fields the two then compare — so a drift between the copies would let the
 * renderer and the fail-closed spawn guard disagree about what a definition
 * declares, which is exactly the disagreement the guard exists to catch.
 *
 * Deliberately not a YAML parser: only the flat `key: value` lines of a leading
 * `---` block are recognised, values are trimmed, and an empty value is treated
 * as absent (a declared-but-blank field must not read as a binding).
 *
 * `null` means "no frontmatter block", which is distinct from an empty one.
 */
export function parseFrontmatterFields(content: string): Record<string, string> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (field && field[2] !== "") fields[field[1]!] = field[2]!;
  }
  return fields;
}
