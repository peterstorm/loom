/**
 * The `helper amend-spec` shell (ADR-0087): route traits, the commit order
 * (audit under the lock, then the spec bytes), the crash replay that only
 * writes the bytes, and refusals that change nothing. The decision is pinned
 * in tests/core/spec-amendment.test.ts.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAmendSpecHandler, parseAmendSpecArgs } from "../../../src/handlers/helpers/amend-spec";
import { newWaveGate } from "../../../src/core/wave-gate-model";
import { WHITELISTED_HELPERS } from "../../../src/core/guard-state-file";
import { KNOWN_HANDLERS, piRuntimeHandshakeRequired } from "../../../src/handler-routes";
import { StateManager } from "../../../src/state-manager";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { guardDecision } from "../../fixtures/guard-decision";
import { specDefining } from "../../fixtures/spec-index-fixture";
import { taskFixture } from "../../fixtures/task-lifecycle";

const BEFORE = specDefining(["FR-001"], ["AS-001"]);
const AFTER = BEFORE.replace("FR-001: System MUST satisfy FR-001", "FR-001: System MUST satisfy FR-001 within budget");
const ADDED = specDefining(["FR-001", "FR-002"], ["AS-001"]);

const cleanup: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const task = (id: string, wave: number, anchors: readonly string[]) => taskFixture({
  id, description: id, agent: "code-implementer-agent", wave, depends_on: [], file_list: [`src/${id}.ts`],
  spec_anchors: [...anchors], spec_contributions: [], review_status: "pending",
});

/** A live Wave 1 graph whose spec_file holds BEFORE, and a proposed spec file holding `proposed`. */
function fixture(proposed: string): Readonly<{ statePath: string; specFile: string; proposedFile: string }> {
  const root = canonicalTempDir("loom-amend-spec-");
  cleanup.push(root);
  // The spec sits in its own directory, so a test can make only that directory unwritable.
  mkdirSync(join(root, "spec"));
  const specFile = join(root, "spec", "spec.md");
  writeFileSync(specFile, BEFORE);
  const proposedFile = join(root, "proposed.md");
  writeFileSync(proposedFile, proposed);
  const statePath = join(root, "active_task_graph.json");
  writeFileSync(statePath, JSON.stringify({
    spec_trace_version: 2,
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: specFile,
    plan_file: null,
    current_wave: 1,
    executing_tasks: [],
    tasks: [task("T1", 1, ["FR-001", "AS-001"])],
    wave_gates: { "1": newWaveGate() },
  }));
  chmodSync(statePath, 0o444);
  vi.stubEnv("LOOM_STATE_PATH", statePath);
  const subagents = join(root, "subagents");
  mkdirSync(subagents);
  vi.stubEnv("LOOM_SUBAGENT_DIR", subagents);
  return { statePath, specFile, proposedFile };
}

const quiet = () => false;
const REASON = "Tighten FR-001 to the per-request budget";

describe("amend-spec registration", () => {
  it("is routed, whitelisted past the State File guard, and handshake-gated", () => {
    expect(KNOWN_HANDLERS.helper?.has("amend-spec")).toBe(true);
    expect(WHITELISTED_HELPERS).toContain("amend-spec");
    expect(piRuntimeHandshakeRequired("helper", "amend-spec")).toBe(true);
    expect(guardDecision('bun "$LOOM_DIR/engine/src/cli.ts" helper amend-spec --from /tmp/spec.md --reason r')).toBe("allow");
  });

  it.each<[readonly string[], string]>([
    [[], "Usage"],
    [["--from", "a.md"], "Usage"],
    [["--from", "a.md", "--reason", "r", "--from", "b.md"], "--from is given twice"],
    [["--bogus", "x"], "unknown argument '--bogus'"],
    [["--from", "--reason"], "--from needs a value"],
  ])("refuses arguments %j", (args, problem) => {
    const parsed = parseAmendSpecArgs(args);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(problem);
  });
});

describe("amend-spec helper", () => {
  it("commits the audit, then writes the new spec bytes", async () => {
    const { statePath, specFile, proposedFile } = fixture(AFTER);
    const result = await createAmendSpecHandler(quiet)("", ["--from", proposedFile, "--reason", REASON]);
    expect(result.kind, result.kind === "error" ? result.message : "").toBe("passthrough");
    expect(readFileSync(specFile, "utf8")).toBe(AFTER);
    const stored = new StateManager(statePath).load();
    expect(stored.spec_amendments?.[0]).toMatchObject({ kind: "spec-amended", wave: 1, rewritten: ["FR-001"], added: [], withdrawn: [] });
  });

  it("finishes a recorded amendment whose bytes were never written, without a second audit", async () => {
    const { statePath, specFile, proposedFile } = fixture(AFTER);
    await createAmendSpecHandler(quiet)("", ["--from", proposedFile, "--reason", REASON]);
    writeFileSync(specFile, BEFORE); // a crash between the commit and the byte write
    const result = await createAmendSpecHandler(quiet)("", ["--from", proposedFile, "--reason", REASON]);
    expect(result.kind).toBe("passthrough");
    expect(readFileSync(specFile, "utf8")).toBe(AFTER);
    expect(new StateManager(statePath).load().spec_amendments).toHaveLength(1);
  });

  it.skipIf(process.getuid?.() === 0)("reports a recorded amendment whose byte write failed, and the rerun finishes it", async () => {
    const { statePath, specFile, proposedFile } = fixture(AFTER);
    const directory = dirname(specFile);
    chmodSync(directory, 0o555);
    let result;
    try {
      result = await createAmendSpecHandler(quiet)("", ["--from", proposedFile, "--reason", REASON]);
    } finally {
      chmodSync(directory, 0o755);
    }
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("the amendment is recorded, but writing") });
    expect(readFileSync(specFile, "utf8")).toBe(BEFORE);
    expect(existsSync(`${specFile}.amend-spec.tmp`)).toBe(false);
    expect((await createAmendSpecHandler(quiet)("", ["--from", proposedFile, "--reason", REASON])).kind).toBe("passthrough");
    expect(readFileSync(specFile, "utf8")).toBe(AFTER);
    expect(new StateManager(statePath).load().spec_amendments).toHaveLength(1);
  });

  it("changes nothing when the spec already holds the proposed text", async () => {
    const { statePath, proposedFile } = fixture(BEFORE);
    const before = readFileSync(statePath, "utf8");
    expect((await createAmendSpecHandler(quiet)("", ["--from", proposedFile, "--reason", REASON])).kind).toBe("passthrough");
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("records an added Requirement for amend-spec-trace to assign", async () => {
    const { statePath, proposedFile } = fixture(ADDED);
    await createAmendSpecHandler(quiet)("", ["--from", proposedFile, "--reason", "Paging adds FR-002"]);
    expect(new StateManager(statePath).load().spec_amendments?.[0]).toMatchObject({ added: ["FR-002"] });
  });

  it("refuses without writing anything while a subagent is active, or when the proposed file is unreadable", async () => {
    const { statePath, specFile, proposedFile } = fixture(AFTER);
    const before = readFileSync(statePath, "utf8");
    const busy = await createAmendSpecHandler(() => true)("", ["--from", proposedFile, "--reason", REASON]);
    expect(busy).toMatchObject({ kind: "error", message: expect.stringContaining("Spec amendment refused while a subagent is active") });
    const missing = await createAmendSpecHandler(quiet)("", ["--from", `${proposedFile}.missing`, "--reason", REASON]);
    expect(missing).toMatchObject({ kind: "error", message: expect.stringContaining("cannot read") });
    expect(readFileSync(statePath, "utf8")).toBe(before);
    expect(readFileSync(specFile, "utf8")).toBe(BEFORE);
  });

  it("refuses a core precondition without writing the state or the spec", async () => {
    const { statePath, specFile, proposedFile } = fixture(AFTER);
    const before = readFileSync(statePath, "utf8");
    const result = await createAmendSpecHandler(quiet)("", ["--from", proposedFile, "--reason", "  "]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("refused without changing state (invalid-reason)") });
    expect(readFileSync(statePath, "utf8")).toBe(before);
    expect(readFileSync(specFile, "utf8")).toBe(BEFORE);
  });
});
