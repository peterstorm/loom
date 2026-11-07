/**
 * Lens selection properties. The selector stands in for a judgement upstream
 * left to the orchestrator ("pick the relevant lenses"), so the properties that
 * matter are the ones that make the judgement auditable:
 *
 *   INV-L1  ATTACK-CLASSES.md is always included, first;
 *   INV-L2  a hunter never receives more than the cap, however rich the target;
 *   INV-L3  every vendored lens is either included or excluded with a reason;
 *   INV-L4  selection is a pure function of the signals.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  SECURITY_LENSES,
  renderLensSelection,
  selectSecurityLenses,
  type StackSignals,
} from "../../src/core/security-lens-select";

const signalsArb: fc.Arbitrary<StackSignals> = fc.record({
  languages: fc.array(fc.constantFrom("ts", "tsx", "java", "rs", "c", "go", "py"), { maxLength: 5 }),
  manifests: fc.array(fc.constantFrom("package.json", "Cargo.toml", "pom.xml", "go.mod", "Chart.yaml"), { maxLength: 4 }),
  servesHttp: fc.boolean(),
  rendersClientSide: fc.boolean(),
  drivesModelsOrTools: fc.boolean(),
  usesQueuesOrRpc: fc.boolean(),
  isolatesTenants: fc.boolean(),
  deploysInfrastructure: fc.boolean(),
  hasNativeMemory: fc.boolean(),
  hasAppOrLocalIpc: fc.boolean(),
  hasReleasePipelines: fc.boolean(),
  hasSharedResourcePressure: fc.boolean(),
});

describe("lens selection", () => {
  it("always includes the core class list first (INV-L1)", () => {
    fc.assert(
      fc.property(signalsArb, (signals) => {
        const selection = selectSecurityLenses(signals);
        expect(selection.included[0]?.lens).toBe("ATTACK-CLASSES.md");
      }),
    );
  });

  it("never exceeds the cap, whatever the target looks like (INV-L2)", () => {
    fc.assert(
      fc.property(signalsArb, fc.integer({ min: 1, max: 5 }), (signals, maxLenses) => {
        const selection = selectSecurityLenses(signals, { maxLenses });
        expect(selection.included.length).toBeLessThanOrEqual(maxLenses + 1);
        expect(new Set(selection.included.map((entry) => entry.lens)).size).toBe(selection.included.length);
      }),
    );
  });

  it("accounts for every vendored lens with a reason (INV-L3)", () => {
    fc.assert(
      fc.property(signalsArb, (signals) => {
        const selection = selectSecurityLenses(signals);
        const accounted = [...selection.included.map((entry) => entry.lens), ...selection.excluded.map((entry) => entry.lens)];
        expect([...accounted].sort()).toEqual([...SECURITY_LENSES].sort());
        expect(selection.excluded.every((entry) => entry.reason.length > 0)).toBe(true);
        expect(selection.included.filter((entry) => entry.lens !== "ATTACK-CLASSES.md").every((entry) => entry.reasons.length > 0)).toBe(true);
      }),
    );
  });

  it("is a pure function of the signals (INV-L4)", () => {
    fc.assert(
      fc.property(signalsArb, (signals) => {
        expect(selectSecurityLenses(signals)).toEqual(selectSecurityLenses({ ...signals }));
      }),
    );
  });

  it("ranks a stack's real surfaces above incidental ones", () => {
    const selection = selectSecurityLenses({
      languages: ["ts", "tsx"],
      manifests: ["package.json"],
      servesHttp: true,
      rendersClientSide: true,
      drivesModelsOrTools: true,
      usesQueuesOrRpc: false,
      isolatesTenants: true,
      deploysInfrastructure: false,
      hasNativeMemory: false,
      hasAppOrLocalIpc: false,
      hasReleasePipelines: false,
      hasSharedResourcePressure: false,
    });
    const chosen = selection.included.map((entry) => entry.lens);
    expect(chosen).toContain("AI-AND-LLM.md");
    expect(chosen).toContain("DATA-ISOLATION-AND-LIFECYCLE.md");
    expect(chosen).toContain("WEB-PROTOCOL-AND-AUTH.md");
    expect(chosen).not.toContain("MEMORY-SAFETY-AND-BINARY.md");
    expect(selection.excluded.find((entry) => entry.lens === "MEMORY-SAFETY-AND-BINARY.md")?.reason).toContain("no matching signal");
  });

  it("renders the choice and the exclusions for a prompt", () => {
    const rendered = renderLensSelection(selectSecurityLenses({
      languages: [],
      manifests: [],
      servesHttp: true,
      rendersClientSide: false,
      drivesModelsOrTools: false,
      usesQueuesOrRpc: false,
      isolatesTenants: false,
      deploysInfrastructure: false,
      hasNativeMemory: false,
      hasAppOrLocalIpc: false,
      hasReleasePipelines: false,
      hasSharedResourcePressure: false,
    }));
    expect(rendered).toContain("references/security-lenses/ATTACK-CLASSES.md");
    expect(rendered).toContain("references/security-lenses/WEB-PROTOCOL-AND-AUTH.md");
    expect(rendered).toContain("Excluded lenses:");
  });
});
