import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ROOT = resolve(ENGINE, "..");
const CLI = join(ENGINE, "src/cli.ts");
const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

function cli(args: string[], stdin = "", env: Record<string, string> = {}): string {
  return execFileSync("bun", [CLI, ...args], {
    cwd: ROOT,
    input: stdin,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

describe("quality-program helper boundaries", () => {
  it("validates source profiles and renders exact Pi OpenAI models", () => {
    expect(cli(["helper", "model-profiles", "validate", "--agents-dir", "agents"]))
      .toContain("Validated 28");
    const output = mkdtempSync(join(tmpdir(), "loom-pi-agents-"));
    cleanup.push(output);
    cli(["helper", "model-profiles", "render-pi", "--agents-dir", "agents", "--output", output]);
    expect(readFileSync(join(output, "code-reviewer.md"), "utf-8"))
      .toContain("model: openai-codex/gpt-5.6-sol:high");
    expect(readFileSync(join(output, "comment-analyzer.md"), "utf-8"))
      .toContain("model: openai-codex/gpt-5.4-mini:medium");
  });

  it("validates the committed historical corpus and refuses to call missing history green", () => {
    expect(cli(["helper", "model-calibration", "validate", "--corpus", "calibration/corpus.json"]))
      .toContain("Validated 8 calibration cases");
    const corpus = JSON.parse(readFileSync(join(ROOT, "calibration/corpus.json"), "utf-8")) as { cases: Array<{ id: string }> };
    const predictions = {
      schema_version: 1,
      profile_id: "focused-review",
      cases: corpus.cases.map(({ id }) => ({ case_id: id, status: "not-executed", reason: "fixture" })),
    };
    const score = JSON.parse(cli(
      ["helper", "model-calibration", "score", "--corpus", "calibration/corpus.json"],
      JSON.stringify(predictions),
    ));
    expect(score.execution).toBe("incomplete");
    expect(score.vulnerable.executedCaseCount).toBe(0);
  });

  it("event-sources the exact refutation batch and waits for all slots before tally", () => {
    const input = {
      input: {
        criticalFindingIds: ["T1:code-reviewer-1"],
        lenses: ["reproduction", "intent", "blast-radius"],
      },
      events: [],
    };
    const first = JSON.parse(cli(["helper", "panel-program", "refutation"], JSON.stringify(input)));
    expect(first.action.type).toBe("spawn-batch");
    expect(first.action.requests.map((request: { modelProfile: string }) => request.modelProfile))
      .toEqual(["refutation", "refutation", "refutation"]);

    input.events.push({
      type: "spawn-outcome",
      requestId: "refutation:verifier:1",
      attempt: 1,
      outcome: "succeeded",
    } as never);
    const partial = JSON.parse(cli(["helper", "panel-program", "refutation"], JSON.stringify(input)));
    expect(partial.action).toBeNull();
    expect(partial.state.stage).toBe("verifiers");
  });

  it("creates and verifies a task-scoped review packet through the real CLI", () => {
    const dir = mkdtempSync(join(ROOT, ".tmp-review-packet-test-"));
    cleanup.push(dir);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" }).trim();
    const state = join(dir, "state.json");
    const packet = join(dir, "packet.json");
    writeFileSync(state, JSON.stringify({
      current_phase: "execute",
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: null,
      plan_file: null,
      current_wave: 1,
      tasks: [{
        id: "T1", description: "packet", agent: "code-implementer-agent", wave: 1,
        status: "pending", depends_on: [], start_sha: head,
        file_list: ["engine/src/core/model-profiles.ts"],
        files_modified: ["engine/src/core/model-profiles.ts"],
      }],
      wave_gates: {},
    }));
    const id = cli(
      ["helper", "review-packet", "create", "--task", "T1", "--output", packet],
      "",
      { LOOM_STATE_PATH: state },
    ).trim();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(cli(["helper", "review-packet", "verify", "--packet", packet]).trim()).toBe(id);
  });

  it("rejects an unknown refutation lens at the CLI boundary", () => {
    const run = spawnSync("bun", [CLI, "helper", "panel-program", "refutation"], {
      cwd: ROOT,
      input: JSON.stringify({ input: { criticalFindingIds: ["F1"], lenses: ["invented"] }, events: [] }),
      encoding: "utf-8",
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("unknown refutation lens");
  });
});
