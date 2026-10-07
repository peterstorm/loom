/**
 * Spawn Admission is a pure decision exercised through in-memory ports: the
 * batch gate chain, its totality properties, and how the per-item emission
 * capability decision composes into it. The capability decision itself is
 * tested at its own seam in issued-emission-capability.test.ts.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  admitPiSpawnBatch,
  MAX_PI_ORCHESTRATION_BATCH_SIZE,
  type SpawnAdmissionPorts,
} from "../../src/core/spawn-admission";
import {
  agentRequiresInteractiveTransport,
  DESKTOP_VLLM_ROUTE,
  LOOM_OWNED_AGENTS,
  type LoomAgentName,
} from "../../src/core/model-profiles";
import { AGENT_REQUIRED_SKILLS } from "../../src/core/orchestration-contract";
import {
  CONTEXT_DIGEST,
  emissionItem,
  emissionTask,
  issuedFor,
  issuedTask,
  missingIssuedRequest,
  REGISTRY_CELLS,
  REVIEWER_V2,
  spawnItem,
} from "../fixtures/issued-emission";

const agentMarkdown = (agent: LoomAgentName): string => {
  const skill = AGENT_REQUIRED_SKILLS[agent];
  return `---\nname: ${agent}\n${skill === null ? "" : `skills:\n  - ${skill}\n`}---\nBody\n`;
};

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
    const tasks = Array.from({ length: MAX_PI_ORCHESTRATION_BATCH_SIZE + 1 }, () => spawnItem("code-reviewer"));
    const admission = admitPiSpawnBatch({ tasks }, allowPorts());
    expect(admission).toMatchObject({ kind: "block", guard: "batch-size" });
    if (admission.kind === "block") expect(admission.reason).toContain(String(MAX_PI_ORCHESTRATION_BATCH_SIZE));
  });

  it("routes every interactive phase role exclusively through the RPC transport", () => {
    for (const agent of ["specify-agent", "clarify-agent", "architecture-agent", "arch-interviewer-agent"] as const) {
      const task = spawnItem(agent);
      expect(admitPiSpawnBatch(task, allowPorts())).toMatchObject({
        kind: "block",
        guard: "interactive-transport",
      });
      expect(admitPiSpawnBatch(task, allowPorts({ transport: "interactive-rpc" })).kind).toBe("admit");
    }
  });

  it("refuses headless roles and batches on the single-agent interactive transport", () => {
    const headless = admitPiSpawnBatch(spawnItem("code-reviewer"), allowPorts({ transport: "interactive-rpc" }));
    expect(headless).toMatchObject({ kind: "block", guard: "interactive-transport" });
    const batch = admitPiSpawnBatch({
      tasks: [spawnItem("specify-agent"), spawnItem("architecture-agent")],
    }, allowPorts({ transport: "interactive-rpc" }));
    expect(batch).toMatchObject({ kind: "block", guard: "interactive-transport" });
  });

  it("requires agentScope 'user', defaulting an absent scope to 'user'", () => {
    const base = spawnItem("code-reviewer");
    expect(admitPiSpawnBatch({ ...base }, allowPorts()).kind).toBe("admit");
    const scoped = admitPiSpawnBatch({ ...base, agentScope: "project" }, allowPorts());
    expect(scoped).toMatchObject({ kind: "block", guard: "agent-scope" });
  });

  it("blocks on a stale rendered definition with the remediation command", () => {
    const admission = admitPiSpawnBatch({ ...spawnItem("code-reviewer") }, allowPorts({
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
      { tasks: [spawnItem("code-reviewer"), { agent: "code-simplifier", task: "no skill named" }] },
      allowPorts(),
    );
    expect(admission).toMatchObject({ kind: "block", guard: "validate-agent-skill" });
  });

  it("phase and template port blocks surface verbatim under their guard names", () => {
    const phase = admitPiSpawnBatch({ ...spawnItem("code-reviewer") }, allowPorts({
      checkPhaseOrder: () => ({ kind: "block", message: "phase says no" }),
    }));
    expect(phase).toEqual({ kind: "block", guard: "validate-phase-order", reason: "phase says no" });
    const template = admitPiSpawnBatch({ ...spawnItem("code-reviewer") }, allowPorts({
      checkTemplateSubstitution: () => ({ kind: "block", message: "unsubstituted template" }),
    }));
    expect(template).toEqual({ kind: "block", guard: "validate-template-substitution", reason: "unsubstituted template" });
  });

  it("admits a clean batch with index-aligned classifications", () => {
    const admission = admitPiSpawnBatch({ tasks: [spawnItem("code-reviewer"), spawnItem("code-simplifier")] }, allowPorts());
    expect(admission.kind).toBe("admit");
    if (admission.kind !== "admit") return;
    expect(admission.itemAdmissions.map(({ item: { agent } }) => agent)).toEqual(["code-reviewer", "code-simplifier"]);
    // Each item carries its own lifecycle classification: review agents outside
    // a standalone-review context are non-implementation spawns.
    expect(admission.itemAdmissions.map(({ taskExecutionSpawn }) => taskExecutionSpawn)).toEqual([
      { kind: "non-implementation" },
      { kind: "non-implementation" },
    ]);
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

describe("admitPiSpawnBatch emission expectations", () => {
  it("carries each expectation and execution classification with the item it governs", () => {
    const admission = admitPiSpawnBatch(
      { tasks: [emissionItem("code-reviewer", REVIEWER_V2), spawnItem("code-simplifier")] },
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
          route: DESKTOP_VLLM_ROUTE,
        },
      },
      {
        item: spawnItem("code-simplifier"),
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
      { tasks: [spawnItem("code-simplifier"), spawnItem("code-reviewer", issuedTask("code-reviewer", REVIEWER_V2))] },
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
    const admission = admitPiSpawnBatch({ tasks: [spawnItem("code-reviewer"), spawnItem("code-simplifier")] }, allowPorts());
    expect(admission.kind).toBe("admit");
    if (admission.kind !== "admit") return;
    expect(admission.itemAdmissions.map(({ emissionExpectation }) => emissionExpectation)).toEqual([
      { kind: "no-emission-tool" },
      { kind: "no-emission-tool" },
    ]);
  });

  it("blocks every self-consistent forged descriptor without an independently reserved request", () => {
    fc.assert(fc.property(fc.constantFrom(...REGISTRY_CELLS), (binding) => {
      const agent = binding.kind.kind === "judge-verdict" ? "arch-judge-agent" : "review-verifier-agent";
      expect(admitPiSpawnBatch(emissionItem(agent, binding), allowPorts())).toMatchObject({
        kind: "block", guard: "expected-emission-capability",
        reason: expect.stringContaining("no independently issued request"),
      });
    }));
  });
});
