/**
 * The deterministic mutation plan of one owner module (AD-6; FR-009..FR-012,
 * FR-017). One of the two INV-1 seams allowed to import `typescript`: it
 * parses already-read owner text with `ts.createSourceFile` only — no
 * `ts.sys`, no Program, no language service, no filesystem.
 *
 * The engine fixes the operator set, in this order:
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
 * A site is a candidate when its replaced span starts on a changed line
 * (1-based). Candidates sort by (start, operator order, end); over the cap the
 * selection is the evenly spaced indices `floor(i * n / cap)` for `i < cap`,
 * so mutants never cluster at the top of the file. The cap's parser and the
 * plan's constructor are the only ways to hold a `MutantCap` and a
 * `MutationPlan`.
 */

import ts from "typescript";
import { sha256Hex } from "../digest";
import { failure, success } from "../orchestration-contract/identity";
import type {
  ApplyMutantFn,
  Mutant,
  MutantCap,
  MutationOperator,
  MutationPlan,
  MutationPlanFn,
  MutationPlanOfFn,
  ParseMutantCapFn,
} from "./types";

/** The brand's one minting point: callers hold a cap only through `parseMutantCap`. */
const mintCap = (raw: number): MutantCap => raw as MutantCap;

/** The engine's per-Invariant mutant cap. */
export const MUTANT_CAP_PER_INVARIANT: MutantCap = mintCap(24);

/** The engine's per-mutant time limit, before the runner's own timeout clamps it. */
export const MUTANT_TIMEOUT_MS = 60_000;

/** The per-mutant time limit actually applied: the engine's, clamped to at most the frozen runner's timeout. */
export const mutantTimeoutMs = (runnerTimeoutMs: number): number => Math.min(MUTANT_TIMEOUT_MS, runnerTimeoutMs);

export const parseMutantCap: ParseMutantCapFn = (raw) =>
  Number.isInteger(raw) && raw > 0 ? success(mintCap(raw)) : failure({ kind: "not-positive-integer", raw });

const isCount = (value: number): boolean => Number.isInteger(value) && value >= 0;

export const mutationPlanOf: MutationPlanOfFn = ({ mutants, candidates, cap }) => {
  if (!isCount(candidates)) return failure({ kind: "candidates-not-a-count", candidates });
  if (mutants.length > candidates) return failure({ kind: "mutants-exceed-candidates", mutants: mutants.length, candidates });
  if (mutants.length > cap) return failure({ kind: "mutants-exceed-cap", mutants: mutants.length, cap });
  return success(Object.freeze({ mutants: Object.freeze([...mutants]), candidates, cap }) as MutationPlan);
};

const OPERATOR_ORDER: readonly MutationOperator[] = [
  "condition-negation",
  "comparison-flip",
  "logical-swap",
  "boolean-literal-flip",
  "return-value-replacement",
  "statement-removal",
];

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
type Site = Readonly<{ operator: MutationOperator; node: ts.Node; replace: (original: string) => string }>;

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

/** A candidate before its identity: the resolved span of one site. */
type Candidate = Omit<Mutant, "id">;

const byPosition = (left: Candidate, right: Candidate): number =>
  left.start - right.start
  || OPERATOR_ORDER.indexOf(left.operator) - OPERATOR_ORDER.indexOf(right.operator)
  || left.end - right.end;

/** The evenly spaced selection of at most `cap` of `candidates`: indices `floor(i * n / cap)`. */
function select<T>(candidates: readonly T[], cap: number): readonly T[] {
  const n = candidates.length;
  if (n <= cap) return candidates;
  return Array.from({ length: cap }, (_, i) => candidates[Math.floor((i * n) / cap)]!);
}

export const mutationPlan: MutationPlanFn = ({ ownerPath, ownerText, changedLines, cap }) => {
  const source = ts.createSourceFile(ownerPath, ownerText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const candidates = allSites(source)
    .map((site): Candidate => {
      const start = site.node.getStart(source);
      const end = site.node.getEnd();
      const position = source.getLineAndCharacterOfPosition(start);
      const original = ownerText.slice(start, end);
      return { operator: site.operator, line: position.line + 1, column: position.character + 1, start, end, original, replacement: site.replace(original) };
    })
    .filter((candidate) => changedLines.has(candidate.line))
    .sort(byPosition);
  const mutants = select(candidates, cap).map((candidate): Mutant => Object.freeze({
    id: sha256Hex(JSON.stringify([ownerPath, candidate.start, candidate.end, candidate.operator])),
    ...candidate,
  }));
  const plan = mutationPlanOf({ mutants, candidates: candidates.length, cap });
  if (!plan.ok) throw new Error(`invariant: the evenly spaced selection broke the plan's bounds (${plan.error.kind})`);
  return plan.value;
};

export const applyMutant: ApplyMutantFn = (ownerText, mutant) =>
  ownerText.slice(0, mutant.start) + mutant.replacement + ownerText.slice(mutant.end);
