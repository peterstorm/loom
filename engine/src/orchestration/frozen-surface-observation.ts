/**
 * Observe a contract's frozen types file as a parsed surface (AD-1 stage two,
 * AD-9's stub step). The bytes are read without following any link; the
 * reader — TypeScript or Java — is chosen by `skeletonLanguageOf` (INV-6
 * sibling), never by an extension test here.
 *
 * - `stamped`: the bytes must digest to the contract's Acceptance Freeze stamp
 *   for the types file, else `types-drifted` (a types file with no stamp, a
 *   contract still awaiting red, can equal none). Registration uses this, so a
 *   skeleton is only ever generated from the compiler-checked frozen bytes.
 * - `current`: the bytes as they are now, for the contract Task's own stop,
 *   which runs before its freeze is stamped.
 *
 * Every failure is a `ResolutionProblem` value naming the types file.
 */

import { join } from "node:path";
import type { AcceptanceContract, ContractTypes } from "../core/acceptance-contract";
import { sha256Bytes } from "../core/digest";
import type { DomainResult } from "../core/orchestration-contract";
import { samePlanPath } from "../core/plan-path-match";
import { readJavaTypesSurface } from "../core/skeleton/java-surface";
import { skeletonLanguageOf } from "../core/skeleton/language";
import { readTsTypesSurface, typesImportSpecifier } from "../core/skeleton/ts-surface";
import type { FrozenSurface, ResolutionProblem, SpecifierStyle, SurfaceProblem } from "../core/skeleton/types";
import { readRunBytesNoFollow, resolveBaseDirectory } from "../utils/no-follow-fs";
import { describeCause } from "../utils/describe-cause";

export type FrozenSurfaceMode = "stamped" | "current";

/** A parsed frozen surface and the digest of the bytes it was read from. */
export type ObservedFrozenSurface = FrozenSurface & Readonly<{ typesSha256: string }>;

/** A contract that freezes a types file: the only kind with a surface. */
export type TypedContract = AcceptanceContract & Readonly<{ types: Extract<ContractTypes, { kind: "file" }> }>;

/** The contract as a `TypedContract`, or null when it freezes no types file. */
export const typedContract = (contract: AcceptanceContract): TypedContract | null =>
  contract.types.kind === "file" ? Object.freeze({ ...contract, types: contract.types }) : null;

/** The repository bytes of `path`, read without following any component. */
const readNoFollow = (root: string, path: string): Buffer => readRunBytesNoFollow(join(resolveBaseDirectory(root), path));

const surfaceProblem = (problem: SurfaceProblem): ResolutionProblem =>
  Object.freeze({ kind: problem.kind === "unparseable" ? "types-unparseable" : "unsupported-holder-shape", typesFile: problem.path, detail: problem.detail });

/** The freeze stamp's digest of the types file, or null when none is stamped. */
function stampedDigest(contract: TypedContract): string | null {
  if (contract.freeze.state === "awaiting-red") return null;
  return contract.freeze.paths.find(({ path }) => samePlanPath(path, contract.types.path))?.sha256 ?? null;
}

/** Parse `text` with the reader `skeletonLanguageOf` picks for `typesFile`. */
function readSurface(typesFile: string, text: string): DomainResult<FrozenSurface, ResolutionProblem> {
  const target = skeletonLanguageOf(typesFile);
  if (target.kind === "unsupported") {
    return { ok: false, error: Object.freeze({ kind: "types-unparseable", typesFile, detail: `no skeleton language reads it (${target.reason})` }) };
  }
  const surface: DomainResult<FrozenSurface, SurfaceProblem> = target.language === "typescript"
    ? readTsTypesSurface(typesFile, text)
    : readJavaTypesSurface(typesFile, text);
  return surface.ok ? surface : { ok: false, error: surfaceProblem(surface.error) };
}

export function observeFrozenSurface(
  root: string,
  contract: TypedContract,
  mode: FrozenSurfaceMode,
): DomainResult<ObservedFrozenSurface, ResolutionProblem> {
  const typesFile = contract.types.path;
  let bytes: Buffer;
  try {
    bytes = readNoFollow(root, typesFile);
  } catch (error) {
    return { ok: false, error: Object.freeze({ kind: "types-unparseable", typesFile, detail: `unreadable: ${describeCause(error)}` }) };
  }
  const typesSha256 = sha256Bytes(bytes);
  if (mode === "stamped" && stampedDigest(contract) !== typesSha256) {
    return { ok: false, error: Object.freeze({ kind: "types-drifted", typesFile }) };
  }
  const surface = readSurface(typesFile, bytes.toString("utf-8"));
  return surface.ok ? { ok: true, value: Object.freeze({ ...surface.value, typesSha256 }) } : surface;
}

/**
 * The relative-specifier style the contract's TypeScript acceptance files
 * import its types file with (AD-8): the first file that imports it decides;
 * null when none does. Only TypeScript acceptance files are read.
 */
export function observeSpecifierStyle(root: string, contract: TypedContract): DomainResult<SpecifierStyle | null, string> {
  for (const { path } of contract.acceptance) {
    const target = skeletonLanguageOf(path);
    if (target.kind === "unsupported" || target.language !== "typescript") continue;
    let text: string;
    try {
      text = readNoFollow(root, path).toString("utf-8");
    } catch (error) {
      return { ok: false, error: `cannot read ${contract.id}'s acceptance file ${path}: ${describeCause(error)}` };
    }
    const style = typesImportSpecifier(path, text, contract.types.path);
    if (style !== null) return { ok: true, value: style };
  }
  return { ok: true, value: null };
}
