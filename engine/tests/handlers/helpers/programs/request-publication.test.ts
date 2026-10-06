import { describe, expect, it } from "vitest";
import { legacyPublicationRefusal } from "../../../../src/handlers/helpers/programs/request-publication";
import type { RegisteredWaveGateProgram } from "../../../../src/core/wave-gate-program";
import { CURRENT_REVIEWER_PROTOCOL } from "../../../../src/core/reviewer-contract";

/** The pure legacy publication admission: only an archived schema-1 program may use the legacy route. */
const DIGEST = "a".repeat(64);
const program = { kind: "wave-gate", input: { wave: 1 }, taskIds: ["T1", "T2"], authorityDigest: DIGEST } as const;
const schemaOne: RegisteredWaveGateProgram = { schemaVersion: 1, ...program, taskIds: [...program.taskIds] };
const schemaTwo: RegisteredWaveGateProgram = {
  schemaVersion: 2, reviewerProtocol: CURRENT_REVIEWER_PROTOCOL, ...program, taskIds: [...program.taskIds],
};

describe("legacyPublicationRefusal", () => {
  it("admits an archived schema-1 review program", () => {
    expect(legacyPublicationRefusal({ kind: "registered", program: schemaOne })).toBeNull();
  });

  it("refuses a current schema-2 review program", () => {
    expect(legacyPublicationRefusal({ kind: "registered", program: schemaTwo })).toBe(
      "legacy publication route refused an emission-eligible request: the run's registered wave-gate program is current (schemaVersion 2), not an archived schema-1 contract",
    );
  });

  it.each([
    [{ kind: "unclaimed" } as const, "no program registration is durably claimed for this run"],
    [{ kind: "invalid", message: "bad bytes" } as const, "bad bytes"],
  ])("refuses an unproven registration (%j)", (registration, reason) => {
    expect(legacyPublicationRefusal(registration)).toBe(
      `legacy publication route refused an emission-eligible request: the run's program registration is unparseable (${reason})`,
    );
  });
});
