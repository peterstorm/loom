/**
 * The read obligation (ADR-0022) as a registration fact: `readObligated` is the
 * one predicate every consumer asks. Only a schema-2 standalone registration
 * carrying the read-coverage policy obliges its reviewers to read their frozen
 * diff; a v1 Run, a v2 Run registered before the policy existed and a
 * successor (v3) Run do not.
 */
import { describe, expect, it } from "vitest";
import { encodeByteSection } from "../../../../src/core/context-packets";
import { CURRENT_REVIEWER_PROTOCOL } from "../../../../src/core/reviewer-contract";
import { STANDALONE_READ_COVERAGE_V1 } from "../../../../src/core/standalone-read-coverage";
import { STANDALONE_REVIEWER_PROTOCOL_V3 } from "../../../../src/core/standalone-lineage-contract";
import { readObligated, type RegisteredStandaloneProgram } from "../../../../src/handlers/helpers/programs/registration";
import { parseStandaloneSuccessorRegistration } from "../../../../src/handlers/helpers/programs/standalone-successor-registration";
import { value } from "../../../fixtures/parse-result";

const INPUT = Object.freeze({ kind: "code" as const, files: null, dryRun: false });

const V1: RegisteredStandaloneProgram = { schemaVersion: 1, kind: "standalone-review", input: INPUT, authority: {} };
const V2: RegisteredStandaloneProgram = {
  schemaVersion: 2, reviewerProtocol: CURRENT_REVIEWER_PROTOCOL, kind: "standalone-review", input: INPUT, authority: {},
};
const V2_WITH_COVERAGE: RegisteredStandaloneProgram = { ...V2, schemaVersion: 2, readCoverage: STANDALONE_READ_COVERAGE_V1 };

/** A successor registration as its own parser admits one. */
function successorRegistration(): RegisteredStandaloneProgram {
  const section = value(encodeByteSection("standalone-frozen-source", JSON.stringify({ kind: "fixture" })));
  return value(parseStandaloneSuccessorRegistration({
    schemaVersion: 3,
    kind: "standalone-review",
    reviewerProtocol: STANDALONE_REVIEWER_PROTOCOL_V3,
    input: {
      schemaVersion: 3, kind: "types", files: ["a.ts"], dryRun: false,
      successor: { source: { locator: "/owned/source", runId: "source", resultDigest: "a".repeat(64) },
        disposition: { kind: "historical-decision-unavailable" } },
    },
    authority: {},
    currentSource: { label: section.label, bytes: section.bytes, digest: section.digest, byteLength: section.byteLength },
    previousContexts: [],
  }));
}

describe("readObligated", () => {
  it.each<[string, () => RegisteredStandaloneProgram, boolean]>([
    ["a v1 registration", () => V1, false],
    ["a v2 registration without the read-coverage policy", () => V2, false],
    ["a successor (v3) registration", successorRegistration, false],
    ["a v2 registration carrying the read-coverage policy", () => V2_WITH_COVERAGE, true],
  ])("answers for %s", (_label, registration, obligated) => {
    expect(readObligated(registration())).toBe(obligated);
  });
});
