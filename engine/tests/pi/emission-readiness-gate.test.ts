/**
 * The launcher's emission readiness gate as a pure contract (FR-008 / AS-020 /
 * AD-4): no process, no I/O — the decision law every launcher crosses, in its
 * two stages (readiness, then route binding over a READY readiness only).
 *
 * The expectation is minted through the real `issueEmissionBinding` over
 * `EMISSION_TOOL_SPECS` (the schema digest derived from the frozen bytes,
 * never trusted), and the readiness payload is parsed with the production
 * identity parsers. The gate is a closed ADT: FOURTEEN refusal codes, both
 * decision arms' runtime shapes pinned, the remediation named in every
 * message, and DELIBERATELY NO SEMANTIC ARM — a startup refusal is
 * evidence/infrastructure class, never a payload decision and never a
 * consumed attempt.
 */

import { describe, expect, it } from "vitest";
import {
  decideReadinessGate,
  decideStartupRoute,
  EMISSION_STARTUP_REMEDIATIONS,
  parseReadinessReport,
  parseReadinessStageObservation,
  type EmissionReadinessRefusalCode,
  type EmissionStartupRefusalCode,
  type ExpectedEmissionRoute,
  type ReadinessObservation,
  type ReadinessStageObservation,
  type RouteObservation,
} from "../../../pi/emission-readiness-gate";
import { canonicalRecord } from "../../src/core/orchestration-contract/identity";
import {
  asOpen,
  asReady,
  asRefused,
  contextDigestOf,
  makeExpectation,
  nextRequestId,
  STALE_REVISION,
} from "../fixtures/emission-child-harness";
import { sha256Hex } from "../../src/core/digest";
import { cellSchemaDigest, REVIEWER_V2_CELL } from "../fixtures/emission-registry-cells";

describe("the emission-startup gate decision — a closed ADT with no semantic arm (FR-008/AD-4)", () => {
  const expectation = makeExpectation(REVIEWER_V2_CELL, nextRequestId("gate-contract"), "http://127.0.0.1:9/v1");

  const honestReport = (overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> => ({
    requestId: expectation.binding.requestId,
    contextDigest: expectation.contextDigest,
    kind: expectation.binding.kind.kind,
    version: expectation.binding.version,
    toolName: expectation.binding.toolName,
    schemaDigest: expectation.binding.schemaDigest,
    revision: expectation.revision,
    active: true,
    childPid: 4242,
    registeredTools: [expectation.binding.toolName, "read"],
    ...overrides,
  });

  const observedReport = (overrides: Readonly<Record<string, unknown>> = {}): ReadinessObservation =>
    canonicalRecord({ kind: "observed" as const, payload: honestReport(overrides) });

  type ProbeFacts = Parameters<typeof parseReadinessStageObservation>[0];

  /** The stage a launcher observes for `readiness` over a live channel with
   *  the readiness command listed; a row overrides only the channel fact it
   *  varies. */
  const stageWith = (
    readiness: ReadinessObservation,
    channel: Partial<Omit<ProbeFacts, "readiness">> = {},
  ): ReadinessStageObservation => parseReadinessStageObservation(canonicalRecord({
    channelAlive: true,
    channelDiagnostic: null,
    commandListed: true,
    readiness,
    ...channel,
  }));

  const readyStage = (): ReadinessStageObservation => stageWith(observedReport());

  const ready = () => asReady(decideReadinessGate(expectation, readyStage()));

  const boundRouteOf = (route: ExpectedEmissionRoute & Readonly<{ api: string; baseUrl: string }>): RouteObservation =>
    canonicalRecord({
      kind: "bound" as const,
      model: canonicalRecord({
        provider: route.provider,
        id: route.modelId,
        api: route.api,
        baseUrl: route.baseUrl,
      }),
    });

  const stageRows: readonly { readonly code: EmissionReadinessRefusalCode; readonly stage: ReadinessStageObservation }[] = [
    { code: "child-unreachable", stage: stageWith(observedReport(), { channelAlive: false, channelDiagnostic: "connection refused" }) },
    { code: "readiness-command-absent", stage: stageWith(observedReport(), { commandListed: false }) },
    { code: "readiness-timeout", stage: stageWith(canonicalRecord({ kind: "absent" as const, reason: "no readiness entry within 2500ms" })) },
    { code: "startup-unavailable", stage: stageWith(canonicalRecord({ kind: "startup-unavailable" as const, reason: "LOOM_EMISSION_BINDING is missing" })) },
    { code: "malformed-readiness", stage: stageWith(canonicalRecord({ kind: "observed" as const, payload: { emitted: "legacy-shape" } })) },
    {
      code: "malformed-readiness",
      stage: stageWith(canonicalRecord({ kind: "malformed" as const, reason: "readiness invocation produced 2 entries; exactly one is required" })),
    },
    { code: "wrong-request", stage: stageWith(observedReport({ requestId: "req-emission-startup-t4-other-peer-1" })) },
    { code: "unexpected-kind", stage: stageWith(observedReport({ kind: "judge-verdict" })) },
    { code: "unexpected-version", stage: stageWith(observedReport({ version: "v9" })) },
    { code: "schema-digest-mismatch", stage: stageWith(observedReport({ schemaDigest: sha256Hex("stale-bytes") })) },
    { code: "tool-name-mismatch", stage: stageWith(observedReport({ toolName: "loom_emit_refutation_verdict" })) },
    { code: "tool-inactive", stage: stageWith(observedReport({ active: false })) },
    { code: "revision-mismatch", stage: stageWith(observedReport({ revision: STALE_REVISION })) },
    { code: "cancelled", stage: stageWith(canonicalRecord({ kind: "cancelled" as const })) },
  ];

  const routeRows: readonly { readonly route: RouteObservation }[] = [
    { route: canonicalRecord({ kind: "unbound" as const }) },
    { route: canonicalRecord({ kind: "failed" as const, reason: "set_model refused: unknown provider" }) },
    {
      route: canonicalRecord({
        kind: "bound" as const,
        model: canonicalRecord({ provider: "other-provider", id: "other-model", api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1" }),
      }),
    },
    {
      // The pinned endpoint is part of the route: the right model behind the
      // wrong base URL, or an unreported one, never opens.
      route: canonicalRecord({
        kind: "bound" as const,
        model: canonicalRecord({ provider: "loom-counting", id: "loom-counting-model", api: "openai-completions", baseUrl: "http://127.0.0.1:10/v1" }),
      }),
    },
    {
      route: canonicalRecord({
        kind: "bound" as const,
        model: canonicalRecord({ provider: "loom-counting", id: "loom-counting-model", api: null, baseUrl: null }),
      }),
    },
  ];

  it("refuses every mismatching observation with its exact code, and every refusal message names the remediation", () => {
    for (const row of stageRows) {
      const refusedDecision = asRefused(decideReadinessGate(expectation, row.stage));
      expect(refusedDecision.code, JSON.stringify(row.stage)).toBe(row.code);
      expect(refusedDecision.message, row.code).toContain(EMISSION_STARTUP_REMEDIATIONS[row.code]);
      expect(refusedDecision.remediation, row.code).toBe(EMISSION_STARTUP_REMEDIATIONS[row.code]);
    }
    for (const row of routeRows) {
      const refusedDecision = asRefused(decideStartupRoute(expectation.route, ready(), row.route));
      expect(refusedDecision.code, JSON.stringify(row.route)).toBe("route-bind-refused");
      expect(refusedDecision.message).toContain(EMISSION_STARTUP_REMEDIATIONS["route-bind-refused"]);
    }
  });

  it("the binding check precedes every capability check — a misbound readiness refuses wrong-request first, and each later field speaks only after its predecessors match (FR-014)", () => {
    // The gate's field-comparison order IS the misbinding precedence: a
    // readiness report bound to another request must refuse wrong-request
    // even when EVERY later capability field also mismatches — a child
    // holding another request's readiness is never reclassified by its
    // kind/version/digest/tool/active/revision claims. The remaining rows
    // pin the whole chain: each refusal code appears exactly when its field
    // mismatches and every EARLIER field matched, so no later mismatch can
    // mask a misbinding and no earlier one can mask a capability lie.
    const misboundEverywhere = asRefused(decideReadinessGate(
      expectation,
      stageWith(observedReport({
        requestId: "req-emission-startup-t4-misbound-peer-1",
        contextDigest: contextDigestOf("emission-startup-context:req-emission-startup-t4-misbound-peer-1"),
        kind: "judge-verdict",
        version: "v9",
        schemaDigest: sha256Hex("misbound-bytes"),
        toolName: "loom_emit_judge_verdict",
        active: false,
        revision: STALE_REVISION,
      })),
    ));
    expect(misboundEverywhere.code).toBe("wrong-request");
    expect(misboundEverywhere.message).toContain("req-emission-startup-t4-misbound-peer-1");
    expect(misboundEverywhere.message).toContain("≠ issued");

    const misboundDigestOnly = asRefused(decideReadinessGate(
      expectation,
      stageWith(observedReport({
        contextDigest: contextDigestOf("emission-startup-context:some-other-request"),
        kind: "judge-verdict",
      })),
    ));
    expect(misboundDigestOnly.code).toBe("wrong-request");

    // The successor chain: each row matches every field BEFORE its index and
    // mismatches its own field plus every LATER one — the earliest mismatch
    // must win, every time.
    const chainRows: readonly {
      readonly code: EmissionReadinessRefusalCode;
      readonly overrides: Readonly<Record<string, unknown>>;
    }[] = [
      { code: "unexpected-kind", overrides: { kind: "judge-verdict", version: "v9", schemaDigest: sha256Hex("misbound-bytes"), toolName: "loom_emit_judge_verdict", active: false, revision: STALE_REVISION } },
      { code: "unexpected-version", overrides: { version: "v9", schemaDigest: sha256Hex("misbound-bytes"), toolName: "loom_emit_judge_verdict", active: false, revision: STALE_REVISION } },
      { code: "schema-digest-mismatch", overrides: { schemaDigest: sha256Hex("misbound-bytes"), toolName: "loom_emit_judge_verdict", active: false, revision: STALE_REVISION } },
      { code: "tool-name-mismatch", overrides: { toolName: "loom_emit_refutation_verdict", active: false, revision: STALE_REVISION } },
      { code: "tool-inactive", overrides: { active: false, revision: STALE_REVISION } },
      { code: "revision-mismatch", overrides: { revision: STALE_REVISION } },
    ];
    for (const row of chainRows) {
      const decision = asRefused(decideReadinessGate(expectation, stageWith(observedReport(row.overrides))));
      expect(decision.code, JSON.stringify(row.overrides)).toBe(row.code);
    }
  });

  it("the gate decision is idempotent — repeated evaluation of the same observation yields the identical decision, and every refusal arm releases without prompting", () => {
    for (const row of stageRows) {
      const first = decideReadinessGate(expectation, row.stage);
      const second = decideReadinessGate(expectation, row.stage);
      expect(second, row.code).toEqual(first);
      expect(first.kind, row.code).toBe("refused");
    }
    for (const row of routeRows) {
      const first = decideStartupRoute(expectation.route, ready(), row.route);
      const second = decideStartupRoute(expectation.route, ready(), row.route);
      expect(second, JSON.stringify(row.route)).toEqual(first);
      expect(first.kind).toBe("refused");
    }
  });

  it("the refusal vocabulary is closed at exactly fourteen codes and both decision arms have exact non-semantic shapes", () => {
    const codes = Object.keys(EMISSION_STARTUP_REMEDIATIONS);
    expect(codes).toHaveLength(14);
    expect(new Set(codes).size).toBe(14);
    for (const code of codes) expect(EMISSION_STARTUP_REMEDIATIONS[code as EmissionStartupRefusalCode].length).toBeGreaterThan(0);

    // The open arm and the refused arm are the ONLY declared union arms; the
    // assertions below pin their runtime shapes. Neither arm carries a payload,
    // source, or attempt field — startup never minted, consumed, or advanced
    // semantic evidence (FR-008).
    const open = asOpen(decideStartupRoute(expectation.route, ready(), boundRouteOf(expectation.route)));
    expect(Object.keys(open).sort().join(",")).toBe("kind,readiness,route");

    const refusedDecision = asRefused(decideStartupRoute(expectation.route, ready(), { kind: "unbound" }));
    expect(refusedDecision.code).toBe("route-bind-refused");
    expect(Object.keys(refusedDecision).sort().join(",")).toBe("code,kind,message,remediation");
    expect(Object.keys(ready()).sort().join(",")).toBe("kind,readiness");

    // The refusal vocabulary is disjoint from the AD-9 semantic selection
    // vocabulary — a startup refusal cannot be mistaken for a payload decision.
    const semanticSelectionArms = [
      "emission-tool-arguments",
      "final-message-extraction",
      "extraction-over-refused-call",
      "duplicate-emission-call",
      "refused-call-no-fallback",
      "observation-refused",
    ];
    for (const code of codes) expect(semanticSelectionArms).not.toContain(code);
  });

  it("canonicalizes contradictory raw facts with cancelled > unreachable > command-absent precedence", () => {
    const contradictoryRows = [
      {
        facts: {
          channelAlive: false,
          channelDiagnostic: "connection refused",
          commandListed: false,
          readiness: canonicalRecord({ kind: "cancelled" as const }),
        },
        expected: { kind: "cancelled" },
      },
      {
        facts: {
          channelAlive: false,
          channelDiagnostic: "connection refused",
          commandListed: false,
          readiness: observedReport(),
        },
        expected: { kind: "unreachable", diagnostic: "connection refused" },
      },
      {
        facts: {
          channelAlive: true,
          channelDiagnostic: "stale diagnostic",
          commandListed: false,
          readiness: canonicalRecord({ kind: "startup-unavailable" as const, reason: "command failed" }),
        },
        expected: { kind: "command-absent" },
      },
      {
        facts: {
          channelAlive: true,
          channelDiagnostic: null,
          commandListed: false,
          readiness: canonicalRecord({ kind: "malformed" as const, reason: "two entries" }),
        },
        expected: { kind: "command-absent" },
      },
    ] as const;

    for (const { facts, expected } of contradictoryRows) {
      const stage = parseReadinessStageObservation(facts);
      expect(stage).toEqual(expected);
      expect(Object.hasOwn(stage, "channelAlive")).toBe(false);
      expect(Object.hasOwn(stage, "commandListed")).toBe(false);
      expect(Object.hasOwn(stage, "readiness")).toBe(false);
    }
  });

  it("binds a route only to a READY readiness decision, carrying exactly the readiness the gate parsed", () => {
    const readiness = ready();
    const open = asOpen(decideStartupRoute(expectation.route, readiness, boundRouteOf(expectation.route)));
    expect(open.readiness).toBe(readiness.readiness);
    expect(open.route).toBe(expectation.route);
    // Route evidence can only follow a READY decision: binding a refused
    // readiness is a compile-time error, so no launcher can pair a stale or
    // sibling route with a readiness the gate refused. (Never invoked.)
    const bindRefusedReadiness = (refused: ReturnType<typeof asRefused>) =>
      // @ts-expect-error a refused readiness decision can never be route-bound
      decideStartupRoute(expectation.route, refused, boundRouteOf(expectation.route));
    expect(typeof bindRefusedReadiness).toBe("function");
  });

  it("an issued-model route pins provider and model only — the parent bridge's route — while a pinned endpoint also pins api and base URL", () => {
    const issued: ExpectedEmissionRoute = { kind: "issued-model", provider: "loom-counting", modelId: "loom-counting-model" };
    const unreportedEndpoint: RouteObservation = {
      kind: "bound",
      model: { provider: "loom-counting", id: "loom-counting-model", api: null, baseUrl: null },
    };
    expect(asOpen(decideStartupRoute(issued, ready(), unreportedEndpoint)).route).toBe(issued);
    const wrongModel = asRefused(decideStartupRoute(issued, ready(), {
      kind: "bound",
      model: { provider: "loom-counting", id: "other-model", api: null, baseUrl: null },
    }));
    expect(wrongModel.message).toContain("not the expected constrained route (loom-counting/loom-counting-model)");
    const pinned = asRefused(decideStartupRoute(expectation.route, ready(), unreportedEndpoint));
    expect(pinned.message).toContain("an unreported api");
    expect(pinned.message).toContain(`via openai-completions at ${expectation.route.baseUrl}`);
  });

  it("parses the readiness payload through the production identity parsers", () => {
    const parsed = parseReadinessReport(honestReport());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.requestId).toBe(expectation.binding.requestId);
      expect(parsed.value.contextDigest).toBe(expectation.contextDigest);
      expect(parsed.value.schemaDigest).toBe(expectation.binding.schemaDigest);
      expect(parsed.value.kind).toBe(expectation.binding.kind.kind);
      expect(parsed.value.active).toBe(true);
      expect(parsed.value.childPid).toBe(4242);
      expect(parsed.value.registeredTools).toEqual([expectation.binding.toolName, "read"]);
    }
  });

  it("refuses a malformed readiness payload naming every violated field — parse, don't validate", () => {
    const parsed = parseReadinessReport({
      requestId: 42,
      contextDigest: "not-a-digest",
      schemaDigest: `sha256-${"0".repeat(64)}`,
      kind: "",
      version: "v2",
      toolName: "loom_emit_reviewer_payload",
      revision: "r",
      active: "yes",
      childPid: 0,
      registeredTools: ["ok", 7],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      for (const fragment of ["requestId", "contextDigest", "schemaDigest", "kind", "active", "childPid", "registeredTools"]) {
        expect(parsed.error.reason, fragment).toContain(fragment);
      }
    }
  });

  it("opens only on the full conjunction — matching readiness AND a verified route, with the mint digesting the frozen bytes", () => {
    const open = asOpen(decideStartupRoute(expectation.route, ready(), boundRouteOf(expectation.route)));
    expect(open.readiness.requestId).toBe(expectation.binding.requestId);
    expect(open.readiness.toolName).toBe(REVIEWER_V2_CELL.spec.toolName);
    expect(open.readiness.schemaDigest).toBe(cellSchemaDigest(REVIEWER_V2_CELL));
    expect(open.route).toEqual({
      kind: "pinned-endpoint",
      provider: "loom-counting",
      modelId: "loom-counting-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:9/v1",
    });
  });
});
