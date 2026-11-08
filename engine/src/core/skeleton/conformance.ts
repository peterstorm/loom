/**
 * The completion conformance judge (AD-11): every violation of one Task's
 * in-scope production files against its frozen contracts, as data, and the
 * diagnostic that lists them. Pure — texts and parsed surfaces in, a
 * `ContractConformance` out.
 *
 * Per bound export (FR-013, FR-014), judged against its contract's surface:
 * - `deleted` — no export (TypeScript) or field of the file's class (Java)
 *   carries the name, or the file is missing or no longer parses: an
 *   unreadable file proves none of its bound exports, and its remedy names
 *   the reader's problem.
 * - `renamed` — the name is missing, and another export or field that is no
 *   bound name of the binding carries the same frozen alias.
 * - `retyped` — the name is present, but not as `export const name: Alias`
 *   (TypeScript) or `static final Alias name` (Java), with `Alias` proven to
 *   come from the frozen types file or holder.
 * - `still unimplemented` — a string literal of the initializer or body is
 *   exactly `unimplemented: <name>`. Any other throw passes (AS-025).
 *
 * Per frozen ADT of a surface of the file's own language (FR-015..FR-017):
 * - `shadows frozen ADT` — a local type, interface, class, enum or record,
 *   at any depth, named as a frozen ADT or one of its named variants.
 * - `re-lists frozen variants` — a local union whose object-shaped members
 *   carry the frozen discriminant key with two or more distinct frozen tags,
 *   or a local sealed type permitting two or more frozen variant names. The
 *   remedy names the frozen and the local type.
 *
 * Every violation is listed: per file, the signature violations in binding
 * order, then the shadowing ones, then the re-listing ones. Only files with a
 * violation appear, in input order. Syntactic only — no assignability.
 * Additions never add a violation (FR-022): every rule starts from a bound
 * name or a frozen name, never from what else a file declares.
 */

import { match } from "ts-pattern";
import type { DomainResult, NonEmpty } from "../orchestration-contract";
import { samePlanPath } from "../plan-path-match";
import { readJavaImplementationSurface } from "./java-surface";
import { readTsImplementationSurface, typesImportSpecifier } from "./ts-surface";
import type {
  BoundExport,
  ConformanceFile,
  ConformanceViolation,
  ContractSurface,
  ExportBinding,
  FrozenAdt,
  FrozenSurface,
  JavaImplementationSurface,
  JavaTypesSurface,
  JudgeConformanceFn,
  SurfaceProblem,
  TsImplementationSurface,
  TsTypesSurface,
  ViolationReason,
} from "./types";

type Violations = readonly ConformanceViolation[];

const violation = (subject: string, reason: ViolationReason, remedy: string | null = null): ConformanceViolation => ({
  subject,
  reason,
  remedy,
});

const unique = <T>(values: readonly T[]): readonly T[] => [...new Set(values)];

// ---------------------------------------------------------------------------
// Signatures: one rule over a language-neutral member view
// ---------------------------------------------------------------------------

/** One exported name (TypeScript) or field of the file's class (Java):
 *  `frozenAlias` is the alias it is typed by when it has the bound form and
 *  the alias is proven frozen, else null. */
type Member = Readonly<{ name: string; frozenAlias: string | null; strings: readonly string[] }>;

const markerOf = (name: string): string => `unimplemented: ${name}`;

const judgeBoundExport = (bound: BoundExport, members: readonly Member[], boundNames: ReadonlySet<string>): Violations => {
  const member = members.find(({ name }) => name === bound.name);
  if (member === undefined) {
    const movedElsewhere = members.some(({ name, frozenAlias }) => frozenAlias === bound.alias && !boundNames.has(name));
    return [violation(bound.name, movedElsewhere ? "renamed" : "deleted")];
  }
  return [
    ...(member.frozenAlias === bound.alias ? [] : [violation(bound.name, "retyped")]),
    ...(member.strings.includes(markerOf(bound.name)) ? [violation(bound.name, "still-unimplemented")] : []),
  ];
};

/** Every signature violation of one binding of a file that was read. */
const judgeBinding = (binding: ExportBinding, members: readonly Member[]): Violations => {
  const boundNames = new Set<string>(binding.exports.map(({ name }) => name));
  return binding.exports.flatMap((bound) => judgeBoundExport(bound, members, boundNames));
};

// ---------------------------------------------------------------------------
// Frozen ADTs: names and re-listings
// ---------------------------------------------------------------------------

const frozenNamesOf = (adt: FrozenAdt): readonly string[] =>
  match(adt)
    .with({ kind: "discriminated-union" }, { kind: "sealed-interface" }, ({ name, variants }) => [name, ...variants])
    .with({ kind: "brand" }, { kind: "record" }, ({ name }) => [name])
    .exhaustive();

/** One `shadows frozen ADT` per local name that a frozen ADT or variant carries, in declaration order. */
const judgeShadowing = (localNames: readonly string[], adts: readonly FrozenAdt[]): Violations => {
  const frozen = new Set(adts.flatMap(frozenNamesOf));
  return unique(localNames.filter((name) => frozen.has(name))).map((name) => violation(name, "shadows-frozen-adt"));
};

type DiscriminatedUnion = Extract<FrozenAdt, { kind: "discriminated-union" }>;
type SealedInterface = Extract<FrozenAdt, { kind: "sealed-interface" }>;

const isDiscriminatedUnion = (adt: FrozenAdt): adt is DiscriminatedUnion => adt.kind === "discriminated-union";
const isSealedInterface = (adt: FrozenAdt): adt is SealedInterface => adt.kind === "sealed-interface";

const RELISTING_THRESHOLD = 2;

const unionRemedy = (local: string, frozen: DiscriminatedUnion, tags: readonly string[]): string =>
  `${local} re-lists the variants ${tags.map((tag) => `"${tag}"`).join(", ")} of the frozen union ${frozen.name}: derive it as `
  + `Extract<${frozen.name}, ${tags.map((tag) => `{ ${frozen.discriminant}: "${tag}" }`).join(" | ")}>, `
  + `or use ${frozen.name} and its variant types directly`;

const hierarchyRemedy = (local: string, frozen: SealedInterface, variants: readonly string[]): string =>
  `${local} re-lists the variants ${variants.join(", ")} of the frozen sealed interface ${frozen.name}: `
  + `use ${frozen.name} and its variants directly, imported from the frozen holder`;

/** Each local union re-listing two or more distinct tags of a frozen union, on its discriminant key. */
const judgeTsRelisting = (implementation: TsImplementationSurface, adts: readonly FrozenAdt[]): Violations =>
  implementation.localUnions.flatMap((local) =>
    adts.filter(isDiscriminatedUnion).flatMap((frozen) => {
      const tags = unique(local.objectMembers.flatMap((properties) =>
        properties.filter(({ key, literal }) => key === frozen.discriminant && frozen.tags.includes(literal)).map(({ literal }) => literal)));
      return tags.length >= RELISTING_THRESHOLD
        ? [violation(frozen.name, "re-lists-frozen-variants", unionRemedy(local.name, frozen, tags))]
        : [];
    }));

/** Each local sealed type permitting two or more variants of a frozen sealed interface. */
const judgeJavaRelisting = (implementation: JavaImplementationSurface, adts: readonly FrozenAdt[]): Violations =>
  implementation.localTypes.filter(({ sealed }) => sealed).flatMap((local) =>
    adts.filter(isSealedInterface).flatMap((frozen) => {
      const shared = unique(local.permits.filter((name) => frozen.variants.includes(name)));
      return shared.length >= RELISTING_THRESHOLD
        ? [violation(frozen.name, "re-lists-frozen-variants", hierarchyRemedy(local.name, frozen, shared))]
        : [];
    }));

// ---------------------------------------------------------------------------
// TypeScript files
// ---------------------------------------------------------------------------

type Judged<S> = Readonly<{ contract: string; surface: S }>;

/** An annotation is frozen when it is imported from the types file; the one
 *  rule for whether a specifier names that file is `typesImportSpecifier`'s. */
const namesTypesFile = (path: string, specifier: string, typesPath: string): boolean =>
  typesImportSpecifier(path, `import ${JSON.stringify(specifier)};\n`, typesPath) !== null;

const tsMembers = (implementation: TsImplementationSurface, surface: TsTypesSurface | undefined): readonly Member[] =>
  implementation.exports.map(({ name, declaration, annotation, annotationSource, initializerStrings }) => ({
    name,
    frozenAlias:
      surface !== undefined && declaration === "const" && annotation !== null && annotationSource !== null
        && namesTypesFile(implementation.path, annotationSource, surface.path)
        ? annotation
        : null,
    strings: initializerStrings,
  }));

// ---------------------------------------------------------------------------
// Java files
// ---------------------------------------------------------------------------

const qualified = (pkg: string | null, name: string): string => (pkg === null ? name : `${pkg}.${name}`);

/**
 * Whether a simple type name, used in the implementation, names `target`:
 * a single-type import of that simple name decides alone; without one, the
 * name is visible through `fallback` (the same package, or an on-demand
 * import of `target`'s owner). A local type of that name shadows every import.
 */
const resolvesTo = (
  implementation: JavaImplementationSurface,
  simple: string,
  target: string,
  fallback: boolean,
): boolean => {
  if (implementation.localTypes.some(({ name }) => name === simple)) return false;
  const singleType = implementation.imports.filter((name) => name.split(".").at(-1) === simple);
  const owner = target.slice(0, Math.max(target.lastIndexOf("."), 0));
  return singleType.length > 0
    ? singleType.every((name) => name === target)
    : fallback || (owner !== "" && implementation.imports.includes(`${owner}.*`));
};

/** The alias a field's type token names when it is a type nested in the frozen holder, else null. */
const frozenJavaAlias = (implementation: JavaImplementationSurface, token: string, surface: JavaTypesSurface): string | null => {
  const holder = qualified(surface.package, surface.holder);
  const segments = token.split(".");
  const alias = segments.at(-1) ?? "";
  const prefix = segments.slice(0, -1).join(".");
  const proven = match(prefix)
    .with("", () => resolvesTo(implementation, alias, `${holder}.${alias}`, false))
    .with(surface.holder, () => resolvesTo(implementation, surface.holder, holder, implementation.package === surface.package))
    .otherwise(() => prefix === holder);
  return proven ? alias : null;
};

const javaMembers = (implementation: JavaImplementationSurface, surface: JavaTypesSurface | undefined): readonly Member[] =>
  implementation.fields.map(({ name, modifiers, typeToken, initializerStrings }) => ({
    name,
    frozenAlias:
      surface !== undefined && modifiers.includes("static") && modifiers.includes("final")
        ? frozenJavaAlias(implementation, typeToken, surface)
        : null,
    strings: initializerStrings,
  }));

// ---------------------------------------------------------------------------
// One file, through its language's reading
// ---------------------------------------------------------------------------

/** What the judge needs of one language: how a file is read (the reader's
 *  problem when it does not parse), and the views every rule works from. */
type LanguageReading<I, S> = Readonly<{
  read: (path: string, text: string) => DomainResult<I, SurfaceProblem>;
  members: (implementation: I, surface: S | undefined) => readonly Member[];
  localNames: (implementation: I) => readonly string[];
  relisting: (implementation: I, adts: readonly FrozenAdt[]) => Violations;
}>;

const TYPESCRIPT: LanguageReading<TsImplementationSurface, TsTypesSurface> = {
  read: readTsImplementationSurface,
  members: tsMembers,
  localNames: ({ localDeclarations }) => localDeclarations.map(({ name }) => name),
  relisting: judgeTsRelisting,
};

const JAVA: LanguageReading<JavaImplementationSurface, JavaTypesSurface> = {
  read: readJavaImplementationSurface,
  members: javaMembers,
  localNames: ({ localTypes }) => localTypes.map(({ name }) => name),
  relisting: judgeJavaRelisting,
};

/** Why a present file proves none of its bound exports: the reader's problem, as a remedy. */
const unreadableRemedy = (problem: SurfaceProblem): string =>
  match(problem)
    .with({ kind: "unparseable" }, ({ path, detail }) => `${path} no longer parses (${detail})`)
    .with({ kind: "unsupported-holder-shape" }, ({ path, detail }) => `${path} cannot be read (${detail})`)
    .exhaustive() + ", so none of its bound exports is proven; make it parse";

/** Every bound export of a file that was not read, `deleted`: a missing file
 *  names no remedy, an unreadable one names its problem. */
const judgeUnread = (bindings: readonly ExportBinding[], remedy: string | null): Violations =>
  bindings.flatMap(({ exports }) => exports.map(({ name }) => violation(name, "deleted", remedy)));

/** Every violation of one file: its bindings' signatures, then the frozen ADTs of its language's surfaces. */
const judgeWith = <I, S extends FrozenSurface>(
  reading: LanguageReading<I, S>,
  file: Readonly<{ path: string; text: string | null }>,
  surfaces: readonly Judged<S>[],
  bindings: readonly ExportBinding[],
): Violations => {
  if (file.text === null) return judgeUnread(bindings, null);
  const read = reading.read(file.path, file.text);
  if (!read.ok) return judgeUnread(bindings, unreadableRemedy(read.error));
  const implementation = read.value;
  const signature = bindings.flatMap((binding) => judgeBinding(
    binding,
    reading.members(implementation, surfaces.find(({ contract }) => contract === binding.contract)?.surface),
  ));
  const adts = surfaces.flatMap(({ surface }) => surface.adts);
  return [...signature, ...judgeShadowing(reading.localNames(implementation), adts), ...reading.relisting(implementation, adts)];
};

// ---------------------------------------------------------------------------
// The judge and the diagnostic
// ---------------------------------------------------------------------------

const tsSurfaces = (surfaces: readonly ContractSurface[]): readonly Judged<TsTypesSurface>[] =>
  surfaces.flatMap(({ contract, surface }) => (surface.language === "typescript" ? [{ contract, surface }] : []));

const javaSurfaces = (surfaces: readonly ContractSurface[]): readonly Judged<JavaTypesSurface>[] =>
  surfaces.flatMap(({ contract, surface }) => (surface.language === "java" ? [{ contract, surface }] : []));

const judgeFile = (file: ConformanceFile, surfaces: readonly ContractSurface[], bindings: readonly ExportBinding[]): Violations => {
  const bound = bindings.filter(({ path }) => samePlanPath(path, file.target.path));
  return match(file.target)
    .with({ language: "typescript" }, ({ path }) => judgeWith(TYPESCRIPT, { path, text: file.text }, tsSurfaces(surfaces), bound))
    .with({ language: "java" }, ({ path }) => judgeWith(JAVA, { path, text: file.text }, javaSurfaces(surfaces), bound))
    .exhaustive();
};

export const judgeConformance: JudgeConformanceFn = ({ surfaces, bindings, files }) => ({
  kind: "judged",
  violations: new Map(files.flatMap((file) => {
    const [first, ...rest] = judgeFile(file, surfaces, bindings);
    return first === undefined ? [] : [[file.target.path, [first, ...rest]] as const];
  })),
});

/** The diagnostic's wording of each reason (FR-021). */
const REASON_WORDS: Readonly<Record<ViolationReason, string>> = {
  deleted: "deleted",
  renamed: "renamed",
  retyped: "retyped",
  "still-unimplemented": "still unimplemented",
  "shadows-frozen-adt": "shadows frozen ADT",
  "re-lists-frozen-variants": "re-lists frozen variants",
};

/** One diagnostic for one artifact: its path, then every violation — the
 *  subject, the reason in words (`deleted`, `renamed`, `retyped`, `still
 *  unimplemented`, `shadows frozen ADT`, `re-lists frozen variants`) and the
 *  remedy where one exists. */
export const renderConformanceViolations = (artifact: string, violations: NonEmpty<ConformanceViolation>): string =>
  [
    `${artifact}:`,
    ...violations.map(({ subject, reason, remedy }) => `  - ${subject}: ${REASON_WORDS[reason]}${remedy === null ? "" : ` — ${remedy}`}`),
  ].join("\n");
