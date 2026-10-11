/**
 * Compiler-in-the-loop type diagnostics, advisory form (vault lever I5,
 * narrowed): after an edit lands, tell the implementer what no longer
 * typechecks while the fix is one tool call away instead of one wave gate.
 *
 * It never blocks. A blocking type gate gives a model an unbounded retry
 * surface; this one adds context and, when the same diagnostics survive
 * consecutive edits, escalates a repeat reminder instead.
 *
 * Two rules keep it from becoming noise:
 * - Errors in OTHER files are reported only when this edit introduced them,
 *   judged against the previous completed run (a project that already has
 *   errors elsewhere does not nag on every edit; a broken caller does).
 * - Diagnostics are identified by file, code and message, never by line, so
 *   moving code is not a new error and does not reset the repeat count.
 *
 * Remedies are written per diagnostic code, in Loom's vocabulary: the
 * compiler supplies the numbers, this module supplies the words.
 *
 * Pure module: no I/O, no clock, no randomness. The shell
 * (handlers/type-diagnostics-runner.ts) runs `tsc`, loads and stores memory.
 */

import { match } from "ts-pattern";
import { isAbsolute, relative, resolve } from "node:path";

export type TypeDiagnostic = Readonly<{
  /** Absolute path. */
  file: string;
  line: number;
  column: number;
  code: number;
  message: string;
}>;

/** A diagnostic tsc could not attach to a file: configuration and option errors. */
export type GlobalTypeDiagnostic = Readonly<{ code: number; message: string }>;

export type TypeCheckOutcome =
  /** tsc ran to completion; `diagnostics` is the whole program's located set. */
  | Readonly<{ kind: "completed"; diagnostics: readonly TypeDiagnostic[]; global: readonly GlobalTypeDiagnostic[] }>
  /** Not a checkable situation (no tsconfig, no project TypeScript). Silent by design. */
  | Readonly<{ kind: "unavailable"; reason: string }>
  /** Another check of the same project is still running (a cold build warming the cache). */
  | Readonly<{ kind: "busy" }>
  | Readonly<{ kind: "timed-out"; afterMs: number }>
  | Readonly<{ kind: "failed"; reason: string }>;

export type RepeatRecord = Readonly<{ fingerprint: string; consecutive: number }>;

/** What survives between runs for one tsconfig. */
export type TypeCheckMemory = Readonly<{
  /** Identity keys of every located diagnostic in the last completed run. */
  diagnosticKeys: readonly string[];
  /** Per touched file: how many consecutive edits left the same diagnostics. */
  repeats: Readonly<Record<string, RepeatRecord>>;
}>;

export type TypeAdvisory = Readonly<{
  /** Context the implementing model must see, or null when there is nothing to say. */
  forModel: string | null;
  /** A note for the operator (the check could not run), never shown to the model. */
  forOperator: string | null;
}>;

export const REPEAT_THRESHOLDS = [3, 5, 8] as const;
const MAX_TOUCHED_LISTED = 8;
const MAX_OTHER_LISTED = 5;

const TS_SOURCE = /\.(?:ts|tsx|mts|cts)$/;
const DECLARATION = /\.d\.(?:ts|mts|cts)$/;

/** Files whose edits the type check covers: TypeScript sources, not declarations. */
export function isTypeScriptSource(path: string): boolean {
  return TS_SOURCE.test(path) && !DECLARATION.test(path);
}

// ── Parsing ────────────────────────────────────────────────────────────

const LOCATED = /^(.+?)\((\d+),(\d+)\): error TS(\d+): (.*)$/;
const GLOBAL = /^error TS(\d+): (.*)$/;
const CONTINUATION = /^\s+\S/;

type Parsed = Readonly<{ located: readonly TypeDiagnostic[]; global: readonly GlobalTypeDiagnostic[] }>;

/** Parse `tsc --pretty false` output. Relative paths resolve against `projectDir`. Total. */
export function parseTscOutput(output: string, projectDir: string): Parsed {
  const located: TypeDiagnostic[] = [];
  const global: GlobalTypeDiagnostic[] = [];
  let last: { list: "located" | "global"; index: number } | null = null;

  for (const line of output.split(/\r?\n/)) {
    const at = LOCATED.exec(line);
    if (at) {
      const [, file, row, column, code, message] = at;
      const lineNumber = Number(row);
      const columnNumber = Number(column);
      if (lineNumber < 1 || columnNumber < 1) { last = null; continue; }
      located.push({
        file: isAbsolute(file!) ? resolve(file!) : resolve(projectDir, file!),
        line: lineNumber,
        column: columnNumber,
        code: Number(code),
        message: message!,
      });
      last = { list: "located", index: located.length - 1 };
      continue;
    }
    const projectLevel = GLOBAL.exec(line);
    if (projectLevel) {
      global.push({ code: Number(projectLevel[1]), message: projectLevel[2]! });
      last = { list: "global", index: global.length - 1 };
      continue;
    }
    if (last && CONTINUATION.test(line)) {
      const list: { message: string }[] = last.list === "located" ? located : global;
      const previous = list[last.index]!;
      list[last.index] = { ...previous, message: `${previous.message}\n${line}` };
      continue;
    }
    last = null;
  }
  return { located, global };
}

// ── Remedies ───────────────────────────────────────────────────────────

const REMEDIES: ReadonlyMap<number, string> = new Map([
  [2307, "Check the import path. If the module belongs to another Task and does not exist yet, import from the plan's frozen contract instead of creating it."],
  [2304, "Import the name from the module that declares it, or check its spelling. Do not declare a local stand-in."],
  [2305, "Read the module's actual exports. Import an existing export; do not invent a re-export to satisfy this import."],
  [2724, "Read the module's actual exports. Import an existing export; do not invent a re-export to satisfy this import."],
  [2339, "Read the type's declaration. On a union, narrow on its discriminant (match/switch) before reading a variant's field."],
  [2322, "Read both types' declarations and fix how the value is constructed, or parse it at the boundary. Never silence it with `as`."],
  [2345, "Read the callee's parameter type and fix the argument, or parse it at the boundary. Never silence it with `as`."],
  [2532, "Handle the absent case explicitly (early return or match) instead of asserting it away with `!`."],
  [18048, "Handle the absent case explicitly (early return or match) instead of asserting it away with `!`."],
  [2531, "Handle the null case explicitly (early return or match) instead of asserting it away with `!`."],
  [18047, "Handle the null case explicitly (early return or match) instead of asserting it away with `!`."],
  [7006, "Annotate the parameter with its domain type."],
  [2366, "Make the branching exhaustive: `.exhaustive()` on a ts-pattern match, or a `never` binding in the default case."],
  [7030, "Make the branching exhaustive: `.exhaustive()` on a ts-pattern match, or a `never` binding in the default case."],
  [2741, "Supply the required field. Read the type's declaration for what it must hold."],
  [6133, "Delete the unused declaration. Prefix an intentionally unused parameter with `_`."],
  [2554, "Read the function's current signature. Fix this call site to match it; change the signature only if the plan says so."],
]);

export function remedyFor(code: number): string | undefined {
  return REMEDIES.get(code);
}

// ── Judging ────────────────────────────────────────────────────────────

const keyOf = (d: TypeDiagnostic): string => `${d.file}\u0000${d.code}\u0000${d.message}`;

/** Order- and line-insensitive identity of a diagnostic set. */
const fingerprintOf = (diagnostics: readonly TypeDiagnostic[]): string =>
  [...new Set(diagnostics.map(keyOf))].sort().join("\u0001");

function nextRepeat(previous: RepeatRecord | undefined, touched: readonly TypeDiagnostic[]): RepeatRecord | null {
  if (touched.length === 0) return null;
  const fingerprint = fingerprintOf(touched);
  return previous?.fingerprint === fingerprint
    ? { fingerprint, consecutive: previous.consecutive + 1 }
    : { fingerprint, consecutive: 1 };
}

function repeatReminder(consecutive: number): string | null {
  const reached = REPEAT_THRESHOLDS.filter((threshold) => consecutive >= threshold).at(-1);
  if (reached === undefined) return null;
  const lead = `These same type errors have survived ${consecutive} consecutive edits of this file.`;
  return match(reached)
    .with(3, () => `${lead} Stop patching at the error site: read the declarations the messages name, then fix the cause.`)
    .with(5, () => `${lead} The current approach is not converging: re-read the Task, the types and their callers, and change approach rather than editing again.`)
    .with(8, () => `${lead} Stop editing this file. Report the blocking type errors and what you tried in your final message instead of retrying.`)
    .exhaustive();
}

const displayPath = (file: string, projectDir: string): string => {
  const rel = relative(projectDir, file);
  return rel.startsWith("..") || isAbsolute(rel) ? file : rel;
};

function renderDiagnostic(d: TypeDiagnostic, prefix: string): readonly string[] {
  const remedy = remedyFor(d.code);
  const [head, ...rest] = d.message.split("\n");
  return [
    `${prefix}${d.line}:${d.column} TS${d.code} ${head}`,
    ...rest.map((line) => `${prefix}  ${line.trim()}`),
    ...(remedy ? [`${prefix}  → ${remedy}`] : []),
  ];
}

function renderForModel(
  touchedFile: string,
  touched: readonly TypeDiagnostic[],
  introducedElsewhere: readonly TypeDiagnostic[],
  reminder: string | null,
  projectDir: string,
): string {
  const lines: string[] = [
    "⚠ TYPE DIAGNOSTICS (advisory — the edit landed and is not blocked, but the code does not typecheck yet; fix it before you finish):",
  ];
  if (touched.length > 0) {
    lines.push(displayPath(touchedFile, projectDir));
    for (const d of touched.slice(0, MAX_TOUCHED_LISTED)) lines.push(...renderDiagnostic(d, "  "));
    if (touched.length > MAX_TOUCHED_LISTED) lines.push(`  … ${touched.length - MAX_TOUCHED_LISTED} more in this file`);
  }
  if (introducedElsewhere.length > 0) {
    lines.push(`This edit also introduced ${introducedElsewhere.length} error(s) in other files:`);
    for (const d of introducedElsewhere.slice(0, MAX_OTHER_LISTED)) {
      lines.push(`  ${displayPath(d.file, projectDir)}`, ...renderDiagnostic(d, "    "));
    }
    if (introducedElsewhere.length > MAX_OTHER_LISTED) lines.push(`  … ${introducedElsewhere.length - MAX_OTHER_LISTED} more`);
  }
  if (reminder) lines.push(reminder);
  return lines.join("\n");
}

export type TypeCheckJudgement = Readonly<{ advisory: TypeAdvisory; memory: TypeCheckMemory | null }>;

/**
 * Judge one run for one touched file against the previous run's memory.
 * Memory changes only on a completed run; any other outcome leaves it as is.
 */
export function judgeTypeCheck(input: Readonly<{
  touchedFile: string;
  outcome: TypeCheckOutcome;
  memory: TypeCheckMemory | null;
  /** The tsconfig's directory: paths are shown relative to it. */
  projectDir: string;
}>): TypeCheckJudgement {
  const { touchedFile, outcome, memory, projectDir } = input;
  const unchanged = (forOperator: string | null): TypeCheckJudgement =>
    ({ advisory: { forModel: null, forOperator }, memory });

  return match(outcome)
    .with({ kind: "unavailable" }, { kind: "busy" }, () => unchanged(null))
    .with({ kind: "timed-out" }, ({ afterMs }) => unchanged(
      `Loom type diagnostics skipped: tsc did not finish within ${Math.round(afterMs / 1000)}s. ` +
      "A cold run builds the incremental cache in the background; later edits are faster.",
    ))
    .with({ kind: "failed" }, ({ reason }) => unchanged(`Loom type diagnostics could not run: ${reason}`))
    .with({ kind: "completed" }, ({ diagnostics, global }) => {
      const touched = diagnostics.filter((d) => d.file === touchedFile);
      const baseline = memory === null ? null : new Set(memory.diagnosticKeys);
      const introducedElsewhere = baseline === null
        ? []
        : diagnostics.filter((d) => d.file !== touchedFile && !baseline.has(keyOf(d)));

      const repeat = nextRepeat(memory?.repeats[touchedFile], touched);
      const { [touchedFile]: _previous, ...otherRepeats } = memory?.repeats ?? {};
      const nextMemory: TypeCheckMemory = {
        diagnosticKeys: [...new Set(diagnostics.map(keyOf))].sort(),
        repeats: repeat === null ? otherRepeats : { ...otherRepeats, [touchedFile]: repeat },
      };

      const forModel = touched.length === 0 && introducedElsewhere.length === 0
        ? null
        : renderForModel(touchedFile, touched, introducedElsewhere, repeat && repeatReminder(repeat.consecutive), projectDir);
      const forOperator = global.length === 0
        ? null
        : `Loom type diagnostics: tsc reported project-level errors: ${global.map((g) => `TS${g.code} ${g.message}`).join("; ")}`;
      return { advisory: { forModel, forOperator }, memory: nextMemory };
    })
    .exhaustive();
}

// ── Memory parsing ─────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseRepeat(value: unknown): RepeatRecord | null {
  if (!isRecord(value)) return null;
  const { fingerprint, consecutive } = value;
  return typeof fingerprint === "string" && typeof consecutive === "number" && Number.isInteger(consecutive) && consecutive >= 1
    ? { fingerprint, consecutive }
    : null;
}

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Parse stored memory; anything malformed is treated as no memory. */
export function parseTypeCheckMemory(raw: unknown): TypeCheckMemory | null {
  if (!isRecord(raw)) return null;
  const { diagnosticKeys, repeats } = raw;
  if (!isStringArray(diagnosticKeys)) return null;
  if (!isRecord(repeats)) return null;
  const parsed: Record<string, RepeatRecord> = {};
  for (const [file, record] of Object.entries(repeats)) {
    const repeat = parseRepeat(record);
    if (repeat === null) return null;
    parsed[file] = repeat;
  }
  return { diagnosticKeys, repeats: parsed };
}
