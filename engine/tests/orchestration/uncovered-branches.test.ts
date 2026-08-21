import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildContextPacket,
  encodeByteSection,
  parseContextPacket,
  type ByteSection,
} from "../../src/orchestration/context-packets";
import {
  parseSessionRunBindingRegistry,
  registerSessionRunBinding,
} from "../../src/orchestration/session-run-bindings";
import { fixFull } from "../../src/handlers/helpers/validate-task-graph";
import {
  reduceArchitectureProgram,
  reduceRefutationProgram,
  type ArchitectureProgramEvent,
  type ArchitectureProgramState,
  type RefutationProgramEvent,
  type RefutationProgramState,
} from "../../src/core/panel-program";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const section = (label: string, text: string): ByteSection => {
  const encoded = encodeByteSection(label, text);
  if (!encoded.ok) throw new Error(encoded.error.message);
  return encoded.value;
};

/**
 * `requiredFieldProblem` — the context packet's own required-field gate.
 *
 * A packet with an empty role, an empty required-skill, or no sections at all
 * is a packet a verifier cannot act on, and the digest would seal that
 * emptiness as authoritative. Nothing exercised the check, so a packet built
 * from a partially-populated request would have been sealed and shipped.
 */
describe("context packet required fields", () => {
  const valid = {
    requestId: "request:reviewer:1" as never,
    role: "code-reviewer",
    requiredSkill: "none",
    outputContract: "machine-summary-v1",
    fixedContext: [section("rules", "always parse, never validate")],
    variableContext: [] as readonly ByteSection[],
  } as const;

  it("builds a packet when every required field is present", () => {
    expect(buildContextPacket({ ...valid }).ok).toBe(true);
  });

  it.each([
    ["requestId", { requestId: "" }],
    ["role", { role: "" }],
    ["requiredSkill", { requiredSkill: "" }],
    ["outputContract", { outputContract: "" }],
  ])("refuses an empty %s, naming the field", (field, override) => {
    const built = buildContextPacket({ ...valid, ...override } as typeof valid);

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.field).toBe(field);
    expect(built.error.message).toContain(field);
  });

  it("refuses a packet carrying no sections at all", () => {
    const built = buildContextPacket({ ...valid, fixedContext: [], variableContext: [] });

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.field).toBe("sections");
    expect(built.error.message).toContain("at least one section");
  });

  it("accepts a packet whose only section is variable", () => {
    expect(buildContextPacket({
      ...valid,
      fixedContext: [],
      variableContext: [section("task", "the finding under review")],
    }).ok).toBe(true);
  });

  it("refuses an in-process section with an empty label", () => {
    const unlabeled = { ...section("rules", "content"), label: "" };

    const built = buildContextPacket({ ...valid, fixedContext: [unlabeled] });

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.field).toBe("fixedContext[0].label");
    expect(built.error.message).toContain("non-empty string");
  });

  it("takes immutable ownership of caller-supplied section bytes", () => {
    const encoded = section("mutable", "abc");
    const callerBytes = [...encoded.bytes];
    const callerSection = { ...encoded, bytes: callerBytes };

    const built = buildContextPacket({ ...valid, fixedContext: [callerSection] });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const digest = built.value.digest;
    callerBytes[0] = 0;

    expect(built.value.fixedContext[0]?.bytes).toEqual([97, 98, 99]);
    expect(built.value.digest).toBe(digest);
    expect(Object.isFrozen(built.value.fixedContext[0]?.bytes)).toBe(true);
  });

  it("refuses sparse byte arrays at build and parse boundaries", () => {
    const sparse = new Array<number>(1);
    const zeroDigest = createHash("sha256").update(Uint8Array.from([0])).digest("hex");
    const forged = { label: "sparse", byteLength: 1, digest: zeroDigest, bytes: sparse };

    expect(buildContextPacket({ ...valid, fixedContext: [forged as never] }).ok).toBe(false);
    expect(parseContextPacket({
      schemaVersion: 1,
      digest: "irrelevant",
      requestId: valid.requestId,
      role: valid.role,
      requiredSkill: valid.requiredSkill,
      outputContract: valid.outputContract,
      fixedContext: [forged],
      variableContext: [],
    }).ok).toBe(false);
  });

  it("refuses an in-process section containing a number outside the byte domain", () => {
    const coercedDigest = createHash("sha256").update(Uint8Array.from([0])).digest("hex");
    const forged = {
      label: "forged",
      byteLength: 1,
      digest: coercedDigest,
      bytes: [256],
    } as never;

    const built = buildContextPacket({ ...valid, fixedContext: [forged] });

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.field).toBe("fixedContext[0]");
    expect(built.error.message).toContain("only bytes");
  });
});

/**
 * Session run-binding registry validation.
 *
 * The registry is how a Pi session proves which orchestration run a result
 * belongs to. Two of its integrity rules — no duplicate run identities across
 * bindings, no duplicate request ids within one — had no test, and either
 * violation lets one result be attributed to two runs (or one request to two
 * slots) with the registry still parsing clean.
 */
describe("session run binding registry validation", () => {
  const SESSION = "019fca39-f989-7510-8e62-50dadbcad4b0";

  function runDirectory(name: string) {
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-binding-"));
    cleanup.push(runsRoot);
    const directory = join(runsRoot, name);
    mkdirSync(directory, { recursive: true });
    return { runsRoot, directory };
  }

  const registry = (bindings: readonly unknown[]) => ({
    schemaVersion: 1,
    kind: "session-run-bindings",
    harness: "pi",
    sessionId: SESSION,
    bindings,
  });

  it("accepts a well-formed registry", () => {
    const { runsRoot, directory } = runDirectory("run.binding1");
    const parsed = parseSessionRunBindingRegistry(registry([{
      runId: "run.binding1", runsRoot, runDirectory: directory, requestIds: ["request:a"],
    }]), SESSION);

    expect(parsed.ok, parsed.ok ? "" : parsed.message).toBe(true);
  });

  it("refuses duplicate request ids inside one binding", () => {
    const { runsRoot, directory } = runDirectory("run.binding2");
    const parsed = parseSessionRunBindingRegistry(registry([{
      runId: "run.binding2", runsRoot, runDirectory: directory, requestIds: ["request:a", "request:a"],
    }]), SESSION);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("requestIds must be unique");
  });

  it("refuses two bindings naming the same run identity", () => {
    const { runsRoot, directory } = runDirectory("run.binding3");
    const binding = { runId: "run.binding3", runsRoot, runDirectory: directory, requestIds: ["request:a"] };
    const parsed = parseSessionRunBindingRegistry(
      registry([binding, { ...binding, requestIds: ["request:b"] }]),
      SESSION,
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("duplicate run identities");
  });

  it("refuses a binding whose runId contradicts its run directory", () => {
    const { runsRoot, directory } = runDirectory("run.binding4");
    const parsed = parseSessionRunBindingRegistry(registry([{
      runId: "run.somethingelse", runsRoot, runDirectory: directory, requestIds: ["request:a"],
    }]), SESSION);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("does not match its parsed run directory identity");
  });

  it("refuses a registry belonging to another session", () => {
    const { runsRoot, directory } = runDirectory("run.binding5");
    const parsed = parseSessionRunBindingRegistry(registry([{
      runId: "run.binding5", runsRoot, runDirectory: directory, requestIds: ["request:a"],
    }]), "019fca39-f989-7510-8e62-50dadbcad4ff");

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("belongs to another session");
  });

  it("refuses an empty requestIds list", () => {
    const { runsRoot, directory } = runDirectory("run.binding6");
    const parsed = parseSessionRunBindingRegistry(registry([{
      runId: "run.binding6", runsRoot, runDirectory: directory, requestIds: [],
    }]), SESSION);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("non-empty array");
  });

  it("registers a binding through the real filesystem boundary and reads it back", async () => {
    const subagentDir = mkdtempSync(join(tmpdir(), "loom-binding-subagents-"));
    cleanup.push(subagentDir);
    const { runsRoot, directory } = runDirectory("run.binding7");

    const registered = await registerSessionRunBinding(subagentDir, SESSION, {
      runId: "run.binding7" as never,
      runsRoot,
      runDirectory: directory,
      requestIds: ["request:a" as never],
    });

    expect(registered.ok, registered.ok ? "" : registered.message).toBe(true);
  });
});

/**
 * `fixFull`'s `runInvalidated` branch.
 *
 * A findings repair that re-mints an id, recovers a view-only claim, or drops a
 * malformed record has changed the very finding set an in-flight review run was
 * adjudicating. Leaving `review_run` in place would let that run's later tally
 * apply verdicts to findings that no longer exist under those ids — so the
 * repair clears the review record and re-opens the review. Nothing tested it,
 * and an unreviewed task blocks the gate, so the failure direction is a stale
 * review silently passing.
 */
describe("--fix clears an in-flight review run whose finding set it changed", () => {
  const reviewRun = {
    packet_id: "a".repeat(64),
    packet_path: ".claude/reviews/T1.json",
    head_sha: "b".repeat(64),
    review_generation: 0,
    scope: ["src/x.ts"],
  };

  const task = (extra: Record<string, unknown>) => ({
    id: "T1", description: "d", agent: "code-implementer-agent", wave: 1,
    status: "implemented", depends_on: [], review_run: reviewRun, review_status: "in_review",
    ...extra,
  });

  it("clears review_run and re-opens the review when a view-only claim is recovered", () => {
    // `critical_findings` carries a claim that `findings` does not: the repair
    // recovers it with a fresh identity, which is a finding set the in-flight
    // run never briefed.
    const report = fixFull({
      current_wave: 1,
      tasks: [task({ findings: [], critical_findings: ["a recovered blocker"], advisory_findings: [] })],
    });

    const fixedTask = (JSON.parse(report.json) as { tasks: readonly Record<string, unknown>[] }).tasks[0]!;
    expect(fixedTask.review_run).toBeUndefined();
    expect(fixedTask.review_status).toBe("pending");
  });

  it("clears review_run when a malformed finding is dropped", () => {
    const report = fixFull({
      current_wave: 1,
      tasks: [task({
        findings: [{ not: "a finding" }],
        critical_findings: [],
        advisory_findings: [],
      })],
    });

    const fixedTask = (JSON.parse(report.json) as { tasks: readonly Record<string, unknown>[] }).tasks[0]!;
    expect(fixedTask.review_run).toBeUndefined();
    expect(fixedTask.review_status).toBe("pending");
  });

  it("KEEPS an in-flight review run whose finding set the repair did not change", () => {
    // The other direction, which matters just as much: a repair that touched
    // nothing must not gratuitously discard a live review run and force a
    // re-review.
    const finding = {
      id: "code-reviewer-1", agent: "code-reviewer", severity: "critical",
      file: "src/x.ts", line: 1, claim: "a real blocker", review_generation: 0,
      review_packet_id: reviewRun.packet_id,
    };
    const report = fixFull({
      current_wave: 1,
      tasks: [task({
        findings: [finding],
        critical_findings: [finding.claim],
        advisory_findings: [],
        review_generation: 0,
      })],
    });

    const fixedTask = (JSON.parse(report.json) as { tasks: readonly Record<string, unknown>[] }).tasks[0]!;
    expect(fixedTask.review_run).toBeDefined();
  });
});

/**
 * Panel reducers reject every UNDECLARED (state, event) pair.
 *
 * Every sibling machine in this diff carries this exhaustive property; the two
 * panel reducers did not, so a stage that silently accepted an event meant for
 * another stage — the classic way a state machine loses its guarantees — had
 * nothing to catch it. Rejection here means a typed refusal, never a throw and
 * never a silent no-op that returns the same state.
 */
describe("panel reducers reject undeclared state × event pairs", () => {
  const EVENT_TYPES = ["spawn-outcome", "engine-outcome", "user-decision"] as const;
  type EventType = (typeof EVENT_TYPES)[number];

  /** The ONE event type each stage declares. Terminal stages declare none. */
  const architectureStages: Readonly<Record<string, EventType | null>> = {
    "interview": "spawn-outcome",
    "prepare-candidates": "engine-outcome",
    "candidates": "spawn-outcome",
    "prepare-judges": "engine-outcome",
    "judges": "spawn-outcome",
    "aggregate": "engine-outcome",
    "finalize": "spawn-outcome",
    "complete": null,
    "blocked": null,
  };
  const refutationStages: Readonly<Record<string, EventType | null>> = {
    "prepare-verifiers": "engine-outcome",
    "verifiers": "spawn-outcome",
    "tally": "engine-outcome",
    "skipped": null,
    "complete": null,
    "blocked": null,
  };

  const eventOf = (type: EventType): unknown => {
    switch (type) {
      case "spawn-outcome":
        return { type, requestId: "not-a-live-request", attempt: 1, outcome: "succeeded" };
      case "engine-outcome":
        return { type, operationId: "architecture-aggregate", outcome: "succeeded" };
      case "user-decision":
        return { type, decisionId: "not-a-live-decision", decision: { kind: "approve" } };
    }
  };

  it("architecture: every stage refuses every event type it does not declare", () => {
    fc.assert(fc.property(
      fc.constantFrom(...Object.keys(architectureStages)),
      fc.constantFrom(...EVENT_TYPES),
      (stage, type) => {
        fc.pre(architectureStages[stage] !== type);
        // Only the stage tag is needed: the event-type guard is the FIRST thing
        // each arm does, so an undeclared pair is refused before any slot or
        // operation state is read. That ordering is exactly the invariant —
        // a stage that reached its payload logic before checking the event
        // kind would be acting on an event meant for another stage.
        const state = { stage, completedRequestIds: [], completedOperationIds: [] } as unknown as ArchitectureProgramState;
        const result = reduceArchitectureProgram(state, eventOf(type) as ArchitectureProgramEvent);
        expect(result.ok, `${stage} accepted a ${type}`).toBe(false);
        if (result.ok) return;
        expect(result.error).toMatchObject({ kind: "unexpected-event", panel: "architecture", stage });
      },
    ), { numRuns: 300 });
  });

  it("refutation: every stage refuses every event type it does not declare", () => {
    fc.assert(fc.property(
      fc.constantFrom(...Object.keys(refutationStages)),
      fc.constantFrom(...EVENT_TYPES),
      (stage, type) => {
        fc.pre(refutationStages[stage] !== type);
        const state = { stage, completedRequestIds: [], completedOperationIds: [] } as unknown as RefutationProgramState;
        const result = reduceRefutationProgram(state, eventOf(type) as RefutationProgramEvent);
        expect(result.ok, `${stage} accepted a ${type}`).toBe(false);
        if (result.ok) return;
        expect(result.error).toMatchObject({ kind: "unexpected-event", panel: "refutation", stage });
      },
    ), { numRuns: 300 });
  });

  it("every terminal stage refuses every event, in both panels", () => {
    for (const type of EVENT_TYPES) {
      for (const stage of ["complete", "blocked"]) {
        const architecture = reduceArchitectureProgram(
          { stage, completedRequestIds: [], completedOperationIds: [] } as unknown as ArchitectureProgramState,
          eventOf(type) as ArchitectureProgramEvent,
        );
        expect(architecture.ok, `architecture ${stage} accepted ${type}`).toBe(false);
      }
      for (const stage of ["skipped", "complete", "blocked"]) {
        const refutation = reduceRefutationProgram(
          { stage, completedRequestIds: [], completedOperationIds: [] } as unknown as RefutationProgramState,
          eventOf(type) as RefutationProgramEvent,
        );
        expect(refutation.ok, `refutation ${stage} accepted ${type}`).toBe(false);
      }
    }
  });
});
