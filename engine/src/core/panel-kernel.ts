/**
 * Panel kernel — the primitives every adversarial panel shares.
 *
 * Loom runs two panels: the architecture panel (`/loom --panel`) fans designers
 * across lenses and ranks their candidates; the review panel fans verifiers
 * across lenses and adjudicates a wave's findings. They differ in three ways
 * that matter — item identity (a closed, order-significant lens enum vs. an
 * open, unordered set of finding ids), criteria (interview-derived vs.
 * policy-set), and aggregate output (a total order vs. a per-item verdict).
 *
 * So this is NOT a `PanelKind<Context, Item, Payload, Decision>` descriptor
 * both panels instantiate. A descriptor general enough to cover both would
 * constrain almost nothing — it would buy indirection, not type safety. What
 * genuinely generalizes is the *envelope*: one agent's verdict on one
 * criterion, covering every item exactly once.
 *
 * That shape is shared only because of a deliberate choice in the review panel:
 * it spawns N verifiers each covering ALL findings, not N verifiers per
 * finding. Had it gone the other way the envelope would be trivial per call and
 * there would be nothing here worth extracting.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import { basename, join, normalize } from "node:path";

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

export const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
export const fail = <T>(errors: readonly string[]): ParseResult<T> => ({ ok: false, errors });

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Run layout — what one panel calls the files inside its run directory
// ---------------------------------------------------------------------------

/**
 * The file and directory names one panel uses inside its run directory.
 *
 * Pure data, so it lives with the parsers that give it meaning rather than with
 * the filesystem primitives that happen to consume it — the manifest parsers
 * used to hardcode `"interview.md"` / `"candidates"` while the shell declared
 * them as constants, with nothing comparing the two.
 *
 * `Panel` is a phantom tag, not decoration. `RunLayout<"architecture">` and
 * `RunLayout<"review">` are structurally identical, so without it the compiler
 * happily accepts `ARCHITECTURE_LAYOUT` where a review layout belongs and the
 * only thing separating the two panels is that both callers remember to pin a
 * module-scope constant.
 */
export interface RunLayout<Panel extends string = string> {
  /** Which panel this layout belongs to — the tag that keeps the two apart. */
  readonly panel: Panel;
  /** Human-readable context the panel was built from. */
  readonly contextMd: string;
  /** Its validated, canonical JSON form — the only version agents consume. */
  readonly contextJson: string;
  /** Directory holding the items the panel judges. */
  readonly itemDir: string;
  /** Directory holding one verdict file per criterion. */
  readonly verdictDir: string;
}

/** `/loom --panel`: an interview digest and one candidate per lens. */
export const ARCHITECTURE_LAYOUT: RunLayout<"architecture"> = Object.freeze({
  panel: "architecture",
  contextMd: "interview.md",
  contextJson: "interview.json",
  itemDir: "candidates",
  verdictDir: "verdicts",
});

/** The wave gate's refutation panel: a findings brief and the finding set. */
export const REVIEW_LAYOUT: RunLayout<"review"> = Object.freeze({
  panel: "review",
  contextMd: "brief.md",
  contextJson: "brief.json",
  itemDir: "findings",
  verdictDir: "verdicts",
});

// ---------------------------------------------------------------------------
// The run manifest — the item-set authority, shared by both panels
// ---------------------------------------------------------------------------

/**
 * One item the manifest names, bound to a run-scoped path.
 *
 * `Id` is the caller's own id type (`PanelLens`, `WaveFindingId`), threaded
 * through so the membership check below PROVES it. The entry id used to come
 * back as a bare string, and both consumers re-asserted their type with an `as`
 * cast justified by a "safe by construction" comment — a fact the compiler
 * already had and was being asked to forget.
 */
export interface RunManifestEntry<Id extends string = string> {
  readonly id: Id;
  readonly path: string;
  readonly filename: string;
}

export interface RunManifest<Id extends string = string> {
  readonly runId: string;
  readonly contextMd: string;
  readonly contextJson: string;
  readonly entries: readonly RunManifestEntry<Id>[];
}

/** How one panel names its manifest fields and derives its item filenames. */
export interface RunManifestSpec<Id extends string = string> {
  /** What the manifest is called in diagnostics, e.g. "panel manifest". */
  readonly label: string;
  /** The JSON field holding the context markdown path, e.g. "interview_file". */
  readonly contextMdKey: string;
  /** The JSON field holding the context JSON path, e.g. "interview_json". */
  readonly contextJsonKey: string;
  /** The JSON field holding the item array, e.g. "candidates". */
  readonly itemsKey: string;
  /** The JSON field inside an item holding its id, e.g. "lens". */
  readonly itemIdKey: string;
  /** Singular/plural noun for one item, e.g. ["candidate", "candidates"]. */
  readonly itemNoun: readonly [string, string];
  /** The exact ordered item set the manifest must name. */
  readonly expectedIds: readonly Id[];
  /** Run-scoped artifact filename for one item id. */
  readonly filenameOf: (id: Id) => string;
}

/**
 * Parse the exact item-set handoff and bind every path to one run root.
 *
 * The manifest fixes what a panel judges before any agent spawns, so an agent
 * can neither invent an item nor skip one. Both panels enforce the identical
 * rule set — run id, context paths, exact length, id membership, derived
 * filename, run-scoped path, uniqueness, order, and explicit "missing"
 * diagnostics — and they were maintained as two copies that had already
 * diverged: only one of them checked that every expected id was PRESENT by
 * name, which is the rule that makes an omitted item impossible.
 *
 * Every error is collected, for the same reason parseVerdictEnvelope collects
 * them: a re-run should learn all of its mistakes at once.
 */
export function parseRunManifest<Panel extends string, Id extends string>(
  raw: unknown,
  expectedRunDir: string,
  layout: RunLayout<Panel>,
  spec: RunManifestSpec<Id>,
): ParseResult<RunManifest<Id>> {
  if (!isRecord(raw)) return fail([`${spec.label} must be a JSON object`]);

  const [noun, nounPlural] = spec.itemNoun;
  const errors: string[] = [];
  const runDir = normalize(expectedRunDir);

  const runId = typeof raw.run_id === "string" ? raw.run_id.trim() : "";
  const contextMd = typeof raw[spec.contextMdKey] === "string" ? (raw[spec.contextMdKey] as string).trim() : "";
  const contextJson = typeof raw[spec.contextJsonKey] === "string" ? (raw[spec.contextJsonKey] as string).trim() : "";
  if (runId !== basename(runDir)) errors.push("manifest.run_id must equal the run directory basename");
  if (contextMd !== join(runDir, layout.contextMd)) {
    errors.push(`manifest.${spec.contextMdKey} must exactly equal <run-dir>/${layout.contextMd}`);
  }
  if (contextJson !== join(runDir, layout.contextJson)) {
    errors.push(`manifest.${spec.contextJsonKey} must exactly equal <run-dir>/${layout.contextJson}`);
  }

  const rawItems = raw[spec.itemsKey];
  if (!Array.isArray(rawItems) || rawItems.length !== spec.expectedIds.length) {
    errors.push(`manifest.${spec.itemsKey} must contain exactly ${spec.expectedIds.length} ${nounPlural}`);
  }

  const entries: RunManifestEntry<Id>[] = [];
  if (Array.isArray(rawItems)) {
    for (const [index, item] of rawItems.entries()) {
      const path = `manifest.${spec.itemsKey}[${index}]`;
      if (!isRecord(item)) {
        errors.push(`${path} must be an object`);
        continue;
      }
      const raw = typeof item[spec.itemIdKey] === "string" ? (item[spec.itemIdKey] as string).trim() : "";
      const itemPath = typeof item.path === "string" ? item.path.trim() : "";
      const filename = typeof item.filename === "string" ? item.filename.trim() : "";
      // Resolve against the expected set rather than testing membership: the
      // value that flows on is then the caller's own id type, proven, instead
      // of a string the caller has to re-assert with a cast.
      const id = spec.expectedIds.find((expected) => expected === raw);
      if (id === undefined) {
        errors.push(`${path}.${spec.itemIdKey} is not one of the expected ${nounPlural}: ${raw || "<empty>"}`);
        continue;
      }
      const expectedFilename = spec.filenameOf(id);
      if (filename !== expectedFilename) {
        errors.push(`${path}.filename must equal ${expectedFilename}`);
      }
      if (itemPath !== join(runDir, layout.itemDir, expectedFilename)) {
        errors.push(`${path}.path must exactly equal its run-scoped ${noun} path`);
      }
      entries.push({ id, path: itemPath, filename });
    }
  }

  const ids = entries.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) errors.push(`manifest ${noun} ids must be unique`);
  for (const expectedId of spec.expectedIds) {
    if (!ids.includes(expectedId)) errors.push(`manifest is missing ${noun}: ${expectedId}`);
  }
  if (ids.length === spec.expectedIds.length && ids.some((id, index) => id !== spec.expectedIds[index])) {
    errors.push(`manifest ${nounPlural} must exactly match: ${spec.expectedIds.join(", ")}`);
  }
  const filenames = entries.map((entry) => entry.filename);
  if (new Set(filenames).size !== filenames.length) errors.push(`manifest ${noun} filenames must be unique`);
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) errors.push(`manifest ${noun} paths must be unique`);

  return errors.length > 0 ? fail(errors) : ok({ runId, contextMd, contextJson, entries });
}

/**
 * Validated prose is substituted into agent prompt templates, where a surviving
 * `{identifier}` would be read as an unsubstituted placeholder and block the
 * spawn. Braces are stripped rather than escaped: no panel payload has a
 * legitimate use for them, and a stripped brace is visible in the output while
 * an escaped one is a new failure mode downstream.
 */
export const sanitizeProse = (value: string): string => value.replace(/[{}]/g, "").trim();

/** One agent's verdict on one criterion: an entry per item, each item once. */
export interface VerdictEnvelope<Payload> {
  readonly criterion: string;
  readonly entries: readonly Payload[];
}

/**
 * How one panel's envelope is named and how its per-item payload parses.
 *
 * Deliberately NOT carrying an `itemIdOf(payload)` accessor: the envelope
 * reads each item id from the RAW entry, before `parseEntry` runs. If coverage
 * were computed over successfully-parsed payloads instead, an entry naming a
 * real item but failing a payload rule (a score of 11, say) would report both
 * "score out of range" AND "missing item" for the same item — two errors, one
 * of them a lie about what the agent submitted.
 */
export interface VerdictEnvelopeSpec<Payload> {
  /** What the envelope is called in diagnostics, e.g. "judge verdict". */
  readonly label: string;
  /** The JSON field holding the per-item entries, e.g. "rankings". */
  readonly entriesKey: string;
  /** The JSON field inside an entry holding the item id, e.g. "candidate". */
  readonly itemIdKey: string;
  /** Singular/plural noun for one item, e.g. ["candidate", "candidates"]. */
  readonly itemNoun: readonly [string, string];
  /** Parse the payload-specific fields. `path` is the entry's error prefix. */
  readonly parseEntry: (raw: Record<string, unknown>, path: string) => ParseResult<Payload>;
  /** Rules over the entry SET (ordering, mutual consistency). Optional: the
   *  architecture panel requires non-increasing scores; review requires nothing. */
  readonly crossCheck?: (entries: readonly Payload[]) => readonly string[];
}

/**
 * Parse untrusted agent output into a canonical, substitution-safe envelope.
 *
 * Enforces, for every panel: valid JSON, an object, exact criterion identity,
 * an entries array of exactly the expected length, each expected item id
 * present exactly once, no foreign ids, no duplicates, explicit "missing"
 * diagnostics — and then whatever `crossCheck` adds.
 *
 * Every error is collected, not thrown at the first one: an agent re-spawned
 * with diagnostics should learn about all of its mistakes at once.
 */
export function parseVerdictEnvelope<Payload>(
  rawJson: string,
  expectedCriterion: string,
  expectedItemIds: readonly string[],
  spec: VerdictEnvelopeSpec<Payload>,
): ParseResult<VerdictEnvelope<Payload>> {
  const [noun, nounPlural] = spec.itemNoun;

  let raw: unknown;
  try {
    raw = JSON.parse(rawJson);
  } catch (error) {
    return fail([`${spec.label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`]);
  }
  if (!isRecord(raw)) return fail([`${spec.label} must be a JSON object`]);

  const errors: string[] = [];
  if (raw.criterion !== expectedCriterion) {
    errors.push(`criterion must equal ${JSON.stringify(expectedCriterion)}`);
  }

  const rawEntries = raw[spec.entriesKey];
  if (!Array.isArray(rawEntries)) {
    return fail([...errors, `${spec.entriesKey} must be an array`]);
  }
  if (rawEntries.length !== expectedItemIds.length) {
    errors.push(`${spec.entriesKey} must contain exactly ${expectedItemIds.length} ${nounPlural}`);
  }

  const expected = new Set(expectedItemIds);
  const seen = new Set<string>();
  const entries: Payload[] = [];

  for (const [index, rawEntry] of rawEntries.entries()) {
    const path = `${spec.entriesKey}[${index}]`;
    if (!isRecord(rawEntry)) {
      errors.push(`${path} must be an object`);
      continue;
    }

    const itemId = typeof rawEntry[spec.itemIdKey] === "string" ? (rawEntry[spec.itemIdKey] as string) : "";
    const known = expected.has(itemId);
    const duplicate = seen.has(itemId);
    if (!known) errors.push(`${path} has unknown ${noun}: ${itemId || "<empty>"}`);
    if (duplicate) errors.push(`${spec.entriesKey} contains duplicate ${noun}: ${itemId}`);
    seen.add(itemId);

    const payload = spec.parseEntry(rawEntry, path);
    if (!payload.ok) errors.push(...payload.errors);

    // Only fully-valid entries enter `entries`. A partially-valid entry would
    // have to carry a placeholder for whatever failed, and a placeholder is
    // exactly what `crossCheck` would then silently compare against — an
    // out-of-range score becoming NaN made every `<` comparison false, so the
    // ordering check passed on the data it was there to reject.
    if (known && !duplicate && payload.ok) entries.push(payload.value);
  }

  for (const itemId of expectedItemIds) {
    if (!seen.has(itemId)) errors.push(`${spec.entriesKey} is missing ${noun}: ${itemId}`);
  }
  errors.push(...(spec.crossCheck?.(entries) ?? []));

  return errors.length > 0 ? fail(errors) : ok({ criterion: expectedCriterion, entries });
}

/**
 * The criteria-set rule, one level up from a single envelope: the verdicts a
 * panel collected must cover the expected criteria exactly once each.
 *
 * This is the same coverage rule `parseVerdictEnvelope` enforces over items
 * INSIDE one verdict, applied to the verdict SET. Without it two verdicts
 * sharing a criterion silently produce a wrong aggregate — the per-verdict
 * check cannot see across verdicts, and nothing else was looking.
 *
 * `verdictCriteria` is matched to `expected` BY NAME, so the order verdicts
 * were collected in is irrelevant and a swapped pair is not an error.
 */
export function parseCriteriaSet(
  verdictCriteria: readonly string[],
  expected: readonly string[],
): ParseResult<void> {
  const errors: string[] = [];

  if (expected.length === 0) errors.push("criteria must be non-empty");
  if (new Set(expected).size !== expected.length) errors.push("criteria must be distinct");
  if (verdictCriteria.length !== expected.length) {
    errors.push(`expected exactly ${expected.length} verdict(s); received ${verdictCriteria.length}`);
  }

  const seen = new Set<string>();
  for (const criterion of verdictCriteria) {
    if (seen.has(criterion)) {
      errors.push(`duplicate verdict for criterion: ${criterion}`);
      continue;
    }
    if (!expected.includes(criterion)) {
      errors.push(`unexpected verdict criterion: ${criterion}`);
      continue;
    }
    seen.add(criterion);
  }
  for (const criterion of expected) {
    if (!seen.has(criterion)) errors.push(`missing verdict for criterion: ${criterion}`);
  }

  return errors.length > 0 ? fail(errors) : ok(undefined);
}

/**
 * Re-check that each collected verdict covers every item exactly once.
 *
 * `parseVerdictEnvelope` already enforced this when it parsed each verdict, so
 * this is redundant on the happy path and deliberately so: both aggregators are
 * exported and safe to call standalone, and a coverage rule that only holds
 * "when you came in through the front door" is the kind that silently stops
 * holding. Shared rather than duplicated per panel for the reason the criteria
 * rule is shared — a rule tightened in one copy and not the other is a
 * divergence nothing detects.
 */
export function coverageErrors<Payload>(
  byCriterion: ReadonlyMap<string, VerdictEnvelope<Payload>>,
  criteriaInOrder: readonly string[],
  expectedItemIds: readonly string[],
  itemIdOf: (entry: Payload) => string,
  requirement: string,
): string[] {
  const expected = new Set(expectedItemIds);
  const errors: string[] = [];
  for (const criterion of criteriaInOrder) {
    const verdict = byCriterion.get(criterion);
    if (!verdict) continue;
    const seen = new Set(verdict.entries.map(itemIdOf));
    const covers =
      verdict.entries.length === expectedItemIds.length &&
      seen.size === verdict.entries.length &&
      [...seen].every((id) => expected.has(id));
    if (!covers) errors.push(`verdict for '${criterion}' ${requirement}`);
  }
  return errors;
}

/**
 * The entry one criterion's verdict recorded for one item.
 *
 * Throws rather than defaulting when the entry is absent. Every caller runs
 * `coverageErrors` first, so a miss here is not a degraded input — it is a
 * broken invariant, and the plausible defaults it replaces (`?? 0` for a score,
 * "abstain" for a vote) are exactly the values that would change which
 * architecture wins or whether a finding survives, silently, if that guard were
 * ever weakened.
 */
export function requireEntry<Payload>(
  byCriterion: ReadonlyMap<string, VerdictEnvelope<Payload>>,
  criterion: string,
  itemId: string,
  itemIdOf: (entry: Payload) => string,
): Payload {
  const entry = byCriterion.get(criterion)?.entries.find((e) => itemIdOf(e) === itemId);
  if (entry === undefined) {
    throw new Error(
      `panel kernel invariant: verdict for '${criterion}' has no entry for '${itemId}' after coverage check`,
    );
  }
  return entry;
}
