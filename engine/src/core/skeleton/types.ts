/**
 * The frozen surface of G2 skeletons (Acceptance Contract CT-1): export
 * bindings, frozen types surfaces, implementation surfaces, stage-two
 * resolution, canonical skeleton bytes, skeleton outcomes and records, and
 * the conformance judgment. Every G2 module and acceptance test imports these
 * declarations. No logic lives here: its bytes freeze at the CT-1 Wave Gate.
 *
 * Everything under `core/skeleton/` is pure — strings and graph data in, data
 * out. Expected failures are values (`DomainResult` or a problem ADT), never
 * throws.
 */

import type { PlanContract } from "../acceptance-contract";
import type { DomainResult, NonEmpty } from "../orchestration-contract";
import type { RegressionWaiverReason } from "../verification-policy";
import type { TaskGraph } from "../../types";
import type {
  ContractId,
  ExportBinding,
  Identifier,
  PathSkeletonOutcome,
  SkeletonLanguage,
  UnsupportedReason,
} from "./persisted";
import type { ContractConformance } from "./conformance-verdict";

/** The persisted values (AD-4) live in the leaf `./persisted.ts`, which
 *  `engine/src/types.ts` can import without a cycle; re-exported here so every
 *  skeleton consumer keeps one import site. */
export type {
  BoundExport,
  ContractId,
  ExportBinding,
  Identifier,
  PathSkeletonOutcome,
  SkeletonLanguage,
  SkeletonOrigin,
  SkeletonOutcome,
  SkeletonRecord,
  UnsupportedReason,
} from "./persisted";

// ---------------------------------------------------------------------------
// Export bindings (AD-3): the plan's `**Export bindings:**` lines
// ---------------------------------------------------------------------------

/** Why a raw token is no `Identifier`. */
export type IdentifierProblem = "invalid-identifier" | "reserved-word";

/** Why a raw token is no `ContractId`. */
export type ContractIdProblem = "invalid-contract-id";

/** Why one binding line failed the grammar. */
export type MalformedEntryReason =
  | "not-a-binding-line"
  | "missing-contract"
  | "missing-name"
  | "missing-alias"
  | "empty-exports"
  | IdentifierProblem;

/**
 * Why a binding is refused. Each names the file it refuses (`path`, or null
 * when the line carries no readable path) and exactly one reason.
 *
 * Parse-time problems (`malformed-entry`, `duplicate-name`,
 * `name-collides-with-alias`, `duplicate-path`, `multi-contract`) are
 * collected by `parseExportBindings`; the graph-shape
 * problems by `validateExportBindings`, which also reports every parse-time
 * problem it receives.
 */
export type BindingProblem =
  | Readonly<{ kind: "unsafe-path"; path: string }>
  | Readonly<{ kind: "frozen-path"; path: string; contract: string }>
  | Readonly<{ kind: "malformed-entry"; path: string | null; line: string; reason: MalformedEntryReason }>
  | Readonly<{ kind: "duplicate-name"; path: string; name: string }>
  /** An export name equal to an alias on the same line: the TypeScript
   *  skeleton would import that alias and declare the name in one scope
   *  (TS2440). */
  | Readonly<{ kind: "name-collides-with-alias"; path: string; name: string }>
  | Readonly<{ kind: "duplicate-path"; path: string; contract: string }>
  | Readonly<{ kind: "multi-contract"; path: string; contracts: readonly [string, string, ...string[]] }>
  | Readonly<{ kind: "unknown-contract"; path: string; contract: string }>
  | Readonly<{ kind: "contract-without-types"; path: string; contract: string }>
  | Readonly<{ kind: "bound-on-contract-task"; path: string; contract: string; task: string }>
  | Readonly<{ kind: "unheld-path"; path: string }>
  | Readonly<{ kind: "holder-not-after-contract"; path: string; task: string; contractTask: string }>
  | Readonly<{ kind: "bound-on-waived-task"; path: string; task: string; reason: RegressionWaiverReason }>;

/** What `parseExportBindings` reads from a File Structure section: every
 *  well-formed binding in plan order, and every problem the grammar found.
 *  Total — a problem is collected, never thrown. */
export type ExportBindingsDeclaration = Readonly<{
  bindings: readonly ExportBinding[];
  problems: readonly BindingProblem[];
}>;

/** The Task fields binding validation reads. The contract Task of each
 *  contract is the Task whose `file_list` holds its frozen paths. */
export type BindingTaskView = Readonly<{
  id: string;
  file_list: readonly string[];
  depends_on: readonly string[];
  /** The Task's regression waiver reason, or null when regression is required. */
  regressionWaiver: RegressionWaiverReason | null;
}>;

// ---------------------------------------------------------------------------
// Languages and targets (AD-15, INV-6)
// ---------------------------------------------------------------------------

declare const SKELETON_TARGET: unique symbol;

type SkeletonTargetBrand = Readonly<{ [SKELETON_TARGET]: true }>;

/** A TypeScript skeleton target: `.ts`, `.tsx`, `.mts`, `.cts` (never a
 *  `.d.ts` declaration file). */
export type TsSkeletonTarget = Readonly<{ kind: "supported"; language: "typescript"; path: string }> & SkeletonTargetBrand;

/** A Java skeleton target: a `.java` path under a `src/main/java/` root;
 *  `package` is the path after that root (null for the default package),
 *  `className` the basename. */
export type JavaSkeletonTarget = Readonly<{
  kind: "supported";
  language: "java";
  path: string;
  package: string | null;
  className: string;
}> & SkeletonTargetBrand;

/**
 * A path parsed into a supported skeleton target, so every consumer works
 * from the one supported-language decision (INV-6) and never re-decides it.
 *
 * The brand is type-level. An object literal lacks the brand key, so nothing
 * builds a target without a type assertion, but TypeScript cannot forbid an
 * assertion. The single-constructor rule (`language.ts`'s `skeletonLanguageOf`
 * is the only code that asserts to a target type) is therefore enforced by a
 * source scan in `tests/core/skeleton-language.matrix.test.ts`, which fails
 * on such an assertion anywhere else in the engine, the Pi package or the
 * tests.
 */
export type SkeletonTarget = TsSkeletonTarget | JavaSkeletonTarget;

export type UnsupportedTarget = Readonly<{ kind: "unsupported"; path: string; reason: UnsupportedReason }>;

// ---------------------------------------------------------------------------
// Frozen types surfaces (AD-6, AD-7)
// ---------------------------------------------------------------------------

/** What a declared alias is, as far as binding goes. A TypeScript function
 *  type alias, or a Java interface with exactly one abstract method, is a
 *  `function`; `parameterCount` is its (single abstract method's) arity. */
export type AliasShape =
  | Readonly<{ kind: "function"; generic: boolean; parameterCount: number }>
  | Readonly<{ kind: "not-a-function" }>;

/** One type the frozen types file declares (TypeScript: an exported type
 *  alias or interface; Java: a type nested in the holder). */
export type DeclaredAlias = Readonly<{ name: string; shape: AliasShape }>;

/**
 * A frozen algebraic data type: implementations import it, never re-declare
 * or re-list it (FR-015..FR-017).
 */
export type FrozenAdt =
  | Readonly<{ kind: "discriminated-union"; name: string; discriminant: string; tags: NonEmpty<string>; variants: readonly string[] }>
  | Readonly<{ kind: "brand"; name: string }>
  | Readonly<{ kind: "sealed-interface"; name: string; variants: readonly string[] }>
  | Readonly<{ kind: "record"; name: string }>;

export type TsTypesSurface = Readonly<{
  language: "typescript";
  /** The types file's repository path. */
  path: string;
  aliases: readonly DeclaredAlias[];
  adts: readonly FrozenAdt[];
}>;

/** A frozen Java types file: exactly one top-level `public` interface or
 *  `public final class` (the holder) nesting every declared type. */
export type JavaTypesSurface = Readonly<{
  language: "java";
  path: string;
  /** The file's package, or null for the default package. */
  package: string | null;
  /** The holder's simple name. */
  holder: string;
  aliases: readonly DeclaredAlias[];
  adts: readonly FrozenAdt[];
}>;

export type FrozenSurface = TsTypesSurface | JavaTypesSurface;

/** A frozen surface with the contract whose types file it was read from. */
export type ContractSurface = Readonly<{ contract: string; surface: FrozenSurface }>;

/** Why a source text yields no surface. */
export type SurfaceProblem =
  | Readonly<{ kind: "unparseable"; path: string; detail: string }>
  | Readonly<{ kind: "unsupported-holder-shape"; path: string; detail: string }>;

/** The relative-specifier style the frozen acceptance tests use to import a
 *  types file (AD-8). */
export type SpecifierStyle = "extensionless" | ".js" | ".ts";

// ---------------------------------------------------------------------------
// Implementation surfaces (read for conformance, AD-11)
// ---------------------------------------------------------------------------

/** One exported binding of a TypeScript implementation file. */
export type TsExportedBinding = Readonly<{
  name: string;
  declaration: "const" | "let" | "var" | "function" | "class" | "re-export" | "other";
  /** The type annotation when it is a bare identifier (`export const name: Alias`), else null. */
  annotation: string | null;
  /** The module specifier the annotation identifier is imported from, or null when it is not imported. */
  annotationSource: string | null;
  /** Every string literal value inside the initializer or body. */
  initializerStrings: readonly string[];
}>;

export type TsLocalDeclaration = Readonly<{ name: string; kind: "type" | "interface" | "class" | "enum" }>;

/** The string-literal-valued properties of one object-shaped union member. */
export type LiteralProperties = readonly Readonly<{ key: string; literal: string }>[];

/** A local named union with its object-shaped members (members that are type
 *  references, such as imported frozen variants, are not listed). */
export type TsLocalUnion = Readonly<{ name: string; objectMembers: readonly LiteralProperties[] }>;

export type TsImplementationSurface = Readonly<{
  language: "typescript";
  path: string;
  exports: readonly TsExportedBinding[];
  localDeclarations: readonly TsLocalDeclaration[];
  localUnions: readonly TsLocalUnion[];
}>;

/** One field declaration of a Java implementation file's top-level class. */
export type JavaField = Readonly<{
  name: string;
  modifiers: readonly string[];
  /** The declared type token as written (`PriceOrderFn`, `OrderContract.PriceOrderFn`). */
  typeToken: string;
  initializerStrings: readonly string[];
}>;

export type JavaLocalType = Readonly<{
  name: string;
  kind: "class" | "interface" | "record" | "enum";
  sealed: boolean;
  /** Permitted simple names: explicit `permits`, or the implicit nested subtypes. */
  permits: readonly string[];
}>;

export type JavaImplementationSurface = Readonly<{
  language: "java";
  path: string;
  package: string | null;
  /** Each import's qualified name, as written (without `import` and `;`). */
  imports: readonly string[];
  fields: readonly JavaField[];
  localTypes: readonly JavaLocalType[];
}>;

// ---------------------------------------------------------------------------
// Stage-two resolution (FR-003)
// ---------------------------------------------------------------------------

/** A bound export whose alias the frozen surface declares as a bindable function type. */
export type ResolvedExport = Readonly<{ name: Identifier; alias: Identifier; parameterCount: number }>;

export type ResolvedBinding = Readonly<{
  path: string;
  contract: string;
  exports: NonEmpty<ResolvedExport>;
}>;

/** Why a binding cannot be generated. `path` is the binding file, `typesFile`
 *  the frozen types file. The last three are observed by the shell before
 *  resolution runs. */
export type ResolutionProblem =
  | Readonly<{ kind: "missing-alias"; alias: string; path: string; typesFile: string }>
  | Readonly<{ kind: "not-a-function"; alias: string; path: string; typesFile: string }>
  | Readonly<{ kind: "generic-alias"; alias: string; path: string; typesFile: string }>
  | Readonly<{ kind: "unsupported-holder-shape"; typesFile: string; detail: string }>
  | Readonly<{ kind: "types-unparseable"; typesFile: string; detail: string }>
  | Readonly<{ kind: "types-drifted"; typesFile: string }>;

// ---------------------------------------------------------------------------
// Canonical skeleton bytes (AD-8)
// ---------------------------------------------------------------------------

/**
 * What one skeleton is generated from, correlated by language at the type
 * level: a TypeScript target only ever pairs with a TypeScript surface, a Java
 * target with a Java surface. The skeleton's path is the target's path (the
 * input carries no second path), so generation has no mismatch to refuse and
 * is total. `contract` and `exports` come from the target path's
 * `ResolvedBinding`.
 */
export type GenerateSkeletonInput = TsSkeletonInput | JavaSkeletonInput;

export type TsSkeletonInput = Readonly<{
  language: "typescript";
  target: TsSkeletonTarget;
  surface: TsTypesSurface;
  contract: string;
  exports: NonEmpty<ResolvedExport>;
  /** The acceptance tests' specifier style; null means extensionless. */
  specifierStyle: SpecifierStyle | null;
}>;

export type JavaSkeletonInput = Readonly<{
  language: "java";
  target: JavaSkeletonTarget;
  surface: JavaTypesSurface;
  contract: string;
  exports: NonEmpty<ResolvedExport>;
}>;

/** Canonical skeleton bytes: LF, trailing newline, no timestamps; `sha256`
 *  is the lowercase hex digest of the UTF-8 bytes. */
export type GeneratedSkeleton = Readonly<{
  path: string;
  language: SkeletonLanguage;
  bytes: string;
  sha256: string;
}>;

// ---------------------------------------------------------------------------
// Skeleton records and outcomes (AD-4, AD-13)
// ---------------------------------------------------------------------------

/** Why a Task's outcomes cannot be derived: the graph holds no Task with that id. */
export type UnknownTask = Readonly<{ kind: "unknown-task"; taskId: string }>;

/** What the shell observed of one path: absent, or present with its current
 *  digest and the canonical digest the generator produces for the current
 *  surface (null when no canonical bytes exist). */
export type PathObservation =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "present"; sha256: string; canonicalSha256: string | null }>;

// ---------------------------------------------------------------------------
// Conformance (AD-11)
// ---------------------------------------------------------------------------

/** The verdict values (`ViolationReason`, `ConformanceViolation`,
 *  `ContractConformance`) live in the leaf `./conformance-verdict.ts`, which
 *  the proof channel can import without a cycle; re-exported here so every
 *  skeleton consumer keeps one import site. */
export type { ConformanceViolation, ContractConformance, ViolationReason } from "./conformance-verdict";

/** One in-scope production file with its parsed target; `text` null when missing. */
export type ConformanceFile = Readonly<{ target: SkeletonTarget; text: string | null }>;

export type JudgeConformanceInput = Readonly<{
  surfaces: readonly ContractSurface[];
  bindings: readonly ExportBinding[];
  files: readonly ConformanceFile[];
}>;

// ---------------------------------------------------------------------------
// Function signatures
// ---------------------------------------------------------------------------

/** The one `Identifier` constructor. */
export type ParseIdentifierFn = (raw: string) => DomainResult<Identifier, IdentifierProblem>;

/** The one `ContractId` constructor. */
export type ParseContractIdFn = (raw: string) => DomainResult<ContractId, ContractIdProblem>;

/** Read every `**Export bindings:**` list of a plan's File Structure section. */
export type ParseExportBindingsFn = (fileStructureSection: string) => ExportBindingsDeclaration;

/** Every refusal of a parsed declaration against the plan's contracts and Tasks (FR-002). */
export type ValidateExportBindingsFn = (
  declaration: ExportBindingsDeclaration,
  contracts: readonly PlanContract[],
  tasks: readonly BindingTaskView[],
) => readonly BindingProblem[];

export type ReadTsTypesSurfaceFn = (path: string, text: string) => DomainResult<TsTypesSurface, SurfaceProblem>;

export type ReadTsImplementationSurfaceFn = (path: string, text: string) => DomainResult<TsImplementationSurface, SurfaceProblem>;

/** The specifier style an acceptance file uses to import the types file, or
 *  null when it does not import it. */
export type TypesImportSpecifierFn = (acceptancePath: string, acceptanceText: string, typesPath: string) => SpecifierStyle | null;

/** Refuses any shape other than one top-level holder (`unsupported-holder-shape`). */
export type ReadJavaTypesSurfaceFn = (path: string, text: string) => DomainResult<JavaTypesSurface, SurfaceProblem>;

export type ReadJavaImplementationSurfaceFn = (path: string, text: string) => DomainResult<JavaImplementationSurface, SurfaceProblem>;

/** Resolve one contract's bindings against its frozen surface; every problem is listed. */
export type ResolveBindingsFn = (
  surface: FrozenSurface,
  bindings: readonly ExportBinding[],
) => DomainResult<readonly ResolvedBinding[], NonEmpty<ResolutionProblem>>;

/** Total: the input's types already rule out every mismatch. */
export type GenerateSkeletonFn = (input: GenerateSkeletonInput) => GeneratedSkeleton;

export type JudgeConformanceFn = (input: JudgeConformanceInput) => ContractConformance;

/** Exactly one outcome per non-test file_list path of the Task, in file_list
 *  order; `unknown-task` when the graph holds no Task with that id. */
export type SkeletonOutcomesOfFn = (
  graph: TaskGraph,
  taskId: string,
  observations: ReadonlyMap<string, PathObservation>,
) => DomainResult<readonly PathSkeletonOutcome[], UnknownTask>;

/** The one supported-language predicate (INV-6). */
export type SkeletonLanguageOfFn = (path: string) => SkeletonTarget | UnsupportedTarget;
