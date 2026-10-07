/**
 * The Pi child's emission provisioning and readiness seam
 * (pi/emission-tool.ts): the production tool definition — the exact
 * registration surface — the registration state machine, the provisioning ADT
 * that certifies the issued binding against the frozen registry, the readiness
 * protocol contract the launcher barrier parses, and the registry-projected
 * tool family. No Pi runtime is loaded; the real pi validator, agent loop and
 * resolver pins are emission-tool-runtime.test.ts.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  admitIssuedEmissionArguments,
  EMISSION_CONSTRAINED_SAMPLING_REQUEST,
  EMISSION_TOOL_SPECS,
  type IssuedEmissionBinding,
} from "../../src/core/emission-tool";
import { REVIEWER_PAYLOAD_EXAMPLE_V2 } from "../../src/core/reviewer-contract";
import { sha256Hex } from "../../src/core/digest";
import {
  decideEmissionHoldTransition,
  decideEmissionToolRegistration,
  describeEmissionRegistrationContradiction,
  emissionHoldWedgesPrompt,
  emissionReadinessReport,
  emissionToolDefinition,
  EMISSION_HOLD_ENTRY_TYPE,
  initialEmissionHold,
  LOOM_EMISSION_BINDING_ENV,
  parseEmissionChildProvisioning,
  type EmissionHoldEvent,
  type EmissionHoldState,
  type EmissionToolRegistration,
} from "../../../pi/emission-tool";
import { EMISSION_READINESS_COMMAND, EMISSION_READINESS_ENTRY_TYPE } from "../../../pi/emission-readiness-protocol";
import { whitespaceOnlyArguments } from "../fixtures/emission-arguments";
import {
  canonicalArguments,
  cellSchemaBytes,
  cellSchemaDigest,
  JUDGE_V1_CELL,
  mintedBindingFor,
  REFUTATION_V1_CELL,
  REGISTRY_CELLS,
  REVIEWER_V2_CELL,
  REVIEWER_V3_CELL,
  type RegistryCell,
} from "../fixtures/emission-registry-cells";

/** The startup-context digest convention the launcher provisions a child with. */
const startupContextDigest = (requestId: string): string => sha256Hex(`emission-startup-context:${requestId}`);

/** The full provisioning claims a launcher hands a child for `binding`. */
const provisionedClaims = (
  binding: IssuedEmissionBinding,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  requestId: binding.requestId,
  contextDigest: startupContextDigest(binding.requestId),
  kind: binding.kind.kind,
  version: binding.version,
  toolName: binding.toolName,
  schemaDigest: binding.schemaDigest,
  ...overrides,
});

describe("the registry-cell fixture union — the kind/version pairing is a compile-time guarantee", () => {
  it("lists every frozen registry cell exactly once, and an unsupported pair does not compile", () => {
    const frozenPairs = Object.entries(EMISSION_TOOL_SPECS)
      .flatMap(([kind, spec]) => Object.keys(spec.schemaVersions).map((version) => `${kind}/${version}`));
    expect(REGISTRY_CELLS.map((cell) => `${cell.kind}/${cell.version}`).sort()).toEqual(frozenPairs.sort());
    // @ts-expect-error judge-verdict freezes no v2 schema — the pair is unrepresentable
    const judgeV2: RegistryCell = { kind: "judge-verdict", version: "v2", spec: JUDGE_V1_CELL.spec };
    // @ts-expect-error reviewer-payload freezes no v1 schema — the pair is unrepresentable
    const reviewerV1: RegistryCell = { kind: "reviewer-payload", version: "v1", spec: REVIEWER_V2_CELL.spec };
    // The forged literals exist only to carry the compile-time assertions above.
    expect([judgeV2.kind, reviewerV1.kind]).toEqual(["judge-verdict", "reviewer-payload"]);
  });
});

describe("the production emission tool definition — the exact registration surface (FR-001/FR-002/FR-013/FR-021/SC-006)", () => {
  it("carries the registry's exact name, the frozen bytes as parameters, and the ONE preferred sampling request, for every registry cell", () => {
    for (const registryCell of REGISTRY_CELLS) {
      const definition = emissionToolDefinition(mintedBindingFor(registryCell, "req-emission-tool-t5-def"));
      expect(definition.name, `${registryCell.kind}/${registryCell.version}`).toBe(registryCell.spec.toolName);
      expect(definition.label).toBe(`Emission ${registryCell.kind} ${registryCell.version}`);
      // SC-006 at the definition surface: the parameters ARE the frozen
      // payload schema bytes, parsed once — one schema, no second contract.
      expect(definition.parameters).toEqual(JSON.parse(cellSchemaBytes(registryCell)));
      // INV-1: the ONE preferred-strict request — the same object every
      // emission tool registers with, minted in the engine core.
      expect(definition.constrainedSampling).toBe(EMISSION_CONSTRAINED_SAMPLING_REQUEST);
      // The wire-form canonicalization rides the definition, wired to the
      // SAME parameters object: the recorded string-typed class canonicalizes
      // into a payload the engine's admission gate admits.
      expect(typeof definition.prepareArguments).toBe("function");
      if (registryCell.kind === "reviewer-payload" && registryCell.version === "v2") {
        const stringy = {
          schemaVersion: "2",
          kind: "standalone-review",
          findings: JSON.stringify([
            { ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!, claim: "supported input bypasses the authorization check" },
          ]),
        };
        const canonicalized = definition.prepareArguments(stringy);
        expect(canonicalized).not.toBe(stringy);
        expect(admitIssuedEmissionArguments(mintedBindingFor(registryCell, "req-emission-tool-admission"), canonicalized).kind).toBe("valid");
      }
      expect(typeof definition.description).toBe("string");
    }
  });

  it("execute admits valid arguments into the minimal terminating acknowledgment with NO payload echo", async () => {
    const registryCell = JUDGE_V1_CELL;
    const definition = emissionToolDefinition(mintedBindingFor(registryCell, "req-emission-tool-t5-exec"));
    const args = canonicalArguments(registryCell);
    const acknowledgment = await definition.execute("call-exec-1", args);
    // FR-013: terminating, minimal, empty details — and never the payload.
    expect(acknowledgment.terminate).toBe(true);
    expect(acknowledgment.details).toEqual({});
    expect(acknowledgment.content).toHaveLength(1);
    expect(acknowledgment.content[0]!.type).toBe("text");
    expect(acknowledgment.content[0]!.text).toBe("payload acknowledged");
    expect(JSON.stringify(acknowledgment.content)).not.toContain("extensibility");
  });

  it("execute THROWS the engine's refusal verbatim for engine-refined arguments — never a returned error-labeled object (AD-3)", async () => {
    const registryCell = JUDGE_V1_CELL;
    const definition = emissionToolDefinition(mintedBindingFor(registryCell, "req-emission-tool-t5-throw"));
    const whitespaceArgs = whitespaceOnlyArguments(registryCell.kind);
    let thrown: unknown = null;
    try {
      await definition.execute("call-ws", whitespaceArgs);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    // The refusal is the admission's own code and message — the model's
    // correction surface is the parse's vocabulary, never a shell-invented
    // string (FR-006 retained diagnostics).
    expect(message).toContain("invalid-schema");
    expect(message).toContain("frozen schema");
  });

  it("the definition constructor refuses a binding whose registry cell is absent — the invariant guard over minted bindings", () => {
    // The mint refuses unsupported (kind, version) pairs, so the guard is
    // unreachable through the mint; this pins it against future construction
    // paths with a test-confined forged binding.
    const minted = mintedBindingFor(JUDGE_V1_CELL, "req-emission-tool-t5-guard");
    const forged = { ...minted, version: "v9" } as unknown as IssuedEmissionBinding;
    expect(() => emissionToolDefinition(forged)).toThrow(/invariant failed/);
  });
});

describe("the child's emission-tool registration state machine — idempotent only for the exact same request/kind/version/digest (AD-4)", () => {
  const registeredA = mintedBindingFor(REVIEWER_V2_CELL, "req-emission-tool-t5-reg-a");
  const registeredAReplay = mintedBindingFor(REVIEWER_V2_CELL, "req-emission-tool-t5-reg-a");
  const differentRequest = mintedBindingFor(REVIEWER_V2_CELL, "req-emission-tool-t5-reg-b");
  const differentVersion = mintedBindingFor(REVIEWER_V3_CELL, "req-emission-tool-t5-reg-a");
  const differentKind = mintedBindingFor(JUDGE_V1_CELL, "req-emission-tool-t5-reg-a");
  const differentDigestSource = REFUTATION_V1_CELL;

  it("registers on an unregistered child and is idempotent for the exact same binding", () => {
    const unregistered: EmissionToolRegistration = { kind: "unregistered" };
    expect(decideEmissionToolRegistration(unregistered, registeredA)).toEqual({ kind: "register" });
    const registered: EmissionToolRegistration = { kind: "registered", binding: registeredA };
    expect(decideEmissionToolRegistration(registered, registeredAReplay)).toEqual({ kind: "idempotent" });
  });

  it("refuses every contradictory re-registration, naming both bindings in the diagnostic", () => {
    const registered: EmissionToolRegistration = { kind: "registered", binding: registeredA };
    for (const [label, attempted] of [
      ["different request", differentRequest],
      ["different version", differentVersion],
      ["different kind", differentKind],
      ["different digest source", mintedBindingFor(differentDigestSource, "req-emission-tool-t5-reg-a")],
    ] as const) {
      const decision = decideEmissionToolRegistration(registered, attempted);
      if (decision.kind !== "contradictory") {
        throw new Error(`expected a contradictory decision for ${label}, received ${decision.kind}`);
      }
      expect(decision.registered.requestId).toBe(registeredA.requestId);
      expect(decision.attempted).toBe(attempted);
      const message = describeEmissionRegistrationContradiction(decision);
      expect(message, label).toContain(registeredA.requestId);
      expect(message, label).toContain(attempted.requestId);
      expect(message, label).toContain(registeredA.version);
      expect(message, label).toContain(registeredA.schemaDigest);
    }
  });
});

describe("the child's readiness hold transitions — fail-closed as data (AD-4)", () => {
  const ARMED: EmissionHoldState = { kind: "armed" };
  const RELEASED: EmissionHoldState = { kind: "released" };
  const UNPROVISIONED: EmissionHoldState = { kind: "unprovisioned" };
  const holdStates = fc.constantFrom<EmissionHoldState>(ARMED, RELEASED, UNPROVISIONED);
  const holdEvents = fc.oneof(
    fc.boolean().map((active): EmissionHoldEvent => ({ kind: "readiness-reported", active })),
    fc.constant<EmissionHoldEvent>({ kind: "session-shutdown" }),
  );

  it("arms every provisioned child — refused provisioning included — and no non-emission child", () => {
    expect(initialEmissionHold(parseEmissionChildProvisioning(undefined))).toEqual(UNPROVISIONED);
    expect(initialEmissionHold(parseEmissionChildProvisioning("{not json"))).toEqual(ARMED);
    const binding = mintedBindingFor(JUDGE_V1_CELL, "req-emission-tool-t5-hold");
    const provisioned = parseEmissionChildProvisioning(JSON.stringify(provisionedClaims(binding)));
    expect(provisioned.kind).toBe("provisioned");
    expect(initialEmissionHold(provisioned)).toEqual(ARMED);
  });

  it("releases an armed hold only for an ACTIVE readiness report, and at shutdown with its forensic marker", () => {
    expect(decideEmissionHoldTransition(ARMED, { kind: "readiness-reported", active: true }))
      .toEqual({ next: RELEASED, release: true, diagnostic: null });
    expect(decideEmissionHoldTransition(ARMED, { kind: "readiness-reported", active: false }))
      .toEqual({ next: ARMED, release: false, diagnostic: null });
    expect(decideEmissionHoldTransition(ARMED, { kind: "session-shutdown" }))
      .toEqual({ next: RELEASED, release: true, diagnostic: "shutdown-released" });
    expect(emissionHoldWedgesPrompt(ARMED)).toBe(true);
    expect(emissionHoldWedgesPrompt(RELEASED)).toBe(false);
    expect(emissionHoldWedgesPrompt(UNPROVISIONED)).toBe(false);
  });

  it("never re-arms, never releases twice, and leaves a never-armed hold inert under every event sequence", () => {
    fc.assert(fc.property(holdStates, fc.array(holdEvents, { maxLength: 8 }), (initial, events) => {
      let state = initial;
      let releases = 0;
      for (const event of events) {
        const transition = decideEmissionHoldTransition(state, event);
        if (transition.release) releases += 1;
        // A release always lands on `released`; without one the hold stays put.
        expect(transition.next).toEqual(transition.release ? RELEASED : state);
        // Only an armed hold moves at all.
        if (state.kind !== "armed") expect(transition).toEqual({ next: state, release: false, diagnostic: null });
        state = transition.next;
      }
      expect(releases).toBeLessThanOrEqual(initial.kind === "armed" ? 1 : 0);
      // The hold opens before shutdown only through an active readiness report.
      const opened = events.findIndex((event) => event.kind === "session-shutdown" ||
        (event.kind === "readiness-reported" && event.active));
      expect(state).toEqual(initial.kind === "armed" && opened >= 0 ? RELEASED : initial);
    }));
  });
});

describe("the child's provisioning ADT — the issued binding certified against the frozen registry, never trusted (FR-008)", () => {
  const provisionedBinding = mintedBindingFor(JUDGE_V1_CELL, "req-emission-tool-t5-prov");

  it("only an absent env is not-provisioned; present blank provisioning refuses instead of silently becoming extraction-only", () => {
    expect(parseEmissionChildProvisioning(undefined)).toEqual({ kind: "not-provisioned" });
    for (const raw of ["", "   "]) {
      const refused = parseEmissionChildProvisioning(raw);
      expect(refused.kind).toBe("provisioning-refused");
      if (refused.kind === "provisioning-refused") {
        expect(refused.code).toBe("invalid-json");
        expect(refused.reason).toContain("not valid JSON");
      }
    }
  });

  it("refuses non-JSON and non-object payloads with a bounded reason", () => {
    const notJson = parseEmissionChildProvisioning("{not json");
    expect(notJson.kind).toBe("provisioning-refused");
    if (notJson.kind === "provisioning-refused") {
      expect(notJson.code).toBe("invalid-json");
      expect(notJson.reason).toContain("not valid JSON");
    }
    const notObject = parseEmissionChildProvisioning("[]");
    expect(notObject.kind).toBe("provisioning-refused");
    if (notObject.kind === "provisioning-refused") {
      expect(notObject.code).toBe("non-object");
      expect(notObject.reason).toContain("not an object");
    }
  });

  it("refuses an out-of-contract context digest and a non-string kind before the mint is consulted", () => {
    const badDigest = parseEmissionChildProvisioning(JSON.stringify(provisionedClaims(provisionedBinding, { contextDigest: "sha256-not-hex" })));
    expect(badDigest.kind).toBe("provisioning-refused");
    if (badDigest.kind === "provisioning-refused") {
      expect(badDigest.code).toBe("invalid-context-digest");
      expect(badDigest.reason).toContain("context-digest");
    }
    const badKind = parseEmissionChildProvisioning(JSON.stringify(provisionedClaims(provisionedBinding, { kind: 42 })));
    expect(badKind.kind).toBe("provisioning-refused");
    if (badKind.kind === "provisioning-refused") {
      expect(badKind.code).toBe("invalid-claim-type");
      expect(badKind.reason).toContain("not a producer kind");
    }
  });

  it("refuses malformed present optional claims instead of silently deriving registry values", () => {
    for (const overrides of [{ toolName: 42 }, { schemaDigest: false }]) {
      const refused = parseEmissionChildProvisioning(JSON.stringify(provisionedClaims(provisionedBinding, overrides)));
      expect(refused.kind).toBe("provisioning-refused");
      if (refused.kind === "provisioning-refused") {
        expect(refused.code).toBe("invalid-claim-type");
        expect(refused.reason).toContain("present optional claims must be strings");
      }
    }
  });

  it("refuses every claim that does not select a frozen registry cell, carrying the mint's own code and message", () => {
    for (const [label, overrides, expectedCode] of [
      ["unknown kind", { kind: "no-such-kind" }, "unknown-producer-kind"],
      ["unsupported version", { version: "v9" }, "unsupported-schema-version"],
      ["wrong claimed digest", { schemaDigest: sha256Hex("stale-bytes") }, "schema-digest-mismatch"],
      ["wrong claimed tool name", { toolName: "loom_emit_refutation_verdict" }, "tool-name-mismatch"],
      ["empty request id", { requestId: "" }, "invalid-request-identity"],
    ] as const) {
      const refused = parseEmissionChildProvisioning(JSON.stringify(provisionedClaims(provisionedBinding, overrides)));
      expect(refused.kind, label).toBe("provisioning-refused");
      if (refused.kind === "provisioning-refused") {
        expect(refused.code, label).toBe(expectedCode);
        expect(refused.reason.length, label).toBeGreaterThan(0);
      }
    }
  });

  it("certifies valid claims into the minted binding and a canonical context digest", () => {
    const provisioned = parseEmissionChildProvisioning(JSON.stringify(provisionedClaims(provisionedBinding)));
    if (provisioned.kind !== "provisioned") throw new Error(`expected a provisioned child, received ${provisioned.kind}`);
    const expected = mintedBindingFor(JUDGE_V1_CELL, "req-emission-tool-t5-prov");
    expect(provisioned.binding).toEqual(expected);
    expect(provisioned.contextDigest).toBe(startupContextDigest(expected.requestId));
  });

  it("derives absent claims from the ONE frozen source — never a second default (AD-7)", () => {
    const claims = provisionedClaims(provisionedBinding);
    const minimal = JSON.stringify({ requestId: claims.requestId, contextDigest: claims.contextDigest, kind: claims.kind, version: claims.version });
    const provisioned = parseEmissionChildProvisioning(minimal);
    if (provisioned.kind !== "provisioned") throw new Error(`expected a provisioned child, received ${provisioned.kind}`);
    const expected = mintedBindingFor(JUDGE_V1_CELL, "req-emission-tool-t5-prov");
    expect(provisioned.binding.toolName).toBe(expected.toolName);
    expect(provisioned.binding.schemaDigest).toBe(expected.schemaDigest);
  });
});

describe("the readiness protocol contract — command, entry type, hold marker, and the bound report the barrier parses (AD-4)", () => {
  it("carries the settled protocol names the wave-2 barrier suite and the probe pin", () => {
    expect(EMISSION_READINESS_COMMAND).toBe("loom-emission-readiness");
    expect(EMISSION_READINESS_ENTRY_TYPE).toBe("loom-emission-readiness");
    expect(EMISSION_HOLD_ENTRY_TYPE).toBe("loom-emission-hold");
    expect(LOOM_EMISSION_BINDING_ENV).toBe("LOOM_EMISSION_BINDING");
  });

  it("the readiness report carries exactly the ten contract fields, minted binding plus the child's honest observations", () => {
    const binding = mintedBindingFor(JUDGE_V1_CELL, "req-emission-tool-t5-report");
    const provisioned = parseEmissionChildProvisioning(JSON.stringify(provisionedClaims(binding)));
    if (provisioned.kind !== "provisioned") throw new Error(`expected a provisioned child, received ${provisioned.kind}`);
    const report = emissionReadinessReport(provisioned, {
      revision: "sha256:loom-emission-rev-t5",
      active: true,
      childPid: 4242,
      registeredTools: [binding.toolName, "read"],
    });
    expect(Object.keys(report).sort()).toEqual([
      "active", "childPid", "contextDigest", "kind", "registeredTools",
      "requestId", "revision", "schemaDigest", "toolName", "version",
    ]);
    expect(report.requestId).toBe(binding.requestId);
    expect(report.contextDigest).toBe(startupContextDigest(binding.requestId));
    expect(report.kind).toBe("judge-verdict");
    expect(report.version).toBe("v1");
    expect(report.toolName).toBe("loom_emit_judge_verdict");
    expect(report.schemaDigest).toBe(cellSchemaDigest(JUDGE_V1_CELL));
    expect(report.revision).toBe("sha256:loom-emission-rev-t5");
    expect(report.active).toBe(true);
    expect(report.childPid).toBe(4242);
    expect(report.registeredTools).toEqual([binding.toolName, "read"]);
  });
});

