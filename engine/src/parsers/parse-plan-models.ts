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

import { match } from "ts-pattern";

export type InvariantTier = "checkable" | "advisory";

/** Model sections that carry `### ` id-blocks. */
export type BlockSection = "Lifecycles" | "Invariants";

/** All canonical model sections. */
export type ModelSection = BlockSection | "Pipeline";

/**
 * A near-miss or misplaced model marker. Each variant carries the context
 * needed to explain itself (`renderStray`); validation treats ANY stray as
 * an error — a typo must never read as an opt-out.
 */
export type Stray =
  | { readonly kind: "unterminated-fence" }
  | { readonly kind: "empty-section"; readonly section: BlockSection }
  | { readonly kind: "near-miss-heading"; readonly heading: string }
  | {
      readonly kind: "bad-block-grammar";
      readonly heading: string;
      readonly section: BlockSection;
      readonly prefix: "LC" | "INV";
    }
  | { readonly kind: "misplaced-heading"; readonly heading: string; readonly home: BlockSection }
  | { readonly kind: "misplaced-label"; readonly label: string; readonly home: ModelSection };

/** Human-readable description of a stray, for validation error messages. */
export function renderStray(s: Stray): string {
  return match(s)
    .with(
      { kind: "unterminated-fence" },
      () => "unterminated code fence — everything after it is invisible to the model parser; close the fence",
    )
    .with(
      { kind: "empty-section" },
      ({ section }) =>
        `'## ${section}' section is declared but contains no '### ' blocks — declare the model or remove the section`,
    )
    .with(
      { kind: "near-miss-heading" },
      ({ heading }) =>
        `near-miss section heading '${heading}' — model sections must be exactly '## Lifecycles', '## Pipeline', or '## Invariants'`,
    )
    .with(
      { kind: "bad-block-grammar" },
      ({ heading, section, prefix }) =>
        `heading '### ${heading}' inside '## ${section}' does not match '### ${prefix}-<n>: <title>' (uppercase ${prefix}, numeric id, colon)`,
    )
    .with(
      { kind: "misplaced-heading" },
      ({ heading, home }) =>
        `heading '### ${heading}' found outside its '## ${home}' section — declarations there are not parsed`,
    )
    .with(
      { kind: "misplaced-label" },
      ({ label, home }) => `'**${label}:**' line found outside a '## ${home}' section — it binds nothing there`,
    )
    .exhaustive();
}

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
  /** Node names from the first column of the Pipeline section's node table
   *  (header/separator rows skipped); empty when the section has no table.
   *  Cross-checked against the sidecar to catch plan↔sidecar drift. */
  readonly declaredNodes: readonly string[];
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
   * discriminated Stray carrying its context; render with `renderStray`.
   * Any stray means the plan tried to declare a model and failed —
   * validation must error, not skip.
   */
  readonly strays: readonly Stray[];
}

export function hasModels(models: PlanModels): boolean {
  return (
    models.lifecycles.length > 0 ||
    models.pipeline !== null ||
    models.invariants.length > 0 ||
    models.strays.length > 0
  );
}

/**
 * Blank out fenced code blocks, preserving line structure. Tracks which
 * marker opened the fence (``` vs ~~~) so a mixed marker can't close it
 * early, and reports an unterminated fence — everything after one is
 * invisible to the parser, which must be a stray, never a silent opt-out.
 */
function stripFences(markdown: string): { text: string; unterminated: boolean } {
  let fenceMarker: "```" | "~~~" | null = null;
  const text = markdown
    .split("\n")
    .map((line) => {
      const open = /^\s*(```|~~~)/.exec(line);
      if (open) {
        const marker = open[1] as "```" | "~~~";
        if (fenceMarker === null) {
          fenceMarker = marker;
          return "";
        }
        if (fenceMarker === marker) {
          fenceMarker = null;
          return "";
        }
        // other marker inside an open fence — still fenced content
        return "";
      }
      return fenceMarker !== null ? "" : line;
    })
    .join("\n");
  return { text, unterminated: fenceMarker !== null };
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

/** Node names from the first column of a `| Node | Kind | … |` markdown table
 *  in a section body — header (`Node`) and separator (`---`) rows skipped,
 *  backticks stripped. Empty when the body has no table. Non-table lines (the
 *  `**AuthoredDag:**` field, prose) are ignored. */
function pipelineNodes(body: string): string[] {
  const nodes: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    const first = cells[0] ?? "";
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator row
    if (first.toLowerCase() === "node") continue; // header row
    const name = first.replace(/^`(.*)`$/, "$1").trim();
    if (name.length > 0) nodes.push(name);
  }
  return nodes;
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
): Stray[] {
  const strays: Stray[] = [];

  // Near-miss `##` section headings: start with a model-section word but
  // don't match the canonical heading exactly.
  for (const m of text.matchAll(/^##\s+((?:lifecycles?|pipelines?|invariants?)\b[^\n]*)$/gim)) {
    const line = m[0].trim();
    const exact = CANONICAL_SECTIONS.some((name) =>
      new RegExp(`^##\\s+${name}\\s*$`, "i").test(line)
    );
    if (!exact) {
      strays.push({ kind: "near-miss-heading", heading: line });
    }
  }

  // `###` headings inside a model section must match the block grammar.
  const blockGrammar: Array<{ s: Section | null; prefix: "LC" | "INV"; section: BlockSection }> = [
    { s: lifecycles, prefix: "LC", section: "Lifecycles" },
    { s: invariants, prefix: "INV", section: "Invariants" },
  ];
  for (const { s, prefix, section: sectionName } of blockGrammar) {
    if (s === null) continue;
    for (const m of s.body.matchAll(/^###\s+([^\n]+)$/gm)) {
      const heading = m[1].trim();
      if (!new RegExp(`^${prefix}-\\d+:\\s*.+$`).test(heading)) {
        strays.push({ kind: "bad-block-grammar", heading, section: sectionName, prefix });
      }
    }
  }

  // LC/INV-shaped headings outside their sections.
  for (const m of text.matchAll(/^###\s+((?:LC|INV)[-\s][^\n]*)$/gim)) {
    const idx = m.index ?? 0;
    const isLC = /^lc/i.test(m[1]);
    const home = isLC ? lifecycles : invariants;
    if (!inRange(idx, home)) {
      strays.push({
        kind: "misplaced-heading",
        heading: m[1].trim(),
        home: isLC ? "Lifecycles" : "Invariants",
      });
    }
  }

  // Model field labels outside their sections.
  const labelHomes: Array<{ label: string; s: Section | null; home: ModelSection }> = [
    { label: "Machine file", s: lifecycles, home: "Lifecycles" },
    { label: "AuthoredDag", s: pipeline, home: "Pipeline" },
    { label: "Rule file", s: invariants, home: "Invariants" },
    { label: "Tier", s: invariants, home: "Invariants" },
  ];
  for (const { label, s, home } of labelHomes) {
    for (const m of text.matchAll(new RegExp(`^\\*\\*${label}:\\*\\*[^\\n]*$`, "gim"))) {
      const idx = m.index ?? 0;
      if (!inRange(idx, s)) {
        strays.push({ kind: "misplaced-label", label, home });
      }
    }
  }

  return strays;
}

/** A section that opted in must contain at least one block heading */
function emptySectionStray(s: Section | null, section: BlockSection): Stray[] {
  if (s === null || /^###\s+/m.test(s.body)) return [];
  return [{ kind: "empty-section", section }];
}

export function parsePlanModels(markdown: string): PlanModels {
  const { text, unterminated } = stripFences(markdown);

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
    : {
        dagFile: fieldValue(pipelineSection.body, "AuthoredDag"),
        declaredNodes: pipelineNodes(pipelineSection.body),
      };

  const invariantsSection = section(text, "Invariants");
  const invariants: PlanInvariant[] = invariantsSection === null
    ? []
    : idBlocks(invariantsSection.body, "INV").map(({ id, title, block }) => ({
        id,
        title,
        tier: parseTier(fieldValue(block, "Tier")),
        ruleFile: fieldValue(block, "Rule file"),
      }));

  const strays: Stray[] = [
    ...(unterminated ? [{ kind: "unterminated-fence" } as const] : []),
    ...emptySectionStray(lifecyclesSection, "Lifecycles"),
    ...emptySectionStray(invariantsSection, "Invariants"),
    ...collectStrays(text, lifecyclesSection, pipelineSection, invariantsSection),
  ];

  return { lifecycles, pipeline, invariants, strays };
}
