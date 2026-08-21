import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRunDirectory } from "../../src/orchestration/run-directory-handle";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    try { chmodSync(path, 0o755); } catch { /* best effort before removal */ }
    rmSync(path, { recursive: true, force: true });
  }
});

function freshRun(name = "run.pristine1") {
  const runsRoot = mkdtempSync(join(tmpdir(), "loom-pristine-"));
  cleanup.push(runsRoot);
  const runDirectory = join(runsRoot, name);
  mkdirSync(runDirectory, { recursive: true });
  const opened = openRunDirectory(runsRoot, runDirectory);
  if (!opened.ok) throw new Error(opened.error.message);
  return { runsRoot, runDirectory, handle: opened.value };
}

/**
 * `isPristine()` decides whether a replacement Run Directory is safe to adopt
 * during orphan recovery and wave-gate restart — i.e. whether the engine may
 * install fresh authority into a directory the operator supplied.
 *
 * It is reachable end-to-end (the recover-orphan CLI surfaces its refusal as
 * "must be pristine"), but nothing tested the predicate itself, so which
 * entries it tolerates and which it rejects rested entirely on one CLI
 * assertion about a single stray file. Its allowlist has structure — the
 * engine's own `authority.json`/`program.json` and the fixed subdirectories are
 * fine; `requests/correlators` is the ONE permitted nested entry — and every
 * arm of that structure could regress silently.
 */
describe("run directory isPristine()", () => {
  it("accepts a directory holding only the engine's own fixed layout", () => {
    // `openRunDirectory` writes authority.json and builds every fixed
    // subdirectory, so a freshly opened run is the canonical pristine shape.
    const { handle } = freshRun();

    const pristine = handle.isPristine();

    expect(pristine.ok).toBe(true);
    if (!pristine.ok) return;
    expect(pristine.value).toBe(true);
  });

  it("accepts the one permitted nested entry: requests/correlators", () => {
    const { runDirectory, handle } = freshRun();
    // Built by the fixed layout itself; it must not be read as contamination.
    mkdirSync(join(runDirectory, "requests", "correlators"), { recursive: true });

    const pristine = handle.isPristine();

    expect(pristine.ok && pristine.value).toBe(true);
  });

  it.each([
    ["a stray file at the root", "stray.txt"],
    ["a stray directory at the root", "extra/"],
    ["a checkpoint from a previous run", "checkpoint.json"],
    ["a published result", "result.json"],
    ["a dotfile", ".hidden"],
  ])("rejects %s", (_label, entry) => {
    const { runDirectory, handle } = freshRun();
    if (entry.endsWith("/")) mkdirSync(join(runDirectory, entry.slice(0, -1)));
    else writeFileSync(join(runDirectory, entry), "x");

    const pristine = handle.isPristine();

    expect(pristine.ok).toBe(true);
    if (!pristine.ok) return;
    expect(pristine.value).toBe(false);
  });

  it.each([
    ["a reserved request", join("requests", "r.json")],
    ["a captured transcript", join("transcripts", "attempt-1.raw")],
    ["a context packet", join("contexts", "abc.json")],
    ["an effect receipt", join("receipts", "e.json")],
    ["a published artifact", join("artifacts", "a.json")],
  ])("rejects %s inside a fixed subdirectory", (_label, entry) => {
    // Contents, not just root entries: a run directory that already holds
    // reserved authority is emphatically not reusable, and adopting it would
    // graft a prior run's identity onto a fresh one.
    const { runDirectory, handle } = freshRun();
    writeFileSync(join(runDirectory, entry), "{}");

    const pristine = handle.isPristine();

    expect(pristine.ok).toBe(true);
    if (!pristine.ok) return;
    expect(pristine.value).toBe(false);
  });

  it("rejects a nested entry under requests/correlators", () => {
    const { runDirectory, handle } = freshRun();
    writeFileSync(join(runDirectory, "requests", "correlators", "c.json"), "{}");

    const pristine = handle.isPristine();

    expect(pristine.ok).toBe(true);
    if (!pristine.ok) return;
    expect(pristine.value).toBe(false);
  });

  it("rejects a symlink planted at the root", () => {
    const { runDirectory, handle } = freshRun();
    symlinkSync("/etc", join(runDirectory, "link"));

    const pristine = handle.isPristine();

    expect(pristine.ok).toBe(true);
    if (!pristine.ok) return;
    expect(pristine.value).toBe(false);
  });

  it("returns a typed FAILURE, not `false`, when the directory cannot be read", () => {
    // "Cannot prove pristine" and "proved not pristine" are different answers.
    // Collapsing the first into the second would let an unreadable directory
    // read as an ordinary refusal, hiding a permissions fault behind a
    // recovery diagnostic that suggests the operator left a stray file.
    const { runDirectory, handle } = freshRun();
    rmSync(join(runDirectory, "requests"), { recursive: true, force: true });

    const pristine = handle.isPristine();

    expect(pristine.ok).toBe(false);
    if (pristine.ok) return;
    expect(pristine.error.message).toContain("cannot prove replacement run pristine");
  });
});
