/**
 * Compiler-in-the-loop type diagnostics, advisory form (vault lever I5,
 * narrowed): after an edit lands, tell the implementer what no longer
 * typechecks while the fix is one tool call away instead of one wave gate.
 *
 * It never blocks. A blocking type gate gives a model an unbounded retry
 * surface; this one adds context and, when the same diagnostics survive
 * consecutive edits, escalates a repeat reminder instead.
 *
 * Three rules keep it from becoming noise:
 * - Errors in OTHER files are reported only when this edit introduced them,
 *   judged against the previous completed run (a project that already has
 *   errors elsewhere does not nag on every edit; a broken caller does).
 * - Diagnostics are identified by file, code and message, never by line, so
 *   moving code is not a new error and does not reset the repeat count. The
 *   identity is a multiset: a second identical error on another line counts.
 * - Memory is only trusted within REPEAT_WINDOW_MS. Memory lives per tsconfig
 *   in the user cache and outlives any one session, so an older baseline or
 *   repeat record belongs to someone else's edits and is not held against
 *   this one.
 *
 * Remedies are written per diagnostic code, in Loom's vocabulary: the
 * compiler supplies the numbers, this module supplies the words.
 *
 * Pure module: no I/O, no clock, no randomness — `now` is an input. The shell
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

/** How many consecutive edits of one file left the same diagnostics, as of `at` (epoch ms). */
export type RepeatRecord = Readonly<{ fingerprint: string; consecutive: number; at: number }>;

/** What survives between runs for one tsconfig. */
export type TypeCheckMemory = Readonly<{
  /** When the completed run that produced this memory was judged (epoch ms). */
  recordedAt: number;
  /** Identity keys of every located diagnostic in that run, as a sorted multiset. */
  diagnosticKeys: readonly string[];
  /** Per touched file: the repeat record of its last judged edit. */
  repeats: Readonly<Record<string, RepeatRecord>>;
}>;

/**
 * Two independent channels. Every combination is meaningful: nothing to say,
 * model only, operator only (the check could not run), or both.
 */
export type TypeAdvisory = Readonly<{
  /** Context the implementing model must see, or null when there is nothing to say. */
  forModel: string | null;
  /** A note for the operator, never shown to the model. */
  forOperator: string | null;
}>;

export const NO_ADVISORY: TypeAdvisory = { forModel: null, forOperator: null };

/** The advisory for one landed edit of an absolute file path. */
export type AdviseOnEdit = (file: string) => Promise<TypeAdvisory>;

export const REPEAT_THRESHOLDS = [3, 5, 8] as const;
/** How long a baseline or repeat record stays attributable to the current edits. */
export const REPEAT_WINDOW_MS = 30 * 60_000;
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

/** How a tsc process ended: an exit code, or the signal that stopped it. */
export type TscExit = Readonly<{ code: number | null; signal: string | null }>;

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim().slice(0, 300) ?? "";
}

const withDetail = (reason: string, output: string): string => {
  const detail = firstLine(output);
  return detail ? `${reason}: ${detail}` : reason;
};

/**
 * Classify one finished tsc run. Exit 0 is a clean program; exit 1 or 2 is a
 * completed run only when it produced diagnostics — tsc reports type errors
 * with those codes, but a crashing Node process exits 1 too, and treating
 * that as "clean" would silently reset memory and say nothing.
 */
export function outcomeOfTscExit(exit: TscExit, output: string, projectDir: string): TypeCheckOutcome {
  if (exit.code === 0) {
    const parsed = parseTscOutput(output, projectDir);
    return { kind: "completed", diagnostics: parsed.located, global: parsed.global };
  }
  if (exit.code === 1 || exit.code === 2) {
    const parsed = parseTscOutput(output, projectDir);
    return parsed.located.length === 0 && parsed.global.length === 0
      ? { kind: "failed", reason: withDetail(`tsc exited with ${exit.code} without diagnostics`, output) }
      : { kind: "completed", diagnostics: parsed.located, global: parsed.global };
  }
  return { kind: "failed", reason: withDetail(`tsc exited with ${exit.code ?? exit.signal}`, output) };
}

// ── Remedies ───────────────────────────────────────────────────────────

const EXPORT_REMEDY = "Read the module's actual exports. Import an existing export; do not invent a re-export to satisfy this import.";
const ABSENT_REMEDY = "Handle the absent case explicitly (early return or match) instead of asserting it away with `!`.";
const NULL_REMEDY = "Handle the null case explicitly (early return or match) instead of asserting it away with `!`.";
const EXHAUSTIVE_REMEDY = "Make the branching exhaustive: `.exhaustive()` on a ts-pattern match, or a `never` binding in the default case.";

const REMEDIES: ReadonlyMap<number, string> = new Map([
  [2307, "Check the import path. If the module belongs to another Task and does not exist yet, import from the plan's frozen contract instead of creating it."],
  [2304, "Import the name from the module that declares it, or check its spelling. Do not declare a local stand-in."],
  [2305, EXPORT_REMEDY],
  [2724, EXPORT_REMEDY],
  [2339, "Read the type's declaration. On a union, narrow on its discriminant (match/switch) before reading a variant's field."],
  [2322, "Read both types' declarations and fix how the value is constructed, or parse it at the boundary. Never silence it with `as`."],
  [2345, "Read the callee's parameter type and fix the argument, or parse it at the boundary. Never silence it with `as`."],
  [2532, ABSENT_REMEDY],
  [18048, ABSENT_REMEDY],
  [2531, NULL_REMEDY],
  [18047, NULL_REMEDY],
  [7006, "Annotate the parameter with its domain type."],
  [2366, EXHAUSTIVE_REMEDY],
  [7030, EXHAUSTIVE_REMEDY],
  [2741, "Supply the required field. Read the type's declaration for what it must hold."],
  [6133, "Delete the unused declaration. Prefix an intentionally unused parameter with `_`."],
  [2554, "Read the function's current signature. Fix this call site to match it; change the signature only if the plan says so."],
]);

export function remedyFor(code: number): string | undefined {
  return REMEDIES.get(code);
}

// ── Judging ────────────────────────────────────────────────────────────

const keyOf = (d: TypeDiagnostic): string => `${d.file}\u0000${d.code}\u0000${d.message}`;

/** Order- and line-insensitive identity of a diagnostic multiset. */
const identityKeys = (diagnostics: readonly TypeDiagnostic[]): readonly string[] =>
  diagnostics.map(keyOf).sort();

const fingerprintOf = (diagnostics: readonly TypeDiagnostic[]): string => identityKeys(diagnostics).join("\u0001");

const withinWindow = (at: number, now: number): boolean => now - at <= REPEAT_WINDOW_MS;

/** Diagnostics in `candidates` beyond what the baseline multiset already held. */
function introducedSince(baseline: readonly string[], candidates: readonly TypeDiagnostic[]): readonly TypeDiagnostic[] {
  const remaining = new Map<string, number>();
  for (const key of baseline) remaining.set(key, (remaining.get(key) ?? 0) + 1);
  return candidates.filter((d) => {
    const count = remaining.get(keyOf(d)) ?? 0;
    if (count === 0) return true;
    remaining.set(keyOf(d), count - 1);
    return false;
  });
}

function nextRepeat(previous: RepeatRecord | undefined, touched: readonly TypeDiagnostic[], now: number): RepeatRecord | null {
  if (touched.length === 0) return null;
  const fingerprint = fingerprintOf(touched);
  const continues = previous !== undefined && previous.fingerprint === fingerprint && withinWindow(previous.at, now);
  return { fingerprint, consecutive: continues ? previous.consecutive + 1 : 1, at: now };
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

/** What the shell does with stored memory after a judgement. */
export type MemoryUpdate =
  | Readonly<{ kind: "keep" }>
  | Readonly<{ kind: "replace"; memory: TypeCheckMemory }>;

export type TypeCheckJudgement = Readonly<{ advisory: TypeAdvisory; memoryUpdate: MemoryUpdate }>;

/**
 * Judge one run for one touched file against the previous run's memory
 * (null: no memory yet). Only a completed run replaces memory.
 */
export function judgeTypeCheck(input: Readonly<{
  touchedFile: string;
  outcome: TypeCheckOutcome;
  memory: TypeCheckMemory | null;
  /** The tsconfig's directory: paths are shown relative to it. */
  projectDir: string;
  /** Epoch ms of this judgement. */
  now: number;
}>): TypeCheckJudgement {
  const { touchedFile, outcome, memory, projectDir, now } = input;
  const keep = (forOperator: string | null): TypeCheckJudgement =>
    ({ advisory: { forModel: null, forOperator }, memoryUpdate: { kind: "keep" } });

  return match(outcome)
    .with({ kind: "unavailable" }, { kind: "busy" }, () => keep(null))
    .with({ kind: "timed-out" }, ({ afterMs }) => keep(
      `Loom type diagnostics skipped: tsc did not finish within ${Math.round(afterMs / 1000)}s. ` +
      "A cold run builds the incremental cache in the background; later edits are faster.",
    ))
    .with({ kind: "failed" }, ({ reason }) => keep(`Loom type diagnostics could not run: ${reason}`))
    .with({ kind: "completed" }, ({ diagnostics, global }): TypeCheckJudgement => {
      const touched = diagnostics.filter((d) => d.file === touchedFile);
      const baseline = memory !== null && withinWindow(memory.recordedAt, now) ? memory.diagnosticKeys : null;
      const introducedElsewhere = baseline === null
        ? []
        : introducedSince(baseline, diagnostics.filter((d) => d.file !== touchedFile));

      const repeat = nextRepeat(memory?.repeats[touchedFile], touched, now);
      const otherRepeats = Object.fromEntries(Object.entries(memory?.repeats ?? {})
        .filter(([file, record]) => file !== touchedFile && withinWindow(record.at, now)));
      const nextMemory: TypeCheckMemory = {
        recordedAt: now,
        diagnosticKeys: identityKeys(diagnostics),
        repeats: repeat === null ? otherRepeats : { ...otherRepeats, [touchedFile]: repeat },
      };

      const forModel = touched.length === 0 && introducedElsewhere.length === 0
        ? null
        : renderForModel(touchedFile, touched, introducedElsewhere, repeat && repeatReminder(repeat.consecutive), projectDir);
      const forOperator = global.length === 0
        ? null
        : `Loom type diagnostics: tsc reported project-level errors: ${global.map((g) => `TS${g.code} ${g.message}`).join("; ")}`;
      return { advisory: { forModel, forOperator }, memoryUpdate: { kind: "replace", memory: nextMemory } };
    })
    .exhaustive();
}

// ── One edit, either harness ───────────────────────────────────────────

/** The operator note for a check that could not run at all. */
export const couldNotRun = (error: unknown): TypeAdvisory & Readonly<{ forModel: null; forOperator: string }> =>
  ({ forModel: null, forOperator: `Loom type diagnostics could not run: ${error instanceof Error ? error.message : String(error)}` });

/**
 * The advisory for one landed edit, as both harness adapters ask for it: the
 * edited path as the harness reported it (relative paths resolve against
 * `root`), checked by `advise`. Fail-open: a throwing advisor becomes an
 * operator note. Only extracting the path and rendering the result are
 * harness-specific.
 */
export async function adviceForEdit(path: string | null, root: string | null, advise: AdviseOnEdit): Promise<TypeAdvisory> {
  if (path === null) return NO_ADVISORY;
  const file = isAbsolute(path) || root === null ? path : resolve(root, path);
  try {
    return await advise(file);
  } catch (error: unknown) {
    return couldNotRun(error);
  }
}

// ── Memory parsing ─────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isEpochMs = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function parseRepeat(value: unknown): RepeatRecord | null {
  if (!isRecord(value)) return null;
  const { fingerprint, consecutive, at } = value;
  return typeof fingerprint === "string" && typeof consecutive === "number" && Number.isInteger(consecutive) && consecutive >= 1 && isEpochMs(at)
    ? { fingerprint, consecutive, at }
    : null;
}

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Parse stored memory; anything malformed (including an older format) is treated as no memory. */
export function parseTypeCheckMemory(raw: unknown): TypeCheckMemory | null {
  if (!isRecord(raw)) return null;
  const { recordedAt, diagnosticKeys, repeats } = raw;
  if (!isEpochMs(recordedAt)) return null;
  if (!isStringArray(diagnosticKeys)) return null;
  if (!isRecord(repeats)) return null;
  const parsed: Record<string, RepeatRecord> = {};
  for (const [file, record] of Object.entries(repeats)) {
    const repeat = parseRepeat(record);
    if (repeat === null) return null;
    parsed[file] = repeat;
  }
  return { recordedAt, diagnosticKeys, repeats: parsed };
}
