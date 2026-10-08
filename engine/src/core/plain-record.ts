/**
 * The one shared exact-parse kernel for untrusted, JSON-shaped wire input.
 *
 * Two record guards, deliberately distinct:
 *
 * - `isRecord` — a non-null, non-array object. Prototype is NOT checked:
 *   parsed disk JSON always carries `Object.prototype`, and the lax wire
 *   parsers (panel kernel, state file, transcripts) only ask the shape question.
 * - `isPlainRecord` — additionally requires a `null` or `Object.prototype`
 *   prototype, so class instances, `Map`s and foreign-realm objects refuse.
 *
 * Two exact-key predicates, for parsers that word one refusal of their own,
 * mirror the two guards: `hasExactKeys` is the lax guard's (string keys only,
 * any prototype) and `hasExactPlainKeys` the strict guard's (a plain record
 * with no symbol keys) — exactly the records `parseExactRecord` admits.
 *
 * On top of the strict guard sit the two exact-shape parsers the completion
 * and verification aggregates share: `parseExactRecord` (exact own key set,
 * missing then surplus diagnostics) and `collectDenseArray` (no holes,
 * per-index diagnostics interleaved in index order).
 *
 * Per-site labels stay with the caller: a failure carries a typed `problem`
 * and only the diagnostics every caller words identically. Each caller lifts
 * that into its own result shape, so persisted error text stays byte-stable.
 * Two lifting helpers keep those adapters one line long:
 * `exactRecordErrors` renders a failure as diagnostics, taking the caller's
 * own record noun ("an object", "a plain object") for the not-a-record case;
 * `toElementResult` narrows a caller's `{ ok, error: { errors } }` result to
 * the `ElementResult` that `collectDenseArray` consumes.
 *
 * Descriptor-level snapshots that refuse getters and return `null` instead of
 * diagnostics live in `exact-data.ts`; that module reuses `isPlainRecord`.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

export type UnknownRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isPlainRecord(value: unknown): value is UnknownRecord {
  if (!isRecord(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

/**
 * The diagnostic-free exact-key predicate for the lax guard: the record's own
 * string keys — enumerable or not — are exactly the SET named by `keys`, in any
 * order, with no prototype check. Symbol keys are not compared.
 *
 * The expected list is read as a set, so a repeated name is the same key named
 * twice, never an unsatisfiable length; the invariant lives here, not in every
 * call site's literal list. A non-enumerable own key counts like any other: a
 * hidden surplus key refuses, and a hidden expected key is present.
 *
 * For callers that word their own single refusal; callers that report
 * per-field missing/surplus diagnostics use `parseExactRecord`.
 */
export function hasExactKeys(record: Readonly<UnknownRecord>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  const own = Object.getOwnPropertyNames(record);
  return own.length === expected.size && own.every((key) => expected.has(key));
}

/**
 * The exact-key predicate for the strict guard: a plain record (`null` or
 * `Object.prototype` prototype) whose own keys are exactly the SET named by
 * `keys` — any own symbol key refuses, where `hasExactKeys` ignores it. It is
 * `parseExactRecord`'s verdict by construction (same checks, same inspection
 * order, diagnostics discarded), so a caller that words one refusal of its own
 * can never admit a record the diagnostic parser refuses.
 */
export function hasExactPlainKeys(raw: unknown, keys: readonly string[]): raw is UnknownRecord {
  return parseExactRecord(raw, keys, "").ok;
}

export type ExactRecordResult =
  | Readonly<{ ok: true; value: UnknownRecord }>
  | Readonly<{ ok: false; problem: "not-plain-record" }>
  | Readonly<{ ok: false; problem: "field-mismatch"; errors: readonly [string, ...string[]] }>;

/**
 * Admit exactly `fields` as own string keys of a plain record. Every absent
 * field is reported (`${path}.${field} is required`) before every foreign own
 * key, symbols included (`${path}.${key} is not allowed`). The input itself is
 * returned on success — callers read fields from it, nothing is copied.
 */
export function parseExactRecord(raw: unknown, fields: readonly string[], path: string): ExactRecordResult {
  if (!isPlainRecord(raw)) return Object.freeze({ ok: false, problem: "not-plain-record" });
  const expected = new Set(fields);
  const missing = fields
    .filter((field) => !Object.prototype.hasOwnProperty.call(raw, field))
    .map((field) => `${path}.${field} is required`);
  const surplus = Reflect.ownKeys(raw).flatMap((key) =>
    typeof key === "string" && expected.has(key) ? [] : [`${path}.${String(key)} is not allowed`]);
  const [head, ...tail] = [...missing, ...surplus];
  if (head === undefined) return Object.freeze({ ok: true, value: raw });
  const errors: readonly [string, ...string[]] = Object.freeze([head, ...tail]);
  return Object.freeze({ ok: false, problem: "field-mismatch", errors });
}

/**
 * Render a `parseExactRecord` failure as diagnostics. The not-a-record case
 * reads `${path} must be ${recordNoun}`; the noun is the caller's own wording.
 * A field mismatch returns its missing-then-surplus diagnostics unchanged.
 */
export function exactRecordErrors(
  failure: Extract<ExactRecordResult, { ok: false }>,
  path: string,
  recordNoun: string,
): readonly [string, ...string[]] {
  return failure.problem === "not-plain-record" ? [`${path} must be ${recordNoun}`] : failure.errors;
}

export type ElementResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; errors: readonly string[] }>;

/** Narrow a caller's `{ ok, error: { errors } }` result to an `ElementResult`; success passes through as-is. */
export function toElementResult<T>(
  parsed: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: Readonly<{ errors: readonly string[] }> }>,
): ElementResult<T> {
  return parsed.ok ? parsed : Object.freeze({ ok: false, errors: parsed.error.errors });
}

export type DenseArrayCollection<T> =
  | Readonly<{ kind: "not-array" }>
  | Readonly<{ kind: "array"; values: readonly T[]; errors: readonly string[] }>;

/**
 * Walk an array index by index. A hole contributes `${path}[${index}] must be
 * present`; a present element is handed to `parseElement` with its indexed
 * path. Accepted values and all diagnostics come back together, in index
 * order, so callers can still run set-level rules over the accepted values.
 */
export function collectDenseArray<T>(
  raw: unknown,
  path: string,
  parseElement: (value: unknown, elementPath: string) => ElementResult<T>,
): DenseArrayCollection<T> {
  if (!Array.isArray(raw)) return Object.freeze({ kind: "not-array" });
  const values: T[] = [];
  const errors: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const elementPath = `${path}[${index}]`;
    if (!Object.prototype.hasOwnProperty.call(raw, index)) {
      errors.push(`${elementPath} must be present`);
      continue;
    }
    const parsed = parseElement(raw[index], elementPath);
    if (parsed.ok) values.push(parsed.value);
    else errors.push(...parsed.errors);
  }
  return Object.freeze({ kind: "array", values: Object.freeze(values), errors: Object.freeze(errors) });
}
