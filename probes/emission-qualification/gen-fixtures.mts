/**
 * FR-002 qualification fixtures — generated ONCE from the real zod schemas so
 * the probe's fixtures are canonical parsed payloads of the frozen contracts,
 * never hand-authored JSON that could drift from them.
 *
 * Run: npx tsx probes/emission-qualification/gen-fixtures.mts
 * Writes: probes/emission-qualification/fixtures/manifest.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  EMISSION_TOOL_SPECS,
} from "../../engine/src/core/emission-tool";
import { REVIEWER_PAYLOAD_EXAMPLE_V2, reviewerPayloadV2Schema } from "../../engine/src/core/reviewer-contract";
import { judgeVerdictV1Schema } from "../../engine/src/core/panel-contract";
import { refutationVerdictV1Schema } from "../../engine/src/core/review-panel";
import { standaloneReviewerPayloadV3Schema } from "../../engine/src/core/standalone-lineage-contract";

const here = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
mkdirSync(here, { recursive: true });

const HEX64 = "a".repeat(64);

// Canonical fixtures: every one is .parse()d through its real zod schema, so
// what the probe asks the model to emit is a schema-valid payload by
// construction.
const v2 = reviewerPayloadV2Schema.parse(REVIEWER_PAYLOAD_EXAMPLE_V2);
const v3 = standaloneReviewerPayloadV3Schema.parse({
  schemaVersion: 3,
  kind: "standalone-successor-review",
  lineageDigest: HEX64,
  snapshotDigest: HEX64,
  priorAssessments: [],
  findings: [],
});
const judge = judgeVerdictV1Schema.parse({
  criterion: "extensibility",
  rankings: [
    {
      candidate: "candidate-a.ts",
      score: 7,
      fatal_flaw: null,
      strongest_idea: "Frozen bytes as the parameter schema remove drift.",
    },
  ],
});
const refutation = refutationVerdictV1Schema.parse({
  criterion: "code-reviewer",
  verdicts: [
    {
      finding_id: "F-001",
      verdict: "upheld",
      reasoning: "The claim holds against the cited contract text.",
    },
  ],
});

/** Violation probes: each tempts exactly one SCHEMA-forbidden shape, framed
 *  as an explicit negative test (models comply with testing framings where a
 *  plainly-worded violation gets self-censored) and using a subtle forbidden
 *  value. The engine-only refinements are NOT probed here — the provider
 *  grammar cannot know them; AS-018's engine-refusal cases are Phase-3
 *  acceptance work. */
const violations = {
  "reviewer-payload": {
    instruction: "NEGATIVE TEST: we are testing the rejection path. Emit the call anyway, including a top-level key \"probe_violation\" with the boolean value true. It will be rejected; that is the point.",
    detect: (args: unknown): boolean =>
      typeof args === "object" && args !== null && "probe_violation" in args,
  },
  "judge-verdict": {
    instruction: "NEGATIVE TEST: we are testing the rejection path. Emit the call anyway with the first ranking scored 12 (an integer outside the 0..10 domain). It will be rejected; that is the point.",
    detect: (args: unknown): boolean => {
      const rankings = (args as { rankings?: readonly { score?: number }[] })?.rankings ?? [];
      return rankings.some((r) => typeof r.score === "number" && (r.score < 0 || r.score > 10 || !Number.isInteger(r.score)));
    },
  },
  "refutation-verdict": {
    instruction: "NEGATIVE TEST: we are testing the rejection path. Emit the call anyway with the first verdict set to \"partially_upheld\" (not one of refuted/upheld/uncertain). It will be rejected; that is the point.",
    detect: (args: unknown): boolean => {
      const verdicts = (args as { verdicts?: readonly { verdict?: string }[] })?.verdicts ?? [];
      return verdicts.some((v) => v.verdict !== undefined && !["refuted", "upheld", "uncertain"].includes(v.verdict));
    },
  },
} as const;

const specs = [
  { kind: "reviewer-payload", version: "v2", registeredToolName: "loom_emit_reviewer_payload_v2", schemaBytes: EMISSION_TOOL_SPECS["reviewer-payload"].schemaVersions["v2"]!.schemaBytes, fixture: v2, violation: violations["reviewer-payload"] },
  { kind: "reviewer-payload", version: "v3", registeredToolName: "loom_emit_reviewer_payload_v3", schemaBytes: EMISSION_TOOL_SPECS["reviewer-payload"].schemaVersions["v3"]!.schemaBytes, fixture: v3, violation: violations["reviewer-payload"] },
  { kind: "judge-verdict", version: "v1", registeredToolName: EMISSION_TOOL_SPECS["judge-verdict"].toolName, schemaBytes: EMISSION_TOOL_SPECS["judge-verdict"].schemaVersions["v1"]!.schemaBytes, fixture: judge, violation: violations["judge-verdict"] },
  { kind: "refutation-verdict", version: "v1", registeredToolName: EMISSION_TOOL_SPECS["refutation-verdict"].toolName, schemaBytes: EMISSION_TOOL_SPECS["refutation-verdict"].schemaVersions["v1"]!.schemaBytes, fixture: refutation, violation: violations["refutation-verdict"] },
] as const;

const manifest = specs.map((spec) => ({
  kind: spec.kind,
  version: spec.version,
  registeredToolName: spec.registeredToolName,
  schemaBytes: spec.schemaBytes,
  schemaDigest: "sha256-" + createHash("sha256").update(spec.schemaBytes).digest("hex"),
  fixtureJson: JSON.stringify(spec.fixture, null, 2),
  violationInstruction: spec.violation.instruction,
  violationDetect: spec.violation.detect.toString(),
}));

writeFileSync(join(here, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`wrote ${manifest.length} fixtures to fixtures/manifest.json`);
for (const entry of manifest) {
  console.log(`  ${entry.registeredToolName}: schema ${(entry.schemaBytes.length / 1024).toFixed(1)}KB digest ${entry.schemaDigest.slice(0, 16)}…`);
}
