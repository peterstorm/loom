import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRunDirectory, parseRunAbandonment } from "../../src/orchestration/run-directory-handle";
import type { OrchestrationRunId } from "../../src/core/orchestration-contract";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    try { chmodSync(path, 0o755); } catch { /* best effort before removal */ }
    rmSync(path, { recursive: true, force: true });
  }
});

function freshRun(name = "run.abandon1") {
  const runsRoot = mkdtempSync(join(tmpdir(), "loom-abandon-"));
  cleanup.push(runsRoot);
  const runDirectory = join(runsRoot, name);
  mkdirSync(runDirectory, { recursive: true });
  const opened = openRunDirectory(runsRoot, runDirectory);
  if (!opened.ok) throw new Error(opened.error.message);
  return { runsRoot, runDirectory, handle: opened.value };
}

/**
 * A Run Directory is never deleted — it holds the evidence of why the run ended
 * the way it did — so a run replaced by a newer one sits in the listing
 * indistinguishable from a live one, with the only record of the supersession
 * living in some parent session's notes. The abandonment marker is that record,
 * moved into the run.
 *
 * Everything asserted here follows from one rule: abandonment is TERMINAL. It
 * is written once, it never removes anything, and a run carrying it can be read
 * but not advanced.
 */
describe("run abandonment marker", () => {
  it("records the replacement and the reason, and deletes nothing", async () => {
    const { runDirectory, handle } = freshRun();

    const abandoned = await handle.abandonRun({ supersededBy: "run.replacement", reason: "superseded" });

    expect(abandoned).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        kind: "run-abandoned",
        runId: "run.abandon1",
        supersededBy: "run.replacement",
        reason: "superseded",
      },
    });
    expect(handle.readAbandonment()).toEqual(abandoned);
    for (const survivor of ["authority.json", "events", "requests", "transcripts"]) {
      expect(existsSync(join(runDirectory, survivor)), `${survivor} was removed`).toBe(true);
    }
  });

  it("reports a run that was never abandoned as null rather than as an error", () => {
    expect(freshRun().handle.readAbandonment()).toEqual({ ok: true, value: null });
  });

  /**
   * `registerProgram`'s rule, for the same reason: a byte-identical repeat is
   * the idempotent retry of an interrupted command, and anything else is a
   * second, different terminal claim on a run that already has one. Without
   * this a run could be re-pointed at a different replacement, which makes the
   * pointer a guess rather than a record.
   */
  it("is idempotent on an identical repeat and refuses a different one", async () => {
    const { handle } = freshRun();
    const input = { supersededBy: "run.replacement", reason: "superseded" };
    expect((await handle.abandonRun(input)).ok).toBe(true);

    expect((await handle.abandonRun(input)).ok).toBe(true);
    expect(await handle.abandonRun({ supersededBy: "run.other", reason: "superseded" })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "run is already abandoned under a different marker" }),
    });
    expect(await handle.abandonRun({ supersededBy: "run.replacement", reason: "different story" })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "run is already abandoned under a different marker" }),
    });
  });

  it("allows an abandonment with no replacement at all", async () => {
    const { handle } = freshRun();

    const abandoned = await handle.abandonRun({ supersededBy: null, reason: "scope was dropped" });

    expect(abandoned).toMatchObject({ ok: true, value: { supersededBy: null } });
  });

  /**
   * An abandoned run must never be adopted as the pristine replacement that a
   * wave-gate restart or an orphan recovery installs fresh authority into —
   * that would resurrect a run the operator retired.
   */
  it("makes the run non-pristine, so no recovery can adopt it as a replacement", async () => {
    const { handle } = freshRun();
    expect(handle.isPristine()).toEqual({ ok: true, value: true });

    expect((await handle.abandonRun({ supersededBy: null, reason: "retired" })).ok).toBe(true);

    expect(handle.isPristine()).toEqual({ ok: true, value: false });
  });

  it("refuses a marker written for a different run, or one that is malformed", () => {
    const { runDirectory, handle } = freshRun();

    writeFileSync(join(runDirectory, "abandoned.json"), JSON.stringify({
      schemaVersion: 1, kind: "run-abandoned", runId: "run.someone-else", supersededBy: null, reason: "x",
    }));

    expect(handle.readAbandonment()).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "run abandonment marker does not describe this run" }),
    });
  });

  it("keeps the stored marker readable as exactly what it claimed", async () => {
    const { runDirectory, handle } = freshRun();
    await handle.abandonRun({ supersededBy: "run.replacement", reason: "superseded" });

    const raw = JSON.parse(readFileSync(join(runDirectory, "abandoned.json"), "utf-8")) as Record<string, unknown>;

    // No timestamp: a clock reading would make two identical abandonments
    // differ and turn the idempotent repeat above into a conflict.
    expect(Object.keys(raw).sort()).toEqual(["kind", "reason", "runId", "schemaVersion", "supersededBy"]);
  });
});

describe("parseRunAbandonment", () => {
  const runId = "run.self" as OrchestrationRunId;

  /**
   * A run naming itself as its own replacement is a pointer that reads as
   * "look elsewhere" and sends the operator back to the run they are already
   * standing in — and the marker is immutable, so it would be frozen there.
   */
  it("refuses a run that supersedes itself", () => {
    expect(parseRunAbandonment(runId, { supersededBy: "run.self", reason: "x" })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "a run cannot supersede itself" }),
    });
  });

  it("requires a reason, because an unexplained abandonment says nothing the listing did not", () => {
    for (const reason of ["", "   "]) {
      expect(parseRunAbandonment(runId, { supersededBy: null, reason })).toEqual({
        ok: false,
        error: expect.objectContaining({ message: "an abandonment must carry a reason" }),
      });
    }
  });

  it("bounds the reason and trims it", () => {
    expect(parseRunAbandonment(runId, { supersededBy: null, reason: "  retired  " }))
      .toMatchObject({ ok: true, value: { reason: "retired" } });
    expect(parseRunAbandonment(runId, { supersededBy: null, reason: "x".repeat(513) }))
      .toMatchObject({ ok: false });
  });

  it("refuses a replacement that is not a canonical run id", () => {
    expect(parseRunAbandonment(runId, { supersededBy: "../escape", reason: "x" })).toMatchObject({ ok: false });
  });
});
