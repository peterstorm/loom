/**
 * The frozen emission registry's cells as Pi-suite fixtures: one record per
 * (kind, version) with its tool spec, the canonical arguments minted from the
 * real zod schemas, and the issued binding for a cell under a request id —
 * through the shared binding mint (`issued-emission`). The Pi runtime, review
 * route, provisioning and transcript-frame suites share them, so a registry
 * change is one edit here.
 */
import { EMISSION_TOOL_SPECS, type EmissionSchemaVersion, type EmissionToolSpec, type IssuedEmissionBindingOf } from "../../src/core/emission-tool";
import type { PayloadProducerKindName } from "../../src/core/model-profiles";
import { sha256Hex } from "../../src/core/digest";
import {
  validJudgeArguments,
  validRefutationArguments,
  validReviewerArgumentsV2,
  validReviewerArgumentsV3,
} from "./emission-arguments";
import { mintEmissionBinding } from "./issued-emission";

export interface RegistryCell<K extends PayloadProducerKindName = PayloadProducerKindName> {
  readonly kind: K;
  readonly version: EmissionSchemaVersion;
  readonly spec: EmissionToolSpec;
}

export const REVIEWER_V2_CELL: RegistryCell<"reviewer-payload"> = {
  kind: "reviewer-payload", version: "v2", spec: EMISSION_TOOL_SPECS["reviewer-payload"],
};
export const REVIEWER_V3_CELL: RegistryCell<"reviewer-payload"> = {
  kind: "reviewer-payload", version: "v3", spec: EMISSION_TOOL_SPECS["reviewer-payload"],
};
export const JUDGE_V1_CELL: RegistryCell<"judge-verdict"> = {
  kind: "judge-verdict", version: "v1", spec: EMISSION_TOOL_SPECS["judge-verdict"],
};
export const REFUTATION_V1_CELL: RegistryCell<"refutation-verdict"> = {
  kind: "refutation-verdict", version: "v1", spec: EMISSION_TOOL_SPECS["refutation-verdict"],
};

export const REGISTRY_CELLS: readonly RegistryCell[] = [REVIEWER_V2_CELL, REVIEWER_V3_CELL, JUDGE_V1_CELL, REFUTATION_V1_CELL];

/** The frozen schema bytes of one cell. */
const cellSchemaBytes = (cell: RegistryCell): string => cell.spec.schemaVersions[cell.version]!.schemaBytes;

/** Canonical emission arguments per registry cell, minted through the shared
 *  emission-argument fixtures over the real zod schemas (the qualification
 *  probe's fixture posture: a fixture exists only after `schema.parse`
 *  succeeds). */
export const canonicalArguments = (kind: RegistryCell["kind"], version: EmissionSchemaVersion): unknown => {
  if (kind === "reviewer-payload") {
    return version === "v2"
      ? validReviewerArgumentsV2("supported input bypasses the authorization check")
      : validReviewerArgumentsV3();
  }
  return kind === "judge-verdict" ? validJudgeArguments("extensibility") : validRefutationArguments("reproduction");
};

/** The registry-certified issued binding for `cell` under `requestId`, with
 *  the cell's own tool name and schema digest claimed (and re-verified by the
 *  mint). The cell's kind parameter carries through, so a reviewer cell mints
 *  the path-refined reviewer binding the capture observation takes. */
export const mintedBindingFor = <K extends PayloadProducerKindName>(
  cell: RegistryCell<K>,
  requestId: string,
): IssuedEmissionBindingOf<K> => mintEmissionBinding({
  requestId,
  kind: cell.kind,
  version: cell.version,
  toolName: cell.spec.toolName,
  schemaDigest: sha256Hex(cellSchemaBytes(cell)),
});

/** The request id the transcript-observation fixtures mint their issued bindings under. */
export const OBSERVED_REQUEST_ID = "req-emission-tool-t5-obs";
