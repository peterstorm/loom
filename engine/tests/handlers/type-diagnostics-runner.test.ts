/**
 * The type-diagnostics shell. Orchestration (run slot, memory custody,
 * fail-open mapping) is exercised against an in-memory RunTypeCheck fake;
 * the real tsc adapter is exercised against a REAL TypeScript compiler: a
 * temp project whose node_modules/typescript links to the engine's pinned one.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STALE_RUN_MS,
  locateTypeCheckProject,
  typeCheckCachePaths,
  typeDiagnosticsAdvisory,
  type RunTypeCheck,
  type TypeCheckRun,
  type TypeDiagnosticsOptions,
} from "../../src/handlers/type-diagnostics-runner";
import { NO_ADVISORY, parseTypeCheckMemory, type TypeCheckOutcome } from "../../src/core/type-diagnostics";

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENGINE_TYPESCRIPT = join(ENGINE, "node_modules", "typescript");

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function scratch(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporary.push(directory);
  return directory;
}

function write(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/**
 * A TypeScript project with its own cache directory. "real" links the
 * engine's compiler; "stub" installs a tsc.js that is never meant to run
 * (the fake port stands in for it); "none" installs no compiler.
 */
function project(files: Readonly<Record<string, string>>, typescript: "real" | "stub" | "none" = "real") {
  const root = scratch("loom-type-diagnostics-");
  write(root, {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, target: "esnext", module: "esnext", moduleResolution: "bundler", types: [], noEmit: true },
      include: ["src"],
    }),
    ...files,
  });
  if (typescript === "real") {
    mkdirSync(join(root, "node_modules"));
    symlinkSync(ENGINE_TYPESCRIPT, join(root, "node_modules", "typescript"), "dir");
  }
  if (typescript === "stub") write(root, { "node_modules/typescript/lib/tsc.js": "process.exit(99);\n" });
  const options: TypeDiagnosticsOptions = { cacheDir: scratch("loom-type-cache-"), deadlineMs: 60_000, env: {} };
  const paths = typeCheckCachePaths(options.cacheDir!, join(root, "tsconfig.json"));
  return { root, file: (path: string) => join(root, path), options, paths };
}

/** An in-memory RunTypeCheck: records each run and answers with `respond`. */
function fakeCheck(respond: (run: TypeCheckRun) => TypeCheckOutcome | Promise<TypeCheckOutcome>) {
  const runs: TypeCheckRun[] = [];
  const runCheck: RunTypeCheck = async (run) => {
    runs.push(run);
    return respond(run);
  };
  return { runs, runCheck };
}

/** A pid that is certainly not alive: a child that already exited. */
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid!;

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
}

const BROKEN = "src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.";

describe("locateTypeCheckProject", () => {
  it("finds the nearest tsconfig above the file and the project's own compiler", () => {
    const p = project({ "src/deep/a.ts": "export const a = 1;\n" });
    const located = locateTypeCheckProject(p.file("src/deep/a.ts"));
    expect(located).toEqual({
      ok: true,
      value: { tsconfig: p.file("tsconfig.json"), projectDir: p.root, tscPath: join(p.root, "node_modules", "typescript", "lib", "tsc.js") },
    });
  });

  it("is unavailable without a project TypeScript", () => {
    const p = project({ "src/a.ts": "export const a = 1;\n" }, "none");
    const located = locateTypeCheckProject(p.file("src/a.ts"));
    expect(located.ok).toBe(false);
  });

  it("is unavailable without a tsconfig.json above the file", () => {
    const root = scratch("loom-type-noconfig-");
    write(root, { "a.ts": "export const a = 1;\n" });
    expect(locateTypeCheckProject(join(root, "a.ts"))).toMatchObject({ ok: false, error: expect.stringContaining("tsconfig.json") });
  });
});

describe("typeDiagnosticsAdvisory — orchestration over the check port", () => {
  const completedWith = (output: string, root: string): TypeCheckOutcome => ({
    kind: "completed",
    diagnostics: output ? [{ file: join(root, "src/a.ts"), line: 1, column: 14, code: 2322, message: "Type 'string' is not assignable to type 'number'." }] : [],
    global: [],
  });

  it("runs one check per edit, stores memory and releases the run slot", async () => {
    const p = project({ "src/a.ts": "export const a: number = 'x';\n" }, "stub");
    const check = fakeCheck(() => completedWith(BROKEN, p.root));
    const advisory = await typeDiagnosticsAdvisory(p.file("src/a.ts"), { ...p.options, runCheck: check.runCheck });

    expect(advisory.forModel).toContain("TS2322");
    expect(check.runs).toHaveLength(1);
    expect(check.runs[0]!.buildInfo).toBe(p.paths.buildInfo);
    expect(parseTypeCheckMemory(JSON.parse(readFileSync(p.paths.memory, "utf-8")))).not.toBeNull();
    expect(existsSync(p.paths.slot)).toBe(false);
    expect(readdirSync(p.options.cacheDir!).filter((name) => name.endsWith(".out"))).toEqual([]);
  });

  it("gives each run its own output file", async () => {
    const p = project({ "src/a.ts": "export const a = 1;\n" }, "stub");
    const check = fakeCheck(() => completedWith("", p.root));
    await typeDiagnosticsAdvisory(p.file("src/a.ts"), { ...p.options, runCheck: check.runCheck });
    await typeDiagnosticsAdvisory(p.file("src/a.ts"), { ...p.options, runCheck: check.runCheck });
    expect(new Set(check.runs.map((run) => run.output)).size).toBe(2);
  });

  it("hands the slot to a run that missed the deadline, and stays silent (busy) while it lives", async () => {
    const p = project({ "src/a.ts": "export const a = 1;\n" }, "stub");
    const detached = fakeCheck((run) => {
      run.onSpawn(process.pid); // a live process now owns the slot
      return { kind: "timed-out", afterMs: 1 };
    });
    const first = await typeDiagnosticsAdvisory(p.file("src/a.ts"), { ...p.options, runCheck: detached.runCheck });
    expect(first.forOperator).toMatch(/did not finish within/);
    expect(existsSync(p.paths.slot)).toBe(true);

    const second = fakeCheck(() => completedWith("", p.root));
    expect(await typeDiagnosticsAdvisory(p.file("src/a.ts"), { ...p.options, runCheck: second.runCheck })).toEqual(NO_ADVISORY);
    expect(second.runs).toHaveLength(0);
  });

  it("lets only one of two concurrent edits run the check", async () => {
    const p = project({ "src/a.ts": "export const a = 1;\n" }, "stub");
    const check = fakeCheck(() => new Promise((settle) => setTimeout(() => settle(completedWith("", p.root)), 50)));
    const options = { ...p.options, runCheck: check.runCheck };
    await Promise.all([typeDiagnosticsAdvisory(p.file("src/a.ts"), options), typeDiagnosticsAdvisory(p.file("src/a.ts"), options)]);
    expect(check.runs).toHaveLength(1);
  });

  it.each<[string, (output: string) => string]>([
    ["a dead owner", (output) => JSON.stringify({ pid: deadPid(), startedAt: Date.now(), output })],
    ["a live owner older than the stale age", (output) => JSON.stringify({ pid: process.pid, startedAt: Date.now() - STALE_RUN_MS - 1, output })],
    ["an unreadable record", () => "not json"],
  ])("reclaims a slot held by %s, removing its leftover output", async (_label, record) => {
    const p = project({ "src/a.ts": "export const a = 1;\n" }, "stub");
    const leftover = join(p.options.cacheDir!, "leftover.out");
    writeFileSync(leftover, "old");
    writeFileSync(p.paths.slot, record(leftover));

    const check = fakeCheck(() => completedWith("", p.root));
    await typeDiagnosticsAdvisory(p.file("src/a.ts"), { ...p.options, runCheck: check.runCheck });
    expect(check.runs).toHaveLength(1);
    expect(existsSync(p.paths.slot)).toBe(false);
    if (record(leftover).startsWith("{")) expect(existsSync(leftover)).toBe(false);
  });

  it("never removes a file outside the cache directory named by a slot record", async () => {
    const p = project({ "src/a.ts": "export const a = 1;\n" }, "stub");
    const outside = p.file("src/keep.txt");
    writeFileSync(outside, "keep");
    writeFileSync(p.paths.slot, JSON.stringify({ pid: deadPid(), startedAt: Date.now(), output: outside }));
    await typeDiagnosticsAdvisory(p.file("src/a.ts"), { ...p.options, runCheck: fakeCheck(() => completedWith("", p.root)).runCheck });
    expect(readFileSync(outside, "utf-8")).toBe("keep");
  });

  it("reports a failed run to the operator, leaves memory untouched and releases the slot", async () => {
    const p = project({ "src/a.ts": "export const a = 1;\n" }, "stub");
    const check = fakeCheck(() => ({ kind: "failed", reason: "tsc exited with 1 without diagnostics" }));
    const advisory = await typeDiagnosticsAdvisory(p.file("src/a.ts"), { ...p.options, runCheck: check.runCheck });
    expect(advisory).toEqual({ forModel: null, forOperator: "Loom type diagnostics could not run: tsc exited with 1 without diagnostics" });
    expect(existsSync(p.paths.memory)).toBe(false);
    expect(existsSync(p.paths.slot)).toBe(false);
  });

  it("never throws: a throwing check becomes an operator note and the slot is released", async () => {
    const p = project({ "src/a.ts": "export const a = 1;\n" }, "stub");
    const check = fakeCheck(() => { throw new Error("adapter exploded"); });
    const advisory = await typeDiagnosticsAdvisory(p.file("src/a.ts"), { ...p.options, runCheck: check.runCheck });
    expect(advisory).toEqual({ forModel: null, forOperator: "Loom type diagnostics could not run: adapter exploded" });
    expect(existsSync(p.paths.slot)).toBe(false);
  });

  it("treats corrupt memory as no baseline, then replaces it", async () => {
    const p = project({ "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n" }, "stub");
    writeFileSync(p.paths.memory, "{ corrupt");
    const elsewhere: TypeCheckOutcome = {
      kind: "completed",
      diagnostics: [{ file: p.file("src/b.ts"), line: 1, column: 1, code: 2304, message: "Cannot find name 'q'." }],
      global: [],
    };
    const advisory = await typeDiagnosticsAdvisory(p.file("src/a.ts"), { ...p.options, runCheck: fakeCheck(() => elsewhere).runCheck });
    expect(advisory).toEqual(NO_ADVISORY);
    expect(parseTypeCheckMemory(JSON.parse(readFileSync(p.paths.memory, "utf-8")))).not.toBeNull();
  });

  it("judges against the injected clock", async () => {
    const p = project({ "src/a.ts": "export const a = 1;\n" }, "stub");
    await typeDiagnosticsAdvisory(p.file("src/a.ts"), { ...p.options, now: () => 42, runCheck: fakeCheck(() => completedWith("", p.root)).runCheck });
    expect(parseTypeCheckMemory(JSON.parse(readFileSync(p.paths.memory, "utf-8")))?.recordedAt).toBe(42);
  });

  it("ignores non-TypeScript files and declaration files without touching the cache", async () => {
    const p = project({ "src/a.js": "x", "src/a.d.ts": "export declare const a: number;\n" }, "stub");
    const check = fakeCheck(() => completedWith("", p.root));
    expect(await typeDiagnosticsAdvisory(p.file("src/a.js"), { ...p.options, runCheck: check.runCheck })).toEqual(NO_ADVISORY);
    expect(await typeDiagnosticsAdvisory(p.file("src/a.d.ts"), { ...p.options, runCheck: check.runCheck })).toEqual(NO_ADVISORY);
    expect(check.runs).toHaveLength(0);
    expect(readdirSync(p.options.cacheDir!)).toEqual([]);
  });

  it("is switched off by LOOM_TYPE_DIAGNOSTICS=off", async () => {
    const p = project({ "src/a.ts": "export const a: number = 'x';\n" }, "stub");
    const check = fakeCheck(() => completedWith(BROKEN, p.root));
    const advisory = await typeDiagnosticsAdvisory(p.file("src/a.ts"), { ...p.options, runCheck: check.runCheck, env: { LOOM_TYPE_DIAGNOSTICS: "off" } });
    expect(advisory).toEqual(NO_ADVISORY);
    expect(check.runs).toHaveLength(0);
  });

  it("stays silent where no project TypeScript exists", async () => {
    const p = project({ "src/a.ts": "export const a: number = 'x';\n" }, "none");
    const check = fakeCheck(() => completedWith(BROKEN, p.root));
    expect(await typeDiagnosticsAdvisory(p.file("src/a.ts"), { ...p.options, runCheck: check.runCheck })).toEqual(NO_ADVISORY);
    expect(check.runs).toHaveLength(0);
  });
});

describe("typeDiagnosticsAdvisory against a real tsc", () => {
  it("says nothing for a file that typechecks", async () => {
    const p = project({ "src/a.ts": "export const a: number = 1;\n" });
    expect(await typeDiagnosticsAdvisory(p.file("src/a.ts"), p.options)).toEqual(NO_ADVISORY);
  }, 60_000);

  it("reports the touched file's type error with its remedy, and a caller this edit broke", async () => {
    const p = project({
      "src/price.ts": "export const price = (amount: number, rate: number): number => amount * rate;\n",
      "src/checkout.ts": "import { price } from './price';\nexport const total = price(10, 2);\n",
    });
    // Baseline run: clean.
    expect((await typeDiagnosticsAdvisory(p.file("src/price.ts"), p.options)).forModel).toBeNull();

    // The edit: a wrong return value in price.ts, and a signature change that breaks checkout.ts.
    write(p.root, { "src/price.ts": "export const price = (amount: number): number => 'free';\n" });
    const advisory = await typeDiagnosticsAdvisory(p.file("src/price.ts"), p.options);
    expect(advisory.forModel).toContain("src/price.ts");
    expect(advisory.forModel).toContain("TS2322");
    expect(advisory.forModel).toContain("Never silence it with `as`");
    expect(advisory.forModel).toContain("src/checkout.ts");
    expect(advisory.forModel).toContain("TS2554");
  }, 120_000);

  it("escalates the repeat reminder across real consecutive runs", async () => {
    const p = project({ "src/a.ts": "export const a: number = 'x';\n" });
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await typeDiagnosticsAdvisory(p.file("src/a.ts"), p.options));
    expect(runs[1]!.forModel).not.toContain("consecutive edits");
    expect(runs[2]!.forModel).toContain("survived 3 consecutive edits");
  }, 120_000);

  it("leaves a build that missed the deadline running, and a second check is busy rather than timed out", async () => {
    const p = project({ "src/a.ts": "export const a: number = 'x';\n" });
    const advisory = await typeDiagnosticsAdvisory(p.file("src/a.ts"), { ...p.options, deadlineMs: 1 });
    expect(advisory.forModel).toBeNull();
    expect(advisory.forOperator).toMatch(/did not finish within/);

    const owner: { pid: number } = JSON.parse(readFileSync(p.paths.slot, "utf-8"));
    expect(await typeDiagnosticsAdvisory(p.file("src/a.ts"), { ...p.options, deadlineMs: 1 })).toEqual(NO_ADVISORY);

    // Let the detached build finish before its project is removed.
    await waitForExit(owner.pid, 60_000);
    expect(isAlive(owner.pid)).toBe(false);
  }, 90_000);

  it.each<[string, RegExp]>([
    ["process.stderr.write('boom'); process.exit(7);\n", /could not run: tsc exited with 7: boom/],
    ["process.stderr.write('TypeError: x is undefined'); process.exit(1);\n", /could not run: tsc exited with 1 without diagnostics: TypeError: x is undefined/],
  ])("reports a compiler that crashes to the operator (%s)", async (tsc, note) => {
    const p = project({ "src/a.ts": "export const a = 1;\n" }, "none");
    write(p.root, { "node_modules/typescript/lib/tsc.js": tsc });
    const advisory = await typeDiagnosticsAdvisory(p.file("src/a.ts"), p.options);
    expect(advisory.forModel).toBeNull();
    expect(advisory.forOperator).toMatch(note);
    expect(existsSync(p.paths.memory)).toBe(false);
  }, 60_000);
});
