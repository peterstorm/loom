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
 *                        `advisory` (prose, never enforced), each declaring its
 *                        owner module, sibling entry points and matrix test —
 *                        or `**Owner module:** none` with a reason
 *   - `## Contracts`   — `### CT-N: {title}` blocks, each naming a
 *                        declarations-only types file (or `none` with a
 *                        reason), the dedicated acceptance test files and the
 *                        Requirements each decides, optionally the entry
 *                        point those tests drive, and the statement
 *                        consumers rely on; frozen once observed red
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

import type {
  BlockSection,
  InvariantOwnership,
  ModelSection,
  OwnershipProblem,
  PlanInvariant,
  PlanInvariantTier,
  PlanLifecycle,
  PlanModels,
  PlanPipeline,
  SiblingEntryPoint,
  Stray,
  BlockPrefix,
  ContractAcceptanceFile,
  ContractDeclaration,
  ContractProblem,
  ContractTypes,
  PlanContract,
} from "../types";
import { isRepoRelativePlanPath, normalizePlanPath } from "./plan-path-match";
import { COVERABLE_ANCHOR } from "./acceptance-contract";

// The plan model data shapes live in types.ts (consumers that only need the
// shapes need not import the grammar). Only the shapes importers take through
// this module are re-exported; every other shape is imported from types.ts.
// The grammar itself lives in core/ — a domain grammar whose output carries
// invariants, like the Spec Index — so the orchestration shell that renders
// implementation briefs may parse the plan.
export type { PlanContract, PlanInvariant, PlanModels, Stray };

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
        `near-miss section heading '${heading}' — model sections must be exactly '## Lifecycles', '## Pipeline', '## Invariants', or '## Contracts'`,
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


export function hasModels(models: PlanModels): boolean {
  return (
    models.lifecycles.length > 0 ||
    models.pipeline !== null ||
    models.invariants.length > 0 ||
    models.contracts.length > 0 ||
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

/** Value of a `**{label}:** value` line inside a block, backticks stripped;
 *  null if the line is absent or its value is empty. The value never crosses
 *  the line break: an empty label must not capture the next line. */
function fieldValue(block: string, label: string): string | null {
  const re = new RegExp(`^\\*\\*${label}:\\*\\*[ \\t]*(.*)$`, "im");
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

/**
 * The `**Tier:**` line as its three real states. The raw text is kept on the
 * unrecognized arm — the error message names what the plan actually wrote.
 */
function parseTier(raw: string | null): PlanInvariantTier {
  if (raw === null) return { status: "absent" };
  const lowered = raw.toLowerCase();
  if (lowered === "checkable" || lowered === "advisory") return { status: "ok", tier: lowered };
  return { status: "unrecognized", raw };
}

/** A list-valued label in one block: absent, a value on the label line, or
 *  the `- ` item lines after it — blank lines before the first item allowed —
 *  up to the first line that is not an item. */
type LabelledList =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "inline"; value: string }>
  | Readonly<{ kind: "items"; items: readonly string[] }>;

function labelledList(block: string, label: RegExp): LabelledList {
  const lines = block.split("\n").map((line) => line.replace(/\r$/, ""));
  const at = lines.findIndex((line) => label.test(line));
  if (at === -1) return { kind: "absent" };
  const inline = lines[at]!.replace(label, "").trim();
  if (inline !== "") return { kind: "inline", value: inline };
  const after = lines.slice(at + 1);
  const firstItem = after.findIndex((line) => line.trim() !== "");
  const rest = firstItem === -1 ? [] : after.slice(firstItem);
  const end = rest.findIndex((line) => !line.startsWith("- "));
  return { kind: "items", items: end === -1 ? rest : rest.slice(0, end) };
}

/** The `**Sibling entry points:**` declaration of one block, in its four real
 *  states. `none` is a declared empty list; a bare label with no items is not. */
type SiblingDeclaration =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "empty" }>
  | Readonly<{ status: "malformed"; line: string }>
  | Readonly<{ status: "declared"; entries: readonly SiblingEntryPoint[] }>;

const SIBLING_LABEL = /^\*\*Sibling entry points:\*\*/i;
const SIBLING_ITEM = /^-\s+`?([^`\s]+)`?(?:\s+[—–-]\s+(.+?))?\s*$/;

/** `none` on the label line, or `- path — note` items. `none` belongs on the
 *  label line, never as an item. */
function siblingDeclaration(block: string): SiblingDeclaration {
  const list = labelledList(block, SIBLING_LABEL);
  if (list.kind === "absent") return { status: "absent" };
  if (list.kind === "inline") {
    return list.value.toLowerCase() === "none"
      ? { status: "declared", entries: [] }
      : { status: "malformed", line: list.value };
  }
  const entries: SiblingEntryPoint[] = [];
  for (const line of list.items) {
    const item = SIBLING_ITEM.exec(line);
    if (item === null || item[1]!.toLowerCase() === "none") return { status: "malformed", line };
    entries.push({ path: item[1]!, note: item[2]?.trim() ?? null });
  }
  return entries.length === 0 ? { status: "empty" } : { status: "declared", entries };
}

/**
 * The block's ownership declaration as its three real states. Every problem
 * decidable from the text is collected, so one validation run names all of
 * them — without an owner line, only a malformed sibling line is decidable,
 * since whether siblings and a matrix test are owed depends on the owner. An
 * owned or unowned value exists only when the declaration is complete and
 * consistent.
 */
function parseOwnership(block: string): InvariantOwnership {
  const owner = fieldValue(block, "Owner module");
  const reason = fieldValue(block, "Unowned reason");
  const matrixTest = fieldValue(block, "Matrix test");
  const siblings = siblingDeclaration(block);
  const malformedSibling: readonly OwnershipProblem[] =
    siblings.status === "malformed" ? [{ kind: "malformed-sibling", line: siblings.line }] : [];
  if (owner === null) return { kind: "malformed", problems: [{ kind: "missing-owner" }, ...malformedSibling] };

  if (owner.toLowerCase() === "none") {
    const ownerLabels = [
      ...(siblings.status === "absent" ? [] : ["Sibling entry points"]),
      ...(matrixTest === null ? [] : ["Matrix test"]),
    ];
    const labelProblems: readonly OwnershipProblem[] =
      ownerLabels.length > 0 ? [{ kind: "owner-fields-on-unowned", labels: ownerLabels }] : [];
    if (reason === null) return { kind: "malformed", problems: [{ kind: "unowned-without-reason" }, ...labelProblems] };
    const [first, ...rest] = labelProblems;
    return first === undefined ? { kind: "unowned", reason } : { kind: "malformed", problems: [first, ...rest] };
  }

  if (reason === null && siblings.status === "declared" && matrixTest !== null) {
    return { kind: "owned", owner, siblings: siblings.entries, matrixTest };
  }
  // Not owned, so at least one of these three is present.
  const [first, ...rest]: readonly OwnershipProblem[] = [
    ...(reason === null ? [] : [{ kind: "reason-on-owned" } as const]),
    ...match(siblings)
      .with({ status: "declared" }, () => [])
      .with({ status: "malformed" }, () => malformedSibling)
      .with({ status: "absent" }, { status: "empty" }, () => [{ kind: "missing-siblings" } as const])
      .exhaustive(),
    ...(matrixTest === null ? [{ kind: "missing-matrix-test" } as const] : []),
  ];
  return { kind: "malformed", problems: [first!, ...rest] };
}

/** The types surface, three states plus the problems decidable from the text. */
function contractTypes(block: string): Readonly<{ types: ContractTypes | null; problems: readonly ContractProblem[] }> {
  const file = fieldValue(block, "Types file");
  const reason = fieldValue(block, "No types reason");
  if (file === null) return { types: null, problems: [{ kind: "missing-types" }] };
  if (file.toLowerCase() === "none") {
    return reason === null
      ? { types: null, problems: [{ kind: "none-without-reason" }] }
      : { types: { kind: "none", reason }, problems: [] };
  }
  return reason === null
    ? { types: { kind: "file", path: normalizePlanPath(file) }, problems: [] }
    : { types: null, problems: [{ kind: "reason-with-types-file" }] };
}

const ACCEPTANCE_LABEL = /^\*\*Acceptance tests:\*\*/i;
const ACCEPTANCE_ITEM = /^-\s+`?([^`\s]+)`?\s+[—–-]\s+(.+?)\s*$/;

/** The `- path — FR-n, AS-n` items, every problem in them, and no file twice. */
function contractAcceptance(block: string): Readonly<{ files: readonly ContractAcceptanceFile[]; problems: readonly ContractProblem[] }> {
  const list = labelledList(block, ACCEPTANCE_LABEL);
  if (list.kind === "absent") return { files: [], problems: [{ kind: "missing-acceptance" }] };
  if (list.kind === "inline") return { files: [], problems: [{ kind: "malformed-acceptance", line: list.value }] };
  const files: ContractAcceptanceFile[] = [];
  const problems: ContractProblem[] = [];
  const seen = new Set<string>();
  for (const line of list.items) {
    const item = ACCEPTANCE_ITEM.exec(line);
    if (item === null) {
      problems.push({ kind: "malformed-acceptance", line });
      continue;
    }
    const path = normalizePlanPath(item[1]!);
    const anchors = item[2]!.split(",").map((anchor) => anchor.trim()).filter((anchor) => anchor !== "");
    problems.push(...anchors.filter((anchor) => !COVERABLE_ANCHOR.test(anchor))
      .map((anchor): ContractProblem => ({ kind: "invalid-anchor", path, anchor })));
    problems.push(...[...new Set(anchors.filter((anchor, index) => anchors.indexOf(anchor) !== index))]
      .map((anchor): ContractProblem => ({ kind: "duplicate-anchor", path, anchor })));
    if (seen.has(path)) problems.push({ kind: "duplicate-acceptance", path });
    seen.add(path);
    const [first, ...rest] = anchors.filter((anchor) => COVERABLE_ANCHOR.test(anchor));
    if (first !== undefined) files.push({ path, anchors: [first, ...rest] });
  }
  return files.length === 0 && problems.length === 0
    ? { files, problems: [{ kind: "missing-acceptance" }] }
    : { files, problems };
}

/**
 * One contract block as its two real states. Every problem decidable from the
 * text is collected, so one validation run names all of them; a declared value
 * exists only when the declaration is complete and consistent.
 */
function parseContract(block: string): ContractDeclaration {
  const { types, problems: typeProblems } = contractTypes(block);
  const { files, problems: acceptanceProblems } = contractAcceptance(block);
  const supportedDomain = fieldValue(block, "Supported domain");
  const rawEntryPoint = fieldValue(block, "Entry point");
  const entryPoint = rawEntryPoint === null ? null : normalizePlanPath(rawEntryPoint);
  const statement = fieldValue(block, "Statement");
  const domainProblems: readonly ContractProblem[] =
    supportedDomain !== null && files.length > 0 &&
    !files.some(({ path }) => path === normalizePlanPath(supportedDomain))
      ? [{ kind: "supported-domain-not-acceptance", path: supportedDomain }]
      : [];
  // Frozen paths are hashed through `join(root, path)`: only a path that stays
  // inside the repository may be frozen.
  const declaredPaths = [...(types?.kind === "file" ? [types.path] : []), ...files.map(({ path }) => path)];
  const unsafeProblems = [...declaredPaths, ...(entryPoint === null ? [] : [entryPoint])]
    .filter((path) => !isRepoRelativePlanPath(path))
    .map((path): ContractProblem => ({ kind: "unsafe-path", path }));
  // The entry point is production code the claimants build; a frozen path
  // cannot be it, because nothing may write a frozen path after the freeze.
  const entryProblems: readonly ContractProblem[] = entryPoint !== null && declaredPaths.includes(entryPoint)
    ? [{ kind: "entry-point-frozen", path: entryPoint }]
    : [];
  const [first, ...rest]: readonly ContractProblem[] = [
    ...typeProblems,
    ...acceptanceProblems,
    ...domainProblems,
    ...unsafeProblems,
    ...entryProblems,
    ...(statement === null ? [{ kind: "missing-statement" } as const] : []),
  ];
  if (first !== undefined) return { kind: "malformed", problems: [first, ...rest] };
  // No problem means every part parsed: types and statement are present and
  // at least one acceptance file was listed.
  const [head, ...tail] = files;
  return {
    kind: "declared",
    types: types!,
    acceptance: [head!, ...tail],
    supportedDomain: supportedDomain === null ? null : normalizePlanPath(supportedDomain),
    entryPoint,
    statement: statement!,
  };
}

const CANONICAL_SECTIONS = ["Lifecycles", "Pipeline", "Invariants", "Contracts"] as const;

function inRange(index: number, s: Section | null): boolean {
  return s !== null && index >= s.start && index < s.end;
}

/** Collect near-miss and misplaced model markers — see PlanModels.strays */
function collectStrays(
  text: string,
  lifecycles: Section | null,
  pipeline: Section | null,
  invariants: Section | null,
  contracts: Section | null,
): Stray[] {
  const strays: Stray[] = [];

  // Near-miss `##` section headings: start with a model-section word but
  // don't match the canonical heading exactly.
  for (const m of text.matchAll(/^##\s+((?:lifecycles?|pipelines?|invariants?|contracts?)\b[^\n]*)$/gim)) {
    const line = m[0].trim();
    const exact = CANONICAL_SECTIONS.some((name) =>
      new RegExp(`^##\\s+${name}\\s*$`, "i").test(line)
    );
    if (!exact) {
      strays.push({ kind: "near-miss-heading", heading: line });
    }
  }

  // `###` headings inside a model section must match the block grammar.
  const blockGrammar: Array<{ s: Section | null; prefix: BlockPrefix; section: BlockSection }> = [
    { s: lifecycles, prefix: "LC", section: "Lifecycles" },
    { s: invariants, prefix: "INV", section: "Invariants" },
    { s: contracts, prefix: "CT", section: "Contracts" },
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

  // LC/INV/CT-shaped headings outside their sections.
  for (const m of text.matchAll(/^###\s+((?:LC|INV|CT)[-\s][^\n]*)$/gim)) {
    const idx = m.index ?? 0;
    const home = blockGrammar.find(({ prefix }) => new RegExp(`^${prefix}[-\\s]`, "i").test(m[1]))!;
    if (!inRange(idx, home.s)) {
      strays.push({ kind: "misplaced-heading", heading: m[1].trim(), home: home.section });
    }
  }

  // Model field labels outside their sections.
  const labelHomes: Array<{ label: string; s: Section | null; home: ModelSection }> = [
    { label: "Machine file", s: lifecycles, home: "Lifecycles" },
    { label: "AuthoredDag", s: pipeline, home: "Pipeline" },
    { label: "Rule file", s: invariants, home: "Invariants" },
    { label: "Tier", s: invariants, home: "Invariants" },
    { label: "Owner module", s: invariants, home: "Invariants" },
    { label: "Unowned reason", s: invariants, home: "Invariants" },
    { label: "Sibling entry points", s: invariants, home: "Invariants" },
    { label: "Matrix test", s: invariants, home: "Invariants" },
    { label: "Types file", s: contracts, home: "Contracts" },
    { label: "No types reason", s: contracts, home: "Contracts" },
    { label: "Acceptance tests", s: contracts, home: "Contracts" },
    { label: "Supported domain", s: contracts, home: "Contracts" },
    { label: "Entry point", s: contracts, home: "Contracts" },
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
        statement: fieldValue(block, "Statement"),
        ownership: parseOwnership(block),
      }));

  const contractsSection = section(text, "Contracts");
  const contracts: PlanContract[] = contractsSection === null
    ? []
    : idBlocks(contractsSection.body, "CT").map(({ id, title, block }) => ({
        id,
        title,
        declaration: parseContract(block),
      }));

  const strays: Stray[] = [
    ...(unterminated ? [{ kind: "unterminated-fence" } as const] : []),
    ...emptySectionStray(lifecyclesSection, "Lifecycles"),
    ...emptySectionStray(invariantsSection, "Invariants"),
    ...emptySectionStray(contractsSection, "Contracts"),
    ...collectStrays(text, lifecyclesSection, pipelineSection, invariantsSection, contractsSection),
  ];

  return { lifecycles, pipeline, invariants, contracts, strays };
}
