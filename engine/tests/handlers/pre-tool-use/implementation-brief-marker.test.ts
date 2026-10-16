/**
 * Claude Code expansion of implementation brief markers (G4 pilot F5): the
 * pure expansion, the sibling-gate wrapper, the reservation-taking hook that
 * rewrites the call, the stdout Claude Code reads the rewrite from, and the
 * shell shim's refusal of a marker no TaskGraph can expand.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import type { ImplementationBrief } from "../../../src/core/implementation-brief";
import { expandBriefMarker, withBriefMarkerExpanded, type RenderTaskBrief } from "../../../src/handlers/pre-tool-use/implementation-brief-marker";
import { SPAWN_VETOES } from "../../../src/handlers/pre-tool-use/spawn-vetoes";
import validateTaskExecution, { createValidateTaskExecutionHandler } from "../../../src/handlers/pre-tool-use/validate-task-execution";
import { hookSuccessStdout, preToolUseRewriteResult, type HookHandler, type PreToolUseInput } from "../../../src/types";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";

const MARKER = "LOOM_IMPLEMENTATION_BRIEF: T2";

const brief = (prompt: string, agent = "code-implementer-agent"): ImplementationBrief => ({
  taskId: "T2",
  agent,
  dispatch: { kind: "initial-implementation", taskId: "T2", semanticAttempt: 1, promptAppendix: null },
  prompt,
});

const rendering = (value: ImplementationBrief): RenderTaskBrief => () => ({ ok: true, value });
const failing = (error: string): RenderTaskBrief => () => ({ ok: false, error });

const spawnInput = (prompt: unknown, subagentType = "loom:code-implementer-agent"): PreToolUseInput => ({
  tool_name: "Agent",
  tool_input: { subagent_type: subagentType, model: "opus", description: "Implement T2", prompt },
  session_id: "s",
});

describe("expandBriefMarker", () => {
  it("expands an exact marker to the rendered brief, keeping every other input field", () => {
    const input = spawnInput(MARKER);
    const expansion = expandBriefMarker(input, rendering(brief("**Task ID:** T2\nthe brief")));
    expect(expansion).toEqual({
      kind: "expanded",
      toolInput: { ...input.tool_input, prompt: "**Task ID:** T2\nthe brief" },
      stdin: JSON.stringify({ ...input, tool_input: { ...input.tool_input, prompt: "**Task ID:** T2\nthe brief" } }),
    });
    expect(Object.isFrozen(expansion)).toBe(true);
  });

  it("accepts the marker with surrounding whitespace, as the Pi expansion does", () => {
    expect(expandBriefMarker(spawnInput(`\n  ${MARKER}  \n`), rendering(brief("b")))).toMatchObject({ kind: "expanded", toolInput: { prompt: "b" } });
  });

  it("leaves a prompt that is not exactly one marker alone, without rendering anything", () => {
    const render: RenderTaskBrief = () => { throw new Error("must not render"); };
    for (const prompt of [`${MARKER} please`, `implement ${MARKER}`, "LOOM_IMPLEMENTATION_BRIEF: 2", 42, undefined]) {
      expect(expandBriefMarker(spawnInput(prompt), render)).toEqual({ kind: "no-marker" });
    }
  });

  it("never renders for a prompt that is not a marker line", () => {
    fc.assert(fc.property(fc.string(), (prompt) => {
      fc.pre(!/^LOOM_IMPLEMENTATION_BRIEF: T\d+$/.test(prompt.trim()));
      const render: RenderTaskBrief = () => { throw new Error("must not render"); };
      expect(expandBriefMarker(spawnInput(prompt), render)).toEqual({ kind: "no-marker" });
    }));
  });

  it("refuses a marker whose brief cannot render, naming the cause", () => {
    expect(expandBriefMarker(spawnInput(MARKER), failing("T2: dependency T1 is implemented, not completed"))).toEqual({
      kind: "refused",
      message: "BLOCKED: the implementation brief marker for T2 cannot expand: T2: dependency T1 is implemented, not completed",
    });
  });

  it("refuses a marker spawned on an agent other than the Task's", () => {
    expect(expandBriefMarker(spawnInput(MARKER, "loom:frontend-agent"), rendering(brief("b")))).toEqual({
      kind: "refused",
      message: "BLOCKED: the brief marker spawns \"loom:frontend-agent\" but T2 is assigned to code-implementer-agent",
    });
  });
});

describe("withBriefMarkerExpanded", () => {
  const recording = () => {
    const seen: string[] = [];
    const handler: HookHandler = async (stdin) => { seen.push(stdin); return { kind: "allow" }; };
    return { seen, handler };
  };

  it("hands the gate the expanded payload instead of the marker", async () => {
    const gate = recording();
    const stdin = JSON.stringify(spawnInput(MARKER));
    expect(await withBriefMarkerExpanded("g", gate.handler, rendering(brief("the brief")))(stdin, [])).toEqual({ kind: "allow" });
    expect(JSON.parse(gate.seen[0]!).tool_input.prompt).toBe("the brief");
  });

  it("blocks, naming the gate, and never runs it when the marker cannot expand", async () => {
    const gate = recording();
    const result = await withBriefMarkerExpanded("validate-agent-skill", gate.handler, failing("no TaskGraph"))(JSON.stringify(spawnInput(MARKER)), []);
    expect(result).toEqual({
      kind: "block",
      message: "validate-agent-skill: BLOCKED: the implementation brief marker for T2 cannot expand: no TaskGraph",
    });
    expect(gate.seen).toEqual([]);
  });

  it("passes everything else through byte-identical, malformed input included", async () => {
    const render: RenderTaskBrief = () => { throw new Error("must not render"); };
    for (const stdin of [
      JSON.stringify(spawnInput("**Task ID:** T2 the full brief")),
      JSON.stringify({ tool_name: "Bash", tool_input: { command: MARKER }, session_id: "s" }),
      "{not json",
    ]) {
      const gate = recording();
      await withBriefMarkerExpanded("g", gate.handler, render)(stdin, []);
      expect(gate.seen).toEqual([stdin]);
    }
  });
});

describe("hookSuccessStdout for a PreToolUse rewrite", () => {
  it("renders updatedInput in Claude Code's hookSpecificOutput shape, with no permission decision", () => {
    expect(JSON.parse(hookSuccessStdout(preToolUseRewriteResult({ prompt: "b" }))!)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { prompt: "b" } },
    });
    expect(JSON.parse(hookSuccessStdout(preToolUseRewriteResult({ prompt: "b" }, "note"))!)).toEqual({
      systemMessage: "note",
      hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { prompt: "b" } },
    });
  });
});

const roots: string[] = [];
const previousState = process.env.LOOM_STATE_PATH;
afterEach(() => {
  if (previousState === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = previousState;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A protected graph in Wave 2 owing T2, whose dependency T1 passed its gate,
 *  with the plan the execute phase requires. */
function activeGraph(): string {
  const root = canonicalTempDir("loom-brief-marker-");
  roots.push(root);
  mkdirSync(join(root, ".claude", "state"), { recursive: true });
  mkdirSync(join(root, ".claude", "plans"), { recursive: true });
  const plan = join(root, ".claude", "plans", "plan.md");
  writeFileSync(plan, "# Plan\n");
  const path = join(root, ".claude", "state", "active_task_graph.json");
  writeFileSync(path, JSON.stringify({
    current_phase: "execute", current_wave: 2, phase_artifacts: {}, skipped_phases: ["plan-alignment"],
    spec_file: null, plan_file: plan, executing_tasks: [],
    wave_gates: {
      "1": { impl_complete: true, tests_passed: true, reviews_complete: true, blocked: false },
      "2": { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false },
    },
    tasks: [
      {
        id: "T1", description: "Build the seam", agent: "code-implementer-agent", wave: 1, depends_on: [],
        file_list: ["src/seam.ts"], files_modified: ["src/seam.ts"], status: "completed", legacy_missing_proof: true,
      },
      {
        id: "T2", description: "Use the seam", agent: "code-implementer-agent", wave: 2, depends_on: ["T1"],
        file_list: ["src/use.ts"], status: "pending",
      },
    ],
  }));
  process.env.LOOM_STATE_PATH = path;
  return path;
}

describe("validate-task-execution with a brief marker", () => {
  const stdinOf = (prompt: string, subagentType = "loom:code-implementer-agent") => JSON.stringify(spawnInput(prompt, subagentType));

  it("runs every veto on the expanded brief and rewrites the admitted call to carry it", async () => {
    activeGraph();
    const seen: string[] = [];
    const veto = { name: "record", handler: (async (stdin) => { seen.push(stdin); return { kind: "allow" }; }) as HookHandler };
    const prompt = "**Task ID:** T2\nUse the seam";
    const result = await createValidateTaskExecutionHandler([veto], rendering(brief(prompt)))(stdinOf(MARKER), []);
    expect(result).toEqual(preToolUseRewriteResult({ subagent_type: "loom:code-implementer-agent", model: "opus", description: "Implement T2", prompt }));
    expect(seen.map((stdin) => JSON.parse(stdin).tool_input.prompt)).toEqual([prompt]);
  });

  it("returns a veto unchanged, rewrites nothing and reserves nothing", async () => {
    const statePath = activeGraph();
    const before = readFileSync(statePath);
    const refusal = { kind: "block", message: "BLOCKED: Prompt doesn't reference required skill(s)." } as const;
    const handler = createValidateTaskExecutionHandler([{ name: "skill", handler: async () => refusal }], rendering(brief("**Task ID:** T2")));
    expect(await handler(stdinOf(MARKER), [])).toEqual(refusal);
    expect(readFileSync(statePath).equals(before)).toBe(true);
  });

  it("blocks a marker that cannot expand before any veto or reservation runs", async () => {
    const statePath = activeGraph();
    const before = readFileSync(statePath);
    const vetoes = [{ name: "unreached", handler: (async () => { throw new Error("must not run"); }) as HookHandler }];
    expect(await createValidateTaskExecutionHandler(vetoes, failing("Task T2 is completed"))(stdinOf(MARKER), [])).toEqual({
      kind: "block",
      message: "validate-task-execution: BLOCKED: the implementation brief marker for T2 cannot expand: Task T2 is completed",
    });
    expect(readFileSync(statePath).equals(before)).toBe(true);
  });

  it("leaves a full-brief spawn as it was: judged as sent and never rewritten", async () => {
    activeGraph();
    const render: RenderTaskBrief = () => { throw new Error("must not render"); };
    const result = await createValidateTaskExecutionHandler([], render)(stdinOf("**Task ID:** T2\nUse the seam"), []);
    expect(result.kind).not.toBe("pre-tool-use-rewrite");
  });

  it("end to end, the real gates expand the marker against the protected graph and reserve T2", async () => {
    const statePath = activeGraph();
    const result = await validateTaskExecution(stdinOf(MARKER), []);
    expect(result).toMatchObject({ kind: "pre-tool-use-rewrite", updatedInput: { subagent_type: "loom:code-implementer-agent", model: "opus" } });
    if (result.kind !== "pre-tool-use-rewrite") return;
    const prompt = result.updatedInput.prompt as string;
    expect(prompt).toContain("**Task ID:** T2");
    expect(prompt).toContain("code-implementer");
    expect(prompt).not.toContain("LOOM_IMPLEMENTATION_BRIEF");
    const graph = JSON.parse(readFileSync(statePath, "utf8")) as { tasks: { id: string; reserved_at?: string }[] };
    expect(graph.tasks.find(({ id }) => id === "T2")?.reserved_at).toEqual(expect.any(String));
  });
});

describe("every spawn veto judges the expanded brief", () => {
  it.each(SPAWN_VETOES.map(({ name, handler }) => [name, handler] as const))(
    "%s refuses a marker it cannot expand, naming itself (a new veto that forgets the wrap fails here)",
    async (name, handler) => {
      activeGraph();
      // T1 is completed, so it is owed no dispatch and its brief never renders.
      expect(await handler(JSON.stringify(spawnInput("LOOM_IMPLEMENTATION_BRIEF: T1")), [])).toEqual({
        kind: "block",
        message: `${name}: BLOCKED: the implementation brief marker for T1 cannot expand: Task T1 is completed; it is owed no implementation dispatch`,
      });
    },
  );
});

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CLI = join(PACKAGE_ROOT, "engine", "src", "cli.ts");

/** One real hook process, as Claude Code runs it, against `statePath`, from
 *  its project root made a Git repository (the reservation captures a baseline). */
function runHook(route: string, stdin: string, statePath: string) {
  const project = dirname(dirname(dirname(statePath)));
  for (const args of [["init", "-q"], ["-c", "user.email=loom@example.test", "-c", "user.name=Loom", "commit", "-q", "--allow-empty", "-m", "fixture"]]) {
    spawnSync("git", args, { cwd: project });
  }
  const subagents = canonicalTempDir("loom-brief-marker-subagents-");
  roots.push(subagents);
  const result = spawnSync("bun", [CLI, "pre-tool-use", route], {
    input: stdin,
    encoding: "utf-8",
    cwd: project,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LOOM_STATE_PATH: statePath, LOOM_SUBAGENT_DIR: subagents },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("the real hook processes", () => {
  it("validate-task-execution exits 0 and prints the rewrite Claude Code applies", () => {
    const run = runHook("validate-task-execution", JSON.stringify(spawnInput(MARKER)), activeGraph());
    expect(run.status, run.stderr).toBe(0);
    const output = JSON.parse(run.stdout) as { hookSpecificOutput: { hookEventName: string; updatedInput: { prompt: string } } };
    expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(output.hookSpecificOutput.updatedInput.prompt).toContain("**Task ID:** T2");
  });

  it("validate-agent-skill admits a marker because its brief, not the marker, names the skill", () => {
    const statePath = activeGraph();
    const admitted = runHook("validate-agent-skill", JSON.stringify(spawnInput(MARKER)), statePath);
    expect(admitted.status, admitted.stderr).toBe(0);
    // Control: the same gate refuses a one-line prompt that is not a marker, so
    // the admission above came from the expansion.
    const refused = runHook("validate-agent-skill", JSON.stringify(spawnInput(`${MARKER} please`)), statePath);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("doesn't reference required skill");
  });
});

describe("validate-task-execution.sh without a TaskGraph", () => {
  const SHIM = join(PACKAGE_ROOT, "hooks", "scripts", "validate-task-execution.sh");
  const run = (stdin: string, pluginRoot = PACKAGE_ROOT) => {
    const project = canonicalTempDir("loom-shim-project-");
    roots.push(project);
    const result = spawnSync("bash", [SHIM], {
      input: stdin,
      encoding: "utf-8",
      cwd: project,
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: pluginRoot,
        LOOM_STATE_PATH: join(project, ".claude", "state", "active_task_graph.json"), LOOM_SUBAGENT_DIR: join(project, "subagents"),
      },
    });
    return { status: result.status, stderr: result.stderr };
  };

  it("blocks a marker through the engine's one parser, including JSON-escaped whitespace and pretty-printed input", () => {
    for (const stdin of [
      JSON.stringify(spawnInput(MARKER)),
      JSON.stringify(spawnInput(`\n\t${MARKER}\n`)),
      JSON.stringify(spawnInput(` ${MARKER}`), null, 2),
    ]) {
      const result = run(stdin);
      expect(result.status, stdin).toBe(2);
      expect(result.stderr).toContain("the implementation brief marker for T2 cannot expand");
    }
  });

  it("lets a prompt that only mentions the marker through, judged by the engine", () => {
    for (const prompt of [`${MARKER} please`, `describe ${MARKER}`]) {
      expect(run(JSON.stringify(spawnInput(prompt))).status, prompt).toBe(0);
    }
  });

  it("never starts the engine for a spawn that does not mention the marker", () => {
    expect(run(JSON.stringify(spawnInput("**Task ID:** T2 the brief")), "/nonexistent")).toEqual({ status: 0, stderr: "" });
  });
});
