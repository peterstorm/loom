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

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

export const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
export const fail = <T>(errors: readonly string[]): ParseResult<T> => ({ ok: false, errors });

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
