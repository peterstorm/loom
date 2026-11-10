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
import { SECURITY_PROFILE_LENSES } from "../../src/core/security-audit-contract";
import {
  SECURITY_LENSES,
  renderLensSelection,
  selectSecurityLenses,
  type StackSignals,
} from "../../src/core/security-lens-select";
import { aSignals } from "./fixtures";

/** The selector's cap is a profile's document budget, so a test that omits it
 *  is testing a signature the program never uses. `standard` is the default run. */
const STANDARD = { maxLenses: SECURITY_PROFILE_LENSES.standard } as const;

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
        const selection = selectSecurityLenses(signals, STANDARD);
        expect(selection.included[0]?.lens).toBe("ATTACK-CLASSES.md");
      }),
    );
  });

  it("never exceeds the profile's cap, base lens included (INV-L2)", () => {
    fc.assert(
      fc.property(signalsArb, fc.integer({ min: 1, max: 8 }), (signals, maxLenses) => {
        const selection = selectSecurityLenses(signals, { maxLenses });
        expect(selection.included.length).toBeLessThanOrEqual(maxLenses);
        expect(new Set(selection.included.map((entry) => entry.lens)).size).toBe(selection.included.length);
      }),
    );
  });

  it("accounts for every vendored lens with a reason (INV-L3)", () => {
    fc.assert(
      fc.property(signalsArb, (signals) => {
        const selection = selectSecurityLenses(signals, STANDARD);
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
        expect(selectSecurityLenses(signals, STANDARD)).toEqual(selectSecurityLenses({ ...signals }, STANDARD));
      }),
    );
  });

  it("ranks a stack's real surfaces above incidental ones", () => {
    const selection = selectSecurityLenses(aSignals({
      languages: ["ts", "tsx"],
      manifests: ["package.json"],
      servesHttp: true,
      // Server-rendered: with `rendersClientSide` false a `tsx` file scores
      // CLIENT-SIDE 1, below AI at 4. Were it true (3 + 1) the two would tie at
      // 4, and declaration order would then pick CLIENT-SIDE.
      rendersClientSide: false,
      drivesModelsOrTools: true,
      isolatesTenants: true,
    }), STANDARD);
    const chosen = selection.included.map((entry) => entry.lens);
    expect(chosen).toContain("AI-AND-LLM.md");
    expect(chosen).toContain("DATA-ISOLATION-AND-LIFECYCLE.md");
    expect(chosen).toContain("WEB-PROTOCOL-AND-AUTH.md");
    expect(chosen).not.toContain("MEMORY-SAFETY-AND-BINARY.md");
    expect(selection.excluded.find((entry) => entry.lens === "MEMORY-SAFETY-AND-BINARY.md")?.reason).toContain("no matching signal");
  });

  it("renders the choice and the exclusions for a prompt", () => {
    const rendered = renderLensSelection(selectSecurityLenses(aSignals({ servesHttp: true }), STANDARD));
    expect(rendered).toContain("references/security-lenses/ATTACK-CLASSES.md");
    expect(rendered).toContain("references/security-lenses/WEB-PROTOCOL-AND-AUTH.md");
    expect(rendered).toContain("Excluded lenses:");
  });

  it("breaks a score tie by declaration order, never by filename", () => {
    // SUPPLY-CHAIN and CLOUD tie at 3. Declaration order puts SUPPLY-CHAIN (5)
    // before CLOUD (6); filename order would pick CLOUD first. A two-lens budget
    // (the base lens plus one companion) shows which rule won.
    const selection = selectSecurityLenses(aSignals({ hasReleasePipelines: true, deploysInfrastructure: true }), { maxLenses: 2 });
    expect(selection.included.map((entry) => entry.lens)).toEqual(["ATTACK-CLASSES.md", "SUPPLY-CHAIN-AND-RELEASE.md"]);
  });

  it("credits a manifest only with what it establishes: a dependency manifest raises the supply chain, nothing else", () => {
    // A bare `package.json` names dependencies — not an HTTP surface, not a
    // persistence dependency — so neither the web nor the data-isolation lens
    // may claim it, and the printed reason says exactly what was seen.
    const manifestOnly = selectSecurityLenses(aSignals({ manifests: ["package.json"] }), STANDARD);
    expect(manifestOnly.included.map((entry) => [entry.lens, entry.reasons])).toEqual([
      ["ATTACK-CLASSES.md", ["core class list; always included"]],
      ["SUPPLY-CHAIN-AND-RELEASE.md", ["a dependency manifest is present"]],
    ]);
    // A manifest named by its repository path counts by its basename.
    expect(selectSecurityLenses(aSignals({ manifests: ["services/api/Cargo.toml"] }), STANDARD).included.map((entry) => entry.lens))
      .toContain("SUPPLY-CHAIN-AND-RELEASE.md");
    // A config file that declares no dependencies raises nothing.
    expect(selectSecurityLenses(aSignals({ manifests: ["Chart.yaml", "tsconfig.json"] }), STANDARD).included.map((entry) => entry.lens))
      .toEqual(["ATTACK-CLASSES.md"]);
  });

  it("names, in each exclusion for want of a signal, every signal that WAS present", () => {
    const selection = selectSecurityLenses(aSignals({ manifests: ["Chart.yaml"], servesHttp: true }), STANDARD);
    expect(selection.excluded.find((entry) => entry.lens === "AI-AND-LLM.md")?.reason).toBe("no matching signal (manifests, servesHttp)");
    expect(selectSecurityLenses(aSignals(), STANDARD).excluded.find((entry) => entry.lens === "AI-AND-LLM.md")?.reason)
      .toBe("no matching signal (none detected)");
  });

  it("counts the base lens against the profile's budget", () => {
    const quick = selectSecurityLenses(aSignals({
      languages: ["ts"],
      manifests: ["package.json"],
      servesHttp: true,
      rendersClientSide: true,
      drivesModelsOrTools: true,
      usesQueuesOrRpc: true,
      isolatesTenants: true,
      deploysInfrastructure: true,
      hasNativeMemory: true,
      hasAppOrLocalIpc: true,
      hasReleasePipelines: true,
      hasSharedResourcePressure: true,
    }), { maxLenses: SECURITY_PROFILE_LENSES.quick });
    expect(quick.included).toHaveLength(SECURITY_PROFILE_LENSES.quick);
    expect(quick.included[0]?.base).toBe(true);
  });
});
