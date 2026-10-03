import { describe, expect, it } from "vitest";
import {
  CURRENT_REVIEWER_PROTOCOL, REVIEWER_IMPACT_RUBRIC_V1, REVIEWER_OUTPUT_CONTRACT,
  REVIEWER_PAYLOAD_SCHEMA_V2, parseReviewerProtocolDescriptor, reviewerEmissionToolContract,
} from "../../src/core/reviewer-contract";
import {
  renderReviewerWireContract, renderReviewerWireInstructions,
} from "../../src/core/reviewer-protocol";
import {
  EMISSION_TOOL_SPECS, issueEmissionBinding, notProvidedEmissionCapability,
  providedEmissionCapability, type IssuedEmissionBinding,
} from "../../src/core/emission-tool";
import {
  decideRequestEmissionRoute, emissionToolPrimaryInstruction, issuedReviewerPayloadClaim,
  projectEmissionTaskText, type IssuedProducerClaim,
} from "../../src/core/spawn-admission";
import {
  renderPanelVerdictInstructions, type PanelVerdictInstructionRoute,
} from "../../src/core/panel-program";
import { sha256Hex } from "../../src/core/review-packet";
import {
  parseContextDigest, parseRequestId,
} from "../../src/core/orchestration-contract/identity";

/**
 * The wire-instruction wording gate (FR-020/AS-012; AD-7): newly issued
 * emission-enabled instructions name the exact tool as the primary final
 * action and extraction as the fallback; explicit extraction-only requests
 * retain final-message instructions; archived issued contracts are not
 * rewritten. Every route below is derived from the ACTUAL route machinery
 * (`decideRequestEmissionRoute`/`qualifyIssuedSpawnEmissionRoute` over the
 * frozen registry mint), never from a hand-shaped route literal, and the
 * unchanged-schema/unchanged-protocol claims carry their exact before/after
 * comparison (pinned bytes and descriptor digests), not a bare assertion.
 */

const CONTEXT = parseContextDigest("c0ffee".padEnd(64, "0"));
if (!CONTEXT.ok) throw new Error(`fixture context digest refused: ${CONTEXT.error.message}`);
const CONTEXT_DIGEST = CONTEXT.value;
const REQUEST = parseRequestId("request:protocol-docs");
if (!REQUEST.ok) throw new Error(`fixture request id refused: ${REQUEST.error.message}`);
const REQUEST_ID = REQUEST.value;

/** Legal issued-claim fixture construction follows the production ADT: v1
 *  carries no digest; v2/v3 require the binding's frozen digest. */
const claimOf = (binding: IssuedEmissionBinding): IssuedProducerClaim => {
  const authority = {
    requestId: binding.requestId,
    contextDigest: CONTEXT_DIGEST,
    producerKind: binding.kind.kind,
  };
  return binding.version === "v1"
    ? Object.freeze({ ...authority, version: "v1" as const })
    : Object.freeze({ ...authority, version: binding.version, schemaDigest: binding.schemaDigest });
};

const mustMint = (issued: {
  kind: keyof typeof EMISSION_TOOL_SPECS; version: string;
}): IssuedEmissionBinding => {
  const minted = issueEmissionBinding({ requestId: REQUEST_ID, ...issued });
  if (!minted.ok) throw new Error(`fixture binding refused: ${minted.error.code} — ${minted.error.message}`);
  return minted.value;
};

/** Every supported registry cell, as one binding round-trip case. */
const REGISTRY_CELLS: readonly IssuedEmissionBinding[] = (Object.keys(EMISSION_TOOL_SPECS) as Array<keyof typeof EMISSION_TOOL_SPECS>)
  .flatMap((kind) => Object.keys(EMISSION_TOOL_SPECS[kind].schemaVersions).map((version) => mustMint({ kind, version })));

describe("newly issued emission-enabled wire instructions (FR-020/AS-012)", () => {
  it("names the exact tool as the primary final action, forbids same-spawn re-emission, and names extraction as the fallback — every supported kind/version", () => {
    for (const binding of REGISTRY_CELLS) {
      // The route is derived from the actual route machinery, never a literal.
      const decision = decideRequestEmissionRoute(claimOf(binding), providedEmissionCapability(binding.schemaDigest));
      expect(decision.kind, `${binding.kind.kind}/${binding.version}`).toBe("emission");
      if (decision.kind !== "emission") continue;
      const rendered = renderReviewerWireInstructions({ kind: "emission", toolName: decision.binding.toolName });
      expect(rendered).toBe(reviewerEmissionToolContract(decision.binding.toolName));
      // ONE wording: the render and the production spawn projection agree byte
      // for byte, so the frozen wording is the wording production renders.
      expect(rendered).toBe(emissionToolPrimaryInstruction(decision.binding));
      expect([...rendered.matchAll(new RegExp(binding.toolName, "g"))]).toHaveLength(2);
      expect(rendered).toContain("primary final action");
      expect(rendered).toContain("exactly once");
      expect(rendered).toContain("a second time in this spawn");
      expect(rendered).toContain("fall back to the final message");
      expect(rendered).toContain("conforming to the issued payload schema");
    }
  });

  it("composes with the caller's instruction exactly as the production task-text projection does", () => {
    const binding = REGISTRY_CELLS[0]!;
    const decision = decideRequestEmissionRoute(claimOf(binding), providedEmissionCapability(binding.schemaDigest));
    expect(decision.kind).toBe("emission");
    if (decision.kind !== "emission") return;
    const baseInstruction = "Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required reviewer result.";
    const projected = projectEmissionTaskText(decision, baseInstruction);
    expect(projected.instruction).toBe(
      `${baseInstruction}\n${renderReviewerWireInstructions({ kind: "emission", toolName: decision.binding.toolName })}`,
    );
    expect(projected.descriptor).toContain(decision.binding.toolName);
  });
});

describe("explicit extraction-only routes retain final-message instructions (FR-020/AS-012)", () => {
  it("a not-provided extraction surface (e.g. Claude Code) renders the retained contract verbatim and stamps no descriptor", () => {
    const binding = REGISTRY_CELLS[0]!;
    const decision = decideRequestEmissionRoute(
      claimOf(binding),
      notProvidedEmissionCapability("the parent harness is not Pi: no Loom extension seam", "extraction"),
    );
    expect(decision.kind).toBe("extraction-only");
    if (decision.kind !== "extraction-only") return;
    expect(renderReviewerWireInstructions(decision)).toBe(REVIEWER_OUTPUT_CONTRACT);
    expect(renderReviewerWireInstructions(decision)).not.toContain("loom_emit_");
    const baseInstruction = "Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required reviewer result.";
    const projected = projectEmissionTaskText(decision, baseInstruction);
    expect(projected.instruction).toBe(baseInstruction);
    expect(projected.descriptor).toBe("");
  });

  it("an unqualified Pi route renders the retained contract verbatim (capability flags never upgrade issuance)", () => {
    const binding = REGISTRY_CELLS[0]!;
    const decision = decideRequestEmissionRoute(
      claimOf(binding),
      notProvidedEmissionCapability(
        "issued Pi route other/other is not the explicitly trusted qualified route for the frozen emission schemas",
        "extraction",
      ),
    );
    expect(decision.kind).toBe("extraction-only");
    if (decision.kind !== "extraction-only") return;
    expect(renderReviewerWireInstructions(decision)).toBe(REVIEWER_OUTPUT_CONTRACT);
  });

  it("a caller-supplied retained contract passes through byte-identically", () => {
    const retained = "Emit exactly one JSON object conforming to the unchanged reviewer-payload-schema and reviewer-impact-rubric sections.";
    expect(renderReviewerWireInstructions({ kind: "extraction-only", reason: "extraction surface" }, retained)).toBe(retained);
  });

  it("the panel verdict kinds render the frozen wording for their exact tools and retain the panel's final-message contracts verbatim on extraction-only", () => {
    const verdictKinds = ["judge-verdict", "refutation-verdict"] as const;
    for (const kind of verdictKinds) {
      const binding = mustMint({ kind, version: "v1" });
      const emissionRoute: PanelVerdictInstructionRoute = Object.freeze({
        kind: "emission" as const,
        binding: {
          requestId: binding.requestId, kind: binding.kind, version: binding.version,
          toolName: binding.toolName, schemaDigest: binding.schemaDigest,
        },
      });
      expect(renderPanelVerdictInstructions(emissionRoute, "canonical refutation verdict")).toBe(
        reviewerEmissionToolContract(binding.toolName),
      );
      expect(renderPanelVerdictInstructions(emissionRoute, "canonical refutation verdict")).toBe(
        emissionToolPrimaryInstruction(binding),
      );
      const extractionRoute: PanelVerdictInstructionRoute = Object.freeze({
        kind: "extraction-only" as const, reason: "the panel verdict spawn surface is extraction-only",
      });
      // The panel's own minted final-message wording passes through verbatim.
      const panelContract =
        "Adjudicate every Wave Finding through lens 'correctness' and emit exact refutation verdict JSON.";
      expect(renderPanelVerdictInstructions(extractionRoute, panelContract)).toBe(panelContract);
    }
  });
});

describe("archived issued contracts are not rewritten (FR-020/AS-012)", () => {
  it("an archived schema-1 claim renders the retained final-message contract verbatim, even against a provided surface", () => {
    // The archived claim is minted by the actual issuance renderer, and the
    // capability arm is the PROVIDED arm: the extraction-only outcome is the
    // issuance's own (no frozen registry cell), never a capability shortage.
    const claim = issuedReviewerPayloadClaim(
      { schemaVersion: 1 },
      { requestId: REQUEST_ID, contextDigest: CONTEXT_DIGEST },
    );
    expect(claim.version).toBe("v1");
    const decision = decideRequestEmissionRoute(
      claim,
      providedEmissionCapability(REGISTRY_CELLS[0]!.schemaDigest),
    );
    expect(decision.kind).toBe("extraction-only");
    if (decision.kind !== "extraction-only") return;
    expect(decision.reason).toContain("selects no frozen emission-tool registry cell");
    expect(renderReviewerWireInstructions(decision)).toBe(REVIEWER_OUTPUT_CONTRACT);
  });

  it("the current descriptor admits exactly the frozen bytes and refuses any rewrite (exact before/after)", () => {
    const admitted = parseReviewerProtocolDescriptor(CURRENT_REVIEWER_PROTOCOL);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.value).toBe(CURRENT_REVIEWER_PROTOCOL);
    // One-hex-character rewrites of every digest field are refused: an
    // archived or drifted descriptor cannot silently describe today's bytes.
    for (const key of ["schemaDigest", "rubricDigest"] as const) {
      const original = CURRENT_REVIEWER_PROTOCOL[key];
      const rewritten = {
        ...CURRENT_REVIEWER_PROTOCOL,
        [key]: original.startsWith("0") ? `1${original.slice(1)}` : `0${original.slice(1)}`,
      };
      const refused = parseReviewerProtocolDescriptor(rewritten);
      expect(refused.ok, key).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("unsupported-protocol");
    }
  });

  it("the unchanged schema/rubric claim carries its exact before/after comparison", () => {
    // The route-aware instruction render added NO second schema and rewrote NO
    // protocol bytes: the digests still derive from the frozen bytes, and the
    // fragment the stamper writes still carries exactly those sections.
    expect(sha256Hex(REVIEWER_PAYLOAD_SCHEMA_V2)).toBe(CURRENT_REVIEWER_PROTOCOL.schemaDigest);
    expect(sha256Hex(REVIEWER_IMPACT_RUBRIC_V1)).toBe(CURRENT_REVIEWER_PROTOCOL.rubricDigest);
    const fragment = renderReviewerWireContract();
    expect(fragment).toContain(REVIEWER_PAYLOAD_SCHEMA_V2);
    expect(fragment.endsWith(REVIEWER_IMPACT_RUBRIC_V1)).toBe(true);
    expect([...fragment.matchAll(/reviewer-payload-schema/g)]).toHaveLength(2);
    expect(REVIEWER_OUTPUT_CONTRACT).toBe(
      "Emit exactly one JSON object conforming to reviewer-payload-schema; apply reviewer-impact-rubric. No other final output.",
    );
  });
});
