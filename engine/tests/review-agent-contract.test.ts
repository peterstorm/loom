import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_SUB_AGENTS, WAVE_REVIEW_AGENTS, isReviewAgent } from "../src/core/agent-catalog-projections";
import { carriedOverCount, resolveReviewFindings, resolveTaskReviewFindings } from "../src/core/review-output";
import type { ReviewRun } from "../src/types";
import { buildContextPacket, buildReviewerContextPacket, encodeByteSection, type ContextPacket } from "../src/core/context-packets";
import { CURRENT_REVIEWER_PROTOCOL } from "../src/core/reviewer-contract";
import { parseIssuedReviewerProtocol, parseReviewerEvidence } from "../src/core/review-output";
import { createPublicationAuthorityResolver, parseAgentRequestAuthority, parseIssuedSpawnRequest, parseOrchestrationRunId, parseRequestId } from "../src/core/orchestration-contract";
import { resolveAgentPolicy, resolveModelProfile, lowerModelProfile } from "../src/core/model-profiles";
import { sha256Hex } from "../src/core/digest";
import { extractWireContractRegion } from "../src/core/wire-contract";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const agentFile = (name: string): string =>
  readFileSync(join(REPO_ROOT, "references", "reviewer-protocol-v1", "agents", `${name}.md`), "utf-8");

/**
 * Membership in `REVIEW_SUB_AGENTS` is not a label — it is a routing decision
 * with a failure mode. `store-reviewer-findings` sends every member's transcript
 * through `resolveReviewFindings`, which marks the task `evidence_capture_failed`
 * when it finds no `CRITICAL_COUNT`. So an agent can be added to the set without
 * its file being given the contract, and the result is a wave blocked by an agent
 * that did nothing wrong.
 *
 * Historical context: `code-simplifier` was once catalogued as a review Agent
 * without the Machine Summary contract its runtime parser required. This test
 * executes the current catalog/agent-file relationship so that mismatch cannot
 * recur; it does not infer historical spawn order from today’s command prose.
 */
describe("every archived v1 REVIEW_SUB_AGENT retains the Machine Summary contract", () => {
  const agents = [...REVIEW_SUB_AGENTS].sort();

  it("has at least one member (a vacuous pass would prove nothing)", () => {
    expect(agents.length).toBeGreaterThan(0);
  });

  it.each(agents)("agents/%s.md declares the mandatory block", (agent) => {
    const md = agentFile(agent);
    expect(md, "must have a Machine Summary section").toMatch(/^##+\s+Machine Summary/m);
    expect(md, "must name CRITICAL_COUNT — its absence is what fails the gate").toContain(
      "CRITICAL_COUNT:",
    );
    expect(md, "must name ADVISORY_COUNT — the wave gate's advisory-disposition step triages advisories").toContain(
      "ADVISORY_COUNT:",
    );
    expect(md, "must name the CRITICAL: marker line").toContain("CRITICAL: {");
    expect(md, "must name the ADVISORY: marker line").toContain("ADVISORY: {");
    expect(md, "must document the optional structured findings block").toContain("```findings");
  });

  it.each(agents)("%s routes through the review parser at runtime", (agent) => {
    expect(isReviewAgent(agent)).toBe(true);
  });

  it.each(WAVE_REVIEW_AGENTS)("%s declares remediation lifecycle evidence", (agent) => {
    const md = agentFile(agent);
    expect(md).toContain("REVIEW_GENERATION:");
    expect(md).toContain("REVIEW_PACKET_ID:");
    expect(md).toContain("review_lifecycle");
    expect(md).toContain("resolved_by_remediation");
    expect(md).toContain("still_present");
  });

  /**
   * The lifecycle parser (`parsePriorAssessments`) accepts ONLY `finding_id`
   * and `verdict` — never the plausible synonyms `id`/`status` a model infers
   * from prose alone. Historical reviewer outputs used the plausible
   * `{id, status}` synonyms and were rejected by that exact parser contract.
   * Prose is not a schema; these tests require the wire keys to appear
   * literally in every current reviewer file.
   */
  it.each(WAVE_REVIEW_AGENTS)("%s shows the EXACT lifecycle key names, not synonyms", (agent) => {
    const md = agentFile(agent);
    expect(md, "must show the literal finding_id key").toContain('"finding_id"');
    expect(md, "must show the literal verdict key").toContain('"verdict"');
    expect(md, "must show the prior_findings envelope key").toContain('"prior_findings"');
    expect(md, "must warn against the id synonym").toMatch(/`finding_id`\s*\(NOT\s*`id`\)/);
    expect(md, "must warn against the status synonym").toMatch(/`verdict`\s*\(NOT\s*`status`\)/);
  });

  /**
   * The strongest guarantee: extract the review_lifecycle JSON the agent file
   * actually documents, feed it through the REAL bound-review parser, and prove
   * it resolves to findings — not `evidence-failed`. A documented-but-
   * unparseable example is precisely the failure that blocked the wave, and no
   * amount of prose review catches it. This executes the documentation.
   */
  it.each(WAVE_REVIEW_AGENTS)("the lifecycle example %s documents actually parses", (agent) => {
    const md = agentFile(agent);
    const fence = /```review_lifecycle\s*\r?\n([\s\S]*?)\r?\n```/.exec(md);
    expect(fence, "agent file must contain a concrete review_lifecycle example").not.toBeNull();
    const lifecycleJson = fence![1]!;
    const parsed = JSON.parse(lifecycleJson) as { prior_findings: { finding_id: string }[] };
    const priorIds = parsed.prior_findings.map((entry) => entry.finding_id);
    expect(priorIds.length, "example must assess at least one prior finding").toBeGreaterThan(0);

    const run: ReviewRun = {
      generation: 3,
      packet_id: "a".repeat(64),
      head_sha: "b".repeat(40),
      expected_agents: [agent],
      prior_finding_ids: priorIds,
      evidence: [],
    };
    const transcript = [
      "Some prose the reviewer wrote first.",
      "",
      "### Machine Summary",
      `REVIEW_GENERATION: ${run.generation}`,
      `REVIEW_PACKET_ID: ${run.packet_id}`,
      "CRITICAL_COUNT: 0",
      "ADVISORY_COUNT: 0",
      "CRITICAL:",
      "ADVISORY:",
      "",
      "```findings",
      "[]",
      "```",
      "",
      "```review_lifecycle",
      lifecycleJson,
      "```",
    ].join("\n");

    const resolved = resolveTaskReviewFindings(transcript, agent, run, run.generation);
    expect(
      resolved.kind,
      resolved.kind === "evidence-failed" ? `parser rejected the documented example: ${resolved.message}` : "",
    ).toBe("bound-findings");
    if (resolved.kind !== "bound-findings") return;
    expect(resolved.bound.priorAssessments.map((a) => a.finding_id)).toEqual(priorIds);
    for (const assessment of resolved.bound.priorAssessments) {
      expect(["resolved_by_remediation", "still_present"]).toContain(assessment.verdict);
      expect(assessment.reason.length).toBeGreaterThan(0);
    }
  });

  /**
   * The contract each file documents, executed. A transcript shaped exactly as
   * the agent file instructs must resolve to findings — not to
   * `evidence-failed`, which is what a documented-but-unparseable shape would
   * produce and what no amount of prose review would catch.
   */
  it.each(agents)("the shape %s's file documents actually parses", (agent) => {
    const transcript = [
      "Some prose the reviewer wrote first.",
      "",
      "### Machine Summary",
      "CRITICAL_COUNT: 1",
      "ADVISORY_COUNT: 1",
      "CRITICAL: a real blocker",
      "ADVISORY: a nit",
      "",
      "```findings",
      JSON.stringify([
        { severity: "critical", file: "src/x.ts", line: 42, claim: "a real blocker" },
        { severity: "advisory", file: null, line: null, claim: "a nit" },
      ]),
      "```",
    ].join("\n");

    const resolved = resolveReviewFindings(transcript, agent);
    expect(resolved.kind).toBe("findings");
    if (resolved.kind !== "findings") return;
    expect(resolved.findings.critical).toEqual(["a real blocker"]);
    expect(resolved.findings.advisory).toEqual(["a nit"]);
    expect(resolved.findings.blockStatus.kind).toBe("used");
    // The block won cleanly, so nothing was carried over and nothing duplicated.
    expect(carriedOverCount(resolved.findings.blockStatus)).toBe(0);
  });
});

function value<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>): T {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}

/** Independent in-memory publication bytes, parsed by the real issuance boundary. */
function issuedContract(role: string, version: 1 | 2) {
  const runId = value(parseOrchestrationRunId(`run.shim.${role}.${version}`));
  const policy = value(resolveAgentPolicy(role));
  const profile = value(resolveModelProfile(policy.profile));
  const scope = ["src/x.ts"];
  const input = {
    requestId: value(parseRequestId(`request:${role}:${version}`)), role, requiredSkill: policy.requiredSkill ?? "none",
    fixedContext: [value(encodeByteSection("standalone-review-authority", JSON.stringify({ runId, role, attempt: 1, scope })))],
    variableContext: [],
  };
  const packet = value<ContextPacket>(version === 2 ? buildReviewerContextPacket(input)
    : buildContextPacket({ ...input, outputContract: "Return the Loom Machine Summary." }));
  const authority = value(parseAgentRequestAuthority({
    runId, requestId: packet.requestId, slotId: `slot:${role}`, program: "standalone-review", role, attempt: 1,
    modelProfile: policy.profile, requiredSkill: policy.requiredSkill,
    harnessBinding: { pi: lowerModelProfile(profile, "pi"), claude: lowerModelProfile(profile, "claude-code") },
    contextDigest: packet.digest, outputSlot: `transcripts/${role}/attempt-1.raw`,
  }));
  const context = { digest: packet.digest, slot: { kind: "fixed-artifact-slot", path: `contexts/${packet.digest}.json` } };
  const content = { schemaVersion: 1, kind: "batch-published", effectId: "effect:shim", runId,
    requestIds: [packet.requestId], contextDigests: [packet.digest], issuedRequests: [{ authority, context }] };
  const receipt = { ...content, publicationDigest: sha256Hex(JSON.stringify(content)) };
  const resolver = createPublicationAuthorityResolver(() => ({ ok: true, value: [...new TextEncoder().encode(JSON.stringify(receipt))] }));
  const request = value(parseIssuedSpawnRequest(resolver, { authority, context, issuance: {
    schemaVersion: 1, kind: "issued-spawn-request-proof", runId, effectId: content.effectId, publicationDigest: receipt.publicationDigest, batchIndex: 0,
  } }));
  const registration = version === 2
    ? { schemaVersion: 2 as const, runId, program: "standalone-review" as const, reviewerProtocol: CURRENT_REVIEWER_PROTOCOL }
    : { schemaVersion: 1 as const, runId, program: "standalone-review" as const };
  return value(parseIssuedReviewerProtocol({ request, packet, registration, subject: { kind: "standalone-review", runId, scope } }));
}

const currentAgentFile = (role: string) => readFileSync(join(REPO_ROOT, "agents", `${role}.md`), "utf-8");
function fencedSection(markdown: string, label: string): string {
  const section = markdown.split(`## ${label}\n\n`)[1];
  const found = section === undefined ? null : /^```json\n([\s\S]*?)\n```/.exec(section);
  if (found === null) throw new Error(`missing executable section ${label}`);
  return found[1]!;
}

describe("all seven issued reviewer shims select packet authority before current guidance", () => {
  it.each([...REVIEW_SUB_AGENTS])("%s stamped example is admitted under its actual issued v2 packet", (role) => {
    const issued = issuedContract(role, 2);
    const markdown = currentAgentFile(role);
    const region = value(extractWireContractRegion(markdown));
    const example = fencedSection(region, "Current example (standalone)");
    const schema = fencedSection(region, "reviewer-payload-schema");
    const packetSchema = issued.packet.fixedContext.find(({ label }) => label === "reviewer-payload-schema");
    const packetRubric = issued.packet.fixedContext.find(({ label }) => label === "reviewer-impact-rubric");
    expect(packetSchema).toBeDefined();
    expect(packetRubric).toBeDefined();
    expect(schema).toBe(new TextDecoder().decode(Uint8Array.from(packetSchema!.bytes)));
    expect(region.split("## reviewer-impact-rubric\n\n")[1] + "\n")
      .toBe(new TextDecoder().decode(Uint8Array.from(packetRubric!.bytes)));
    const admitted = value(parseReviewerEvidence(issued, new TextEncoder().encode(example)));
    expect(admitted.protocolVersion).toBe(2);
    expect(admitted.findings.criticalCount).toBe(1);
    expect(admitted.findings.drafts[0]?.basis).toEqual(JSON.parse(example).findings[0].basis);
    expect(parseReviewerEvidence(issued, new TextEncoder().encode("CRITICAL_COUNT: 0\nADVISORY_COUNT: 0")).ok).toBe(false);
  });

  it.each([...REVIEW_SUB_AGENTS])("%s genuine issued v1 selects read-only archived instructions, never v2", (role) => {
    const issued = issuedContract(role, 1);
    const markdown = currentAgentFile(role);
    const bootstrap = markdown.split("\nYou are ")[0]!;
    expect(bootstrap).toContain("## FIRST: issued Context Packet bootstrap");
    expect(bootstrap).toContain("LOOM_CONTEXT_READ_COMMAND");
    expect(bootstrap).not.toContain("call `readContextPacket`");
    expect(bootstrap.indexOf("LOOM_CONTEXT_READ_COMMAND")).toBeLessThan(bootstrap.indexOf("schema-1"));
    expect(bootstrap).toContain(`references/reviewer-protocol-v1/agents/${role}.md`);
    expect(bootstrap).toContain("references/reviewer-protocol-v1/agents/_shared/wire-contract.md");
    expect(bootstrap).toContain("INAPPLICABLE to this legacy request");
    expect(bootstrap).toContain("If either archive is missing/unreadable, report unavailable and stop");
    const archive = agentFile(issued.request.role);
    const shared = readFileSync(join(REPO_ROOT, "references/reviewer-protocol-v1/agents/_shared/wire-contract.md"), "utf-8");
    expect(value(extractWireContractRegion(archive))).toBe(shared.replace(/\n$/, ""));
    const template = /### Machine Summary\nCRITICAL_COUNT:[\s\S]*?(?=\n\n```findings)/.exec(shared)?.[0];
    if (template === undefined) throw new Error("archive lacks Machine Summary template");
    const output = template.replace("{number of critical findings}", "0").replace("{number of advisory findings}", "0")
      .replace("{one critical finding per line}", "").replace("{one advisory finding per line}", "");
    expect(value(parseReviewerEvidence(issued, new TextEncoder().encode(output))).findings.criticalCount).toBe(0);
    expect(issued.packet.schemaVersion).toBe(1);
    expect(issued.packet.fixedContext.some(({ label }) => label === "reviewer-impact-rubric")).toBe(false);
    const currentExample = fencedSection(value(extractWireContractRegion(markdown)), "Current example (standalone)");
    expect(parseReviewerEvidence(issued, new TextEncoder().encode(currentExample)).ok).toBe(false);
  });
});
