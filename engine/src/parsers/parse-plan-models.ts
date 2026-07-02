/**
 * Parse executable-model declarations out of an architecture plan document.
 *
 * Executable-models policy: plans may declare three kinds of model, each
 * opt-in via a dedicated `##` section:
 *
 *   - `## Lifecycles`  — `### LC-N: {title}` blocks, each binding a lifecycle
 *                        to a machine file the implementation imports and runs
 *   - `## Pipeline`    — an `**AuthoredDag:**` sidecar authored by the
 *                        architecture phase (validated deeply by fugue, not loom)
 *   - `## Invariants`  — `### INV-N: {title}` blocks tiered `checkable`
 *                        (bound to a lint-rule file, enforced fail-closed) or
 *                        `advisory` (prose, never enforced)
 *
 * The parser is total and pure: malformed declarations are represented, never
 * thrown. Malformed *field lines* become null fields; malformed or misplaced
 * *headings and labels* (near-miss section names, `### LC-A1:` typos, model
 * markers outside their sections) are collected into `strays` so validation
 * can fail closed instead of treating a typo as an opt-out. Judgment lives in
 * the model-binding validation. Absent sections with no stray markers mean
 * the plan genuinely opted out — no models, no checks.
 *
 * Fenced code blocks (``` / ~~~) are blanked before parsing so plans that
 * quote the template don't produce phantom declarations.
 */

export type InvariantTier = "checkable" | "advisory";

export interface PlanLifecycle {
  /** e.g. "LC-1" */
  readonly id: string;
  readonly title: string;
  /** Path from the `**Machine file:**` line; null when the line is missing */
  readonly machineFile: string | null;
}

export interface PlanPipeline {
  /** Path from the `**AuthoredDag:**` line; null when the line is missing */
  readonly dagFile: string | null;
}

export interface PlanInvariant {
  /** e.g. "INV-1" */
  readonly id: string;
  readonly title: string;
  /** null when the `**Tier:**` line is missing or not a recognized tier */
  readonly tier: InvariantTier | null;
  /** Path from the `**Rule file:**` line; null when the line is missing */
  readonly ruleFile: string | null;
}

export interface PlanModels {
  readonly lifecycles: readonly PlanLifecycle[];
  readonly pipeline: PlanPipeline | null;
  readonly invariants: readonly PlanInvariant[];
  /**
   * Near-miss / misplaced model markers: section headings that almost match
   * (`## Lifecycles:`, `## Pipelines`), `###` blocks inside a model section
   * that don't match the block grammar (`### INV-A1:`, `### lc-1:`, missing
   * colon), LC/INV headings outside their sections, and model field labels
   * (`**Machine file:**` etc.) outside their sections. Each entry is a
   * human-readable description. Any stray means the plan tried to declare a
   * model and failed — validation must error, not skip.
   */
  readonly strays: readonly string[];
}

export function hasModels(models: PlanModels): boolean {
  return (
    models.lifecycles.length > 0 ||
    models.pipeline !== null ||
    models.invariants.length > 0 ||
    models.strays.length > 0
  );
}

/** Blank out fenced code blocks, preserving line structure */
function stripFences(markdown: string): string {
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return "";
      }
      return inFence ? "" : line;
    })
    .join("\n");
}

interface Section {
  readonly body: string;
  /** Offset of the body within the stripped document */
  readonly start: number;
  readonly end: number;
}

/** Extract a `## {heading}` section (up to the next `## ` heading), or null */
function section(markdown: string, heading: string): Section | null {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, "im");
  const m = re.exec(markdown);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = markdown.slice(start);
  const next = /^##\s+/m.exec(rest);
  const end = next ? start + next.index : markdown.length;
  return { body: markdown.slice(start, end), start, end };
}

/** Split a section body into `### ` blocks whose heading matches `{prefix}-N: title` */
function idBlocks(body: string, prefix: string): { id: string; title: string; block: string }[] {
  const headingRe = new RegExp(`^###\\s+(${prefix}-\\d+):\\s*(.+)$`, "gm");
  const matches = [...body.matchAll(headingRe)];
  return matches.map((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : body.length;
    return { id: m[1], title: m[2].trim(), block: body.slice(start, end) };
  });
}

/** Value of a `**{label}:** value` line inside a block, backticks stripped; null if absent */
function fieldValue(block: string, label: string): string | null {
  const re = new RegExp(`^\\*\\*${label}:\\*\\*\\s*(.+)$`, "im");
  const m = re.exec(block);
  if (!m) return null;
  const value = m[1].trim().replace(/^`(.*)`$/, "$1").trim();
  return value.length > 0 ? value : null;
}

function parseTier(raw: string | null): InvariantTier | null {
  if (raw === null) return null;
  const lowered = raw.toLowerCase();
  return lowered === "checkable" || lowered === "advisory" ? lowered : null;
}

const CANONICAL_SECTIONS = ["Lifecycles", "Pipeline", "Invariants"] as const;

function inRange(index: number, s: Section | null): boolean {
  return s !== null && index >= s.start && index < s.end;
}

/** Collect near-miss and misplaced model markers — see PlanModels.strays */
function collectStrays(
  text: string,
  lifecycles: Section | null,
  pipeline: Section | null,
  invariants: Section | null,
): string[] {
  const strays: string[] = [];

  // Near-miss `##` section headings: start with a model-section word but
  // don't match the canonical heading exactly.
  for (const m of text.matchAll(/^##\s+((?:lifecycles?|pipelines?|invariants?)\b[^\n]*)$/gim)) {
    const line = m[0].trim();
    const exact = CANONICAL_SECTIONS.some((name) =>
      new RegExp(`^##\\s+${name}\\s*$`, "i").test(line)
    );
    if (!exact) {
      strays.push(
        `near-miss section heading '${line}' — model sections must be exactly '## Lifecycles', '## Pipeline', or '## Invariants'`
      );
    }
  }

  // `###` headings inside a model section must match the block grammar.
  const blockGrammar: Array<{ s: Section | null; prefix: string; name: string }> = [
    { s: lifecycles, prefix: "LC", name: "Lifecycles" },
    { s: invariants, prefix: "INV", name: "Invariants" },
  ];
  for (const { s, prefix, name } of blockGrammar) {
    if (s === null) continue;
    for (const m of s.body.matchAll(/^###\s+([^\n]+)$/gm)) {
      const heading = m[1].trim();
      if (!new RegExp(`^${prefix}-\\d+:\\s*.+$`).test(heading)) {
        strays.push(
          `heading '### ${heading}' inside '## ${name}' does not match '### ${prefix}-<n>: <title>' (uppercase ${prefix}, numeric id, colon)`
        );
      }
    }
  }

  // LC/INV-shaped headings outside their sections.
  for (const m of text.matchAll(/^###\s+((?:LC|INV)[-\s][^\n]*)$/gim)) {
    const idx = m.index ?? 0;
    const isLC = /^lc/i.test(m[1]);
    const home = isLC ? lifecycles : invariants;
    if (!inRange(idx, home)) {
      strays.push(
        `heading '### ${m[1].trim()}' found outside its '## ${isLC ? "Lifecycles" : "Invariants"}' section — declarations there are not parsed`
      );
    }
  }

  // Model field labels outside their sections.
  const labelHomes: Array<{ label: string; s: Section | null; name: string }> = [
    { label: "Machine file", s: lifecycles, name: "Lifecycles" },
    { label: "AuthoredDag", s: pipeline, name: "Pipeline" },
    { label: "Rule file", s: invariants, name: "Invariants" },
    { label: "Tier", s: invariants, name: "Invariants" },
  ];
  for (const { label, s, name } of labelHomes) {
    for (const m of text.matchAll(new RegExp(`^\\*\\*${label}:\\*\\*[^\\n]*$`, "gim"))) {
      const idx = m.index ?? 0;
      if (!inRange(idx, s)) {
        strays.push(
          `'**${label}:**' line found outside a '## ${name}' section — it binds nothing there`
        );
      }
    }
  }

  return strays;
}

export function parsePlanModels(markdown: string): PlanModels {
  const text = stripFences(markdown);

  const lifecyclesSection = section(text, "Lifecycles");
  const lifecycles: PlanLifecycle[] = lifecyclesSection === null
    ? []
    : idBlocks(lifecyclesSection.body, "LC").map(({ id, title, block }) => ({
        id,
        title,
        machineFile: fieldValue(block, "Machine file"),
      }));

  const pipelineSection = section(text, "Pipeline");
  const pipeline: PlanPipeline | null = pipelineSection === null
    ? null
    : { dagFile: fieldValue(pipelineSection.body, "AuthoredDag") };

  const invariantsSection = section(text, "Invariants");
  const invariants: PlanInvariant[] = invariantsSection === null
    ? []
    : idBlocks(invariantsSection.body, "INV").map(({ id, title, block }) => ({
        id,
        title,
        tier: parseTier(fieldValue(block, "Tier")),
        ruleFile: fieldValue(block, "Rule file"),
      }));

  const strays = collectStrays(text, lifecyclesSection, pipelineSection, invariantsSection);

  return { lifecycles, pipeline, invariants, strays };
}
