import { describe, expect, expectTypeOf, it } from "vitest";
import fc from "fast-check";
import {
  admitPiSpawnBatch,
  MAX_PI_ORCHESTRATION_BATCH_SIZE,
  type SpawnAdmissionPorts,
} from "../../src/core/spawn-admission";
import {
  agentRequiresInteractiveTransport,
  LOOM_OWNED_AGENTS,
  type LoomAgentName,
  type PiSpawnItem,
} from "../../src/core/model-profiles";
import { AGENT_REQUIRED_SKILLS } from "../../src/core/orchestration-contract";

/** Spawn Admission is a pure decision exercised through in-memory ports. */

const agentMarkdown = (agent: LoomAgentName): string => {
  const skill = AGENT_REQUIRED_SKILLS[agent];
  return `---\nname: ${agent}\n${skill === null ? "" : `skills:\n  - ${skill}\n`}---\nBody\n`;
};

const missingIssuedRequest: SpawnAdmissionPorts["readIssuedRequest"] = () => ({
  ok: false, error: { message: "no independently issued request in this fixture" },
});

const allowPorts = (overrides: Partial<SpawnAdmissionPorts> = {}): SpawnAdmissionPorts => ({
  graphActive: true,
  transport: "headless",
  packageRoot: "/pkg",
  validateDefinition: () => ({ ok: true }),
  readSourceAgent: (agent) => ({ ok: true, content: agentMarkdown(agent) }),
  checkPhaseOrder: () => ({ kind: "allow" }),
  checkTemplateSubstitution: () => ({ kind: "allow" }),
  readIssuedRequest: missingIssuedRequest,
  ...overrides,
});

const item = (agent: LoomAgentName, task?: string): PiSpawnItem => ({
  agent,
  task: task ?? `LOOM_REQUIRED_SKILL: ${AGENT_REQUIRED_SKILLS[agent] ?? ""}\ndo the work`,
});

describe("admitPiSpawnBatch gate sequence", () => {
  it("blocks a malformed batch at parsing, naming the guard", () => {
    const admission = admitPiSpawnBatch({ agent: "", task: "" }, allowPorts());
    expect(admission.kind).toBe("block");
    if (admission.kind !== "block") return;
    expect(admission.guard).toBe("parse-pi-subagent-batch");
  });

  it("passes external batches through only on the native transport when no graph is active", () => {
    const external = { agent: "someone-elses-agent", task: "external work" };
    expect(admitPiSpawnBatch(external, allowPorts({ graphActive: false }))).toEqual({ kind: "pass-through" });
    expect(admitPiSpawnBatch(external, allowPorts({ graphActive: true }))).toMatchObject({
      kind: "block",
      guard: "external-agents",
    });
    expect(admitPiSpawnBatch(external, allowPorts({
      graphActive: false,
      transport: "interactive-rpc",
    }))).toMatchObject({ kind: "block", guard: "interactive-transport" });
  });

  it("blocks oversized batches with the exact partitioning instruction", () => {
    const tasks = Array.from({ length: MAX_PI_ORCHESTRATION_BATCH_SIZE + 1 }, () => item("code-reviewer"));
    const admission = admitPiSpawnBatch({ tasks }, allowPorts());
    expect(admission).toMatchObject({ kind: "block", guard: "batch-size" });
    if (admission.kind === "block") expect(admission.reason).toContain(String(MAX_PI_ORCHESTRATION_BATCH_SIZE));
  });

  it("routes every interactive phase role exclusively through the RPC transport", () => {
    for (const agent of ["specify-agent", "clarify-agent", "architecture-agent", "arch-interviewer-agent"] as const) {
      const task = item(agent);
      expect(admitPiSpawnBatch(task, allowPorts())).toMatchObject({
        kind: "block",
        guard: "interactive-transport",
      });
      expect(admitPiSpawnBatch(task, allowPorts({ transport: "interactive-rpc" })).kind).toBe("admit");
    }
  });

  it("refuses headless roles and batches on the single-agent interactive transport", () => {
    const headless = admitPiSpawnBatch(item("code-reviewer"), allowPorts({ transport: "interactive-rpc" }));
    expect(headless).toMatchObject({ kind: "block", guard: "interactive-transport" });
    const batch = admitPiSpawnBatch({
      tasks: [item("specify-agent"), item("architecture-agent")],
    }, allowPorts({ transport: "interactive-rpc" }));
    expect(batch).toMatchObject({ kind: "block", guard: "interactive-transport" });
  });

  it("requires agentScope 'user', defaulting an absent scope to 'user'", () => {
    const base = item("code-reviewer");
    expect(admitPiSpawnBatch({ ...base }, allowPorts()).kind).toBe("admit");
    const scoped = admitPiSpawnBatch({ ...base, agentScope: "project" }, allowPorts());
    expect(scoped).toMatchObject({ kind: "block", guard: "agent-scope" });
  });

  it("blocks on a stale rendered definition with the remediation command", () => {
    const admission = admitPiSpawnBatch({ ...item("code-reviewer") }, allowPorts({
      validateDefinition: () => ({ ok: false, error: "sha mismatch" }),
    }));
    expect(admission).toMatchObject({ kind: "block", guard: "definition-identity" });
    if (admission.kind === "block") {
      expect(admission.reason).toContain("sha mismatch");
      expect(admission.reason).toContain("/pkg/scripts/sync-pi-agents.sh");
    }
  });

  it("an item naming an undeclared skill never passes", () => {
    // code-simplifier declares `distill`; a task that never says it is refused.
    const admission = admitPiSpawnBatch(
      { agent: "code-simplifier", task: "review the frozen scope" },
      allowPorts(),
    );
    expect(admission).toMatchObject({ kind: "block", guard: "validate-agent-skill" });
  });

  it("one bad sibling blocks the whole parallel batch", () => {
    const admission = admitPiSpawnBatch(
      { tasks: [item("code-reviewer"), { agent: "code-simplifier", task: "no skill named" }] },
      allowPorts(),
    );
    expect(admission).toMatchObject({ kind: "block", guard: "validate-agent-skill" });
  });

  it("phase and template port blocks surface verbatim under their guard names", () => {
    const phase = admitPiSpawnBatch({ ...item("code-reviewer") }, allowPorts({
      checkPhaseOrder: () => ({ kind: "block", message: "phase says no" }),
    }));
    expect(phase).toEqual({ kind: "block", guard: "validate-phase-order", reason: "phase says no" });
    const template = admitPiSpawnBatch({ ...item("code-reviewer") }, allowPorts({
      checkTemplateSubstitution: () => ({ kind: "block", message: "unsubstituted template" }),
    }));
    expect(template).toEqual({ kind: "block", guard: "validate-template-substitution", reason: "unsubstituted template" });
  });

  it("admits a clean batch with index-aligned classifications", () => {
    const admission = admitPiSpawnBatch({ tasks: [item("code-reviewer"), item("code-simplifier")] }, allowPorts());
    expect(admission.kind).toBe("admit");
    if (admission.kind !== "admit") return;
    expect(admission.itemAdmissions.map(({ item: { agent } }) => agent)).toEqual(["code-reviewer", "code-simplifier"]);
    expect(admission.itemAdmissions.map(({ taskExecutionSpawn }) => taskExecutionSpawn)).toHaveLength(2);
  });
});

describe("spawn admission properties", () => {
  it("is total: never throws for arbitrary input", () => {
    fc.assert(fc.property(fc.anything(), (raw) => {
      expect(() => admitPiSpawnBatch(raw, allowPorts())).not.toThrow();
    }));
  });

  it("every skill-requiring agent is refused without its skill in the task and admitted with it", () => {
    const requiring = LOOM_OWNED_AGENTS.filter((agent) => AGENT_REQUIRED_SKILLS[agent] !== null);
    fc.assert(fc.property(fc.constantFrom(...requiring), (agent) => {
      const skill = AGENT_REQUIRED_SKILLS[agent]!;
      const transport = agentRequiresInteractiveTransport(agent) ? "interactive-rpc" : "headless";
      const ports = allowPorts({ transport });
      const bare = admitPiSpawnBatch({ agent, task: "do the work" }, ports);
      expect(bare).toMatchObject({ kind: "block", guard: "validate-agent-skill" });
      const marked = admitPiSpawnBatch({ agent, task: `LOOM_REQUIRED_SKILL: ${skill}\ndo the work` }, ports);
      expect(marked.kind).toBe("admit");
    }));
  });

  it("a block never leaks admit data and always names a guard", () => {
    fc.assert(fc.property(fc.anything(), fc.boolean(), (raw, graphActive) => {
      const admission = admitPiSpawnBatch(raw, allowPorts({ graphActive }));
      if (admission.kind === "block") {
        expect(admission.guard.length).toBeGreaterThan(0);
        expect(admission.reason.length).toBeGreaterThan(0);
      }
    }));
  });
});

// ---------------------------------------------------------------------------
// Issued emission capability (AD-6/AD-7, FR-001/FR-008/FR-012/FR-020)
// ---------------------------------------------------------------------------

import {
  EMISSION_DESCRIPTOR_MARKER,
  decideIssuedSpawnEmissionRoute,
  decideRequestEmissionRoute,
  emissionToolPrimaryInstruction,
  expectedSpawnEmissionCapability as decideSpawnEmissionCapability,
  issuedReviewerPayloadClaim,
  parseEmissionDescriptor,
  projectEmissionTaskText,
  qualifyIssuedSpawnEmissionRoute,
  renderEmissionDescriptor,
  type EmissionDescriptorParse,
  type IssuedProducerClaim,
  type IssuedSpawnEmissionAuthority,
  type IssuedSpawnEmissionRoute,
} from "../../src/core/spawn-admission";
import {
  issueEmissionBinding,
  notProvidedEmissionCapability,
  providedEmissionCapability,
  type EmissionToolCapability,
  type IssuedEmissionBinding,
} from "../../src/core/emission-tool";
import {
  parseContextDigest,
  parseRequestId,
  type ArtifactDigest,
  type ContextDigest,
  type RequestId,
} from "../../src/core/orchestration-contract/identity";
import { buildContextPacket, buildStandaloneReviewerContextPacketV3, encodeByteSection } from "../../src/core/context-packets";
import { parseAgentRequestAuthority } from "../../src/core/orchestration-contract";
import {
  REVIEWER_EXTRACTION_RETRY_INSTRUCTION,
  decideRefutationTranscriptRead,
  publishLegacyInitialBatch,
  publishReviewInitialBatch,
  renderReviewProgramSpawnTask,
  renderSpawnTask,
  standaloneRetryTask,
} from "../../src/handlers/helpers/programs/helpers";
import { renderCurrentWaveRetryTask } from "../../src/handlers/helpers/programs/wave-gate";
import type { RunDirHandle } from "../../src/orchestration/run-directory-handle";

const mustMint = (issued: {
  requestId: string;
  kind: "reviewer-payload" | "judge-verdict" | "refutation-verdict";
  version: string;
  schemaDigest?: string;
}): IssuedEmissionBinding => {
  const minted = issueEmissionBinding(issued);
  if (!minted.ok) throw new Error(`fixture binding refused: ${minted.error.code} — ${minted.error.message}`);
  return minted.value;
};

const CONTEXT = parseContextDigest("c0ffee".padEnd(64, "0"));
if (!CONTEXT.ok) throw new Error(`fixture context digest refused: ${CONTEXT.error.message}`);
const CONTEXT_DIGEST = CONTEXT.value;
const OTHER_CONTEXT = parseContextDigest("deadbeef".padEnd(64, "0"));
if (!OTHER_CONTEXT.ok) throw new Error(`fixture alternate context digest refused: ${OTHER_CONTEXT.error.message}`);

const REVIEWER_V2 = mustMint({ requestId: "request:emission-v2", kind: "reviewer-payload", version: "v2" });
const REVIEWER_V3 = mustMint({ requestId: "request:emission-v3", kind: "reviewer-payload", version: "v3" });
const JUDGE_V1 = mustMint({ requestId: "request:emission-judge", kind: "judge-verdict", version: "v1" });
const REFUTATION_V1 = mustMint({ requestId: "request:emission-refutation", kind: "refutation-verdict", version: "v1" });

/** Every frozen registry cell, as one round-trip case. */
const REGISTRY_CELLS: readonly IssuedEmissionBinding[] = [REVIEWER_V2, REVIEWER_V3, JUDGE_V1, REFUTATION_V1];

const emissionRouteFor = (
  binding: IssuedEmissionBinding,
  contextDigest: ContextDigest = CONTEXT_DIGEST,
): IssuedSpawnEmissionRoute => Object.freeze({ kind: "emission-enabled", binding, contextDigest });

/** Legal issued-claim fixture construction follows the production ADT: v1
 *  carries no digest; v2/v3 require the binding's frozen digest. */
const claimOf = (
  binding: IssuedEmissionBinding,
  contextDigest: ContextDigest = CONTEXT_DIGEST,
): IssuedProducerClaim => {
  const authority = {
    requestId: binding.requestId,
    contextDigest,
    producerKind: binding.kind.kind,
  };
  return binding.version === "v1"
    ? Object.freeze({ ...authority, version: "v1" as const })
    : Object.freeze({ ...authority, version: binding.version, schemaDigest: binding.schemaDigest });
};

const issuedFor = (
  agent: LoomAgentName,
  binding: IssuedEmissionBinding,
  contextDigest: ContextDigest = CONTEXT_DIGEST,
  route: IssuedSpawnEmissionRoute = emissionRouteFor(binding, contextDigest),
): SpawnAdmissionPorts["readIssuedRequest"] => (requestId, digest, role) =>
  requestId === binding.requestId && digest === contextDigest && role === agent
    ? { ok: true, value: { role: agent, claim: claimOf(binding, contextDigest), route } }
    : { ok: false, error: { message: "the fixture's issued authority belongs to another request" } };

const expectedSpawnEmissionCapability = (
  spawnItem: PiSpawnItem,
  readIssuedRequest: SpawnAdmissionPorts["readIssuedRequest"] = missingIssuedRequest,
) => decideSpawnEmissionCapability(spawnItem, readIssuedRequest);

/** One engine-issued task carrying exact request identity markers, with
 *  the role's required-Skill line intact. */
const issuedTask = (
  agent: LoomAgentName,
  binding: IssuedEmissionBinding,
  contextDigest: ContextDigest = CONTEXT_DIGEST,
): string =>
  `LOOM_REQUEST_ID: ${binding.requestId}\n` +
  `LOOM_CONTEXT_DIGEST: ${contextDigest}\n` +
  `LOOM_CONTEXT_PATH: /run/contexts/${contextDigest}.json\n` +
  `LOOM_REQUIRED_SKILL: ${AGENT_REQUIRED_SKILLS[agent] ?? ""}\n` +
  "review the frozen scope";

/** The same issued identity plus its untrusted descriptor projection. */
const emissionTask = (
  agent: LoomAgentName,
  binding: IssuedEmissionBinding,
  contextDigest: ContextDigest = CONTEXT_DIGEST,
): string => issuedTask(agent, binding, contextDigest).replace(
  "review the frozen scope",
  `${renderEmissionDescriptor(binding, contextDigest)}review the frozen scope`,
);

const emissionItem = (agent: LoomAgentName, binding: IssuedEmissionBinding, contextDigest: ContextDigest = CONTEXT_DIGEST) =>
  item(agent, emissionTask(agent, binding, contextDigest));

describe("issued emission descriptor render/parse", () => {
  it("round-trips every frozen registry cell byte-for-byte", () => {
    fc.assert(fc.property(fc.constantFrom(...REGISTRY_CELLS), (binding) => {
      const rendered = renderEmissionDescriptor(binding, CONTEXT_DIGEST);
      expect(rendered.startsWith(`${EMISSION_DESCRIPTOR_MARKER}: `)).toBe(true);
      expect(rendered.endsWith("\n")).toBe(true);
      const parsed = parseEmissionDescriptor(`preamble\n${rendered}postamble`);
      expect(parsed).toMatchObject({ kind: "issued" });
      if (parsed.kind !== "issued") return;
      expect(parsed.binding).toEqual(binding);
      expect(parsed.contextDigest).toBe(CONTEXT_DIGEST);
    }));
  });

  it("renders the frozen field order over the exact marker", () => {
    expect(renderEmissionDescriptor(REVIEWER_V2, CONTEXT_DIGEST)).toBe(
      `${EMISSION_DESCRIPTOR_MARKER}: loom_emit_reviewer_payload reviewer-payload v2 ${REVIEWER_V2.requestId} ${CONTEXT_DIGEST} ${REVIEWER_V2.schemaDigest}\n`,
    );
  });

  it("answers absent for tasks without a descriptor line", () => {
    expect(parseEmissionDescriptor(item("code-reviewer").task)).toEqual({ kind: "absent" });
  });

  const malformed = (label: string, task: string, expected: RegExp) => {
    it(`refuses ${label}`, () => {
      const parsed = parseEmissionDescriptor(task);
      expect(parsed.kind).toBe("malformed");
      if (parsed.kind !== "malformed") return;
      expect(parsed.reason).toMatch(expected);
    });
  };

  malformed(
    "a tool name that does not certify the kind's registry tool",
    `${EMISSION_DESCRIPTOR_MARKER}: loom_emit_judge_verdict reviewer-payload v2 ${REVIEWER_V2.requestId} ${CONTEXT_DIGEST} ${REVIEWER_V2.schemaDigest}\n`,
    /tool-name-mismatch/,
  );
  malformed(
    "a producer kind the registry does not freeze",
    `${EMISSION_DESCRIPTOR_MARKER}: loom_emit_reviewer_payload decompose-verdict v2 ${REVIEWER_V2.requestId} ${CONTEXT_DIGEST} ${REVIEWER_V2.schemaDigest}\n`,
    /unknown-producer-kind/,
  );
  malformed(
    "a schema version outside the closed vocabulary",
    `${EMISSION_DESCRIPTOR_MARKER}: loom_emit_reviewer_payload reviewer-payload v4 ${REVIEWER_V2.requestId} ${CONTEXT_DIGEST} ${REVIEWER_V2.schemaDigest}\n`,
    /unsupported-schema-version/,
  );
  malformed(
    "a version the kind's tool does not carry",
    `${EMISSION_DESCRIPTOR_MARKER}: loom_emit_judge_verdict judge-verdict v2 ${REVIEWER_V2.requestId} ${CONTEXT_DIGEST} ${REVIEWER_V2.schemaDigest}\n`,
    /unsupported-schema-version/,
  );
  malformed(
    "a digest that does not certify the frozen bytes",
    `${EMISSION_DESCRIPTOR_MARKER}: loom_emit_reviewer_payload reviewer-payload v2 ${REVIEWER_V2.requestId} ${CONTEXT_DIGEST} ${"b".repeat(64)}\n`,
    /schema-digest-mismatch/,
  );
  malformed(
    "a non-canonical request id",
    `${EMISSION_DESCRIPTOR_MARKER}: loom_emit_reviewer_payload reviewer-payload v2 not a request ${CONTEXT_DIGEST} ${REVIEWER_V2.schemaDigest}\n`,
    /invalid-request-identity|must carry exactly/,
  );
  malformed(
    "a non-digest context field",
    `${EMISSION_DESCRIPTOR_MARKER}: loom_emit_reviewer_payload reviewer-payload v2 ${REVIEWER_V2.requestId} /run/contexts/x.json ${REVIEWER_V2.schemaDigest}\n`,
    /must carry exactly|context digest/,
  );
  malformed(
    "two descriptor lines in one task",
    `${renderEmissionDescriptor(REVIEWER_V2, CONTEXT_DIGEST)}${renderEmissionDescriptor(REVIEWER_V2, CONTEXT_DIGEST)}work`,
    /exactly one descriptor/,
  );
  malformed(
    "a truncated field list",
    `${EMISSION_DESCRIPTOR_MARKER}: loom_emit_reviewer_payload reviewer-payload v2 ${REVIEWER_V2.requestId}\n`,
    /must carry exactly 6/,
  );
  malformed(
    "an empty field from a doubled separator",
    `${EMISSION_DESCRIPTOR_MARKER}: loom_emit_reviewer_payload reviewer-payload v2 ${REVIEWER_V2.requestId}  ${CONTEXT_DIGEST} ${REVIEWER_V2.schemaDigest}\n`,
    /must carry exactly 6/,
  );

  it("retains structural and registry refusal codes as typed parse data", () => {
    expect(parseEmissionDescriptor(`${EMISSION_DESCRIPTOR_MARKER}: truncated\n`)).toMatchObject({
      kind: "malformed",
      code: "descriptor-fields",
    });
    expect(parseEmissionDescriptor(
      `${EMISSION_DESCRIPTOR_MARKER}: loom_emit_reviewer_payload reviewer-payload v4 ${REVIEWER_V2.requestId} ${CONTEXT_DIGEST} ${REVIEWER_V2.schemaDigest}\n`,
    )).toMatchObject({ kind: "malformed", code: "unsupported-schema-version" });
  });

  it("is total over arbitrary task text", () => {
    fc.assert(fc.property(fc.string({ maxLength: 400 }), (task) => {
      const parsed: EmissionDescriptorParse = parseEmissionDescriptor(task);
      expect(["absent", "malformed", "issued"]).toContain(parsed.kind);
    }));
  });
});

describe("expected spawn emission capability", () => {
  it("keeps ordinary descriptor-free, marker-free tasks on the no-tool baseline without an authority read", () => {
    expect(expectedSpawnEmissionCapability(item("code-reviewer"), () => {
      throw new Error("unbound items must not consult the Run Directory");
    })).toEqual({
      ok: true,
      expectation: { kind: "no-emission-tool" },
    });
  });

  it("consults issued authority and blocks descriptor loss on an emission-enabled request", () => {
    let reads = 0;
    const admission = expectedSpawnEmissionCapability(
      item("code-reviewer", issuedTask("code-reviewer", REVIEWER_V2)),
      (...args) => {
        reads += 1;
        return issuedFor("code-reviewer", REVIEWER_V2)(...args);
      },
    );
    expect(reads).toBe(1);
    expect(admission).toMatchObject({
      ok: false,
      reason: expect.stringContaining("missing its required LOOM_EMISSION_DESCRIPTOR"),
    });
  });

  it("honors an explicit extraction-only issued route over a registry-supported claim", () => {
    const route = Object.freeze({ kind: "extraction-only" as const, reason: "issued route was not qualified" });
    const reader = issuedFor("code-reviewer", REVIEWER_V2, CONTEXT_DIGEST, route);
    expect(expectedSpawnEmissionCapability(
      item("code-reviewer", issuedTask("code-reviewer", REVIEWER_V2)),
      reader,
    )).toEqual({ ok: true, expectation: { kind: "no-emission-tool" } });
    expect(expectedSpawnEmissionCapability(
      emissionItem("code-reviewer", REVIEWER_V2),
      reader,
    )).toMatchObject({
      ok: false,
      reason: expect.stringContaining("independently issued route is extraction-only"),
    });
  });

  it("requires the descriptor for an explicit emission-enabled issued route", () => {
    const route = Object.freeze({
      kind: "emission-enabled" as const,
      binding: REVIEWER_V2,
      contextDigest: CONTEXT_DIGEST,
    });
    const reader = issuedFor("code-reviewer", REVIEWER_V2, CONTEXT_DIGEST, route);
    expect(expectedSpawnEmissionCapability(
      item("code-reviewer", issuedTask("code-reviewer", REVIEWER_V2)),
      reader,
    )).toMatchObject({
      ok: false,
      reason: expect.stringContaining("missing its required LOOM_EMISSION_DESCRIPTOR"),
    });
    expect(expectedSpawnEmissionCapability(
      emissionItem("code-reviewer", REVIEWER_V2),
      reader,
    )).toMatchObject({ ok: true, expectation: { kind: "emission-enabled" } });
  });

  it("refuses an emission-enabled route whose request ID is mixed with another issued claim", () => {
    const routeBinding = mustMint({
      requestId: "request:mixed-route-id",
      kind: "reviewer-payload",
      version: REVIEWER_V2.version,
      schemaDigest: REVIEWER_V2.schemaDigest,
    });
    const admission = expectedSpawnEmissionCapability(
      emissionItem("code-reviewer", REVIEWER_V2),
      issuedFor("code-reviewer", REVIEWER_V2, CONTEXT_DIGEST, emissionRouteFor(routeBinding)),
    );
    expect(admission.ok).toBe(false);
    if (admission.ok) return;
    expect(admission.reason).toContain("issued emission route");
    expect(admission.reason).toContain(routeBinding.requestId);
    expect(admission.reason).toContain(REVIEWER_V2.requestId);
  });

  it("fails closed when request-bound authority is unavailable", () => {
    const admission = expectedSpawnEmissionCapability(
      item("code-reviewer", issuedTask("code-reviewer", REVIEWER_V2)),
      missingIssuedRequest,
    );
    expect(admission).toMatchObject({
      ok: false,
      reason: expect.stringContaining("issued emission request authority unavailable"),
    });
  });

  it("fails closed with a diagnostic when authority lookup throws for a request-bound task", () => {
    const admission = expectedSpawnEmissionCapability(
      item("code-reviewer", issuedTask("code-reviewer", REVIEWER_V2)),
      () => { throw new Error("run directory read exploded"); },
    );
    expect(admission).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/could not be read safely.*run directory read exploded/),
    });
  });

  it("allows an explicitly issued archived extraction-only request without a descriptor", () => {
    const archivedReader: SpawnAdmissionPorts["readIssuedRequest"] = () => ({
      ok: true,
      value: {
        role: "code-reviewer",
        claim: {
          requestId: REVIEWER_V2.requestId,
          contextDigest: CONTEXT_DIGEST,
          producerKind: "reviewer-payload",
          version: "v1",
        },
        route: { kind: "extraction-only", reason: "archived reviewer protocol has no emission schema" },
      },
    });
    expect(expectedSpawnEmissionCapability(
      item("code-reviewer", issuedTask("code-reviewer", REVIEWER_V2)),
      archivedReader,
    )).toEqual({ ok: true, expectation: { kind: "no-emission-tool" } });
    expect(expectedSpawnEmissionCapability(
      emissionItem("code-reviewer", REVIEWER_V2),
      archivedReader,
    )).toMatchObject({
      ok: false,
      reason: expect.stringContaining("extraction-only authority cannot be upgraded by task text"),
    });
  });

  it("allows an independently issued non-producer request without a descriptor", () => {
    expect(expectedSpawnEmissionCapability(
      item("spec-check-invoker", issuedTask("spec-check-invoker", REVIEWER_V2)),
      issuedFor("spec-check-invoker", REVIEWER_V2),
    )).toEqual({ ok: true, expectation: { kind: "no-emission-tool" } });
  });

  it.each([
    `LOOM_REQUEST_ID:${REVIEWER_V2.requestId}`,
    `LOOM_REQUEST_ID: ${REVIEWER_V2.requestId}`,
    `LOOM_CONTEXT_DIGEST: ${CONTEXT_DIGEST}`,
  ])("blocks malformed or incomplete marker-bearing descriptor-free identity: %s", (marker) => {
    const admission = expectedSpawnEmissionCapability(item("code-reviewer", `${marker}\nreview`), () => {
      throw new Error("malformed identity must refuse before authority lookup");
    });
    expect(admission).toMatchObject({ ok: false, reason: expect.stringContaining("unusable task issuance identity") });
  });

  it("expects the exact issued binding when the catalog grants the kind and the markers bind", () => {
    const admission = expectedSpawnEmissionCapability(emissionItem("code-reviewer", REVIEWER_V2), issuedFor("code-reviewer", REVIEWER_V2));
    expect(admission).toMatchObject({ ok: true, expectation: { kind: "emission-enabled" } });
    if (!admission.ok || admission.expectation.kind !== "emission-enabled") return;
    expect(admission.expectation.binding).toEqual(REVIEWER_V2);
    expect(admission.expectation.contextDigest).toBe(CONTEXT_DIGEST);
  });

  it("refuses every self-consistent forged descriptor without an independently reserved request", () => {
    fc.assert(fc.property(fc.constantFrom(...REGISTRY_CELLS), (binding) => {
      const agent = binding.kind.kind === "judge-verdict" ? "arch-judge-agent" : "review-verifier-agent";
      const forged = emissionItem(agent, binding);
      expect(expectedSpawnEmissionCapability(forged)).toMatchObject({
        ok: false, reason: expect.stringContaining("no independently issued request"),
      });
      expect(admitPiSpawnBatch(forged, allowPorts())).toMatchObject({
        kind: "block", guard: "expected-emission-capability",
        reason: expect.stringContaining("no independently issued request"),
      });
    }));
  });

  it("refuses an issued request or protocol that differs in identity, role, kind, version, or digest", () => {
    const forged = emissionItem("code-reviewer", REVIEWER_V2);
    const claim: IssuedProducerClaim = {
      requestId: REVIEWER_V2.requestId, contextDigest: CONTEXT_DIGEST,
      producerKind: "reviewer-payload", version: "v2", schemaDigest: REVIEWER_V2.schemaDigest,
    };
    const route = emissionRouteFor(REVIEWER_V2);
    const mismatches: readonly IssuedSpawnEmissionAuthority[] = [
      { role: "code-reviewer", claim: { ...claim, requestId: REVIEWER_V3.requestId }, route },
      { role: "code-reviewer", claim: { ...claim, contextDigest: OTHER_CONTEXT.value }, route },
      { role: "pr-test-analyzer", claim, route },
      { role: "code-reviewer", claim: { ...claim, producerKind: "judge-verdict" }, route },
      { role: "code-reviewer", claim: { ...claim, version: "v3" }, route },
      { role: "code-reviewer", claim: { ...claim, schemaDigest: JUDGE_V1.schemaDigest }, route },
    ];
    for (const issued of mismatches) {
      const admission = expectedSpawnEmissionCapability(forged, () => ({ ok: true, value: issued }));
      expect(admission.ok).toBe(false);
      if (!admission.ok) expect(admission.reason).toMatch(/differs|cannot be upgraded/);
    }
  });

  it("admits the successor v3 cell for the same reviewer role", () => {
    const admission = expectedSpawnEmissionCapability(emissionItem("code-reviewer", REVIEWER_V3), issuedFor("code-reviewer", REVIEWER_V3));
    expect(admission).toMatchObject({ ok: true, expectation: { kind: "emission-enabled" } });
  });

  it("admits each kind of the review-verifier Agent only when the issued context names it (AD-6)", () => {
    for (const binding of [REVIEWER_V2, REFUTATION_V1]) {
      const admission = expectedSpawnEmissionCapability(emissionItem("review-verifier-agent", binding), issuedFor("review-verifier-agent", binding));
      expect(admission).toMatchObject({ ok: true, expectation: { kind: "emission-enabled" } });
    }
  });

  it("admits the arch-judge Agent's catalog-derived judge-verdict kind", () => {
    const admission = expectedSpawnEmissionCapability(emissionItem("arch-judge-agent", JUDGE_V1), issuedFor("arch-judge-agent", JUDGE_V1));
    expect(admission).toMatchObject({ ok: true, expectation: { kind: "emission-enabled" } });
  });

  it("refuses a descriptor whose kind the Agent's catalog row does not grant", () => {
    const admission = expectedSpawnEmissionCapability(
      emissionItem("arch-judge-agent", REVIEWER_V2),
      issuedFor("arch-judge-agent", REVIEWER_V2),
    );
    expect(admission).toMatchObject({ ok: false });
    if (admission.ok) return;
    expect(admission.reason).toContain("cannot produce reviewer-payload");
    expect(admission.reason).toContain("judge-verdict");
    expect(admission.reason).toContain("AD-6");
  });

  it("refuses a descriptor on a non-producer Agent", () => {
    const admission = expectedSpawnEmissionCapability(
      item("code-implementer-agent", emissionTask("code-implementer-agent", REVIEWER_V2)),
      issuedFor("code-implementer-agent", REVIEWER_V2),
    );
    expect(admission).toMatchObject({ ok: false });
    if (admission.ok) return;
    expect(admission.reason).toContain("no producer kind");
  });

  it("refuses when the descriptor does not bind the independently issued request named by the task", () => {
    const otherRequest = fixtureValue(parseRequestId("request:other-attempt"));
    const task = emissionTask("code-reviewer", REVIEWER_V2).replace(
      `LOOM_REQUEST_ID: ${REVIEWER_V2.requestId}`,
      `LOOM_REQUEST_ID: ${otherRequest}`,
    );
    const otherBinding = mustMint({
      requestId: otherRequest,
      kind: "reviewer-payload",
      version: "v2",
      schemaDigest: REVIEWER_V2.schemaDigest,
    });
    const admission = expectedSpawnEmissionCapability(item("code-reviewer", task), () => ({
      ok: true,
      value: { role: "code-reviewer", claim: {
        requestId: otherRequest,
        contextDigest: CONTEXT_DIGEST,
        producerKind: "reviewer-payload",
        version: "v2",
        schemaDigest: REVIEWER_V2.schemaDigest,
      }, route: emissionRouteFor(otherBinding) },
    }));
    expect(admission).toMatchObject({ ok: false, reason: expect.stringContaining("differs from the descriptor") });
  });

  it("refuses when the task carries no request identity marker at all", () => {
    const task = emissionTask("code-reviewer", REVIEWER_V2)
      .split("\n")
      .filter((line) => !line.startsWith("LOOM_REQUEST_ID:"))
      .join("\n");
    const admission = expectedSpawnEmissionCapability(item("code-reviewer", task));
    expect(admission).toMatchObject({ ok: false });
    if (admission.ok) return;
    expect(admission.reason).toContain("LOOM_REQUEST_ID marker is absent");
  });

  it("refuses when the descriptor does not bind the independently issued context named by the task", () => {
    const task = emissionTask("code-reviewer", REVIEWER_V2, CONTEXT_DIGEST).replace(
      `LOOM_CONTEXT_DIGEST: ${CONTEXT_DIGEST}`,
      `LOOM_CONTEXT_DIGEST: ${OTHER_CONTEXT.value}`,
    );
    const admission = expectedSpawnEmissionCapability(item("code-reviewer", task), () => ({
      ok: true,
      value: { role: "code-reviewer", claim: {
        requestId: REVIEWER_V2.requestId,
        contextDigest: OTHER_CONTEXT.value,
        producerKind: "reviewer-payload",
        version: "v2",
        schemaDigest: REVIEWER_V2.schemaDigest,
      }, route: emissionRouteFor(REVIEWER_V2, OTHER_CONTEXT.value) },
    }));
    expect(admission).toMatchObject({ ok: false, reason: expect.stringContaining("differs from the descriptor") });
  });

  it.each([
    ["request", `LOOM_REQUEST_ID: ${REVIEWER_V2.requestId}`, "LOOM_REQUEST_ID: request:contradiction"],
    ["context", `LOOM_CONTEXT_DIGEST: ${CONTEXT_DIGEST}`, `LOOM_CONTEXT_DIGEST: ${OTHER_CONTEXT.value}`],
  ])("refuses contradictory %s identity markers", (_label, marker, contradiction) => {
    const task = emissionTask("code-reviewer", REVIEWER_V2).replace(marker, `${marker}\n${contradiction}`);
    const admission = expectedSpawnEmissionCapability(item("code-reviewer", task));
    expect(admission).toMatchObject({ ok: false });
    if (!admission.ok) expect(admission.reason).toContain("is contradictory");
  });

  it("refuses a whitespace-bearing identity marker value as contradictory", () => {
    const marker = `LOOM_REQUEST_ID: ${REVIEWER_V2.requestId}`;
    const task = emissionTask("code-reviewer", REVIEWER_V2).replace(marker, `${marker} foreign`);
    const admission = expectedSpawnEmissionCapability(item("code-reviewer", task));
    expect(admission).toMatchObject({ ok: false });
    if (!admission.ok) expect(admission.reason).toContain("is contradictory");
  });

  it("refuses a malformed descriptor instead of defaulting to any tool", () => {
    const task = emissionTask("code-reviewer", REVIEWER_V2).replace(" v2 ", " v4 ");
    const admission = expectedSpawnEmissionCapability(
      item("code-reviewer", task),
      issuedFor("code-reviewer", REVIEWER_V2),
    );
    expect(admission).toMatchObject({ ok: false });
    if (admission.ok) return;
    expect(admission.reason).toContain("unusable issued emission descriptor");
    expect(admission.reason).toContain("unsupported-schema-version");
  });

  it("is total over arbitrary task text for every catalog Agent", () => {
    fc.assert(fc.property(fc.constantFrom<LoomAgentName>(...LOOM_OWNED_AGENTS), fc.string({ maxLength: 300 }), (agent, task) => {
      expect(() => expectedSpawnEmissionCapability({ agent, task })).not.toThrow();
    }));
  });
});

describe("admitPiSpawnBatch emission expectations", () => {
  it("carries each expectation and execution classification with the item it governs", () => {
    const admission = admitPiSpawnBatch(
      { tasks: [emissionItem("code-reviewer", REVIEWER_V2), item("code-simplifier")] },
      allowPorts({ readIssuedRequest: issuedFor("code-reviewer", REVIEWER_V2) }),
    );
    expect(admission.kind).toBe("admit");
    if (admission.kind !== "admit") return;
    expect(admission.itemAdmissions).toEqual([
      {
        item: emissionItem("code-reviewer", REVIEWER_V2),
        taskExecutionSpawn: admission.itemAdmissions[0]!.taskExecutionSpawn,
        emissionExpectation: {
          kind: "emission-enabled",
          binding: REVIEWER_V2,
          contextDigest: CONTEXT_DIGEST,
          route: {
            provider: "desktop-vllm",
            model: "glm-5.3-flash-spark-tp2-v14",
          },
        },
      },
      {
        item: item("code-simplifier"),
        taskExecutionSpawn: admission.itemAdmissions[1]!.taskExecutionSpawn,
        emissionExpectation: { kind: "no-emission-tool" },
      },
    ]);
  });

  it("blocks a batch on an unusable descriptor under the emission guard", () => {
    const broken = emissionTask("code-reviewer", REVIEWER_V2).replace(" v2 ", " v4 ");
    const admission = admitPiSpawnBatch(
      { agent: "code-reviewer", task: broken },
      allowPorts({ readIssuedRequest: issuedFor("code-reviewer", REVIEWER_V2) }),
    );
    expect(admission).toMatchObject({ kind: "block", guard: "expected-emission-capability" });
    if (admission.kind === "block") expect(admission.reason).toContain("unsupported-schema-version");
  });

  it("blocks a descriptor that mints authority the catalog withholds", () => {
    const admission = admitPiSpawnBatch(
      { agent: "code-implementer-agent", task: emissionTask("code-implementer-agent", REVIEWER_V2) },
      allowPorts({ readIssuedRequest: issuedFor("code-implementer-agent", REVIEWER_V2) }),
    );
    expect(admission).toMatchObject({ kind: "block", guard: "expected-emission-capability" });
  });

  it("composes the emission gate after the existing gates: a descriptor never bypasses the skill gate", () => {
    // code-simplifier declares the distill skill: the well-formed descriptor
    // does not excuse the missing skill marker — the earlier gate blocks first.
    const unmarked = emissionTask("code-simplifier", REVIEWER_V2)
      .split("\n")
      .filter((line) => !line.startsWith("LOOM_REQUIRED_SKILL:"))
      .join("\n");
    const admission = admitPiSpawnBatch({ agent: "code-simplifier", task: unmarked }, allowPorts());
    expect(admission).toMatchObject({ kind: "block", guard: "validate-agent-skill" });
  });

  it("keeps the interactive-transport gate ahead of the emission gate", () => {
    const admission = admitPiSpawnBatch(
      { agent: "specify-agent", task: emissionTask("specify-agent", REVIEWER_V2) },
      allowPorts(),
    );
    expect(admission).toMatchObject({ kind: "block", guard: "interactive-transport" });
  });

  it("blocks the whole batch when an issued emission-enabled item loses its descriptor", () => {
    let reads = 0;
    const admission = admitPiSpawnBatch(
      { tasks: [item("code-simplifier"), item("code-reviewer", issuedTask("code-reviewer", REVIEWER_V2))] },
      allowPorts({ readIssuedRequest: (...args) => {
        reads += 1;
        return issuedFor("code-reviewer", REVIEWER_V2)(...args);
      } }),
    );
    expect(reads).toBe(1);
    expect(admission).toMatchObject({
      kind: "block",
      guard: "expected-emission-capability",
      reason: expect.stringContaining("missing its required LOOM_EMISSION_DESCRIPTOR"),
    });
  });

  it("expects no emission tool for every item of a descriptor-free unbound batch (unchanged baseline)", () => {
    const admission = admitPiSpawnBatch({ tasks: [item("code-reviewer"), item("code-simplifier")] }, allowPorts());
    expect(admission.kind).toBe("admit");
    if (admission.kind !== "admit") return;
    expect(admission.itemAdmissions.map(({ emissionExpectation }) => emissionExpectation)).toEqual([
      { kind: "no-emission-tool" },
      { kind: "no-emission-tool" },
    ]);
  });
});

describe("request emission routes", () => {
  const extraction = notProvidedEmissionCapability("extraction-only surface", "extraction");
  const hardRefuse = notProvidedEmissionCapability("child revision does not carry the tool", "refuse");
  const issuedPiRoute = (provider: string, model: string) => Object.freeze({
    harnessBinding: Object.freeze({ pi: Object.freeze({ provider, model }) }),
  });

  it("closes issued claim typing and renders genuine v1/v2/v3 protocol paths", () => {
    type ClaimAuthority = Readonly<{
      requestId: RequestId;
      contextDigest: ContextDigest;
      producerKind: "reviewer-payload";
    }>;
    expectTypeOf<IssuedProducerClaim["requestId"]>().toEqualTypeOf<RequestId>();
    expectTypeOf<Extract<IssuedProducerClaim, { version: "v2" | "v3" }>["schemaDigest"]>()
      .toEqualTypeOf<ArtifactDigest>();
    expectTypeOf<ClaimAuthority & { version: "v2" }>().not.toMatchTypeOf<IssuedProducerClaim>();
    expectTypeOf<ClaimAuthority & { version: "v1"; schemaDigest: string }>()
      .not.toMatchTypeOf<IssuedProducerClaim>();

    const request = { requestId: REVIEWER_V2.requestId, contextDigest: CONTEXT_DIGEST };
    const archived = issuedReviewerPayloadClaim({ schemaVersion: 1 }, request);
    expect(archived).toEqual({
      requestId: request.requestId,
      contextDigest: CONTEXT_DIGEST,
      producerKind: "reviewer-payload",
      version: "v1",
    });
    expect("schemaDigest" in archived).toBe(false);
    const archivedRoute = decideRequestEmissionRoute(
      archived,
      providedEmissionCapability(REVIEWER_V2.schemaDigest),
    );
    expect(archivedRoute.kind).toBe("extraction-only");
    if (archivedRoute.kind !== "extraction-only") throw new Error("archived v1 fixture must be extraction-only");
    expect(projectEmissionTaskText(archivedRoute, "archived final-message instruction"))
      .toEqual({ descriptor: "", instruction: "archived final-message instruction", decision: archivedRoute });

    for (const { schemaVersion, binding } of [
      { schemaVersion: 2 as const, binding: REVIEWER_V2 },
      { schemaVersion: 3 as const, binding: REVIEWER_V3 },
    ]) {
      const current = issuedReviewerPayloadClaim(
        { schemaVersion, reviewerProtocol: { schemaDigest: binding.schemaDigest } },
        { requestId: binding.requestId, contextDigest: CONTEXT_DIGEST },
      );
      expect(current).toMatchObject({ version: binding.version, schemaDigest: binding.schemaDigest });
      const route = decideRequestEmissionRoute(current, providedEmissionCapability(binding.schemaDigest));
      expect(route.kind).toBe("emission");
      if (route.kind !== "emission") throw new Error(`reviewer ${binding.version} fixture must emit`);
      expect(projectEmissionTaskText(route, "current instruction").descriptor)
        .toBe(renderEmissionDescriptor(binding, CONTEXT_DIGEST));
    }
  });

  it("qualifies emission only from the frozen issued Pi binding and actual Pi-parent existence", () => {
    const claim = claimOf(REVIEWER_V2);
    const qualified = issuedPiRoute("desktop-vllm", "glm-5.3-flash-spark-tp2-v14");
    expect(qualifyIssuedSpawnEmissionRoute(claim, qualified, true)).toMatchObject({
      kind: "emission-enabled",
      binding: REVIEWER_V2,
      contextDigest: CONTEXT_DIGEST,
    });
    expect(qualifyIssuedSpawnEmissionRoute(claim, qualified, false)).toMatchObject({
      kind: "extraction-only",
      reason: expect.stringContaining("parent harness is not Pi"),
    });
  });

  it("carries only the exact qualified child route in enabled expectations", () => {
    const qualified = qualifyIssuedSpawnEmissionRoute(
      claimOf(REVIEWER_V2),
      issuedPiRoute("desktop-vllm", "glm-5.3-flash-spark-tp2-v14"),
      true,
    );
    expect(qualified.kind).toBe("emission-enabled");
    if (qualified.kind !== "emission-enabled") throw new Error("qualified fixture must enable emission");
    const enabledAdmission = expectedSpawnEmissionCapability(
      emissionItem("code-reviewer", REVIEWER_V2),
      issuedFor("code-reviewer", REVIEWER_V2, CONTEXT_DIGEST, qualified),
    );
    expect(enabledAdmission).toMatchObject({
      ok: true,
      expectation: {
        kind: "emission-enabled",
        route: {
          provider: "desktop-vllm",
          model: "glm-5.3-flash-spark-tp2-v14",
        },
      },
    });
    if (!enabledAdmission.ok || enabledAdmission.expectation.kind !== "emission-enabled") {
      throw new Error("qualified fixture must produce an enabled expectation");
    }
    expect(Object.isFrozen(enabledAdmission.expectation.route)).toBe(true);

    const extractionOnlyRequests = [
      ["swapped provider and model", "glm-5.3-flash-spark-tp2-v14", "desktop-vllm"],
      ["unqualified", "openai-codex", "gpt-5.6-sol"],
    ] as const;
    for (const [label, provider, model] of extractionOnlyRequests) {
      const route = qualifyIssuedSpawnEmissionRoute(claimOf(REVIEWER_V2), issuedPiRoute(provider, model), true);
      expect(route.kind, label).toBe("extraction-only");
      if (route.kind !== "extraction-only") throw new Error(`${label} fixture must remain extraction-only`);
      const admission = expectedSpawnEmissionCapability(
        item("code-reviewer", issuedTask("code-reviewer", REVIEWER_V2)),
        issuedFor("code-reviewer", REVIEWER_V2, CONTEXT_DIGEST, route),
      );
      expect(admission, label).toEqual({ ok: true, expectation: { kind: "no-emission-tool" } });
      if (admission.ok) expect("route" in admission.expectation, label).toBe(false);
    }
  });

  it("cannot upgrade an extraction-only issued profile when the mutable parent model changes", () => {
    const route = qualifyIssuedSpawnEmissionRoute(
      claimOf(REVIEWER_V2),
      issuedPiRoute("openai-codex", "gpt-5.6-sol"),
      true,
    );
    expect(route).toMatchObject({
      kind: "extraction-only",
      reason: expect.stringContaining("issued Pi route openai-codex/gpt-5.6-sol"),
    });
  });

  it("keeps a frozen cloud-issued extraction route no-tool when the ambient Pi parent model is qualified", () => {
    const previous = {
      codingAgent: process.env.PI_CODING_AGENT,
      provider: process.env.PI_PROVIDER,
      model: process.env.PI_MODEL,
    };
    process.env.PI_CODING_AGENT = "true";
    process.env.PI_PROVIDER = "desktop-vllm";
    process.env.PI_MODEL = "glm-5.3-flash-spark-tp2-v14";
    try {
      const route = qualifyIssuedSpawnEmissionRoute(
        claimOf(REVIEWER_V2),
        issuedPiRoute("openai-codex", "gpt-5.6-sol"),
        true,
      );
      if (route.kind !== "extraction-only") throw new Error("cloud-issued fixture must remain extraction-only");
      expect(expectedSpawnEmissionCapability(
        item("code-reviewer", issuedTask("code-reviewer", REVIEWER_V2)),
        issuedFor("code-reviewer", REVIEWER_V2, CONTEXT_DIGEST, route),
      )).toEqual({ ok: true, expectation: { kind: "no-emission-tool" } });
    } finally {
      if (previous.codingAgent === undefined) delete process.env.PI_CODING_AGENT;
      else process.env.PI_CODING_AGENT = previous.codingAgent;
      if (previous.provider === undefined) delete process.env.PI_PROVIDER;
      else process.env.PI_PROVIDER = previous.provider;
      if (previous.model === undefined) delete process.env.PI_MODEL;
      else process.env.PI_MODEL = previous.model;
    }
  });

  it("routes a certified issued contract on a provided surface to emission with the minted binding", () => {
    const route = decideRequestEmissionRoute(claimOf(REVIEWER_V2), providedEmissionCapability(REVIEWER_V2.schemaDigest));
    expect(route).toMatchObject({ kind: "emission" });
    if (route.kind !== "emission") return;
    expect(route.binding).toEqual(REVIEWER_V2);
    expect(route.binding.toolName).toBe("loom_emit_reviewer_payload");
    expect(route.contextDigest).toBe(CONTEXT_DIGEST);
  });

  it("hard-refuses a provided surface whose declared digest is not the issued cell's (US4 containment)", () => {
    const route = decideRequestEmissionRoute(claimOf(REVIEWER_V2), providedEmissionCapability(`${"e".repeat(64)}` as typeof REVIEWER_V2.schemaDigest));
    expect(route).toMatchObject({ kind: "refused" });
    if (route.kind !== "refused") return;
    expect(route.reason).toContain("stale loaded revision");
    expect(route.reason).toContain(REVIEWER_V2.schemaDigest);
  });

  it("routes a not-provided extraction surface to extraction-only with the surface's own reason", () => {
    const route = decideRequestEmissionRoute(claimOf(REVIEWER_V2), extraction);
    expect(route).toEqual({ kind: "extraction-only", reason: "extraction-only surface" });
  });

  it("hard-refuses a not-provided refuse surface (US4)", () => {
    const route = decideRequestEmissionRoute(claimOf(REVIEWER_V2), hardRefuse);
    expect(route).toMatchObject({ kind: "refused" });
    if (route.kind !== "refused") return;
    expect(route.reason).toContain("child revision does not carry the tool");
  });

  it("routes an archived v1 contract to extraction-only regardless of the surface (no schema rewrite)", () => {
    const v1: IssuedProducerClaim = Object.freeze({
      requestId: REVIEWER_V2.requestId,
      contextDigest: CONTEXT_DIGEST,
      producerKind: "reviewer-payload",
      version: "v1",
    });
    expect(decideRequestEmissionRoute(v1, providedEmissionCapability(REVIEWER_V2.schemaDigest)).kind).toBe("extraction-only");
    const reason = decideRequestEmissionRoute(v1, providedEmissionCapability(REVIEWER_V2.schemaDigest));
    if (reason.kind !== "extraction-only") return;
    expect(reason.reason).toContain("unsupported-schema-version");
    expect(decideRequestEmissionRoute(v1, extraction).kind).toBe("extraction-only");
  });

  it("routes a non-certifying issued digest to extraction-only, never to emission", () => {
    const nonCertifying: IssuedProducerClaim = Object.freeze({
      ...claimOf(REVIEWER_V2),
      version: "v3" as const,
      schemaDigest: REVIEWER_V2.schemaDigest,
    });
    const route = decideRequestEmissionRoute(nonCertifying, providedEmissionCapability(REVIEWER_V2.schemaDigest));
    expect(route).toMatchObject({ kind: "extraction-only" });
    if (route.kind !== "extraction-only") return;
    expect(route.reason).toContain("schema-digest-mismatch");
  });

  it("never routes a deliberately forged unsupported claim to emission for any capability arm", () => {
    fc.assert(fc.property(fc.constantFrom(...REGISTRY_CELLS), (binding) => {
      // Trust-boundary negative control: v4 is intentionally impossible in
      // IssuedProducerClaim, so the cast explicitly forges the bad runtime
      // input whose fail-closed behavior this test preserves.
      const unsupported = Object.freeze({
        requestId: binding.requestId,
        contextDigest: CONTEXT_DIGEST,
        producerKind: binding.kind.kind,
        version: "v4",
      }) as unknown as IssuedProducerClaim;
      const arms: readonly EmissionToolCapability[] = [
        providedEmissionCapability(binding.schemaDigest),
        extraction,
        hardRefuse,
      ];
      for (const capability of arms) {
        expect(decideRequestEmissionRoute(unsupported, capability).kind).toBe("extraction-only");
      }
    }));
  });

  it("projects the emission route: descriptor line plus tool-primary instruction after the base", () => {
    const base = "Read the immutable context packet at LOOM_CONTEXT_PATH and complete the exact Wave review request.";
    const route = decideRequestEmissionRoute(claimOf(REVIEWER_V2), providedEmissionCapability(REVIEWER_V2.schemaDigest));
    if (route.kind !== "emission") throw new Error("fixture route must be emission");
    const projected = projectEmissionTaskText(route, base);
    expect(projected.descriptor).toBe(renderEmissionDescriptor(REVIEWER_V2, CONTEXT_DIGEST));
    expect(projected.instruction).toBe(`${base}\n${emissionToolPrimaryInstruction(REVIEWER_V2)}`);
  });

  it("projects the extraction-only route: no descriptor and the caller's instruction verbatim (FR-020)", () => {
    const base = "Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required reviewer result.";
    const route = decideRequestEmissionRoute(claimOf(REVIEWER_V2), extraction);
    if (route.kind !== "extraction-only") throw new Error("fixture route must be extraction-only");
    expect(projectEmissionTaskText(route, base)).toEqual({ descriptor: "", instruction: base, decision: route });
  });

  it("projects an archived v1 route as extraction-only: the archived final-message contract is preserved verbatim (AS-012)", () => {
    const base = "Read the issued Context Packet FIRST. This is an issued schema-1 reviewer request.";
    const v1: IssuedProducerClaim = Object.freeze({
      requestId: REVIEWER_V2.requestId,
      contextDigest: CONTEXT_DIGEST,
      producerKind: "reviewer-payload",
      version: "v1",
    });
    const route = decideRequestEmissionRoute(v1, providedEmissionCapability(REVIEWER_V2.schemaDigest));
    if (route.kind !== "extraction-only") throw new Error("fixture route must be extraction-only");
    expect(projectEmissionTaskText(route, base)).toEqual({ descriptor: "", instruction: base, decision: route });
  });

  it("projects explicit v2/v3 capability simulations through the issued core route without a production render override", () => {
    const cases = [
      { schemaVersion: 2 as const, binding: REVIEWER_V2, instruction: "review current payload" },
      { schemaVersion: 3 as const, binding: REVIEWER_V3, instruction: "review successor payload" },
    ];

    for (const testCase of cases) {
      const claim = issuedReviewerPayloadClaim(
        { schemaVersion: testCase.schemaVersion, reviewerProtocol: { schemaDigest: testCase.binding.schemaDigest } },
        { requestId: testCase.binding.requestId, contextDigest: CONTEXT_DIGEST },
      );
      expect(claim.version).toBe(testCase.binding.version);

      const issuedRoute = decideIssuedSpawnEmissionRoute(
        claim,
        providedEmissionCapability(testCase.binding.schemaDigest),
      );
      if (issuedRoute.kind !== "emission-enabled") {
        throw new Error(`reviewer ${claim.version} fixture route must be emission-enabled`);
      }
      const projection = projectEmissionTaskText(
        { kind: "emission", binding: issuedRoute.binding, contextDigest: issuedRoute.contextDigest },
        testCase.instruction,
      );
      expect(projection.descriptor).toBe(renderEmissionDescriptor(testCase.binding, CONTEXT_DIGEST));
      expect(parseEmissionDescriptor(projection.descriptor)).toEqual({
        kind: "issued",
        binding: testCase.binding,
        contextDigest: CONTEXT_DIGEST,
      });
      expect(projection.instruction).toContain(`calling the exact tool ${testCase.binding.toolName} exactly once`);

      const refused = decideIssuedSpawnEmissionRoute(
        claim,
        providedEmissionCapability("e".repeat(64) as typeof testCase.binding.schemaDigest),
      );
      expect(refused).toMatchObject({ kind: "refused", reason: expect.stringContaining("stale loaded revision") });
    }
  });

  it("renders route-aware retry final actions for both standalone and Wave requests", () => {
    const emission = emissionTask("code-reviewer", REVIEWER_V2);
    const standaloneEmission = standaloneRetryTask(emission, "bad payload", { schemaVersion: 2 });
    expect(standaloneEmission).toContain(`calling the exact tool ${REVIEWER_V2.toolName} exactly once`);
    expect(standaloneEmission).toContain("fresh one-call budget");
    expect(standaloneEmission.endsWith(REVIEWER_EXTRACTION_RETRY_INSTRUCTION)).toBe(false);

    const waveDiagnostic = `retry reason\n\n${REVIEWER_EXTRACTION_RETRY_INSTRUCTION}`;
    const waveEmission = renderCurrentWaveRetryTask(emission, waveDiagnostic);
    expect(waveEmission).toContain(`calling the exact tool ${REVIEWER_V2.toolName} exactly once`);
    expect(waveEmission.endsWith(REVIEWER_EXTRACTION_RETRY_INSTRUCTION)).toBe(false);

    const extractionTask = issuedTask("code-reviewer", REVIEWER_V2);
    expect(standaloneRetryTask(extractionTask, null, { schemaVersion: 2 }))
      .toContain(`This is your final attempt. ${REVIEWER_EXTRACTION_RETRY_INSTRUCTION}`);
    expect(renderCurrentWaveRetryTask(extractionTask, waveDiagnostic)).toBe(`${extractionTask}\n${waveDiagnostic}`);
  });

  it("the tool-primary instruction names the exact tool, the one-call rule, and the extraction fallback", () => {
    for (const binding of REGISTRY_CELLS) {
      const instruction = emissionToolPrimaryInstruction(binding);
      const mentions = instruction.split(binding.toolName).length - 1;
      expect(mentions).toBeGreaterThanOrEqual(2);
      expect(instruction).toContain("exactly once");
      expect(instruction).toContain("a second time");
      expect(instruction).toContain("fall back to the final message");
      // The extraction-only admission prose stays out of the tool-primary arm:
      // the pinned standalone/wave suites assert current v2 tasks never carry it.
      expect(instruction).not.toContain("Machine Summary");
    }
  });
});

describe("renderSpawnTask emission projection wiring", () => {
  /** The confined fake: for requests outside the reviewer emission gate the
   *  render reads only `runDirectory` — the reviewer compatibility bootstrap
   *  and the panel view short-circuit empty before any other port. */
  const ineligibleHandle = { runDirectory: "/run/probe" } as unknown as RunDirHandle;
  const panelAuthority = (() => {
    const parsed = parseAgentRequestAuthority({
      runId: "run-probe",
      requestId: "request:probe-1",
      slotId: "slot-probe-1",
      program: "refutation-panel",
      role: "arch-judge-agent",
      attempt: 1,
      modelProfile: "panel-judge",
      harnessBinding: {
        pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
        claude: { harness: "claude-code", model: "opus" },
      },
      requiredSkill: null,
      contextDigest: CONTEXT_DIGEST,
      outputSlot: "transcripts/slot-probe-1/attempt-1.raw",
    });
    if (!parsed.ok) throw new Error(`fixture authority refused: ${parsed.error.violations.map(({ message }) => message).join("; ")}`);
    return parsed.value;
  })();

  it("renders no descriptor and the instruction verbatim outside the reviewer emission gate (FR-001/FR-020)", () => {
    const instruction = "Complete the exact pending panel request.";
    const task = renderSpawnTask(ineligibleHandle, panelAuthority, instruction);
    expect(task).toBe(
      `LOOM_REQUEST_ID: ${panelAuthority.requestId}\n` +
      `LOOM_CONTEXT_DIGEST: ${CONTEXT_DIGEST}\n` +
      `LOOM_CONTEXT_PATH: /run/probe/contexts/${CONTEXT_DIGEST}.json\n` +
      instruction,
    );
    expect(task).not.toContain(EMISSION_DESCRIPTOR_MARKER);
  });
});

describe("refutation transcript read decision (T6 remediation)", () => {
  it("keeps a captured transcript read failure as blocking infrastructure failure", () => {
    expect(decideRefutationTranscriptRead(
      { ok: false, error: { message: "captured transcript is unreadable" } },
      undefined,
    )).toEqual({ kind: "infrastructure-failure", message: "captured transcript is unreadable" });
  });

  it("turns only an explicit capture-rejection tombstone into semantic rejection", () => {
    expect(decideRefutationTranscriptRead(
      { ok: false, error: { message: "no transcript bytes exist" } },
      "capture runtime terminally rejected this attempt",
    )).toEqual({
      kind: "capture-rejection",
      diagnostic: "capture runtime terminally rejected this attempt",
    });
  });

  it("parses successfully read transcript bytes for verdict submission", () => {
    expect(decideRefutationTranscriptRead(
      { ok: true, value: new TextEncoder().encode('{"verdict":"upheld"}') },
      undefined,
    )).toEqual({ kind: "verdict", transcript: '{"verdict":"upheld"}' });
  });
});

// ---------------------------------------------------------------------------
// Program-path emission authority wiring (T6): the request programs supply the
// issued descriptor eligibility through the render seam, joined against the
// durable registration (AD-7, FR-012).
// ---------------------------------------------------------------------------

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import { CURRENT_REVIEWER_PROTOCOL } from "../../src/core/reviewer-contract";
import { STANDALONE_REVIEWER_PROTOCOL_V3 } from "../../src/core/standalone-lineage-contract";
import { evaluateTaskProof } from "../../src/core/proof-obligations";
import {
  lowerModelProfile,
  resolveAgentPolicy,
  resolveModelProfile,
} from "../../src/core/model-profiles";
import {
  parseRegisteredFacadeProgram,
  type RegisteredStandaloneProgram,
  type RegisteredWaveGateProgram,
} from "../../src/handlers/helpers/programs/helpers";
import { createRunDirectory, openRunDirectory } from "../../src/orchestration/run-directory-handle";
import { parseTaskGraph } from "../../src/state-manager";
import { RUN_DIR_ENV, RUNS_ROOT_ENV } from "../../src/orchestration/harness-capture-runtime";
import { fixturePiEnvironment } from "../fixtures/pi-session";
import { graphFixture, taskFixture } from "../fixtures/task-lifecycle";
import type { TaskGraph } from "../../src/types";
import type { AgentRequestAuthority } from "../../src/core/orchestration-contract";

/** Fixture unwrapping: a refused parse is a fixture bug, thrown loudly. */
function fixtureValue<T, E>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: E }>): T {
  if (!result.ok) throw new Error(`fixture refused: ${JSON.stringify(result.error)}`);
  return result.value;
}

const mustAuthority = (raw: unknown): AgentRequestAuthority => {
  const parsed = parseAgentRequestAuthority(raw);
  if (!parsed.ok) throw new Error(`fixture authority refused: ${parsed.error.violations.map(({ message }) => message).join("; ")}`);
  return parsed.value;
};

/** One eligible reviewer request authority per review program, with the
 *  catalog's real (profile, harness binding) pair for its role. */
const reviewerAuthority = (
  program: "standalone-review" | "wave-gate",
  requestId: string,
  contextDigest: ContextDigest = CONTEXT_DIGEST,
) => {
  const policy = fixtureValue(resolveAgentPolicy("code-reviewer"));
  const profile = fixtureValue(resolveModelProfile(policy.profile));
  return mustAuthority({
    runId: "run.wiring", requestId, slotId: `slot:${requestId}`,
    program, role: "code-reviewer", attempt: 1, modelProfile: policy.profile,
    harnessBinding: { pi: lowerModelProfile(profile, "pi"), claude: lowerModelProfile(profile, "claude-code") },
    requiredSkill: policy.requiredSkill, contextDigest,
    outputSlot: `transcripts/slot:${requestId}/attempt-1.raw`,
  });
};

/** The current wave-gate registration shape, exactly as startWaveGateFacade
 *  freezes it — the program-path emission authority the wave program holds. */
const waveV2Registration: RegisteredWaveGateProgram = Object.freeze({
  schemaVersion: 2,
  reviewerProtocol: CURRENT_REVIEWER_PROTOCOL,
  kind: "wave-gate",
  input: Object.freeze({ wave: 1 }),
  taskIds: Object.freeze(["T1"]),
  authorityDigest: "a".repeat(64),
});

/** A standalone v2 registration for the program-binding refusal arm. */
const standaloneV2Registration: RegisteredStandaloneProgram = Object.freeze({
  schemaVersion: 2,
  reviewerProtocol: CURRENT_REVIEWER_PROTOCOL,
  kind: "standalone-review",
  input: Object.freeze({ kind: "all", files: null, dryRun: false }),
  authority: Object.freeze({}),
});

const successorSource = fixtureValue(encodeByteSection(
  "standalone-frozen-source",
  JSON.stringify({ kind: "successor-v3-render-fixture" }),
));
const standaloneV3RegistrationWire = Object.freeze({
  schemaVersion: 3,
  reviewerProtocol: STANDALONE_REVIEWER_PROTOCOL_V3,
  kind: "standalone-review",
  input: Object.freeze({
    schemaVersion: 3,
    kind: "all",
    files: Object.freeze(["src/x.ts"]),
    dryRun: false,
    successor: Object.freeze({
      source: Object.freeze({ locator: "/owned/source", runId: "source", resultDigest: "a".repeat(64) }),
      disposition: Object.freeze({ kind: "historical-decision-unavailable" as const }),
    }),
  }),
  authority: Object.freeze({}),
  currentSource: Object.freeze({
    label: successorSource.label,
    bytes: Object.freeze([...successorSource.bytes]),
    digest: successorSource.digest,
    byteLength: successorSource.byteLength,
  }),
  previousContexts: Object.freeze([]),
});
const standaloneV3Registration: RegisteredStandaloneProgram = (() => {
  const parsed = parseRegisteredFacadeProgram(standaloneV3RegistrationWire);
  if (parsed.kind !== "registered" || parsed.program.kind !== "standalone-review" || parsed.program.schemaVersion !== 3) {
    throw new Error("fixture standalone-review v3 registration unavailable");
  }
  return parsed.program;
})();

/** A parseable archived wave-gate v1 registration record (no issued emission
 *  schema): the durable side of the protocol-divergence refusal arm. */
const waveV1StoredRegistration = Object.freeze({
  schemaVersion: 1,
  kind: "wave-gate",
  input: Object.freeze({ wave: 1 }),
  taskIds: Object.freeze(["T1"]),
  authorityDigest: "legacy-digest",
});

const storedRegistrationHandle = (value: unknown): RunDirHandle =>
  ({ runDirectory: "/run/probe", readProgramRegistration: () => ({ ok: true as const, value }) }) as unknown as RunDirHandle;
/** An eligible render with an unreadable registration storage refuses with
 *  the exact bootstrap refusal; the run directory only feeds the path markers. */
const unavailableStorageHandle = Object.freeze({
  runDirectory: "/run/probe",
  readProgramRegistration: () => ({ ok: false as const, error: { message: "program registration storage is unavailable" } }),
}) as unknown as RunDirHandle;
/** Renders whose gate refuses before any read only need the path marker root. */
const portlessHandle = Object.freeze({ runDirectory: "/run/probe" }) as unknown as RunDirHandle;

/** The render throws are bounded (Error with a message), never silent. */
const mustThrow = (render: () => string): string => {
  try {
    render();
  } catch (error) {
    if (!(error instanceof Error)) throw new Error(`render refused with a non-Error: ${String(error)}`);
    return error.message;
  }
  throw new Error("render was expected to fail closed but returned a task");
};

describe("program-path emission authority join (T6)", () => {
  const instruction = "Read the immutable context packet at LOOM_CONTEXT_PATH and complete the exact Wave review request.";
  const waveReviewer = reviewerAuthority("wave-gate", "request:wave-wiring-1");
  const standaloneReviewer = reviewerAuthority("standalone-review", "request:standalone-wiring-1");

  it("refuses a supplied authority naming another program before any registration read (AD-7)", () => {
    const standaloneMessage = mustThrow(() =>
      renderReviewProgramSpawnTask(portlessHandle, standaloneReviewer, instruction, waveV2Registration));
    expect(standaloneMessage).toContain("not the request's standalone-review program");
    expect(standaloneMessage).toContain("a descriptor binds only its own program's issued contract");
    const waveMessage = mustThrow(() =>
      renderReviewProgramSpawnTask(portlessHandle, waveReviewer, instruction, standaloneV2Registration));
    expect(waveMessage).toContain("not the request's wave-gate program");
  });

  it("refuses a supplied authority whose issued protocol diverges from the durable registration (FR-012)", () => {
    const message = mustThrow(() =>
      renderReviewProgramSpawnTask(
        storedRegistrationHandle(waveV1StoredRegistration), waveReviewer, instruction, waveV2Registration,
      ));
    expect(message).toContain("schema version 2 with issued digest");
    expect(message).toContain("not the durable registration's the archived schema-1 contract");
    expect(message).toContain("a descriptor names only the joined issued contract");
  });

  it("keeps the durable-only fallback and its exact bootstrap refusal when no authority is supplied", () => {
    const message = mustThrow(() => renderSpawnTask(unavailableStorageHandle, waveReviewer, instruction));
    expect(message).toBe("reviewer bootstrap registration is unavailable: program registration storage is unavailable");
  });

  it("ignores a supplied authority on an ineligible render: extraction-only requests advertise no tool (FR-001)", () => {
    const panelJudge = mustAuthority({
      runId: "run.wiring", requestId: "request:panel-wiring-1", slotId: "slot:panel-wiring-1",
      program: "refutation-panel", role: "arch-judge-agent", attempt: 1, modelProfile: "panel-judge",
      harnessBinding: {
        pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
        claude: { harness: "claude-code", model: "opus" },
      },
      requiredSkill: null, contextDigest: CONTEXT_DIGEST,
      outputSlot: "transcripts/slot:panel-wiring-1/attempt-1.raw",
    });
    const task = renderReviewProgramSpawnTask(portlessHandle, panelJudge, instruction, waveV2Registration);
    expect(task).not.toContain(EMISSION_DESCRIPTOR_MARKER);
    expect(task.endsWith(instruction)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real facade CLI starts exercise both cloud extraction and an exactly
// qualified local parent issuing a tool-primary reviewer route.
// ---------------------------------------------------------------------------

const waveCliRoots: string[] = [];
afterEach(() => { for (const root of waveCliRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const waveCli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

const waveSpecText = `# Feature: Wave fixture

## User Scenarios

### US1: [P1] Review a Wave

**Acceptance Scenarios:**
- AS-001: Given evidence, When accepted, Then the Wave progresses

## Functional Requirements

- FR-001: System MUST review the exact Wave

## Out of Scope

- OOS-001: Unrelated work

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Wave evidence | Exact issued evidence |
`;

function waveEmissionProject(): { root: string; runsRoot: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loom-t6-wave-wiring-")));
  waveCliRoots.push(root);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "runs"));
  mkdirSync(join(root, ".claude", "state"), { recursive: true });
  writeFileSync(join(root, "src", "x.ts"), "export const x = 1;\n");
  writeFileSync(join(root, "spec.md"), waveSpecText);
  writeFileSync(join(root, "plan.md"), "# Model-free plan\n");
  const git = (args: readonly string[]): void => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`fixture git ${args.join(" ")} failed: ${result.stderr}`);
  };
  git(["init", "-q"]);
  git(["add", "src/x.ts", "spec.md", "plan.md"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"]);
  const proof = evaluateTaskProof(
    { newTestsRequired: true, declaredArtifacts: ["src/x.ts"] },
    { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: ["src/x.ts"], newTestsWritten: true },
  );
  if (proof.state !== "satisfied") throw new Error("fixture requires actual satisfied proof construction");
  const graph: TaskGraph = {
    ...graphFixture([taskFixture({
      id: "T1", description: "review fixture", agent: "code-implementer-agent", wave: 1,
      depends_on: [], status: "implemented", proof, file_list: ["src/x.ts"], files_modified: ["src/x.ts"],
      spec_anchors: ["FR-001", "AS-001"], spec_contributions: [], test_result: { verdict: "trusted-pass" },
      test_evidence: "fixture checks passed", new_tests_written: true, new_test_evidence: "fixture tests present",
      review_generation: 0, review_status: "pending", findings: [],
      critical_findings: [], advisory_findings: [],
    })]),
    spec_file: join(root, "spec.md"), plan_file: join(root, "plan.md"), spec_trace_version: 2,
  };
  const parsedGraph = parseTaskGraph(graph);
  if (!parsedGraph.ok) throw new Error(`fixture task graph refused: ${parsedGraph.error}`);
  writeFileSync(join(root, ".claude", "state", "active_task_graph.json"), JSON.stringify(parsedGraph.value));
  return { root, runsRoot: join(root, "runs") };
}

function standaloneEmissionProject(): { root: string; runsRoot: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loom-t6-standalone-wiring-")));
  waveCliRoots.push(root);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "runs"));
  writeFileSync(join(root, "src", "x.ts"), "export const x = 1;\n");
  const git = (args: readonly string[]): void => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`fixture git ${args.join(" ")} failed: ${result.stderr}`);
  };
  git(["init", "-q"]);
  git(["add", "src/x.ts"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"]);
  return { root, runsRoot: join(root, "runs") };
}

const CHANGED_PARENT_ROUTE_ENV = Object.freeze({
  PI_PROVIDER: "desktop-vllm",
  PI_MODEL: "glm-5.3-flash-spark-tp2-v14",
  PI_REASONING_LEVEL: "medium",
});
const QUALIFIED_PARENT_ROUTE_ENV = Object.freeze({
  ...CHANGED_PARENT_ROUTE_ENV,
  PI_REASONING_LEVEL: "high",
});

const startFacadeProgram = (
  project: Readonly<{ root: string; runsRoot: string }>,
  program: "wave-gate" | "standalone-review",
  runId: string,
  input: unknown,
  environment: Readonly<Record<string, string>> = CHANGED_PARENT_ROUTE_ENV,
): Promise<Readonly<{ status: number | null; stdout: string; stderr: string }>> =>
  new Promise((resolve, reject) => {
    const child = spawn("bun", [waveCli, "helper", "orchestration", "start", program,
      "--runs-root", project.runsRoot, "--run", runId],
      { cwd: project.root, env: { ...fixturePiEnvironment(project.root), ...environment } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });

describe("the wave-gate program path projects the frozen issued route (T6)", () => {
  it("keeps frozen cloud Pi bindings extraction-only and renders supplied registration byte-identically to durable fallback", async () => {
    const project = waveEmissionProject();
    const started = await startFacadeProgram(project, "wave-gate", "run.wiring", { wave: 1 });
    expect(started.status, started.stderr).toBe(0);
    const action = JSON.parse(started.stdout) as {
      kind: string;
      requests?: readonly Readonly<{ authority: AgentRequestAuthority; task: string }>[];
    };
    expect(action.kind).toBe("spawn-batch");
    const requests = action.requests ?? [];
    expect(requests.length).toBeGreaterThan(1);
    const specCheck = requests.find(({ authority }) => authority.role === "spec-check-invoker");
    expect(specCheck).toBeDefined();
    // FR-001: the non-producer spec-check request advertises no emission tool.
    expect(specCheck!.task).not.toContain(EMISSION_DESCRIPTOR_MARKER);
    const reviewers = requests.filter(({ authority }) => authority.role !== "spec-check-invoker");
    expect(reviewers.length).toBeGreaterThan(0);
    expect(started.stderr).toContain("issued Pi route openai-codex/gpt-5.6-sol");
    for (const { task } of reviewers) {
      expect(task).not.toContain(EMISSION_DESCRIPTOR_MARKER);
      expect(task).not.toContain("calling the exact tool loom_emit_reviewer_payload");
      // The delivery joins are retained regardless of emission-tool availability (FR-012).
      expect(task).toContain("LOOM_CONTEXT_READ_COMMAND: ");
      expect(task).toContain("Read the issued Context Packet FIRST; its frozen schema and rubric govern your final output.");
    }

    // The explicit program-path supply renders byte-identically to the
    // durable fallback: the join admits a structurally equal REBUILT
    // registration (not merely the same object) and the claim it sources is
    // the one the durable read produces.
    const opened = openRunDirectory(project.runsRoot, "run.wiring");
    if (!opened.ok) throw new Error(opened.error.message);
    const stored = opened.value.readProgramRegistration();
    if (!stored.ok) throw new Error(stored.error.message);
    const parsed = parseRegisteredFacadeProgram(stored.value);
    if (parsed.kind !== "registered" || parsed.program.kind !== "wave-gate") {
      throw new Error("fixture wave-gate registration unavailable");
    }
    const reviewer = reviewers[0]!;
    const waveAuthority = mustAuthority(reviewer.authority);
    const suppliedRegistration: RegisteredWaveGateProgram = Object.freeze({
      schemaVersion: 2,
      reviewerProtocol: CURRENT_REVIEWER_PROTOCOL,
      kind: "wave-gate",
      input: Object.freeze({ wave: parsed.program.input.wave }),
      taskIds: parsed.program.taskIds,
      authorityDigest: parsed.program.authorityDigest,
    });
    const instruction = "Read the immutable context packet at LOOM_CONTEXT_PATH and complete the exact Wave review request.";
    const supplied = renderReviewProgramSpawnTask(
      opened.value,
      waveAuthority,
      instruction,
      suppliedRegistration,
    );
    const fallback = renderSpawnTask(opened.value, waveAuthority, instruction);
    expect(supplied).toBe(fallback);
    expect(supplied).not.toContain(EMISSION_DESCRIPTOR_MARKER);
    expect(supplied).not.toContain("calling the exact tool loom_emit_reviewer_payload");
  }, 60_000);

  it("keeps an unqualified Pi route explicitly extraction-only and logs the retained reason without changing the base instruction", async () => {
    const project = waveEmissionProject();
    const started = await startFacadeProgram(
      project,
      "wave-gate",
      "run.unqualified-route",
      { wave: 1 },
      { PI_PROVIDER: "openai-codex", PI_MODEL: "gpt-5.6-sol" },
    );
    expect(started.status, started.stderr).toBe(0);
    expect(started.stderr).toContain('"event":"loom-emission-route"');
    expect(started.stderr).toContain('"kind":"extraction-only"');
    expect(started.stderr).toContain("is not the explicitly trusted qualified route");
    const action = JSON.parse(started.stdout) as {
      requests?: readonly Readonly<{ authority: AgentRequestAuthority; task: string }>[];
    };
    const reviewers = (action.requests ?? []).filter(({ authority }) => authority.role !== "spec-check-invoker");
    expect(reviewers.length).toBeGreaterThan(0);
    for (const { task } of reviewers) {
      expect(task).not.toContain(EMISSION_DESCRIPTOR_MARKER);
      expect(task).not.toContain("calling the exact tool loom_emit_reviewer_payload");
      expect(task).toContain("Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required reviewer result.");
    }
  }, 60_000);
});

describe("positive program-path issuance through the qualified local Pi parent (T6)", () => {
  it("issues a Wave v2 descriptor and tool-primary instruction only for authenticated reviewer slots", async () => {
    const project = waveEmissionProject();
    const started = await startFacadeProgram(project, "wave-gate", "run.local-wave", { wave: 1 }, QUALIFIED_PARENT_ROUTE_ENV);
    expect(started.status, started.stderr).toBe(0);
    const action = JSON.parse(started.stdout) as {
      kind: string;
      requests?: readonly Readonly<{ authority: AgentRequestAuthority; task: string }>[];
    };
    expect(action.kind).toBe("spawn-batch");
    const requests = action.requests ?? [];
    expect(requests).toHaveLength(6);
    const specCheck = requests.find(({ authority }) => authority.role === "spec-check-invoker");
    expect(specCheck?.authority.modelProfile).toBe("general-review");
    expect(specCheck?.task).not.toContain(EMISSION_DESCRIPTOR_MARKER);
    const { readPiIssuedSpawnRequest } = await import("../../../pi/extension");
    const previous = { root: process.env[RUNS_ROOT_ENV], run: process.env[RUN_DIR_ENV] };
    try {
      process.env[RUNS_ROOT_ENV] = project.runsRoot;
      process.env[RUN_DIR_ENV] = join(project.runsRoot, "run.local-wave");
      for (const { authority, task } of requests.filter(({ authority }) => authority.role !== "spec-check-invoker")) {
        expect(authority.modelProfile).toBe("qualified-local-review");
        expect(authority.harnessBinding.pi).toMatchObject({ provider: "desktop-vllm", model: "glm-5.3-flash-spark-tp2-v14", thinking: "high" });
        const descriptor = parseEmissionDescriptor(task);
        expect(descriptor.kind).toBe("issued");
        if (descriptor.kind !== "issued") continue;
        expect(descriptor.contextDigest).toBe(authority.contextDigest);
        expect(descriptor.binding.requestId).toBe(authority.requestId);
        expect(task).toContain("calling the exact tool loom_emit_reviewer_payload exactly once");
        expect(readPiIssuedSpawnRequest("019fca39-f989-7510-8e62-50dadbcad4ff", authority.requestId, authority.contextDigest, authority.role))
          .toMatchObject({ ok: true, value: { route: { kind: "emission-enabled" } } });
      }
    } finally {
      if (previous.root === undefined) delete process.env[RUNS_ROOT_ENV]; else process.env[RUNS_ROOT_ENV] = previous.root;
      if (previous.run === undefined) delete process.env[RUN_DIR_ENV]; else process.env[RUN_DIR_ENV] = previous.run;
    }
  }, 60_000);

  it("issues standalone v2 with the exact tool descriptor under the same parent route", async () => {
    const project = standaloneEmissionProject();
    const started = await startFacadeProgram(project, "standalone-review", "run.local-standalone",
      { kind: "all", files: ["src/x.ts"], dryRun: false }, QUALIFIED_PARENT_ROUTE_ENV);
    expect(started.status, started.stderr).toBe(0);
    const action = JSON.parse(started.stdout) as {
      kind: string;
      requests?: readonly Readonly<{ authority: AgentRequestAuthority; task: string }>[];
    };
    expect(action.kind).toBe("spawn-batch");
    expect(action.requests?.length).toBeGreaterThan(0);
    for (const { authority, task } of action.requests ?? []) {
      expect(authority.modelProfile).toBe("qualified-local-review");
      expect(parseEmissionDescriptor(task)).toMatchObject({
        kind: "issued", contextDigest: authority.contextDigest,
        binding: { requestId: authority.requestId, version: "v2" },
      });
      expect(task).toContain("calling the exact tool loom_emit_reviewer_payload exactly once");
    }
  }, 60_000);
});

describe("the Pi issuance read behind the spawn admission port (T6)", () => {
  it("proves the reserved publication and program protocol independently of task markers", async () => {
    const project = waveEmissionProject();
    const started = await startFacadeProgram(project, "wave-gate", "run.issued-port", { wave: 1 });
    expect(started.status, started.stderr).toBe(0);
    const action = JSON.parse(started.stdout) as {
      requests?: readonly Readonly<{ authority: AgentRequestAuthority; task: string }>[];
    };
    const reviewer = action.requests?.find(({ authority }) => authority.role === "code-reviewer");
    if (reviewer === undefined) throw new Error("fixture did not publish a reviewer request");
    const authority = mustAuthority(reviewer.authority);
    const { readPiIssuedSpawnRequest } = await import("../../../pi/extension");
    const beforeRoot = process.env[RUNS_ROOT_ENV];
    const beforeRun = process.env[RUN_DIR_ENV];
    try {
      process.env[RUNS_ROOT_ENV] = project.runsRoot;
      process.env[RUN_DIR_ENV] = join(project.runsRoot, "run.issued-port");
      const issued = readPiIssuedSpawnRequest("019fca39-f989-7510-8e62-50dadbcad4ff", authority.requestId, authority.contextDigest, authority.role);
      expect(issued).toMatchObject({ ok: true, value: {
        role: "code-reviewer",
        claim: {
          requestId: authority.requestId, contextDigest: authority.contextDigest,
          producerKind: "reviewer-payload", version: "v2",
          schemaDigest: CURRENT_REVIEWER_PROTOCOL.schemaDigest,
        },
      } });
      expect(readPiIssuedSpawnRequest("019fca39-f989-7510-8e62-50dadbcad4ff", REVIEWER_V2.requestId, authority.contextDigest, authority.role).ok).toBe(false);
      expect(readPiIssuedSpawnRequest("019fca39-f989-7510-8e62-50dadbcad4ff", authority.requestId, OTHER_CONTEXT.value, authority.role).ok).toBe(false);
      expect(readPiIssuedSpawnRequest("019fca39-f989-7510-8e62-50dadbcad4ff", authority.requestId, authority.contextDigest, "pr-test-analyzer").ok).toBe(false);
    } finally {
      if (beforeRoot === undefined) delete process.env[RUNS_ROOT_ENV];
      else process.env[RUNS_ROOT_ENV] = beforeRoot;
      if (beforeRun === undefined) delete process.env[RUN_DIR_ENV];
      else process.env[RUN_DIR_ENV] = beforeRun;
    }
  }, 60_000);
});

describe("the standalone successor v3 program path projects the issued route (T6)", () => {
  it("keeps the published cloud Pi binding extraction-only and renders supplied registration byte-identically to durable fallback", async () => {
    const project = standaloneEmissionProject();
    const created = createRunDirectory(project.runsRoot, "run.wiring");
    if (!created.ok) throw new Error(created.error.message);
    const handle = created.value;
    const registered = await handle.registerProgram(standaloneV3RegistrationWire);
    if (!registered.ok) throw new Error(registered.error.message);

    const requestId = fixtureValue(parseRequestId("request:standalone-successor-v3-wiring-1"));
    const packet = fixtureValue(buildStandaloneReviewerContextPacketV3({
      requestId,
      role: "code-reviewer",
      requiredSkill: "none",
      fixedContext: Object.freeze([]),
      variableContext: Object.freeze([]),
    }));
    const authority = reviewerAuthority("standalone-review", requestId, packet.digest);
    const request = Object.freeze({
      authority,
      context: Object.freeze({
        digest: packet.digest,
        slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${packet.digest}.json` }),
      }),
    });
    const published = await publishReviewInitialBatch(
      handle,
      Object.freeze([request]),
      Object.freeze([packet]),
      "standalone-successor-v3",
      standaloneV3Registration,
    );
    if (!published.ok) throw new Error(published.message);

    const instruction = "Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required reviewer result.";
    const supplied = renderReviewProgramSpawnTask(
      handle,
      authority,
      instruction,
      standaloneV3Registration,
      { standalone: true },
    );
    const fallback = renderSpawnTask(handle, authority, instruction, { standalone: true });

    expect(supplied).toBe(fallback);
    expect(supplied).not.toContain(EMISSION_DESCRIPTOR_MARKER);
    expect(supplied).not.toContain("calling the exact tool loom_emit_reviewer_payload");
  });

  it("renders a published qualified-local successor v3 reviewer descriptor from its issued binding", async () => {
    const project = standaloneEmissionProject();
    const created = createRunDirectory(project.runsRoot, "run.wiring");
    if (!created.ok) throw new Error(created.error.message);
    const handle = created.value;
    const registered = await handle.registerProgram(standaloneV3RegistrationWire);
    if (!registered.ok) throw new Error(registered.error.message);
    const requestId = fixtureValue(parseRequestId("request:standalone-successor-v3-qualified"));
    const packet = fixtureValue(buildStandaloneReviewerContextPacketV3({
      requestId, role: "code-reviewer", requiredSkill: "none",
      fixedContext: Object.freeze([]), variableContext: Object.freeze([]),
    }));
    const profile = fixtureValue(resolveModelProfile("qualified-local-review"));
    const authority = mustAuthority({
      ...reviewerAuthority("standalone-review", requestId, packet.digest),
      modelProfile: profile.id,
      harnessBinding: { pi: lowerModelProfile(profile, "pi"), claude: lowerModelProfile(profile, "claude-code") },
    });
    const previous = process.env.PI_CODING_AGENT;
    try {
      process.env.PI_CODING_AGENT = "true";
      const published = await publishReviewInitialBatch(handle, [{ authority, context: {
        digest: packet.digest, slot: { kind: "fixed-artifact-slot", path: `contexts/${packet.digest}.json` },
      } }], [packet], "standalone-successor-v3", standaloneV3Registration);
      if (!published.ok) throw new Error(published.message);
      const task = (published.action as { requests: readonly { task: string }[] }).requests[0]!.task;
      expect(parseEmissionDescriptor(task)).toMatchObject({
        kind: "issued", contextDigest: packet.digest,
        binding: { requestId, version: "v3", toolName: "loom_emit_reviewer_payload" },
      });
      expect(task).toContain("calling the exact tool loom_emit_reviewer_payload exactly once");
      expect(renderReviewProgramSpawnTask(handle, authority,
        "Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required reviewer result.",
        standaloneV3Registration, { standalone: true })).toBe(task);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT;
      else process.env.PI_CODING_AGENT = previous;
    }
  });
});

describe("the standalone-review v2 program path projects the issued route (T6)", () => {
  it("keeps production requests extraction-only and renders supplied registration byte-identically to durable fallback", async () => {
    const project = standaloneEmissionProject();
    const started = await startFacadeProgram(project, "standalone-review", "run.standalone-wiring",
      { kind: "all", files: ["src/x.ts"], dryRun: false });
    expect(started.status, started.stderr).toBe(0);
    const action = JSON.parse(started.stdout) as {
      kind: string;
      requests?: readonly Readonly<{ authority: AgentRequestAuthority; task: string }>[];
    };
    expect(action.kind).toBe("spawn-batch");
    const requests = action.requests ?? [];
    expect(requests.length).toBeGreaterThan(0);
    expect(started.stderr).toContain("issued Pi route openai-codex/gpt-5.6-sol");
    for (const { task } of requests) {
      expect(task).not.toContain(EMISSION_DESCRIPTOR_MARKER);
      expect(task).not.toContain("calling the exact tool loom_emit_reviewer_payload");
    }

    const opened = openRunDirectory(project.runsRoot, "run.standalone-wiring");
    if (!opened.ok) throw new Error(opened.error.message);
    const stored = opened.value.readProgramRegistration();
    if (!stored.ok) throw new Error(stored.error.message);
    const parsed = parseRegisteredFacadeProgram(stored.value);
    if (parsed.kind !== "registered" || parsed.program.kind !== "standalone-review" || parsed.program.schemaVersion !== 2) {
      throw new Error("fixture standalone-review v2 registration unavailable");
    }
    const registration = parsed.program;
    const reviewer = requests[0]!;
    const authority = mustAuthority(reviewer.authority);
    const instruction = "Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required reviewer result.";
    const supplied = renderReviewProgramSpawnTask(
      opened.value,
      authority,
      instruction,
      registration,
      { standalone: true },
    );
    const fallback = renderSpawnTask(opened.value, authority, instruction, { standalone: true });
    expect(supplied).toBe(fallback);
    expect(supplied).toBe(reviewer.task);
    expect(supplied).not.toContain(EMISSION_DESCRIPTOR_MARKER);
    expect(supplied).not.toContain("calling the exact tool loom_emit_reviewer_payload");
  }, 60_000);
});

describe("the legacy publication route fails closed against a current registration (T6)", () => {
  const runDirectoryFingerprint = (handle: RunDirHandle): readonly string[] =>
    readdirSync(handle.runDirectory, { recursive: true }).map((entry) => String(entry)).sort();

  /** A durable CURRENT standalone-review v2 registration, exactly as the real
   *  facade start freezes it; the eligible-refusal arm reads this registration. */
  const currentProgramRun = async (): Promise<RunDirHandle> => {
    const project = standaloneEmissionProject();
    const started = await startFacadeProgram(project, "standalone-review", "run.legacy-guard",
      { kind: "all", files: ["src/x.ts"], dryRun: false });
    expect(started.status, started.stderr).toBe(0);
    const opened = openRunDirectory(project.runsRoot, "run.legacy-guard");
    if (!opened.ok) throw new Error(opened.error.message);
    const stored = opened.value.readProgramRegistration();
    if (!stored.ok) throw new Error(stored.error.message);
    const parsed = parseRegisteredFacadeProgram(stored.value);
    if (parsed.kind !== "registered" || parsed.program.kind !== "standalone-review" || parsed.program.schemaVersion !== 2) {
      throw new Error("fixture standalone-review v2 registration unavailable");
    }
    return opened.value;
  };

  const legacyRouteAuthority = (requestId: RequestId, contextDigest: ContextDigest, role: "code-reviewer" | "review-verifier-agent") => {
    if (role === "code-reviewer") {
      const policy = fixtureValue(resolveAgentPolicy("code-reviewer"));
      const profile = fixtureValue(resolveModelProfile(policy.profile));
      return mustAuthority({
        runId: "run.legacy-guard", requestId, slotId: `slot:${requestId}`,
        program: "standalone-review", role, attempt: 1, modelProfile: policy.profile,
        harnessBinding: { pi: lowerModelProfile(profile, "pi"), claude: lowerModelProfile(profile, "claude-code") },
        requiredSkill: policy.requiredSkill, contextDigest,
        outputSlot: `transcripts/slot:${requestId}/attempt-1.raw`,
      });
    }
    const policy = fixtureValue(resolveAgentPolicy("review-verifier-agent"));
    const profile = fixtureValue(resolveModelProfile(policy.profile));
    return mustAuthority({
      runId: "run.legacy-guard", requestId, slotId: `slot:${requestId}`,
      program: "refutation-panel", role, attempt: 1, modelProfile: policy.profile,
      harnessBinding: { pi: lowerModelProfile(profile, "pi"), claude: lowerModelProfile(profile, "claude-code") },
      requiredSkill: null, contextDigest,
      outputSlot: `transcripts/slot:${requestId}/attempt-1.raw`,
    });
  };

  it("refuses an emission-eligible reviewer request without writing any receipt or context", async () => {
    const handle = await currentProgramRun();
    const requestId = fixtureValue(parseRequestId("request:legacy-route-eligible-1"));
    const packet = fixtureValue(buildStandaloneReviewerContextPacketV3({
      requestId, role: "code-reviewer", requiredSkill: "none",
      fixedContext: Object.freeze([]), variableContext: Object.freeze([]),
    }));
    const authority = legacyRouteAuthority(requestId, packet.digest, "code-reviewer");
    const before = runDirectoryFingerprint(handle);
    const refused = await publishLegacyInitialBatch(
      handle,
      Object.freeze([{ authority, context: Object.freeze({
        digest: packet.digest, slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${packet.digest}.json` }),
      }) }]),
      Object.freeze([packet]),
      "standalone-review",
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("legacy route published an emission-eligible request");
    expect(refused.message).toContain("legacy publication route refused an emission-eligible request");
    expect(refused.message).toContain("schemaVersion 2");
    expect(runDirectoryFingerprint(handle)).toEqual(before);
  }, 60_000);

  it("still publishes a non-eligible review-verifier-agent refutation panel request on the legacy route", async () => {
    const handle = await currentProgramRun();
    const requestId = fixtureValue(parseRequestId("request:legacy-route-panel-1"));
    const note = fixtureValue(encodeByteSection("fixture-note", "panel retry context"));
    const packet = fixtureValue(buildContextPacket({
      requestId, role: "review-verifier-agent", requiredSkill: "none",
      outputContract: "refutation-verdict",
      fixedContext: Object.freeze([note]), variableContext: Object.freeze([]),
    }));
    const authority = legacyRouteAuthority(requestId, packet.digest, "review-verifier-agent");
    const published = await publishLegacyInitialBatch(
      handle,
      Object.freeze([{ authority, context: Object.freeze({
        digest: packet.digest, slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${packet.digest}.json` }),
      }) }]),
      Object.freeze([packet]),
      "standalone-review",
    );
    if (!published.ok) throw new Error(published.message);
    const task = (published.action as { requests: readonly { task: string }[] }).requests[0]!.task;
    expect(task).not.toContain(EMISSION_DESCRIPTOR_MARKER);
    expect(task).not.toContain("calling the exact tool loom_emit_reviewer_payload");
  }, 60_000);
});
