import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

type Handler = (event: Record<string, unknown>, context: Record<string, unknown>) => unknown;

class FakePi {
  readonly handlers = new Map<string, Handler[]>();

  on(event: string, handler: Handler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  registerCommand(): void {}

  async emit(event: string, payload: Record<string, unknown>, context: Record<string, unknown>): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) await handler(payload, context);
  }
}

const temp = mkdtempSync(join(tmpdir(), "loom-pi-review-events-"));
const statePath = join(temp, "active_task_graph.json");
const previousStatePath = process.env.LOOM_STATE_PATH;
const previousPiDir = process.env.PI_CODING_AGENT_DIR;
process.env.LOOM_STATE_PATH = statePath;
process.env.PI_CODING_AGENT_DIR = join(temp, "pi-agent");

mkdirSync(dirname(statePath), { recursive: true });
writeFileSync(statePath, JSON.stringify({
  current_phase: "execute",
  phase_artifacts: {},
  skipped_phases: [],
  spec_file: null,
  plan_file: null,
  current_wave: 1,
  wave_gates: {},
  tasks: [{
    id: "T1",
    description: "capture Pi review",
    agent: "code-implementer-agent",
    wave: 1,
    status: "implemented",
    depends_on: [],
    review_status: "pending",
  }],
}, null, 2));

afterAll(() => {
  if (previousStatePath === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = previousStatePath;
  if (previousPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousPiDir;
  rmSync(temp, { recursive: true, force: true });
});

const reviewResult = (task: string, claim: string) => ({
  toolName: "subagent",
  isError: false,
  input: {},
  content: [],
  details: {
    results: [{
      agent: "code-reviewer",
      task,
      exitCode: 0,
      messages: [{
        role: "assistant",
        content: [{
          type: "text",
          text: [
            "### Machine Summary",
            "CRITICAL_COUNT: 1",
            "ADVISORY_COUNT: 0",
            `CRITICAL: ${claim}`,
            "```findings",
            JSON.stringify([{ severity: "critical", file: "pi/extension.ts", line: 367, claim }]),
            "```",
          ].join("\n"),
        }],
      }],
    }],
  },
});

describe("Pi extension review tool_result integration", () => {
  it("stores wave findings and leaves standalone review state untouched", async () => {
    vi.resetModules();
    const module = await vi.importActual("../../pi/extension") as {
      default: (pi: unknown) => void;
    };
    const pi = new FakePi();
    module.default(pi as never);
    expect(pi.handlers.get("tool_result")).toHaveLength(2);

    const context = {
      sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad40a" },
    };
    await pi.emit("tool_result", reviewResult("Task: T1", "Pi event shape drops findings"), context);

    const captured = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(captured.tasks[0]).toMatchObject({
      review_status: "blocked",
      critical_findings: ["Pi event shape drops findings"],
      advisory_findings: [],
    });
    expect(captured.tasks[0].findings).toEqual([{
      id: "code-reviewer-1",
      agent: "code-reviewer",
      severity: "critical",
      file: "pi/extension.ts",
      line: 367,
      claim: "Pi event shape drops findings",
    }]);

    await pi.emit(
      "tool_result",
      reviewResult("LOOM_REVIEW_CONTEXT: standalone\nTask: T1", "must not reach task state"),
      context,
    );
    expect(JSON.parse(readFileSync(statePath, "utf-8"))).toEqual(captured);
  });
});
