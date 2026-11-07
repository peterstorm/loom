/**
 * The shell steps every skeleton writer shares (AD-9, AD-10, AD-12): generate
 * a contract's canonical skeletons from its types file as it is now, name the
 * paths no writer may touch, carry out one planned write through the
 * no-clobber writer (INV-3), and name why a write did not land. The contract
 * stub step (`contract-stub-materialization.ts`), the Contract Revision's
 * refresh (`skeleton-revision.ts`) and registration
 * (`skeleton-materialization.ts`) build on these; the decisions they act on
 * are the pure core's (`core/skeleton/refresh-plan.ts`, INV-4).
 */

import { match } from "ts-pattern";
import { frozenPaths } from "../core/acceptance-contract";
import type { DomainResult } from "../core/orchestration-contract";
import { normalizePlanPath } from "../core/plan-path-match";
import { generateSkeleton } from "../core/skeleton/generate";
import { skeletonLanguageOf } from "../core/skeleton/language";
import type { SkeletonProblem } from "../core/skeleton/problems";
import { skeletonRecordOf, type SkeletonCandidate } from "../core/skeleton/records";
import type { AdoptAction, CreateAction, RefreshAction } from "../core/skeleton/refresh-plan";
import { resolveBindings } from "../core/skeleton/resolve";
import type {
  ExportBinding,
  FrozenSurface,
  GeneratedSkeleton,
  ResolvedBinding,
  SkeletonOrigin,
  SkeletonRecord,
  SpecifierStyle,
} from "../core/skeleton/types";
import type { TaskGraph } from "../types";
import { observeFrozenSurface, observeSpecifierStyle, type TypedContract } from "./frozen-surface-observation";
import { createSkeleton, refreshSkeleton, type SkeletonWriteResult } from "./skeleton-writer";

/** Every path an Acceptance Freeze covers or will cover: the writer never writes one. */
export const frozenSkeletonPaths = (graph: TaskGraph): ReadonlySet<string> =>
  new Set((graph.acceptance_contracts ?? []).flatMap((contract) => frozenPaths(contract)).map(normalizePlanPath));

/**
 * The canonical skeleton of one resolved binding, nothing for a path
 * `skeletonLanguageOf` (INV-6) says is unsupported, or the language mismatch
 * that keeps it from being generated.
 */
export function generatedSkeleton(
  surface: FrozenSurface,
  binding: ResolvedBinding,
  specifierStyle: SpecifierStyle | null,
): DomainResult<GeneratedSkeleton | null, SkeletonProblem> {
  const target = skeletonLanguageOf(binding.path);
  if (target.kind === "unsupported") return { ok: true, value: null };
  const { contract, exports } = binding;
  if (target.language === "typescript" && surface.language === "typescript") {
    return { ok: true, value: generateSkeleton({ language: "typescript", target, surface, contract, exports, specifierStyle }) };
  }
  if (target.language === "java" && surface.language === "java") {
    return { ok: true, value: generateSkeleton({ language: "java", target, surface, contract, exports }) };
  }
  return { ok: false, error: Object.freeze({ kind: "language-mismatch", path: binding.path, contract, typesFile: surface.path }) };
}

/** A contract's canonical skeletons from its current types file, and every
 *  binding that has none. */
export type ContractCanonicalSkeletons = Readonly<{
  candidates: readonly SkeletonCandidate[];
  problems: readonly SkeletonProblem[];
}>;

/**
 * Read the contract's types file as it is now and generate the canonical
 * skeleton of each of `bindings`. Each binding is resolved on its own, so the
 * problems of one never hide another's skeleton. An unreadable or
 * unparseable types file is the one problem, with no skeleton; failing to
 * read the acceptance files for the specifier style is an infrastructure error.
 */
export function canonicalContractSkeletons(
  root: string,
  contract: TypedContract,
  bindings: readonly ExportBinding[],
): DomainResult<ContractCanonicalSkeletons, string> {
  const surface = observeFrozenSurface(root, contract, "current");
  if (!surface.ok) return { ok: true, value: Object.freeze({ candidates: Object.freeze([]), problems: Object.freeze([surface.error]) }) };
  const style = surface.value.language === "typescript" ? observeSpecifierStyle(root, contract) : { ok: true as const, value: null };
  if (!style.ok) return style;
  const resolutions = bindings.map((binding) => resolveBindings(surface.value, [binding]));
  const generations = resolutions.flatMap((resolution) => (resolution.ok ? resolution.value : []))
    .map((binding) => generatedSkeleton(surface.value, binding, style.value));
  const { typesSha256 } = surface.value;
  return {
    ok: true,
    value: Object.freeze({
      candidates: Object.freeze(generations.flatMap((generation) => (generation.ok && generation.value !== null
        ? [Object.freeze({ skeleton: generation.value, contract: contract.id, typesSha256 })]
        : []))),
      problems: Object.freeze([
        ...resolutions.flatMap((resolution) => (resolution.ok ? [] : resolution.error)),
        ...generations.flatMap((generation) => (generation.ok ? [] : [generation.error])),
      ]),
    }),
  };
}

/** A writer result that wrote nothing. */
export type UnwrittenResult = Exclude<SkeletonWriteResult, { kind: "written" }>;

/** What one planned write left: the record the engine keeps, or why the writer wrote nothing. */
export type PlannedWrite =
  | Readonly<{ kind: "recorded"; record: SkeletonRecord }>
  | Readonly<{ kind: "unwritten"; result: UnwrittenResult }>;

/**
 * Carry out one planned write through the writer (INV-3): an adoption writes
 * nothing, a creation never replaces anything, a refresh replaces only the
 * engine bytes it expects. The record it leaves has `origin`.
 */
export function writePlanned(
  root: string,
  action: CreateAction | AdoptAction | RefreshAction,
  origin: SkeletonOrigin,
  frozen: ReadonlySet<string>,
): PlannedWrite {
  const recorded: PlannedWrite = Object.freeze({ kind: "recorded", record: skeletonRecordOf(action.candidate, origin) });
  if (action.kind === "adopt") return recorded;
  const { path, bytes } = action.candidate.skeleton;
  const result = action.kind === "create"
    ? createSkeleton(root, path, bytes, frozen)
    : refreshSkeleton(root, path, action.expectedSha256, bytes, frozen);
  return result.kind === "written" ? recorded : Object.freeze({ kind: "unwritten", result });
}

/** Why a write did not land, as the detail of a `write-failed` problem. */
export function writeFailure(path: string, result: UnwrittenResult): SkeletonProblem {
  const detail = match(result)
    .with({ kind: "exists" }, () => "a file appeared there meanwhile; it was left untouched")
    .with({ kind: "refused" }, ({ reason }) => `refused (${reason})`)
    .with({ kind: "io-failed" }, ({ message }) => `write failed (${message})`)
    .exhaustive();
  return Object.freeze({ kind: "write-failed", path, detail });
}
