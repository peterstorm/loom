/**
 * The deterministic mutation plan of one owner module (AD-6; FR-009..FR-012,
 * FR-017). One of the two INV-1 seams allowed to import `typescript`: it
 * parses already-read owner text through `parseModule`, the parse it shares
 * with the import-graph seam (one path-to-script-kind rule, so a `.tsx` or
 * `.jsx` owner is parsed with JSX) — no `ts.sys`, no Program, no language
 * service, no filesystem. A Java owner's sites come from `java-syntax.ts`, the
 * one Java seam, so this module decides which reader a path needs
 * (`language.ts`) and never reads Java bytes itself.
 *
 * An owner with syntax errors has no plan: its sites would come from a
 * recovered tree, so it is `owner-unparseable`, which the shell reports as an
 * infrastructure failure, never a pass. An owner in a language no reader reads
 * is `unsupported-language`: the check refuses a language it cannot read
 * instead of reporting a parse error for one it never tried to parse.
 *
 * The engine fixes the Wave Gate's operator set (`WAVE_GATE_OPERATORS`), in
 * this order. Each operator is a syntax-neutral name with one text per
 * language; a Java site is the text its grammar makes valid:
 * 1. `condition-negation`: an `if`/`while`/`do`/`for`/`?:` condition becomes
 *    `!(…)`. A Java condition that declares a pattern variable offers none:
 *    negating it would put the variable out of scope in the guarded body.
 * 2. `comparison-flip`: TypeScript `<`↔`>=`, `>`↔`<=`, `===`↔`!==`, `==`↔`!=`;
 *    Java has no `===`, so `<`↔`>=`, `>`↔`<=`, `==`↔`!=`.
 * 3. `logical-swap`: `&&`↔`||`.
 * 4. `boolean-literal-flip`: `true`↔`false` (TypeScript never inside a type).
 * 5. `return-value-replacement`: TypeScript `return e` becomes
 *    `return undefined` for a non-empty return whose value is not already
 *    `undefined`; Java becomes `return !(e)` in a `boolean` method,
 *    `return 0` in a numeric one, `return null` in a reference one, and a
 *    `void` method offers no site.
 * 6. `statement-removal`: an expression statement becomes `;`, TypeScript
 *    prologue directives excluded. A Java declaration is not an expression
 *    statement, so a local variable declaration is never removed.
 *
 * The Task mutation check (ADR-0071) runs `TASK_MUTATION_OPERATORS`: one more
 * operator, first in its order, then the same six.
 * 0. `guard-removal`: an `if` with no `else` whose body only exits (`throw`,
 *    `return`, `continue` or `break`, alone or as a block's only statements)
 *    becomes `;`.
 * The operator set is a parameter of the candidates, so `mutationPlan` never
 * yields a `guard-removal` mutant and the Wave Gate's plans and mutant ids are
 * what they were before that operator existed.
 *
 * A site is a candidate when its replaced span starts on a changed line
 * (1-based). Candidates sort by (start, operator order, end); over the cap the
 * selection is the evenly spaced indices `floor(i * n / cap)` for `i < cap`,
 * so mutants never cluster at the top of the file. `taskMutants` applies the
 * same selection once over several files' candidates, in file order, so one
 * cap bounds a whole Task. The cap's parser is the
 * only way to hold a `MutantCap`. A `MutationPlan` is held only through its
 * constructor `mutationPlanOf`, which checks fields it is handed, or through
 * the selection itself (`selectedPlan`), whose evenly spaced choice holds
 * `min(candidates, cap)` mutants by construction: the bound has one home and
 * `mutationPlan` stays total, with no unreachable failure to throw.
 */

import ts from "typescript";
import { sha256Hex } from "../digest";
import { failure, isNonEmpty, success, type DomainResult } from "../orchestration-contract/identity";
import { parseModule, syntaxErrorsOf } from "./import-graph";
import { parseJava } from "./java-syntax";
import { ownerLanguageOf, unsupportedPathText } from "./language";
import type {
  Mutant,
  MutantCap,
  MutationOperator,
  MutationPlan,
  MutationPlanFn,
  MutationPlanOfFn,
  MutationPlanRefusal,
  ParseMutantCapFn,
  TaskMutationOperator,
} from "./types";

/** The brand's one minting point: callers hold a cap only through `parseMutantCap`. */
const mintCap = (raw: number): MutantCap => raw as MutantCap;

/** The engine's per-Invariant mutant cap. */
export const MUTANT_CAP_PER_INVARIANT: MutantCap = mintCap(24);

/** The Task mutation check's cap, over all of one Task's files together (ADR-0071). */
export const MUTANT_CAP_PER_TASK: MutantCap = mintCap(8);

/** The engine's per-mutant time limit, before the runner's own timeout clamps it. */
export const MUTANT_TIMEOUT_MS = 60_000;

/** The per-mutant time limit actually applied: the engine's, clamped to at most the frozen runner's timeout. */
export const mutantTimeoutMs = (runnerTimeoutMs: number): number => Math.min(MUTANT_TIMEOUT_MS, runnerTimeoutMs);

export const parseMutantCap: ParseMutantCapFn = (raw) =>
  Number.isInteger(raw) && raw > 0 ? success(mintCap(raw)) : failure({ kind: "not-positive-integer", raw });

const isCount = (value: number): boolean => Number.isInteger(value) && value >= 0;

/** The plan brand's one minting point, reached only once the bounds hold. */
const mintPlan = (mutants: readonly Mutant[], candidates: number, cap: MutantCap): MutationPlan =>
  Object.freeze({ mutants: Object.freeze([...mutants]), candidates, cap }) as MutationPlan;

export const mutationPlanOf: MutationPlanOfFn = ({ mutants, candidates, cap }) => {
  if (!isCount(candidates)) return failure({ kind: "candidates-not-a-count", candidates });
  if (mutants.length > candidates) return failure({ kind: "mutants-exceed-candidates", mutants: mutants.length, candidates });
  if (mutants.length > cap) return failure({ kind: "mutants-exceed-cap", mutants: mutants.length, cap });
  return success(mintPlan(mutants, candidates, cap));
};

/** The Wave Gate's operator set, in its fixed application order (ADR-0036). */
export const WAVE_GATE_OPERATORS: readonly MutationOperator[] = Object.freeze([
  "condition-negation",
  "comparison-flip",
  "logical-swap",
  "boolean-literal-flip",
  "return-value-replacement",
  "statement-removal",
]);

/** The Task mutation check's operator set, in its application order: `guard-removal` first. */
export const TASK_MUTATION_OPERATORS: readonly TaskMutationOperator[] = Object.freeze(["guard-removal", ...WAVE_GATE_OPERATORS]);

const COMPARISON_FLIPS: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [ts.SyntaxKind.LessThanToken, ">="],
  [ts.SyntaxKind.GreaterThanEqualsToken, "<"],
  [ts.SyntaxKind.GreaterThanToken, "<="],
  [ts.SyntaxKind.LessThanEqualsToken, ">"],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, "!=="],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, "==="],
  [ts.SyntaxKind.EqualsEqualsToken, "!="],
  [ts.SyntaxKind.ExclamationEqualsToken, "=="],
]);

const LOGICAL_SWAPS: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [ts.SyntaxKind.AmpersandAmpersandToken, "||"],
  [ts.SyntaxKind.BarBarToken, "&&"],
]);

/** A site before its position is resolved: the node whose span is replaced, and how. */
type Site = Readonly<{ operator: TaskMutationOperator; node: ts.Node; replace: (original: string) => string }>;

const isExit = (statement: ts.Statement): boolean =>
  ts.isThrowStatement(statement) || ts.isReturnStatement(statement) || ts.isContinueStatement(statement) || ts.isBreakStatement(statement);

/** Whether an `if` is a guard: it has no `else`, and its body does nothing but exit. */
function isExitGuard(node: ts.IfStatement): boolean {
  if (node.elseStatement !== undefined) return false;
  const body = node.thenStatement;
  return ts.isBlock(body) ? body.statements.length > 0 && body.statements.every(isExit) : isExit(body);
}

/** The condition a statement or conditional expression tests, if it tests one. */
function conditionOf(node: ts.Node): ts.Expression | undefined {
  if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) return node.expression;
  if (ts.isForStatement(node)) return node.condition;
  if (ts.isConditionalExpression(node)) return node.condition;
  return undefined;
}

/**
 * Whether an expression statement belongs to a directive prologue: the
 * leading run of string-literal statements of a file or a function body.
 */
function isPrologueDirective(statement: ts.ExpressionStatement): boolean {
  if (!ts.isStringLiteral(statement.expression)) return false;
  const container = statement.parent;
  const isPrologueContainer = ts.isSourceFile(container) || (ts.isBlock(container) && ts.isFunctionLike(container.parent));
  if (!isPrologueContainer) return false;
  for (const sibling of container.statements) {
    if (sibling === statement) return true;
    if (!ts.isExpressionStatement(sibling) || !ts.isStringLiteral(sibling.expression)) return false;
  }
  return false;
}

/** Every site one node offers, in operator order. */
function sitesOf(node: ts.Node): readonly Site[] {
  const sites: Site[] = [];
  if (ts.isIfStatement(node) && isExitGuard(node)) sites.push({ operator: "guard-removal", node, replace: () => ";" });
  const condition = conditionOf(node);
  if (condition !== undefined) sites.push({ operator: "condition-negation", node: condition, replace: (original) => `!(${original})` });
  if (ts.isBinaryExpression(node)) {
    const flipped = COMPARISON_FLIPS.get(node.operatorToken.kind);
    if (flipped !== undefined) sites.push({ operator: "comparison-flip", node: node.operatorToken, replace: () => flipped });
    const swapped = LOGICAL_SWAPS.get(node.operatorToken.kind);
    if (swapped !== undefined) sites.push({ operator: "logical-swap", node: node.operatorToken, replace: () => swapped });
  }
  if ((node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) && !ts.isLiteralTypeNode(node.parent)) {
    const flipped = node.kind === ts.SyntaxKind.TrueKeyword ? "false" : "true";
    sites.push({ operator: "boolean-literal-flip", node, replace: () => flipped });
  }
  if (ts.isReturnStatement(node) && node.expression !== undefined && !(ts.isIdentifier(node.expression) && node.expression.text === "undefined")) {
    sites.push({ operator: "return-value-replacement", node: node.expression, replace: () => "undefined" });
  }
  if (ts.isExpressionStatement(node) && !isPrologueDirective(node)) {
    sites.push({ operator: "statement-removal", node, replace: () => ";" });
  }
  return sites;
}

/** Every site of the owner, pre-order. */
function allSites(source: ts.SourceFile): readonly Site[] {
  const sites: Site[] = [];
  const visit = (node: ts.Node): void => {
    sites.push(...sitesOf(node));
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return sites;
}

/** A candidate before its identity: the resolved span of one site of one operator set. */
type Candidate<Operator extends TaskMutationOperator> = Omit<Mutant, "id" | "operator"> & Readonly<{ operator: Operator }>;

/**
 * Every item when they fit the cap, otherwise the evenly spaced indices
 * `floor(i * n / cap)` for `i < cap`: `min(n, cap)` items, in their order.
 */
function evenlySpaced<T>(items: readonly T[], cap: MutantCap): readonly T[] {
  const n = items.length;
  return n <= cap ? items : Array.from({ length: cap }, (_, i) => items[Math.floor((i * n) / cap)]);
}

const mutantId = (path: string, candidate: Candidate<TaskMutationOperator>): string =>
  sha256Hex(JSON.stringify([path, candidate.start, candidate.end, candidate.operator]));

/** The plan of the sorted candidates: the evenly spaced selection, within both bounds by construction. */
function selectedPlan(ownerPath: string, candidates: readonly Candidate<MutationOperator>[], cap: MutantCap): MutationPlan {
  const mutants = evenlySpaced(candidates, cap).map((candidate): Mutant => Object.freeze({ id: mutantId(ownerPath, candidate), ...candidate }));
  return mintPlan(mutants, candidates.length, cap);
}

/** One module's text and its 1-based changed lines: what its candidates are read from. */
type ModuleChange = Readonly<{ path: string; text: string; changedLines: ReadonlySet<number> }>;

/**
 * A site as a language reader reports it: the operator, the 1-based position
 * of its span, and the span with the text that replaces it. Both readers
 * report this shape, so the candidate and its filter are language-blind.
 */
type ReportedSite = Readonly<{
  operator: TaskMutationOperator;
  line: number;
  column: number;
  start: number;
  end: number;
  original: string;
  replacement: string;
}>;

/** The 1-based line and column of an offset, from the text's line starts. */
function positionsIn(text: string): (offset: number) => Readonly<{ line: number; column: number }> {
  const starts = [0];
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((starts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return { line: low + 1, column: offset - (starts[low] ?? 0) + 1 };
  };
}

/** The TypeScript reader: the compiler's tree, or its syntax errors (failing closed when it reports none). */
function typescriptSites(path: string, text: string): DomainResult<readonly ReportedSite[], MutationPlanRefusal> {
  const source = parseModule(path, text);
  const errors = syntaxErrorsOf(source) ?? ["the TypeScript parser exposes no parse diagnostics, so the owner cannot be proven well-formed"];
  if (isNonEmpty(errors)) return failure({ kind: "owner-unparseable", diagnostics: errors });
  return success(allSites(source).map((site): ReportedSite => {
    const start = site.node.getStart(source);
    const end = site.node.getEnd();
    const { line, character } = source.getLineAndCharacterOfPosition(start);
    const original = text.slice(start, end);
    return { operator: site.operator, line: line + 1, column: character + 1, start, end, original, replacement: site.replace(original) };
  }));
}

/** The Java reader: the one Java seam's projection, or the grammar's refusal. */
function javaSites(text: string): DomainResult<readonly ReportedSite[], MutationPlanRefusal> {
  const parsed = parseJava(text);
  if (!parsed.ok) return failure({ kind: "owner-unparseable", diagnostics: parsed.error.diagnostics });
  const position = positionsIn(text);
  return success(parsed.value.sites.map((site): ReportedSite => {
    const { line, column } = position(site.start);
    return { operator: site.operator, line, column, start: site.start, end: site.end, original: text.slice(site.start, site.end), replacement: site.replacement };
  }));
}

/**
 * The candidates `operators` offer on a module's changed lines, sorted by
 * (start, the operators' own order, end). The module's language picks its
 * reader; a path no reader reads is `unsupported-language`, never a parse
 * error. A site of an operator outside the set is not a candidate, so the set
 * alone decides what a plan can hold.
 */
function candidatesOf<Operator extends TaskMutationOperator>(
  change: ModuleChange,
  operators: readonly Operator[],
): DomainResult<readonly Candidate<Operator>[], MutationPlanRefusal> {
  const language = ownerLanguageOf(change.path);
  if (language.kind === "unsupported") return failure({ kind: "unsupported-language", detail: unsupportedPathText(change.path, language.reason) });
  const reported = language.language === "java" ? javaSites(change.text) : typescriptSites(change.path, change.text);
  if (!reported.ok) return reported;
  const order = (operator: Operator): number => operators.indexOf(operator);
  const candidates = reported.value.flatMap((site): readonly Candidate<Operator>[] => {
    const operator = operators.find((candidate) => candidate === site.operator);
    return operator === undefined ? [] : [{ ...site, operator }];
  });
  return success(candidates
    .filter((candidate) => change.changedLines.has(candidate.line))
    .sort((left, right) => left.start - right.start || order(left.operator) - order(right.operator) || left.end - right.end));
}

export const mutationPlan: MutationPlanFn = ({ ownerPath, ownerText, changedLines, cap }) => {
  const candidates = candidatesOf({ path: ownerPath, text: ownerText, changedLines }, WAVE_GATE_OPERATORS);
  return candidates.ok ? success(selectedPlan(ownerPath, candidates.value, cap)) : candidates;
};

/** One mutant of one of a Task's files: the file it rewrites, and a `Mutant` whose operator may be `guard-removal`. */
export type TaskMutant = Candidate<TaskMutationOperator> & Readonly<{ id: string; path: string }>;

/** The mutants one Task mutation check runs: at most `cap`, in file then position order, of `candidates` sites. */
export type TaskMutants = Readonly<{ mutants: readonly TaskMutant[]; candidates: number }>;

/** Why a Task's files yield no trustworthy mutants: one of them does not parse or is not a source language a reader reads. */
export type TaskFileRefusal = MutationPlanRefusal & Readonly<{ path: string }>;

/**
 * The mutants of a Task's changed lines under `TASK_MUTATION_OPERATORS`: every
 * file's sorted candidates, concatenated in the order the files are given,
 * then the evenly spaced selection of at most `cap` over all of them. Pure.
 */
export function taskMutants(files: readonly ModuleChange[], cap: MutantCap): DomainResult<TaskMutants, TaskFileRefusal> {
  const all: Omit<TaskMutant, "id">[] = [];
  for (const file of files) {
    const candidates = candidatesOf(file, TASK_MUTATION_OPERATORS);
    if (!candidates.ok) return failure({ ...candidates.error, path: file.path });
    all.push(...candidates.value.map((candidate) => ({ ...candidate, path: file.path })));
  }
  const mutants = evenlySpaced(all, cap).map((candidate): TaskMutant => Object.freeze({ id: mutantId(candidate.path, candidate), ...candidate }));
  return success(Object.freeze({ mutants: Object.freeze(mutants), candidates: all.length }));
}

/**
 * Why a plan was refused, as the one line a shell's diagnostic appends to the
 * path: the parser's diagnostics for a syntax error, the language's reason for
 * a path no reader reads.
 */
export const mutationPlanRefusalText = (refusal: MutationPlanRefusal): string =>
  refusal.kind === "owner-unparseable"
    ? `does not parse, so its mutation sites cannot be trusted: ${refusal.diagnostics.join("; ")}`
    : `cannot be mutated: ${refusal.detail}`;

/** A file's text with one mutant of either operator set applied: `[start, end)` replaced by `replacement`. */
export const applyMutant = (text: string, mutant: Pick<TaskMutant, "start" | "end" | "replacement">): string =>
  text.slice(0, mutant.start) + mutant.replacement + text.slice(mutant.end);
