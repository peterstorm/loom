/**
 * Phase-artifact authority: which transcript write may become `spec_file`.
 *
 * `advance-phase` extracted artifacts from the transcript and then judged them
 * with a WEAKER rule than the Pi shell used for the same field: containment in
 * the shared `.claude/specs` root rather than in the run's own `spec_dir`. A
 * sibling run's `spec.md` — or a path carrying `..` segments, which the
 * parser's `includes(specDir)` filter let through — could therefore replace the
 * authoritative spec every later transition reads, on Claude Code only.
 *
 * Both harnesses now cross `core/phase-artifact-paths`. These tests enter the
 * artifact-write block with a real transcript, which no earlier test did: the
 * existing "locked Phase advances" case never supplied
 * `agent_transcript_path`, so the guarded branch was never executed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import advancePhaseHandler from "../../../src/handlers/subagent-stop/advance-phase";
import { SUBAGENT_DIR } from "../../../src/config";
import { StateManager } from "../../../src/state-manager";
import type { TaskGraph } from "../../../src/types";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function mkState(overrides: Partial<TaskGraph> = {}): TaskGraph {
  return {
    current_phase: "specify",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    tasks: [],
    wave_gates: {},
    ...overrides,
  };
}

/** One `Write` tool call, in the shape the transcript parser reads. */
const writeLine = (filePath: string): string =>
  JSON.stringify({
    message: { content: [{ type: "tool_use", name: "Write", input: { file_path: filePath } }] },
  });

describe("advance-phase artifact authority", () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-artifact-authority-")));
    origCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function withPhaseState(session: string, state: TaskGraph, run: () => Promise<void>): Promise<void> {
    const statePath = join(tmpDir, `${session}.json`);
    const pointerPath = join(SUBAGENT_DIR, `${session}.task_graph`);
    writeFileSync(statePath, JSON.stringify(state));
    mkdirSync(SUBAGENT_DIR, { recursive: true });
    writeFileSync(pointerPath, statePath);
    return run().finally(() => rmSync(pointerPath, { force: true }));
  }

  /** A readable spec.md under `relativeDir`, returned as its transcript path. */
  function plantSpec(relativeDir: string, marker = ""): string {
    const directory = join(tmpDir, relativeDir);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "spec.md");
    writeFileSync(path, `# spec\n${marker}`);
    return path;
  }

  const specifyResult = (session: string, transcriptPath: string) => advancePhaseHandler(JSON.stringify({
    session_id: session,
    agent_id: "specify-artifact-agent",
    agent_type: "specify-agent",
    agent_transcript_path: transcriptPath,
  }), []);

  it("records the run's own spec.md and advances on it", async () => {
    const session = `artifact-own-${process.pid}-${Date.now()}`;
    const specDir = ".claude/specs/2026-08-29-own";
    const specPath = plantSpec(specDir);
    const transcript = join(tmpDir, "transcript.jsonl");
    writeFileSync(transcript, writeLine(specPath));

    await withPhaseState(session, mkState({ spec_dir: specDir }), async () => {
      const result = await specifyResult(session, transcript);
      expect(result).toMatchObject({ kind: "passthrough" });
      expect(JSON.parse(readFileSync(join(tmpDir, `${session}.json`), "utf-8"))).toMatchObject({
        current_phase: "architecture",
        spec_file: specPath,
      });
    });
  });

  it("refuses to adopt a sibling run's spec.md as this run's authoritative spec", async () => {
    const session = `artifact-sibling-${process.pid}-${Date.now()}`;
    const ownSpecDir = ".claude/specs/2026-08-29-mine";
    const siblingSpec = plantSpec(".claude/specs/2026-07-01-other");
    mkdirSync(join(tmpDir, ownSpecDir), { recursive: true });
    const transcript = join(tmpDir, "transcript.jsonl");
    writeFileSync(transcript, writeLine(siblingSpec));

    await withPhaseState(session, mkState({ spec_dir: ownSpecDir }), async () => {
      const result = await specifyResult(session, transcript);
      // The run's own directory holds no spec.md, so nothing is readable and
      // the transition refuses — but the decisive fact is on disk.
      expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("no readable spec.md") });
      expect(JSON.parse(readFileSync(join(tmpDir, `${session}.json`), "utf-8")).spec_file).toBeNull();
    });
  });

  it("refuses a sibling spec reached through `..` segments the parser's substring filter admits", async () => {
    const session = `artifact-traversal-${process.pid}-${Date.now()}`;
    const ownSpecDir = ".claude/specs/2026-08-29-mine";
    const siblingSpec = plantSpec(".claude/specs/2026-07-01-other");
    mkdirSync(join(tmpDir, ownSpecDir), { recursive: true });
    // Built by hand, NOT with `join`: join collapses `..` lexically and would
    // produce the plain sibling path, which the parser's substring filter
    // already rejects. This keeps the run's own spec_dir as a literal substring
    // of the written path while resolving into the sibling run — only resolved
    // containment separates the two.
    const disguised = `${tmpDir}/${ownSpecDir}/../2026-07-01-other/spec.md`;
    const transcript = join(tmpDir, "transcript.jsonl");
    writeFileSync(transcript, writeLine(disguised));

    await withPhaseState(session, mkState({ spec_dir: ownSpecDir }), async () => {
      // The sibling spec really is readable, so the refusal is about scope and
      // not about a missing file.
      expect(existsSync(siblingSpec)).toBe(true);
      const result = await specifyResult(session, transcript);
      expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("no readable spec.md") });
      const persisted = JSON.parse(readFileSync(join(tmpDir, `${session}.json`), "utf-8"));
      expect(persisted.spec_file).toBeNull();
    });
  });

  it("refuses the artifact write itself when the Phase advances under the transcript", async () => {
    const session = `artifact-race-${process.pid}-${Date.now()}`;
    const specDir = ".claude/specs/2026-08-29-race";
    const specPath = plantSpec(specDir);
    const transcript = join(tmpDir, "transcript.jsonl");
    writeFileSync(transcript, writeLine(specPath));

    await withPhaseState(session, mkState({ spec_dir: specDir }), async () => {
      const originalUpdate = StateManager.prototype.update;
      const update = vi.spyOn(StateManager.prototype, "update").mockImplementationOnce(async function (
        this: StateManager,
        mutate,
      ) {
        const path = join(tmpDir, `${session}.json`);
        const current = JSON.parse(readFileSync(path, "utf-8"));
        writeFileSync(path, JSON.stringify({ ...current, current_phase: "architecture" }));
        return originalUpdate.call(this, mutate);
      });
      try {
        const result = await specifyResult(session, transcript);
        expect(result).toMatchObject({ kind: "passthrough", systemMessage: expect.stringContaining("already past") });
        const persisted = JSON.parse(readFileSync(join(tmpDir, `${session}.json`), "utf-8"));
        expect(persisted.current_phase).toBe("architecture");
        expect(persisted.spec_file).toBeNull();
        expect(persisted.phase_artifacts).toEqual({});
      } finally {
        update.mockRestore();
      }
    });
  });
});
