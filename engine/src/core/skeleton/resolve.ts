/**
 * Stage-two resolution of export bindings against a frozen surface (FR-003,
 * FR-004). Each bound alias is looked up in the language-tagged surface read
 * from the frozen types file, and only there: a signature never comes from the
 * plan's free-form `**Interface:**` blocks. A bindable alias is a non-generic
 * function type (TypeScript) or single-abstract-method interface (Java); the
 * surface readers already decided that shape, so this module never re-reads
 * source text and never classifies a path.
 *
 * Every problem of every binding is listed, in plan order, each naming the
 * alias, the binding file and the types file; a problem repeated by two
 * exports of one file is listed once. Resolution succeeds only when there is
 * no problem at all. Pure.
 *
 * The other `ResolutionProblem` kinds (`unsupported-holder-shape`,
 * `types-unparseable`, `types-drifted`) are observed by the shell before
 * resolution runs and are never produced here.
 */

import { match } from "ts-pattern";
import { isNonEmpty, type DomainResult, type NonEmpty } from "../orchestration-contract";
import type {
  AliasShape,
  BoundExport,
  ExportBinding,
  ResolutionProblem,
  ResolveBindingsFn,
  ResolvedBinding,
  ResolvedExport,
} from "./types";

type Shapes = ReadonlyMap<string, AliasShape>;

/** Every value when all succeed, else every error — both non-empty, in order. */
function partition<T, E>(results: NonEmpty<DomainResult<T, E>>): DomainResult<NonEmpty<T>, NonEmpty<E>> {
  const [head, ...tail] = results;
  const start: DomainResult<NonEmpty<T>, NonEmpty<E>> = head.ok ? { ok: true, value: [head.value] } : { ok: false, error: [head.error] };
  return tail.reduce<DomainResult<NonEmpty<T>, NonEmpty<E>>>((so, next) =>
    so.ok
      ? next.ok ? { ok: true, value: [...so.value, next.value] } : { ok: false, error: [next.error] }
      : next.ok ? so : { ok: false, error: [...so.error, next.error] }, start);
}

function resolveExport(shapes: Shapes, typesFile: string, path: string, bound: BoundExport): DomainResult<ResolvedExport, ResolutionProblem> {
  const refused = (kind: "missing-alias" | "not-a-function" | "generic-alias"): DomainResult<ResolvedExport, ResolutionProblem> =>
    ({ ok: false, error: Object.freeze({ kind, alias: bound.alias, path, typesFile }) });
  const shape = shapes.get(bound.alias);
  if (shape === undefined) return refused("missing-alias");
  return match(shape)
    .with({ kind: "not-a-function" }, () => refused("not-a-function"))
    .with({ kind: "function", generic: true }, () => refused("generic-alias"))
    .with({ kind: "function", generic: false }, ({ parameterCount }): DomainResult<ResolvedExport, ResolutionProblem> =>
      ({ ok: true, value: Object.freeze({ name: bound.name, alias: bound.alias, parameterCount }) }))
    .exhaustive();
}

function resolveBinding(shapes: Shapes, typesFile: string, binding: ExportBinding): DomainResult<ResolvedBinding, NonEmpty<ResolutionProblem>> {
  const [first, ...rest] = binding.exports;
  const resolve = (bound: BoundExport) => resolveExport(shapes, typesFile, binding.path, bound);
  const exports = partition([resolve(first), ...rest.map(resolve)]);
  return exports.ok
    ? { ok: true, value: Object.freeze({ path: binding.path, contract: binding.contract, exports: Object.freeze(exports.value) }) }
    : exports;
}

/** Problems with exact duplicates dropped, first occurrence kept. */
const unique = (problems: readonly ResolutionProblem[]): readonly ResolutionProblem[] => {
  const keys = problems.map((problem) => JSON.stringify(problem));
  return problems.filter((problem, at) => keys.indexOf(JSON.stringify(problem)) === at);
};

export const resolveBindings: ResolveBindingsFn = (surface, bindings) => {
  // The first declaration of a name wins.
  const shapes: Shapes = new Map([...surface.aliases].reverse().map(({ name, shape }) => [name, shape] as const));
  const results = bindings.map((binding) => resolveBinding(shapes, surface.path, binding));
  const problems = unique(results.flatMap((result) => (result.ok ? [] : result.error)));
  if (isNonEmpty(problems)) return { ok: false, error: Object.freeze(problems) };
  return { ok: true, value: Object.freeze(results.flatMap((result) => (result.ok ? [result.value] : []))) };
};
