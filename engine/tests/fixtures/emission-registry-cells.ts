/**
 * The frozen emission registry's cells as fixtures — the ONE registry-cell
 * concept every emission suite (the Pi runtime, review route, provisioning,
 * transcript-frame, readiness, startup and launch-bridge suites, and the
 * emission-child harness) shares, so a registry change is edited here only.
 *
 * A cell is a (kind, version) pair the frozen registry actually carries, with
 * its tool spec and its own version-keyed schema record. `RegistryCell` is a
 * discriminated union DERIVED from `EMISSION_TOOL_SPECS`: each kind pairs only
 * with the versions its spec freezes, so a fixture naming an unsupported pair
 * (judge-verdict/v2, reviewer-payload/v1) is a compile error, never a runtime
 * mint refusal. The cell's tool name, frozen schema bytes and schema digest
 * are derived from it here, never re-declared by a consumer.
 *
 * Adding a registry cell is its constant and its `REGISTRY_CELLS` entry, plus
 * the one per-cell fixture datum — its `canonicalArguments` arm, which the
 * exhaustive switch turns into a compile error when omitted. Everything else
 * (schema bytes, digest, binding) is one typed lookup on the cell.
 */
import { EMISSION_TOOL_SPECS, type EmissionSchemaVersion, type IssuedEmissionBindingOf } from "../../src/core/emission-tool";
import type { PayloadProducerKindName } from "../../src/core/agent-catalog-projections";
import { sha256Hex } from "../../src/core/digest";
import {
  validJudgeArguments,
  validRefutationArguments,
  validReviewerArgumentsV2,
  validReviewerArgumentsV3,
} from "./emission-arguments";
import { mintEmissionBinding } from "./issued-emission";

type FrozenSpecs = typeof EMISSION_TOOL_SPECS;

/** The schema versions the frozen registry carries for producer kind `K` —
 *  exactly the versions a cell of that kind may name. */
type RegistryCellVersion<K extends PayloadProducerKindName> = keyof FrozenSpecs[K]["schemaVersions"] & EmissionSchemaVersion;

/** One (kind, version) cell: the kind's tool spec beside the frozen schema
 *  record the spec keys under that version. */
type CellOf<K extends PayloadProducerKindName, V extends RegistryCellVersion<K>> = Readonly<{
  kind: K;
  version: V;
  spec: FrozenSpecs[K];
  schema: FrozenSpecs[K]["schemaVersions"][V];
}>;

type CellsOfKind<K extends PayloadProducerKindName> = {
  readonly [V in RegistryCellVersion<K>]: CellOf<K, V>;
}[RegistryCellVersion<K>];

/** One frozen registry cell: a discriminated union over every legal
 *  (kind, version) pair. */
export type RegistryCell = {
  readonly [K in PayloadProducerKindName]: CellsOfKind<K>;
}[PayloadProducerKindName];

const registryCell = <K extends PayloadProducerKindName, V extends RegistryCellVersion<K>>(
  kind: K,
  version: V,
): CellOf<K, V> => {
  const spec: FrozenSpecs[K] = EMISSION_TOOL_SPECS[kind];
  const schemaVersions: FrozenSpecs[K]["schemaVersions"] = spec.schemaVersions;
  return Object.freeze({ kind, version, spec, schema: schemaVersions[version] });
};

export const REVIEWER_V2_CELL = registryCell("reviewer-payload", "v2");
export const REVIEWER_V3_CELL = registryCell("reviewer-payload", "v3");
export const JUDGE_V1_CELL = registryCell("judge-verdict", "v1");
export const REFUTATION_V1_CELL = registryCell("refutation-verdict", "v1");

/** Every frozen registry cell, once. */
export const REGISTRY_CELLS: readonly RegistryCell[] = Object.freeze([REVIEWER_V2_CELL, REVIEWER_V3_CELL, JUDGE_V1_CELL, REFUTATION_V1_CELL]);

/** The frozen schema bytes of one cell: the cell's own schema record, typed
 *  at construction, so no lookup can miss. */
export const cellSchemaBytes = (cell: RegistryCell): string => cell.schema.schemaBytes;

/** The cell's schema digest: the SHA-256 of its frozen schema bytes. */
export const cellSchemaDigest = (cell: RegistryCell): string => sha256Hex(cellSchemaBytes(cell));

/** Canonical emission arguments per registry cell, minted through the shared
 *  emission-argument fixtures over the real zod schemas (the qualification
 *  probe's fixture posture: a fixture exists only after `schema.parse`
 *  succeeds). */
export const canonicalArguments = (cell: RegistryCell): unknown => {
  switch (cell.kind) {
    case "reviewer-payload":
      return cell.version === "v2"
        ? validReviewerArgumentsV2("supported input bypasses the authorization check")
        : validReviewerArgumentsV3();
    case "judge-verdict":
      return validJudgeArguments("extensibility");
    case "refutation-verdict":
      return validRefutationArguments("reproduction");
  }
};

/** The registry-certified issued binding for `cell` under `requestId`, with
 *  the cell's own tool name and schema digest claimed (and re-verified by the
 *  mint). The cell's kind parameter carries through, so a reviewer cell mints
 *  the path-refined reviewer binding the capture observation takes. */
export const mintedBindingFor = <C extends RegistryCell>(
  cell: C,
  requestId: string,
): IssuedEmissionBindingOf<C["kind"]> => mintEmissionBinding({
  requestId,
  kind: cell.kind,
  version: cell.version,
  toolName: cell.spec.toolName,
  schemaDigest: cellSchemaDigest(cell),
});

/** The request id the transcript-observation fixtures mint their issued bindings under. */
export const OBSERVED_REQUEST_ID = "req-emission-tool-t5-obs";
