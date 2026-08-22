import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  admitPiSpawnBatch,
  MAX_PI_ORCHESTRATION_BATCH_SIZE,
  PI_INTERACTIVE_PHASE_AGENTS,
  type SpawnAdmissionPorts,
} from "../../src/core/spawn-admission";
import { LOOM_OWNED_AGENTS, type LoomAgentName } from "../../src/core/model-profiles";
import { AGENT_REQUIRED_SKILLS } from "../../src/core/orchestration-contract";

/** Spawn Admission is a pure decision exercised through in-memory ports. */

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
  ...overrides,
});

const item = (agent: LoomAgentName, task?: string): { agent: string; task: string } => ({
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

  it("passes external batches through when no graph is active, blocks them when one is", () => {
    const external = { agent: "someone-elses-agent", task: "external work" };
    expect(admitPiSpawnBatch(external, allowPorts({ graphActive: false }))).toEqual({ kind: "pass-through" });
    const blocked = admitPiSpawnBatch(external, allowPorts({ graphActive: true }));
    expect(blocked).toMatchObject({ kind: "block", guard: "external-agents" });
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
    expect(admission.items.map(({ agent }) => agent)).toEqual(["code-reviewer", "code-simplifier"]);
    expect(admission.taskExecutionSpawns).toHaveLength(2);
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
      const transport = PI_INTERACTIVE_PHASE_AGENTS.has(agent) ? "interactive-rpc" : "headless";
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
