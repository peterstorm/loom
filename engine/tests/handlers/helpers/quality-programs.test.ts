import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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
    const symlinkTarget = join(output, "source-agent.md");
    const reviewerOutput = join(output, "code-reviewer.md");
    writeFileSync(symlinkTarget, "source must remain unchanged\n");
    symlinkSync(symlinkTarget, reviewerOutput);

    cli([
      "helper", "model-profiles", "render-pi",
      "--agents-dir", "agents",
      "--package-root", ROOT,
      "--output", output,
    ]);

    expect(readFileSync(symlinkTarget, "utf-8")).toBe("source must remain unchanged\n");
    expect(lstatSync(reviewerOutput).isSymbolicLink()).toBe(false);
    const renderedReviewer = readFileSync(reviewerOutput, "utf-8");
    expect(renderedReviewer).toContain("model: openai-codex/gpt-5.6-sol:high");
    expect(renderedReviewer).toContain(`${ROOT}/rules/architecture.md`);
    expect(renderedReviewer).not.toContain("CLAUDE_PLUGIN_ROOT");
    expect(readFileSync(join(output, "comment-analyzer.md"), "utf-8"))
      .toContain("model: openai-codex/gpt-5.4-mini:medium");
    const specify = readFileSync(join(output, "specify-agent.md"), "utf-8");
    expect(specify).toContain("## Preloaded Loom Skill: specify");
    expect(specify).toContain("# Specify - Requirements Before Design");
    expect(specify).toMatch(/^loom-agent-digest: [a-f0-9]{64}$/m);
  });

  it("the user-facing sync script publishes a fully lowered Pi agent catalog", () => {
    const piRoot = mkdtempSync(join(tmpdir(), "loom-pi-agent-home-"));
    cleanup.push(piRoot);
    execFileSync("bash", [join(ROOT, "scripts", "sync-pi-agents.sh")], {
      cwd: ROOT,
      env: { ...process.env, PI_CODING_AGENT_DIR: piRoot },
      encoding: "utf-8",
    });
    const reviewer = readFileSync(join(piRoot, "agents", "code-reviewer.md"), "utf-8");
    expect(reviewer).toContain("loom-package-root:");
    expect(reviewer).toContain("loom-agent-digest:");
    expect(reviewer).toContain(`${ROOT}/rules/architecture.md`);
    expect(reviewer).not.toContain("CLAUDE_PLUGIN_ROOT");
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

  it("keeps calibration prompts blind to corpus labels and expected findings", () => {
    const corpus = JSON.parse(readFileSync(join(ROOT, "calibration/corpus.json"), "utf-8")) as {
      cases: Array<{
        id: string;
        revision: string;
        state: string;
        expected_criticals: Array<{ claim: string }>;
      }>;
    };
    const selected = corpus.cases[0]!;
    const prompt = cli([
      "helper", "model-calibration", "prompt",
      "--corpus", "calibration/corpus.json",
      "--case", selected.id,
    ]);

    expect(prompt).toContain(`Review historical revision ${selected.revision} for critical correctness defects.`);
    expect(prompt).toContain("complete revision-derived changed-path scope");
    expect(prompt).not.toContain(`(${selected.state})`);
    expect(prompt).not.toContain("seeded");
    expect(prompt).not.toContain(selected.expected_criticals[0]!.claim);
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

  it("event-sources the architecture candidate batch and waits for every slot", () => {
    const input = {
      input: {
        candidateLenses: ["simplicity-first", "type-driven-fp"],
        judgeCriteria: ["simplicity", "testability"],
      },
      events: [],
    };
    const first = JSON.parse(cli(["helper", "panel-program", "architecture"], JSON.stringify(input)));
    expect(first.action.type).toBe("spawn-batch");
    expect(first.action.requests).toHaveLength(2);
    expect(first.action.requests.map((request: { modelProfile: string }) => request.modelProfile))
      .toEqual(["panel-design", "panel-design"]);

    input.events.push({
      type: "spawn-outcome",
      requestId: "architecture:candidate:1",
      attempt: 1,
      outcome: "succeeded",
    } as never);
    const partial = JSON.parse(cli(["helper", "panel-program", "architecture"], JSON.stringify(input)));
    expect(partial.action).toBeNull();
    expect(partial.state.stage).toBe("candidates");
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
        // Pi and Claude tool APIs commonly record this as an absolute path.
        // The packet boundary must canonicalize it to the same repo-relative
        // identity as file_list instead of rejecting valid in-repo evidence.
        files_modified: [join(ROOT, "engine/src/core/model-profiles.ts")],
        review_status: "pending",
        review_generation: 1,
        // A pre-identity graph may carry only the derived views. Packet
        // creation must mint the same identity into both packet and run before
        // any reviewer is asked to assess it.
        critical_findings: ["stale finding"],
        advisory_findings: [],
        refuted_findings: [],
        resolved_findings: [],
      }],
      wave_gates: {},
    }));
    const id = cli(
      ["helper", "review-packet", "create", "--task", "T1", "--output", packet],
      "",
      { LOOM_STATE_PATH: state },
    ).trim();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    const written = JSON.parse(readFileSync(packet, "utf-8"));
    expect(written.modifiedPaths).toEqual(["engine/src/core/model-profiles.ts"]);
    expect(written.task.reviewGeneration).toBe(1);
    expect(written.task.priorFindings.map((finding: { id: string }) => finding.id))
      .toEqual(["recovered-view-1"]);
    expect(written.artifacts.map((artifact: { path: string }) => artifact.path))
      .toEqual(["engine/src/core/model-profiles.ts"]);
    const started = JSON.parse(readFileSync(state, "utf-8"));
    expect(started.tasks[0].review_run).toMatchObject({
      generation: 1,
      packet_id: id,
      prior_finding_ids: ["recovered-view-1"],
      evidence: [],
    });
    expect(started.tasks[0].issued_review_packets).toEqual([{
      task_id: "T1",
      packet_id: id,
      packet_path: relative(ROOT, packet),
      base_sha: head,
      head_sha: head,
      scope: ["engine/src/core/model-profiles.ts"],
    }]);
    expect(started.tasks[0].findings).toMatchObject([
      { id: "recovered-view-1", severity: "critical", claim: "stale finding" },
    ]);
    expect(started.tasks[0].review_run.expected_agents).toEqual([
      "code-reviewer",
      "silent-failure-hunter",
      "pr-test-analyzer",
      "type-design-analyzer",
      "comment-analyzer",
    ]);
    expect(cli(["helper", "review-packet", "verify", "--packet", packet]).trim()).toBe(id);
  });

  it("captures a staged deletion with a null postimage", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-review-packet-deletion-"));
    cleanup.push(root);
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "user.email", "loom@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Loom Test"], { cwd: root });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "deleted.ts"), "export const deleted = true;\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "baseline"], { cwd: root });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", head], { cwd: root });
    execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: root });
    rmSync(join(root, "src", "deleted.ts"));
    execFileSync("git", ["add", "-u"], { cwd: root });

    const state = join(root, "state.json");
    const packet = join(root, ".claude", "reviews", "packet.json");
    writeFileSync(state, JSON.stringify({
      current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, current_wave: 1, wave_gates: {},
      tasks: [{
        id: "T1", description: "delete", agent: "code-implementer-agent", wave: 1,
        status: "pending", depends_on: [], start_sha: head,
        file_list: ["src/deleted.ts"], files_modified: ["src/deleted.ts"],
        review_status: "pending", review_generation: 0,
      }],
    }));

    const id = execFileSync("bun", [
      CLI, "helper", "review-packet", "create", "--task", "T1", "--output", ".claude/reviews/packet.json",
    ], {
      cwd: root,
      encoding: "utf-8",
      env: { ...process.env, LOOM_STATE_PATH: state },
    }).trim();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    const written = JSON.parse(readFileSync(packet, "utf-8"));
    expect(written.artifacts).toMatchObject([{
      path: "src/deleted.ts",
      postimage: null,
    }]);
    expect(written.artifacts[0].diff.content).toContain("deleted file mode");
  });

  it("preserves and byte-hashes a binary postimage through the real CLI", () => {
    const dir = mkdtempSync(join(ROOT, ".tmp-review-packet-binary-test-"));
    cleanup.push(dir);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" }).trim();
    const state = join(dir, "state.json");
    const packet = join(dir, "packet.json");
    const image = join(dir, "icon.png");
    const imagePath = relative(ROOT, image);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x80]);
    writeFileSync(image, png);
    writeFileSync(state, JSON.stringify({
      current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, current_wave: 1, wave_gates: {},
      tasks: [{
        id: "T1", description: "binary packet", agent: "code-implementer-agent", wave: 1,
        status: "pending", depends_on: [], start_sha: head,
        file_list: [imagePath], files_modified: [imagePath],
      }],
    }));

    const id = cli(
      ["helper", "review-packet", "create", "--task", "T1", "--output", packet],
      "",
      { LOOM_STATE_PATH: state },
    ).trim();
    const written = JSON.parse(readFileSync(packet, "utf-8"));
    const postimage = written.artifacts[0].postimage;
    expect(written.schemaVersion).toBe(2);
    expect(postimage.encoding).toBe("base64");
    expect(Buffer.from(postimage.content, "base64")).toEqual(png);
    expect(postimage.sha256).toBe(createHash("sha256").update(png).digest("hex"));
    expect(cli(["helper", "review-packet", "verify", "--packet", packet]).trim()).toBe(id);
  });

  it("rejects a scoped path that is neither tracked nor present", () => {
    const dir = mkdtempSync(join(ROOT, ".tmp-review-packet-absent-test-"));
    cleanup.push(dir);
    const state = join(dir, "state.json");
    const packet = join(dir, "packet.json");
    writeFileSync(state, JSON.stringify({
      current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, current_wave: 1, wave_gates: {},
      tasks: [{
        id: "T1", description: "packet", agent: "code-implementer-agent", wave: 1,
        status: "pending", depends_on: [],
        start_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" }).trim(),
        file_list: ["definitely-not-present-review-packet.ts"], files_modified: [],
      }],
    }));

    const run = spawnSync("bun", [CLI, "helper", "review-packet", "create", "--task", "T1", "--output", packet], {
      cwd: ROOT, encoding: "utf-8", env: { ...process.env, LOOM_STATE_PATH: state },
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("neither tracked nor present");
    expect(existsSync(packet)).toBe(false);
  });

  it("fails review-packet creation on an unexpected git probe error", () => {
    const dir = mkdtempSync(join(ROOT, ".tmp-review-packet-git-failure-test-"));
    cleanup.push(dir);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" }).trim();
    const state = join(dir, "state.json");
    const packet = join(dir, "packet.json");
    writeFileSync(state, JSON.stringify({
      current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, current_wave: 1, wave_gates: {},
      tasks: [{
        id: "T1", description: "packet", agent: "code-implementer-agent", wave: 1,
        status: "pending", depends_on: [], start_sha: head,
        file_list: ["engine/src/types.ts"], files_modified: ["engine/src/types.ts"],
      }],
    }));

    const fakeBin = join(dir, "bin");
    mkdirSync(fakeBin);
    const fakeGit = join(fakeBin, "git");
    writeFileSync(fakeGit, [
      "#!/bin/sh",
      "if [ \"$1\" = \"ls-files\" ]; then",
      "  echo forced-ls-files-failure >&2",
      "  exit 2",
      "fi",
      "exec \"$REAL_GIT\" \"$@\"",
      "",
    ].join("\n"), { mode: 0o755 });

    const run = spawnSync("bun", [CLI, "helper", "review-packet", "create", "--task", "T1", "--output", packet], {
      cwd: ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        LOOM_STATE_PATH: state,
        REAL_GIT: execFileSync("which", ["git"], { encoding: "utf-8" }).trim(),
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("forced-ls-files-failure");
    expect(existsSync(packet)).toBe(false);
  });

  it("rejects external task paths instead of reading them into a review packet", () => {
    const dir = mkdtempSync(join(ROOT, ".tmp-review-packet-outside-test-"));
    const outside = mkdtempSync(join(tmpdir(), "loom-review-packet-outside-"));
    cleanup.push(dir, outside);
    const state = join(dir, "state.json");
    const packet = join(dir, "packet.json");
    const external = join(outside, "secret.ts");
    writeFileSync(external, "secret\n");
    writeFileSync(state, JSON.stringify({
      current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, current_wave: 1, wave_gates: {},
      tasks: [{
        id: "T1", description: "packet", agent: "code-implementer-agent", wave: 1,
        status: "pending", depends_on: [], start_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" }).trim(),
        file_list: ["engine/src/types.ts"], files_modified: [external],
      }],
    }));

    const run = spawnSync("bun", [CLI, "helper", "review-packet", "create", "--task", "T1", "--output", packet], {
      cwd: ROOT, encoding: "utf-8", env: { ...process.env, LOOM_STATE_PATH: state },
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("must identify a file inside the repository");
    expect(existsSync(packet)).toBe(false);
  });

  it("rejects a review-packet output path with a symlinked parent", () => {
    const dir = mkdtempSync(join(ROOT, ".tmp-review-packet-symlink-test-"));
    const outside = mkdtempSync(join(tmpdir(), "loom-review-packet-output-"));
    cleanup.push(dir, outside);
    const state = join(dir, "state.json");
    const linked = join(dir, "linked-output");
    symlinkSync(outside, linked);
    writeFileSync(state, JSON.stringify({
      current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, current_wave: 1, wave_gates: {},
      tasks: [{
        id: "T1", description: "packet", agent: "code-implementer-agent", wave: 1,
        status: "pending", depends_on: [], start_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" }).trim(),
        file_list: ["engine/src/types.ts"], files_modified: ["engine/src/types.ts"],
      }],
    }));

    const run = spawnSync("bun", [CLI, "helper", "review-packet", "create", "--task", "T1", "--output", join(linked, "packet.json")], {
      cwd: ROOT, encoding: "utf-8", env: { ...process.env, LOOM_STATE_PATH: state },
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("must not traverse a symlink");
    expect(existsSync(join(outside, "packet.json"))).toBe(false);
  });

  it("rejects an unknown refutation lens at the CLI boundary", () => {
    const run = spawnSync("bun", [CLI, "helper", "panel-program", "refutation"], {
      cwd: ROOT,
      input: JSON.stringify({ input: { criticalFindingIds: ["T1:F1"], lenses: ["invented"] }, events: [] }),
      encoding: "utf-8",
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("unknown refutation lens");
  });

  it("rejects a task-local finding id before constructing a refutation program", () => {
    const run = spawnSync("bun", [CLI, "helper", "panel-program", "refutation"], {
      cwd: ROOT,
      input: JSON.stringify({ input: { criticalFindingIds: ["code-reviewer-1"], lenses: ["intent"] }, events: [] }),
      encoding: "utf-8",
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("wave-scoped task-id:finding-id");
  });
});
