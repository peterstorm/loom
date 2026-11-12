/**
 * The deterministic mutation plan of one owner module (AD-6; FR-009..FR-012,
 * FR-017). One of the two INV-1 seams allowed to import `typescript`: it
 * parses already-read owner text through `parseModule`, the parse it shares
 * with the import-graph seam (one path-to-script-kind rule, so a `.tsx` or
 * `.jsx` owner is parsed with JSX) — no `ts.sys`, no Program, no language
 * service, no filesystem. An owner with syntax errors has no plan: its sites
 * would come from a recovered tree, so it is `owner-unparseable`, which the
 * shell reports as an infrastructure failure, never a pass.
 *
 * The engine fixes the Wave Gate's operator set (`WAVE_GATE_OPERATORS`), in
 * this order:
 * 1. `condition-negation`: the condition of `if`, `while`, `do`, `for` and
 *    `?:` becomes `!(…)`.
 * 2. `comparison-flip`: `<`↔`>=`, `>`↔`<=`, `===`↔`!==`, `==`↔`!=`.
 * 3. `logical-swap`: `&&`↔`||`.
 * 4. `boolean-literal-flip`: `true`↔`false` (never inside a type).
 * 5. `return-value-replacement`: `return e` becomes `return undefined`, for a
 *    non-empty return whose value is not already the identifier `undefined`.
 * 6. `statement-removal`: an expression statement becomes `;`, prologue
 *    directives excluded.
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
import type {
  ApplyMutantFn,
  Mutant,
  MutantCap,
  MutationOperator,
  MutationPlan,
  MutationPlanFn,
  MutationPlanOfFn,
  OwnerUnparseable,
  ParseMutantCapFn,
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

/** Every operator a Task mutation check applies: the Wave Gate's six and `guard-removal`. */
export type TaskMutationOperator = "guard-removal" | MutationOperator;

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

/** The parser's verdict on the owner: its tree, or every syntax error it reported (failing closed when it reports none at all). */
function parsedOwner(ownerPath: string, ownerText: string): DomainResult<ts.SourceFile, OwnerUnparseable> {
  const source = parseModule(ownerPath, ownerText);
  const errors = syntaxErrorsOf(source) ?? ["the TypeScript parser exposes no parse diagnostics, so the owner cannot be proven well-formed"];
  return isNonEmpty(errors) ? failure({ kind: "owner-unparseable", diagnostics: errors }) : success(source);
}

/** One module's text and its 1-based changed lines: what its candidates are read from. */
type ModuleChange = Readonly<{ path: string; text: string; changedLines: ReadonlySet<number> }>;

/**
 * The candidates `operators` offer on a module's changed lines, sorted by
 * (start, the operators' own order, end). A site of an operator outside the
 * set is not a candidate, so the set alone decides what a plan can hold.
 */
function candidatesOf<Operator extends TaskMutationOperator>(
  { path, text, changedLines }: ModuleChange,
  operators: readonly Operator[],
): DomainResult<readonly Candidate<Operator>[], OwnerUnparseable> {
  const parsed = parsedOwner(path, text);
  if (!parsed.ok) return parsed;
  const source = parsed.value;
  const order = (operator: TaskMutationOperator): number => operators.findIndex((candidate) => candidate === operator);
  const candidates = allSites(source).flatMap((site): readonly Candidate<Operator>[] => {
    const operator = operators.find((candidate) => candidate === site.operator);
    if (operator === undefined) return [];
    const start = site.node.getStart(source);
    const end = site.node.getEnd();
    const position = source.getLineAndCharacterOfPosition(start);
    const original = text.slice(start, end);
    return [{ operator, line: position.line + 1, column: position.character + 1, start, end, original, replacement: site.replace(original) }];
  });
  return success(candidates
    .filter((candidate) => changedLines.has(candidate.line))
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

/** Why a Task's files yield no trustworthy mutants: one of them does not parse. */
export type TaskFileUnparseable = OwnerUnparseable & Readonly<{ path: string }>;

/**
 * The mutants of a Task's changed lines under `TASK_MUTATION_OPERATORS`: every
 * file's sorted candidates, concatenated in the order the files are given,
 * then the evenly spaced selection of at most `cap` over all of them. Pure.
 */
export function taskMutants(files: readonly ModuleChange[], cap: MutantCap): DomainResult<TaskMutants, TaskFileUnparseable> {
  const all: Omit<TaskMutant, "id">[] = [];
  for (const file of files) {
    const candidates = candidatesOf(file, TASK_MUTATION_OPERATORS);
    if (!candidates.ok) return failure({ ...candidates.error, path: file.path });
    all.push(...candidates.value.map((candidate) => ({ ...candidate, path: file.path })));
  }
  const mutants = evenlySpaced(all, cap).map((candidate): TaskMutant => Object.freeze({ id: mutantId(candidate.path, candidate), ...candidate }));
  return success(Object.freeze({ mutants: Object.freeze(mutants), candidates: all.length }));
}

/** A file's text with one mutant of either operator set applied: `[start, end)` replaced by `replacement`. */
export const applyTaskMutant = (text: string, mutant: Pick<TaskMutant, "start" | "end" | "replacement">): string =>
  text.slice(0, mutant.start) + mutant.replacement + text.slice(mutant.end);

export const applyMutant: ApplyMutantFn = applyTaskMutant;
