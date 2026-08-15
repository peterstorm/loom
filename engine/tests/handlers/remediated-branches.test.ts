import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvesWithin } from "../../src/handlers/subagent-stop/advance-phase";
import { parseMachineSummary } from "../../src/core/review-output";
import recordOrchestrationSpawn from "../../src/handlers/post-tool-use/record-orchestration-spawn";
import { RUN_DIR_ENV, RUNS_ROOT_ENV } from "../../src/orchestration/harness-capture-runtime";
import { openRunDirectory } from "../../src/orchestration/run-directory-handle";
import { resumeWaveGateFacade } from "../../src/handlers/helpers/programs";
import { driveRemediationFacade } from "../../src/handlers/helpers/programs/remediation";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

/**
 * `resolvesWithin` — the containment check behind `spec_file`/`plan_file`.
 *
 * These paths arrive from a phase agent's transcript and become the
 * authoritative artifacts every later phase transition reads. The check used to
 * be `String.includes(".claude/specs/")`, which a traversal satisfies while
 * resolving somewhere else entirely, so an agent could redirect the
 * authoritative spec at any file on disk.
 */
describe("phase-artifact path containment", () => {
  it.each([
    ".claude/specs/2026-08-15-feature/spec.md",
    "./.claude/specs/nested/deep/spec.md",
    ".claude/specs/a/../b/spec.md",
  ])("accepts %s, which really is inside the directory", (candidate) => {
    expect(resolvesWithin(candidate, ".claude/specs")).toBe(true);
  });

  it.each([
    // The exact bypass: contains the substring, resolves outside.
    ".claude/specs/../../../../tmp/evil/spec.md",
    ".claude/specs/../.claude/plans/spec.md",
    "/tmp/evil/.claude/specs/spec.md",
    "../.claude/specs/spec.md",
    "docs/.claude/specs/spec.md",
  ])("refuses %s, which only LOOKS inside it", (candidate) => {
    expect(resolvesWithin(candidate, ".claude/specs")).toBe(false);
  });

  it("refuses the directory itself — an artifact must be a file under it", () => {
    expect(resolvesWithin(".claude/specs", ".claude/specs")).toBe(false);
    expect(resolvesWithin(".claude/specs/", ".claude/specs")).toBe(false);
  });

  it("keeps the two artifact directories distinct", () => {
    expect(resolvesWithin(".claude/plans/p.md", ".claude/specs")).toBe(false);
    expect(resolvesWithin(".claude/specs/s.md", ".claude/plans")).toBe(false);
  });
});

/**
 * Finding-marker extraction must END at the keyword.
 *
 * The old `CRITICAL(?!_COUNT)` lookahead excluded exactly one continuation, so
 * any longer word on the same stem opened a line as a genuine finding marker
 * and pushed a garbled claim into adjudication — a reviewer's prose becoming a
 * critical finding that nothing wrote, which then blocks a wave and convenes a
 * refutation panel over text that was never a claim.
 */
describe("reviewer finding markers end at the keyword", () => {
  const parse = (body: string) => parseMachineSummary([
    "### Machine Summary",
    "CRITICAL_COUNT: 0",
    "ADVISORY_COUNT: 0",
    body,
  ].join("\n"));

  it.each([
    "CRITICALITY: high",
    "CRITICALLY important context follows",
    "CRITICALS: none",
    "ADVISORYNOTES: read the docs",
    "ADVISORIES follow below",
  ])("does not read %s as a finding marker", (line) => {
    const parsed = parse(line);
    expect(parsed, line + ' was not parsed at all').not.toBeNull();
    expect(parsed!.critical).toEqual([]);
    expect(parsed!.advisory).toEqual([]);
  });

  it("still reads the real markers, in every spelling the contract allows", () => {
    const parsed = parseMachineSummary([
      "### Machine Summary",
      "CRITICAL_COUNT: 2",
      "ADVISORY_COUNT: 1",
      "CRITICAL: a real blocker",
      "- **CRITICAL:** a bolded blocker",
      "  ADVISORY: a real nit",
    ].join("\n"));

    expect(parsed).not.toBeNull();
    expect(parsed!.critical).toEqual(["a real blocker", "a bolded blocker"]);
    expect(parsed!.advisory).toEqual(["a real nit"]);
  });

  it("still refuses to read the COUNT lines themselves as findings", () => {
    const parsed = parseMachineSummary([
      "### Machine Summary",
      "CRITICAL_COUNT: 0",
      "ADVISORY_COUNT: 0",
    ].join("\n"));

    expect(parsed).not.toBeNull();
    expect(parsed!.critical).toEqual([]);
    expect(parsed!.advisory).toEqual([]);
  });
});

/**
 * `record-orchestration-spawn` — the PostToolUse correlator.
 *
 * It runs on EVERY tool call in the session, so its refusals decide whether a
 * foreign spawn can bind itself to this run's authority. Only the happy path
 * and one role mismatch were covered; the passthrough for unrelated work, the
 * multi-marker refusal, the missing-role refusal, the native-id-count refusal,
 * and the unissued-request refusal were all unexercised — and the first of
 * those failing would make the correlator claim every unrelated Task call in
 * the session.
 */
describe("Claude orchestration spawn correlation", () => {
  let runsRoot: string;
  let runDirectory: string;
  let priorRunsRoot: string | undefined;
  let priorRunDir: string | undefined;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "loom-correlate-"));
    cleanup.push(runsRoot);
    runDirectory = join(runsRoot, "run.correlate1");
    mkdirSync(runDirectory, { recursive: true });
    priorRunsRoot = process.env[RUNS_ROOT_ENV];
    priorRunDir = process.env[RUN_DIR_ENV];
    process.env[RUNS_ROOT_ENV] = runsRoot;
    process.env[RUN_DIR_ENV] = runDirectory;
  });

  afterEach(() => {
    if (priorRunsRoot === undefined) delete process.env[RUNS_ROOT_ENV];
    else process.env[RUNS_ROOT_ENV] = priorRunsRoot;
    if (priorRunDir === undefined) delete process.env[RUN_DIR_ENV];
    else process.env[RUN_DIR_ENV] = priorRunDir;
  });

  const spawn = (prompt: string, extra: Record<string, unknown> = {}) => JSON.stringify({
    tool_name: "Task",
    tool_input: { subagent_type: "loom:code-reviewer", prompt, ...extra },
    tool_response: { agent_id: "native-agent-1" },
  });

  it("passes through a call carrying no engine marker at all", async () => {
    // PostToolUse is global: an unrelated Task call in the same session must
    // not be claimed by this run.
    const result = await recordOrchestrationSpawn(spawn("Just do the thing."), []);

    expect(result.kind).toBe("passthrough");
  });

  it("refuses a prompt carrying more than one request marker", async () => {
    const result = await recordOrchestrationSpawn(
      spawn("LOOM_REQUEST_ID: request:a\nLOOM_REQUEST_ID: request:b\nGo."),
      [],
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("exactly one LOOM_REQUEST_ID marker");
  });

  it("refuses a spawn with no agent role", async () => {
    const result = await recordOrchestrationSpawn(JSON.stringify({
      tool_name: "Task",
      tool_input: { prompt: "LOOM_REQUEST_ID: request:a\nGo." },
      tool_response: { agent_id: "native-agent-1" },
    }), []);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("no agent role");
  });

  it.each([
    ["none", {}],
    ["two", { agent_id: "native-1", nested: { agentId: "native-2" } }],
  ])("refuses a response carrying %s native agent ids", async (_label, response) => {
    const result = await recordOrchestrationSpawn(JSON.stringify({
      tool_name: "Task",
      tool_input: { subagent_type: "loom:code-reviewer", prompt: "LOOM_REQUEST_ID: request:a\nGo." },
      tool_response: response,
    }), []);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("exactly one native agent id");
  });

  it("refuses a spawn claiming a request the engine never issued", async () => {
    const opened = openRunDirectory(runsRoot, runDirectory);
    expect(opened.ok).toBe(true);

    const result = await recordOrchestrationSpawn(spawn("LOOM_REQUEST_ID: request:never-issued\nGo."), []);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("unissued request");
  });

  it("refuses invalid JSON on stdin rather than passing it through", async () => {
    const result = await recordOrchestrationSpawn("{not json", []);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("invalid JSON");
  });

  it("refuses half-supplied run authority", async () => {
    delete process.env[RUN_DIR_ENV];

    const result = await recordOrchestrationSpawn(spawn("LOOM_REQUEST_ID: request:a\nGo."), []);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("both run-root and run-directory authority");
  });

  it("passes through entirely when NO run authority is present", async () => {
    delete process.env[RUNS_ROOT_ENV];
    delete process.env[RUN_DIR_ENV];

    const result = await recordOrchestrationSpawn(spawn("LOOM_REQUEST_ID: request:a\nGo."), []);

    expect(result.kind).toBe("passthrough");
  });
});

/**
 * The Wave Gate resume spin-guard.
 *
 * `resumeWaveGateFacade` re-derives its next action after each durable step,
 * and a defect that produced no durable progress would recurse forever — an
 * engine that hangs rather than an engine that reports. The bound converts that
 * into a loud blocked diagnostic, and nothing had ever driven it: the depth
 * parameter exists precisely so the guard is reachable without staging a real
 * pathological run.
 */
describe("Wave Gate resume re-derivation bound", () => {
  it("blocks with a named diagnostic instead of spinning past the bound", async () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-spin-guard-"));
    cleanup.push(runsRoot);
    const runDirectory = join(runsRoot, "run.spinguard");
    mkdirSync(runDirectory, { recursive: true });
    const opened = openRunDirectory(runsRoot, runDirectory);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    // The registration is never consulted: the depth check is the FIRST thing
    // the resume does, which is what makes the bound a real backstop rather
    // than something a later failure could skip past.
    const driven = await resumeWaveGateFacade(
      opened.value,
      {} as never,
      65,
    );

    expect(driven.ok).toBe(true);
    if (!driven.ok) return;
    const action = driven.action as { kind: string; diagnostic: { message: string } };
    expect(action.kind).toBe("blocked");
    expect(action.diagnostic.message).toContain("exceeded 64 re-derivations");
    expect(action.diagnostic.message).toContain("refusing to spin");
  });

  it("does NOT trip the bound at the boundary depth", async () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-spin-guard-edge-"));
    cleanup.push(runsRoot);
    const runDirectory = join(runsRoot, "run.spinedge");
    mkdirSync(runDirectory, { recursive: true });
    const opened = openRunDirectory(runsRoot, runDirectory);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    // Depth 64 is still within the bound, so the resume proceeds into its real
    // work (and fails there on the stub registration) rather than reporting the
    // spin diagnostic. An off-by-one here would cap legitimate long runs.
    const driven = await resumeWaveGateFacade(opened.value, {} as never, 64);

    const action = driven.ok ? driven.action as { kind: string; diagnostic?: { message?: string } } : null;
    const message = action?.kind === "blocked" ? action.diagnostic?.message ?? "" : "";
    expect(message).not.toContain("refusing to spin");
  });
});

/**
 * `driveRemediationFacade`'s refusals.
 *
 * The driver is the last thing between an adjudicated review and a real Git
 * index write, and every branch in it ends in `remediationBlocked`. Only its
 * happy path had a test (through the façade smoke run), so nothing proved the
 * driver refuses when its source authority is absent, unfinished, or when the
 * repository it is asked to stage into cannot be opened — the three ways it can
 * be pointed at the wrong thing.
 */
describe("remediation façade refusals", () => {
  function sourceRun(prepare: (directory: string) => void) {
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-remediation-source-"));
    cleanup.push(runsRoot);
    const source = join(runsRoot, "run.source");
    mkdirSync(source, { recursive: true });
    const opened = openRunDirectory(runsRoot, source);
    if (!opened.ok) throw new Error(opened.error.message);
    prepare(source);
    const remediation = join(runsRoot, "run.remediation");
    mkdirSync(remediation, { recursive: true });
    const openedRemediation = openRunDirectory(runsRoot, remediation);
    if (!openedRemediation.ok) throw new Error(openedRemediation.error.message);
    return { runsRoot, source, handle: openedRemediation.value };
  }

  it("refuses when the source review has written no checkpoint at all", async () => {
    const { runsRoot, source, handle } = sourceRun(() => { /* no checkpoint */ });

    const driven = await driveRemediationFacade(handle, {
      kind: "remediation",
      input: { sourceRunsRoot: runsRoot, sourceRun: source, supportPaths: [] },
    } as never);

    expect(driven.ok).toBe(true);
    if (!driven.ok) return;
    const action = driven.action as { kind: string; diagnostic: { message: string } };
    expect(action.kind).toBe("blocked");
    expect(action.diagnostic.message).toContain("source standalone review checkpoint is missing");
  });

  it("refuses when the source review's checkpoint is unreadable", async () => {
    const { runsRoot, source, handle } = sourceRun((directory) => {
      writeFileSync(join(directory, "checkpoint.json"), "{not json");
    });

    const driven = await driveRemediationFacade(handle, {
      kind: "remediation",
      input: { sourceRunsRoot: runsRoot, sourceRun: source, supportPaths: [] },
    } as never);

    expect(driven.ok).toBe(true);
    if (!driven.ok) return;
    expect((driven.action as { kind: string }).kind).toBe("blocked");
  });

  it("refuses when the source review is registered but NOT done", async () => {
    const { runsRoot, source, handle } = sourceRun((directory) => {
      // A structurally readable checkpoint that does not describe a finished
      // review: remediation may only ever install what a completed adjudication
      // authorized.
      writeFileSync(join(directory, "checkpoint.json"), JSON.stringify({
        schemaVersion: 1,
        state: { kind: "awaiting-reviewers" },
      }));
    });

    const driven = await driveRemediationFacade(handle, {
      kind: "remediation",
      input: { sourceRunsRoot: runsRoot, sourceRun: source, supportPaths: [] },
    } as never);

    expect(driven.ok).toBe(true);
    if (!driven.ok) return;
    const action = driven.action as { kind: string; diagnostic: { message: string } };
    expect(action.kind).toBe("blocked");
    expect(action.diagnostic.message.length).toBeGreaterThan(0);
  });

  it("refuses when the source run directory cannot be opened at all", async () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-remediation-missing-source-"));
    cleanup.push(runsRoot);
    const remediation = join(runsRoot, "run.remediation");
    mkdirSync(remediation, { recursive: true });
    const opened = openRunDirectory(runsRoot, remediation);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const driven = await driveRemediationFacade(opened.value, {
      kind: "remediation",
      input: { sourceRunsRoot: runsRoot, sourceRun: join(runsRoot, "run.absent"), supportPaths: [] },
    } as never);

    expect(driven.ok).toBe(true);
    if (!driven.ok) return;
    expect((driven.action as { kind: string }).kind).toBe("blocked");
  });
});
