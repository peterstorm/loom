/**
 * Parse executable-model declarations out of an architecture plan document.
 *
 * Phase C ("executable models only"): plans may declare three kinds of model,
 * each opt-in via a dedicated `##` section:
 *
 *   - `## Lifecycles`  — `### LC-N: {title}` blocks, each binding a lifecycle
 *                        to a machine file the implementation imports and runs
 *   - `## Pipeline`    — an `**AuthoredDag:**` sidecar authored by the
 *                        architecture phase (validated deeply by fugue, not loom)
 *   - `## Invariants`  — `### INV-N: {title}` blocks tiered `checkable`
 *                        (bound to a lint-rule file, enforced fail-closed) or
 *                        `advisory` (prose, never enforced)
 *
 * The parser is total and pure: malformed declarations are represented (null
 * fields), never thrown. Judgment lives in validate-task-graph's binding
 * checks. Absent sections mean the plan opted out — no models, no checks.
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
}

export function hasModels(models: PlanModels): boolean {
  return models.lifecycles.length > 0 || models.pipeline !== null || models.invariants.length > 0;
}

/** Extract the body of a `## {heading}` section (up to the next `## ` heading), or null */
function sectionBody(markdown: string, heading: string): string | null {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, "im");
  const m = re.exec(markdown);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = markdown.slice(start);
  const next = /^##\s+/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
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

export function parsePlanModels(markdown: string): PlanModels {
  const lifecyclesBody = sectionBody(markdown, "Lifecycles");
  const lifecycles: PlanLifecycle[] = lifecyclesBody === null
    ? []
    : idBlocks(lifecyclesBody, "LC").map(({ id, title, block }) => ({
        id,
        title,
        machineFile: fieldValue(block, "Machine file"),
      }));

  const pipelineBody = sectionBody(markdown, "Pipeline");
  const pipeline: PlanPipeline | null = pipelineBody === null
    ? null
    : { dagFile: fieldValue(pipelineBody, "AuthoredDag") };

  const invariantsBody = sectionBody(markdown, "Invariants");
  const invariants: PlanInvariant[] = invariantsBody === null
    ? []
    : idBlocks(invariantsBody, "INV").map(({ id, title, block }) => ({
        id,
        title,
        tier: parseTier(fieldValue(block, "Tier")),
        ruleFile: fieldValue(block, "Rule file"),
      }));

  return { lifecycles, pipeline, invariants };
}
