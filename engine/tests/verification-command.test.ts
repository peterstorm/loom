import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile, type ExecFileException } from "node:child_process";
import vitestConfig from "../vitest.config";
import { freezeVerificationManifest } from "../src/core/verification-manifest";
import { MAX_STRUCTURED_REPORT_BYTES, parseStructuredTestReportBytes } from "../src/core/structured-test-report";

const repository = resolve("..");
const rootPackage = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
const enginePackage = JSON.parse(readFileSync("package.json", "utf8"));
const temporaryDirectories: string[] = [];
afterEach(() => temporaryDirectories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

const smokeFiles = [
  ["scripts/smoke-panel-mode.sh", "panel"],
  ["scripts/smoke-review-panel.sh", "review"],
  ["scripts/smoke-standalone-review.sh", "standalone"],
  ["scripts/smoke-orchestration-facades.ts", "orchestration"],
  ["scripts/smoke-pi-resources.sh", "pi"],
  ["artifacts/tests/test-validate-task-graph.sh", "graph"],
] as const;
const stages = ["unit", ...smokeFiles.map(([, stage]) => stage)];

function fixture(failingStage: string): string {
  const directory = mkdtempSync(join(tmpdir(), "loom-verify-"));
  temporaryDirectories.push(directory);
  const put = (path: string, content: string): void => {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  put("package.json", JSON.stringify({ scripts: rootPackage.scripts }));
  put("engine/package.json", JSON.stringify({ type: "module", scripts: enginePackage.scripts }));
  put("engine/tsconfig.json", JSON.stringify({ compilerOptions: { types: [], strict: true }, files: ["input.ts"] }));
  put("engine/input.ts", failingStage === "compiler" ? "export const value: number = 'wrong';" : "export const value = 1;");
  put("sentinel.cjs", `const fs = require('node:fs');
const stage = process.argv[2];
if (process.env.PI_CODING_AGENT) process.exit(91);
fs.appendFileSync(${JSON.stringify(join(directory, "stages"))}, stage + '\\n');
if (stage === ${JSON.stringify(failingStage)}) process.exit(17);
`);
  put("engine/node_modules/.bin/vitest", `#!/usr/bin/env bash\nexec node ../sentinel.cjs unit\n`);
  chmodSync(join(directory, "engine/node_modules/.bin/vitest"), 0o755);
  put("node_modules/.bin/pi", "#!/usr/bin/env bash\nexit 92\n");
  chmodSync(join(directory, "node_modules/.bin/pi"), 0o755);
  for (const [path, stage] of smokeFiles) {
    put(path, path.endsWith(".ts")
      ? `import { spawnSync } from 'node:child_process'; process.exit(spawnSync('node', ['../sentinel.cjs', '${stage}'], {stdio:'inherit'}).status ?? 1);`
      : `#!/usr/bin/env bash\nexec node ../sentinel.cjs ${stage}\n`);
  }
  mkdirSync(join(directory, "engine/scripts"), { recursive: true });
  mkdirSync(join(directory, "engine/src/core"), { recursive: true });
  cpSync(resolve("scripts/typecheck.ts"), join(directory, "engine/scripts/typecheck.ts"));
  cpSync(resolve("scripts/verify-prerequisites.sh"), join(directory, "engine/scripts/verify-prerequisites.sh"));
  cpSync(resolve("scripts/bun-version-pin.ts"), join(directory, "engine/scripts/bun-version-pin.ts"));
  cpSync(join(repository, ".bun-version"), join(directory, ".bun-version"));
  cpSync(resolve("src/core/compiler-diagnostic-policy.ts"), join(directory, "engine/src/core/compiler-diagnostic-policy.ts"));
  symlinkSync(resolve("node_modules/typescript"), join(directory, "engine/node_modules/typescript"), "dir");
  return directory;
}

type VerificationExit = Readonly<{
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: ExecFileException | undefined;
}>;

function runVerification(directory: string, env: NodeJS.ProcessEnv = process.env): Promise<VerificationExit> {
  return new Promise((resolve) => {
    const child = execFile("npm", ["run", "verify"], {
      cwd: directory, encoding: "utf8", timeout: 15_000, env,
    }, async (error, stdout, stderr) => {
      // Spawn-error callbacks can precede close; always await pipe cleanup.
      await closed;
      // Numeric exit errors are status; spawn/timeout/signal/buffer failures are not.
      const ordinaryExit = error !== null && typeof error.code === "number"
        && error.code === child.exitCode && !error.killed && child.signalCode === null;
      resolve({
        status: child.exitCode,
        signal: child.signalCode,
        stdout,
        stderr,
        error: ordinaryExit ? undefined : error ?? undefined,
      });
    });
    const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
  });
}

describe("canonical verification command", () => {
  it("allows event-loop progress while awaiting the actual verification child", async () => {
    const directory = fixture("none");
    let progressed = false;
    const marker = setImmediate(() => { progressed = true; });
    try {
      const result = await runVerification(directory, { ...process.env, PI_CODING_AGENT: "true" });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      // Awaiting a synchronous result only queues a microtask; it cannot run this marker.
      expect(progressed).toBe(true);
    } finally {
      clearImmediate(marker);
    }
  });

  it("retains spawn failure diagnostics instead of converting them to an exit status", async () => {
    const directory = fixture("none");
    rmSync(directory, { recursive: true, force: true });
    const result = await runVerification(directory);
    expect(result.error).toMatchObject({ code: "ENOENT" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("has one compiler gate followed by the existing complete test command", () => {
    expect(rootPackage.scripts.verify).toBe("npm --prefix engine run verify");
    expect(enginePackage.scripts.preverify).toBe("bash scripts/verify-prerequisites.sh");
    expect(enginePackage.scripts.verify).toBe("npm run typecheck && npm run test");
    expect(enginePackage.scripts.typecheck).toBe("bun scripts/typecheck.ts");
    expect(enginePackage.scripts["typecheck:unused"]).toBe("npm run typecheck");
    expect(enginePackage.scripts.test).toBe("npm run test:unit && env -u PI_CODING_AGENT npm run test:smoke");
    expect(enginePackage.scripts["test:unit"]).toBe("env -u PI_CODING_AGENT vitest run --reporter=default --reporter=junit --outputFile=../.loom/completion-reports/verify.junit.xml");
    expect(enginePackage.scripts["test:smoke"]).toBe(smokeFiles.map(([path]) => `${path.endsWith(".ts") ? "bun" : "bash"} ../${path}`).join(" && "));
  });

  it("keeps the suite's runner policy in the checked config every entry point loads", () => {
    // Timeout, worker budget and the per-test event-loop turn live in
    // vitest.config.ts, not CLI flags, so `npm run test:unit` and a direct
    // `npx vitest run` run the same suite. Without the turn, back-to-back
    // synchronous tests starve the worker's `onTaskUpdate` RPC reply past its
    // fixed 60s timer and fail fully green runs.
    const test = vitestConfig.test!;
    expect(test.testTimeout).toBe(15_000);
    // Membership, not order: the load-bearing setup files run before every
    // test file, whatever else the config adds beside them.
    expect(test.setupFiles).toEqual(expect.arrayContaining(["./tests/setup/scrub-parent-model.ts", "./tests/setup/task-update-yield.ts"]));
    // The fake local Pi route lives in the main process: workers' spawnSync children could not reach a worker-local server.
    expect(test.globalSetup).toEqual(expect.arrayContaining(["./tests/setup/fixture-pi-route.ts"]));
  });

  // The config sizes its worker pool from the host it loads on. Loading it
  // under fixed host shapes proves it applies the platform budget to the
  // host's real core count; the policy's full table is pinned in
  // vitest-worker-budget.test.ts.
  it.each([
    { platform: "linux", cores: 64, maxWorkers: 4 },
    { platform: "linux", cores: 2, maxWorkers: 2 },
    { platform: "darwin", cores: 3, maxWorkers: 2 },
  ] as const)("sizes the worker pool of a $platform host with $cores cores at $maxWorkers", async ({ platform, cores, maxWorkers }) => {
    const hostPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    vi.doMock("node:os", async (importOriginal) => ({ ...await importOriginal<typeof import("node:os")>(), availableParallelism: () => cores }));
    Object.defineProperty(process, "platform", { ...hostPlatform, value: platform });
    try {
      vi.resetModules();
      const { default: config } = await import("../vitest.config");
      expect(config.test!.maxWorkers).toBe(maxWorkers);
    } finally {
      Object.defineProperty(process, "platform", hostPlatform);
      vi.doUnmock("node:os");
      vi.resetModules();
    }
  });

  it("missing local Pi is blocked even if a global Pi is on PATH", async () => {
    const directory = fixture("none");
    mkdirSync(join(directory, "global-bin"));
    cpSync(join(directory, "node_modules/.bin/pi"), join(directory, "global-bin/pi"));
    rmSync(join(directory, "node_modules/.bin/pi"));
    const result = await runVerification(directory, {
      ...process.env, PATH: `${join(directory, "global-bin")}:${process.env.PATH}`,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Verification blocked: install both frozen locks");
    expect(result.stdout).not.toContain("typecheck.ts");
    expect(() => readFileSync(join(directory, "stages"))).toThrow();
  });

  it("a local Bun other than the .bun-version pin is blocked before the compiler or any suite stage", async () => {
    const directory = fixture("none");
    writeFileSync(join(directory, ".bun-version"), "0.0.1\n");
    const result = await runVerification(directory);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Verification blocked: local Bun is \S+ but \.bun-version pins 0\.0\.1/);
    expect(result.stdout).not.toContain("typecheck.ts");
    expect(() => readFileSync(join(directory, "stages"))).toThrow();
  });

  it("the repository manifest freezes the same root command through the real parser", () => {
    const parsed = freezeVerificationManifest(readFileSync(join(repository, ".loom/verification-manifest.json")));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error.errors.join("\n"));
    expect(parsed.value.projectChecks).toHaveLength(1);
    expect(parsed.value.projectChecks[0]).toEqual({
      kind: "project-command", checkId: "project:verify", executable: "npm", args: ["run", "verify"], cwd: ".", scope: "wave", timeoutMs: 1_800_000,
      reportPolicy: { kind: "required-file", path: ".loom/completion-reports/verify.junit.xml" },
    });
  });

  it.each([
    { failingStage: "none", exitCode: 0, failed: 0, summary: "2 passed | 1 skipped (3)", expectedStages: stages },
    { failingStage: "unit", exitCode: 1, failed: 1, summary: "1 failed | 1 passed | 1 skipped (3)", expectedStages: ["unit"] },
    { failingStage: "graph", exitCode: 17, failed: 0, summary: "2 passed | 1 skipped (3)", expectedStages: stages },
  ])("installed Vitest writes root JUnit once; $failingStage failure still controls root exit", async ({ failingStage, exitCode, failed, summary, expectedStages }) => {
    const directory = fixture(failingStage);
    // Use the installed runner and its real reporter, not the composition sentinel.
    rmSync(join(directory, "engine/node_modules/.bin/vitest"));
    symlinkSync(resolve("node_modules/.bin/vitest"), join(directory, "engine/node_modules/.bin/vitest"));
    symlinkSync(resolve("node_modules/vitest"), join(directory, "engine/node_modules/vitest"), "dir");
    writeFileSync(join(directory, "engine/enrollment.test.ts"), `
import { beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
beforeAll(() => appendFileSync(${JSON.stringify(join(directory, "stages"))}, 'unit\\n'));
describe('enrollment', () => {
  it('normalizes the environment', () => expect(process.env.PI_CODING_AGENT).toBeUndefined());
  describe('nested', () => {
    it('executes a real assertion', () => expect(${JSON.stringify(failingStage)}).not.toBe('unit'));
    it.skip('does not count as executed', () => expect(true).toBe(false));
  });
});
`);
    const result = await runVerification(directory, {
      ...process.env, PI_CODING_AGENT: "true", NO_COLOR: "1", FORCE_COLOR: "0",
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stdout + result.stderr).toBe(exitCode);
    expect(result.stdout).toContain(enginePackage.scripts["test:unit"]);
    expect(result.stdout).toContain(summary);
    expect(readFileSync(join(directory, "stages"), "utf8").trim().split("\n")).toEqual(expectedStages);
    const bytes = readFileSync(join(directory, ".loom/completion-reports/verify.junit.xml"));
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.byteLength).toBeLessThan(MAX_STRUCTURED_REPORT_BYTES);
    const parsed = parseStructuredTestReportBytes(bytes);
    expect(parsed).toEqual({ ok: true, value: { total: 2, failed, source: "junit-xml" } });
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(Number.isSafeInteger(parsed.value.total)).toBe(true);
    expect(parsed.value.total).toBeGreaterThan(0);
  });

  it.each(["none", "compiler", ...stages])("real npm composition short-circuits after %s, never recursively runs the suite", async (failingStage) => {
    const directory = fixture(failingStage);
    const result = await runVerification(directory, { ...process.env, PI_CODING_AGENT: "true" });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stdout + result.stderr).toBe(failingStage === "none" ? 0 : failingStage === "compiler" ? 1 : 17);
    if (failingStage === "compiler") {
      expect(result.stderr).toContain("TS2322");
      expect(() => readFileSync(join(directory, "stages"))).toThrow();
    } else {
      const expected = failingStage === "none" ? stages : stages.slice(0, stages.indexOf(failingStage) + 1);
      expect(readFileSync(join(directory, "stages"), "utf8").trim().split("\n")).toEqual(expected);
    }
  });
});
