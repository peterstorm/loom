import { describe, expect, expectTypeOf, it } from "vitest";
import fc from "fast-check";
import { attributeFindings, reviewFindingCounts } from "../../src/core/findings";
import type { CurrentDraftFinding, Finding } from "../../src/types";
import { CURRENT_REVIEWER_PROTOCOL, REVIEWER_PAYLOAD_EXAMPLE_V2 } from "../../src/core/reviewer-contract";
import { parseReviewerPayloadV2 } from "../../src/core/reviewer-protocol";
import {
  buildFindingBrief, buildStandaloneFindingBrief, parseFindingBriefJson, parseCurrentBriefFinding,
  projectFindingForPanel, serializeFindingBrief, serializeBriefFinding, renderFindingBriefMarkdown,
  serializeReviewManifest, parseReviewManifest, selectReviewLenses, reviewSignals, briefCompletenessErrors,
  type BriefFinding,
} from "../../src/core/review-panel";
import { REVIEW_LAYOUT } from "../../src/core/panel-kernel";
import { canonicalStandalonePanelFindingAuthority, freezeStandalonePanelAuthority, parseFrozenStandalonePanelAuthority } from "../../src/core/standalone-refutation-panel";
import { canonicalDigest } from "../../src/core/digest";
import { type StandaloneReviewAggregate } from "../../src/core/standalone-review-model";
import { findingId } from "../fixtures/finding-id";

function value<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>): T {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}
const example = REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!;
if (example.severity !== "critical") throw new Error("critical fixture required");
const basis = example.basis;
const hostile = "  {claim}\n```\n# injected | <script>&*\t\u001b\u0085\u202e\u200b\u{e0001}  ";
function current(claim = hostile, confidence = 50, trace = true): Finding {
  const evidence = trace ? basis.evidence : {
    kind: "reproduction" as const, execution: "not-executed" as const,
    setup: hostile, input: "input", observed: "predicted only", expected: "expected", reference: hostile,
  };
  const payload = value(parseReviewerPayloadV2(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2, kind: "standalone-review", findings: [{ ...example, claim,
      basis: { ...basis, evidence, truthConfidence: confidence, severityRationale: hostile,
        consequence: { ...basis.consequence, evidenceLimits: hostile } } }],
  }))));
  return attributeFindings(payload.findings.map((draft): CurrentDraftFinding => ({ protocolVersion: 2, ...draft })), "code-reviewer")[0]!;
}
const legacy: Finding = { id: findingId("old-reviewer-1"), agent: " old{reviewer} ", severity: "critical", file: null, line: null, claim: " {old}  claim " };
const taskOf = (findings: readonly Finding[]) => ({ id: "T1", wave: 1, findings, critical_findings: findings.filter(({ severity }) => severity === "critical").map(({ claim }) => claim) });

describe("versioned panel Finding conservation", () => {
  it("requires a complete current critical basis in the ADT", () => {
    expectTypeOf<{ protocolVersion: 2; severity: "critical"; claim: string; file: null; line: null; id: BriefFinding["id"]; taskId: string; agent: string }>()
      .not.toMatchTypeOf<BriefFinding>();
  });

  it("round-trips exact current strings, both evidence arms, duplicates and counts beside historical entries", () => {
    fc.assert(fc.property(fc.string({ maxLength: 100 }), fc.integer({ min: 0, max: 100 }), fc.boolean(), (suffix, confidence, trace) => {
      const first = current(hostile + suffix, confidence, trace);
      const findings = [{ ...legacy, agent: "old-reviewer" }, first, { ...first, id: findingId("code-reviewer-2") }];
      const task = taskOf(findings);
      const before = JSON.stringify(findings);
      const brief = buildFindingBrief(1, [task]);
      expect(briefCompletenessErrors(brief, [task])).toEqual([]);
      const raw = serializeFindingBrief(brief);
      const loaded = value(parseFindingBriefJson(JSON.parse(raw)));
      expect(loaded).toEqual(brief);
      expect(serializeFindingBrief(loaded)).toBe(raw);
      expect(loaded.findings.map(({ id }) => id)).toEqual(["T1:old-reviewer-1", "T1:code-reviewer-1", "T1:code-reviewer-2"]);
      expect(reviewFindingCounts(loaded.findings)).toEqual({ critical: 3, advisory: 0 });
      expect(loaded.findings[1]?.claim).toBe(first.claim);
      expect(loaded.findings[1]?.basis).toEqual(first.basis);
      expect(loaded.findings[1]?.basis).not.toBe(first.basis);
      expect(Object.isFrozen(loaded.findings[1]?.basis?.evidence)).toBe(true);
      expect(JSON.stringify(findings)).toBe(before);
    }), { seed: 4401, numRuns: 60 });
  });

  it.each([false, true])("preserves advisory reason and optional complete basis: %s", (includeBasis) => {
    const draft: CurrentDraftFinding = { protocolVersion: 2, severity: "advisory", file: null, line: null,
      claim: hostile, reason: hostile, ...(includeBasis ? { basis } : {}) };
    const findings = attributeFindings([draft], "comment-analyzer");
    const brief = buildFindingBrief(1, [taskOf(findings)], "advisory");
    const loaded = value(parseFindingBriefJson(JSON.parse(serializeFindingBrief(brief))));
    expect(loaded).toEqual(brief);
    const entry = loaded.findings[0]!;
    if (entry.severity !== "advisory") throw new Error("advisory expected");
    expect(entry.reason).toBe(hostile);
    expect(Object.hasOwn(loaded.findings[0]!, "basis")).toBe(includeBasis);
    expect(buildStandaloneFindingBrief({ subjectId: "standalone-review", findings }).findings).toEqual([]);
  });

  it("encodes current prompt text as reversible JSON data without control/HTML/Markdown injection", () => {
    const finding = current();
    const brief = buildFindingBrief(1, [taskOf([finding])]);
    const stored = serializeFindingBrief(brief);
    const rendered = renderFindingBriefMarkdown(brief);
    expect(rendered).not.toContain("<script>");
    expect(rendered).not.toContain("# injected");
    expect(rendered).not.toMatch(/[\u001b\u0085\p{Cf}]/u);
    const data = /```json\n([\s\S]*?)\n```/.exec(rendered)?.[1];
    expect(data).toBeDefined();
    expect(JSON.parse(data!)).toEqual(JSON.parse(serializeBriefFinding(brief.findings[0]!)));
    expect(serializeFindingBrief(brief)).toBe(stored);
    expect(brief.findings[0]?.claim).toBe(hostile);
  });

  it("does not alias mutable caller basis and renders current task metadata as data", () => {
    const input = JSON.parse(JSON.stringify(current()));
    const projected = projectFindingForPanel("<script>#task", input);
    const before = JSON.stringify(projected);
    input.basis.consequence.impact = "mutated";
    input.basis.evidence.reference = "mutated";
    expect(JSON.stringify(projected)).toBe(before);
    const rendered = renderFindingBriefMarkdown({ wave: 1, severity: "critical", taskIds: ["<script>#task"], findings: [projected] });
    expect(rendered).not.toContain("<script>");
    expect(rendered).not.toContain("#task");
  });

  it("pins distinct historical Wave and standalone authority projections instead of rewriting history", () => {
    const wave = projectFindingForPanel("standalone-review", legacy);
    const standalone = canonicalStandalonePanelFindingAuthority([legacy])[0]!;
    expect(wave.agent).toBe(" old{reviewer} ");
    expect(standalone.agent).toBe("oldreviewer");
    expect(wave.claim).toBe("old  claim");
    expect(serializeBriefFinding(wave)).toBe(JSON.stringify({ id: "standalone-review:old-reviewer-1", task_id: "standalone-review", agent: " old{reviewer} ", severity: "critical", file: null, line: null, claim: "old  claim" }, null, 2));
    const found = current();
    expect(canonicalStandalonePanelFindingAuthority([found])[0]).toEqual(projectFindingForPanel("standalone-review", found));
  });

  it("keeps brace-only current claims rather than dropping or replacing them", () => {
    expect(projectFindingForPanel("T1", current("{}")).claim).toBe("{}");
    expect(projectFindingForPanel("T1", { ...legacy, claim: "{}" }).claim).toContain("unusable after sanitization");
  });

  it("binds the full mixed item roster and ordered lenses through manifest reload", () => {
    const brief = buildFindingBrief(1, [taskOf([legacy, current()])]);
    const lenses = value(selectReviewLenses(reviewSignals(brief.findings), 3));
    const raw = JSON.parse(serializeReviewManifest("run.panel", "panel-runs/run.panel", REVIEW_LAYOUT, lenses, brief.findings));
    expect(value(parseReviewManifest(raw, "panel-runs/run.panel", REVIEW_LAYOUT, lenses, brief.findings.map(({ id }) => id))).findings).toHaveLength(2);
    raw.findings.pop();
    expect(parseReviewManifest(raw, "panel-runs/run.panel", REVIEW_LAYOUT, lenses, brief.findings.map(({ id }) => id)).ok).toBe(false);
  });
});

const mutations: readonly (readonly [string, (entry: Record<string, unknown>) => void])[] = [
  ["missing discriminator", (entry) => { delete entry.protocolVersion; }],
  ["unsupported discriminator", (entry) => { entry.protocolVersion = 3; }],
  ["null discriminator", (entry) => { entry.protocolVersion = null; }],
  ["missing basis", (entry) => { delete entry.basis; }],
  ["unknown entry key", (entry) => { entry.extra = true; }],
  ["unknown evidence key", (entry) => { const b = entry.basis as { evidence: Record<string, unknown> }; b.evidence.extra = true; }],
  ["partial basis", (entry) => { delete (entry.basis as Record<string, unknown>).consequence; }],
  ["advisory without reason", (entry) => { entry.severity = "advisory"; }],
  ["nullable location mismatch", (entry) => { entry.line = 1; }],
];

describe("current brief and independently frozen parent authority refuse downgrade", () => {
  it.each(mutations)("refuses %s before legacy codec stripping", (_name, mutate) => {
    const entry = JSON.parse(JSON.stringify(projectFindingForPanel("T1", current())));
    mutate(entry);
    expect(parseCurrentBriefFinding(entry).ok).toBe(false);
    const { taskId, ...rest } = entry;
    expect(parseFindingBriefJson({ wave: 1, severity: "critical", task_ids: ["T1"], findings: [{ ...rest, task_id: taskId }] }).ok).toBe(false);
  });

  it("refuses changed or wholly stripped basis against parent projection even with recomputed self-digests", () => {
    const aggregate: StandaloneReviewAggregate = { schemaVersion: 2, reviewerProtocol: CURRENT_REVIEWER_PROTOCOL,
      runId: "run.source", subjectId: "standalone-review", scope: ["src/x.ts"], reviewerEvidence: [], findings: [current()] };
    const panelFindings = canonicalStandalonePanelFindingAuthority(aggregate.findings);
    const input = { standaloneRunId: aggregate.runId, panelRunId: "run.panel", aggregate, panelFindings,
      lenses: ["reproduction", "intent", "blast-radius"], threshold: 2, manifestDigest: "a".repeat(64) };
    const authority = value(freezeStandalonePanelAuthority(input));
    expect(authority.schemaVersion).toBe(2);
    expect(value(parseFrozenStandalonePanelAuthority(JSON.parse(JSON.stringify(authority)), aggregate))).toEqual(authority);
    for (const field of ["basis", "claim", "version"] as const) {
      const changed = JSON.parse(JSON.stringify(panelFindings));
      if (field === "basis") changed[0].basis.consequence.impact += " altered";
      if (field === "claim") changed[0].claim += " altered";
      if (field === "version") { delete changed[0].protocolVersion; delete changed[0].basis; }
      expect(freezeStandalonePanelAuthority({ ...input, panelFindings: changed }).ok).toBe(false);
      expect(parseFrozenStandalonePanelAuthority({ ...authority, findings: changed, findingBriefDigest: canonicalDigest(changed) }, aggregate).ok).toBe(false);
    }
  });
});
