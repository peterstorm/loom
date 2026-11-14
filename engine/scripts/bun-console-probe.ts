/**
 * The Bun console probe (ADR-0064). Loom reads a Bun run's collection errors
 * from its console, whose grammar is pinned by fixtures recorded from a real
 * Bun, each named for the release that printed it. This module is the one
 * recorder of that output: it builds the probe project, runs the `bun` on PATH
 * against it under both consoles Bun prints (an agent's and the plain one), and
 * returns what Bun printed with the run's incidental bytes (the scratch path,
 * the build hash, timings, the host name) normalized away.
 *
 * Two readers: `tests/machine/bun-console-pinned-release.test.ts` runs it on
 * every suite and holds the installed Bun to the fixtures recorded for the
 * pinned release, and this file's command line records them:
 *
 *   bun engine/scripts/bun-console-probe.ts   # writes tests/fixtures/bun-<version>-*
 *
 * Moving `.bun-version` therefore means recording the new release's fixtures,
 * or the suite says the pinned release has none.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBunVersion, type BunVersion } from "./bun-version-pin";

/** The probe project. `a.test.ts` imports a module that does not exist, so it
 *  never loads; `b.test.ts` passes; `c.test.ts` has one failing testcase, a
 *  nested describe and a top-level test (an empty JUnit classname). */
const PROBE_FILES: Readonly<Record<string, string>> = {
  "package.json": '{"name":"probe","private":true}\n',
  "src/a.test.ts": [
    'import { thing } from "./missing";',
    'import { test, expect } from "bun:test";',
    'test("never runs", () => { expect(thing).toBe(1); });',
    "",
  ].join("\n"),
  "src/b.test.ts": [
    'import { describe, test, expect } from "bun:test";',
    'describe("ok", () => { test("passes", () => { expect(1).toBe(1); }); });',
    "",
  ].join("\n"),
  "src/c.test.ts": [
    'import { describe, test, expect } from "bun:test";',
    'describe("outer", () => {',
    '  describe("inner", () => { test("nested passes", () => { expect(1).toBe(1); }); });',
    '  test("fails", () => { expect(1).toBe(2); });',
    "});",
    'test("top level", () => { expect(1).toBe(1); });',
    "",
  ].join("\n"),
};

/** Where the probe project appears in a recorded fixture. */
const RECORDED_PROJECT = "/repo/pkg";

/** The recordings of one release. Bun prints two consoles: under an agent it
 *  omits passing tests, and a `.console.txt` is that one, recorded with
 *  `CLAUDECODE` set as Claude Code sets it, the console a Claude Code hook
 *  reads; `.plain.console.txt` is the full one, recorded with no agent
 *  variable set. */
export const BUN_CONSOLE_FIXTURE_KINDS = [
  "mixed.console.txt",
  "mixed.plain.console.txt",
  "mixed.junit.xml",
  "load-failure-only.console.txt",
] as const;
export type BunConsoleFixtureKind = (typeof BUN_CONSOLE_FIXTURE_KINDS)[number];

/** A recording's file name: the release that printed it, then what it is. */
export const bunConsoleFixtureName = (release: BunVersion, kind: BunConsoleFixtureKind): string => `bun-${release}-${kind}`;

/** What one Bun printed for the probe, normalized. */
export type BunConsoleCapture = Readonly<{
  version: BunVersion;
  /** Every recording, keyed as its fixture file is named. */
  recordings: Readonly<Record<BunConsoleFixtureKind, string>>;
  /** Whether Bun wrote a JUnit report for the run whose only file never loaded (ADR-0064: it does not). */
  loadFailureWroteJunit: boolean;
}>;

/**
 * Bun's output with the bytes that differ between two runs of one release
 * replaced by fixed ones: the scratch project path, the build hash on the
 * banner, and the JUnit `time` and `hostname` attributes. A console duration
 * is removed, space and all: Bun prints one only for a test slow enough to
 * register, so a loaded machine adds `[0.12ms]` where an idle one prints
 * nothing. Pure and idempotent; the grammar Loom reads (file headers, the
 * unhandled-error marker, testcase attributes) is untouched.
 */
export function normalizeBunOutput(text: string, project: string): string {
  return text
    .replaceAll(project, RECORDED_PROJECT)
    .replace(/^(bun test v\S+) \([0-9a-f]+\)$/mu, "$1 (0000000)")
    .replace(/ \[\d+(?:\.\d+)?m?s\]/gu, "")
    .replace(/ time="[^"]*"/gu, ' time="0"')
    .replace(/ hostname="[^"]*"/gu, ' hostname="probe"');
}

/** Which console a probe run asks Bun for. */
type ConsoleDialect = "agent" | "plain";

/** The environment a probe run sees: no colour, none of the caller's agent or
 *  CI variables (a CI one makes Bun print annotations), and `CLAUDECODE` only
 *  when the run asks for the agent console. */
const probeEnvironment = (dialect: ConsoleDialect): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  NO_COLOR: "1",
  ...(dialect === "agent" ? { CLAUDECODE: "1" } : {}),
});

/** The `bun` on PATH: its release, or why it named none. */
export type InstalledBun =
  | Readonly<{ ok: true; value: BunVersion }>
  | Readonly<{ ok: false; error: string }>;

/** Bun's own `--version`, parsed. A missing `bun`, a failed run and an
 *  unparseable line are each a value, so the caller decides how to report one. */
export function installedBunVersion(): InstalledBun {
  const printed = spawnSync("bun", ["--version"], { encoding: "utf8", env: probeEnvironment("plain") });
  if (printed.error !== undefined) return { ok: false, error: `\`bun --version\` failed: ${printed.error.message}` };
  if (printed.status !== 0) return { ok: false, error: `\`bun --version\` exited ${printed.status}: ${printed.stderr}` };
  const version = parseBunVersion(printed.stdout);
  return version === null
    ? { ok: false, error: `\`bun --version\` printed ${JSON.stringify(printed.stdout)}, not a Bun version` }
    : { ok: true, value: version };
}

/** Run `bun test` with a JUnit outfile in the probe project; its console and
 *  whether it wrote the report. stdout and stderr share one descriptor, so the
 *  console interleaves as a harness's merged output does. */
function runProbe(
  project: string,
  report: string,
  run: Readonly<{ dialect: ConsoleDialect; files: readonly string[] }>,
): Readonly<{ console: string; junit: string | null }> {
  const consolePath = `${report}.console`;
  const fd = openSync(consolePath, "w");
  let bun: ReturnType<typeof spawnSync>;
  try {
    bun = spawnSync("bun", ["test", "--reporter=junit", `--reporter-outfile=${report}`, ...run.files], {
      cwd: project,
      env: probeEnvironment(run.dialect),
      stdio: ["ignore", fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  const printed = readFileSync(consolePath, "utf8");
  if (bun.error !== undefined) throw bun.error;
  // Every probe run holds a failure, so any other exit means Bun ran something else.
  if (bun.status !== 1) throw new Error(`the Bun probe run exited ${bun.status}, expected 1:\n${printed}`);
  return { console: printed, junit: existsSync(report) ? readFileSync(report, "utf8") : null };
}

/** Run the installed Bun against a fresh probe project, and remove the project. */
export function captureBunConsole(): BunConsoleCapture {
  const installed = installedBunVersion();
  if (!installed.ok) throw new Error(installed.error);
  const version = installed.value;
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-bun-probe-")));
  try {
    const project = join(scratch, "pkg");
    for (const [path, content] of Object.entries(PROBE_FILES)) {
      mkdirSync(join(project, path, ".."), { recursive: true });
      writeFileSync(join(project, path), content);
    }
    const everyFile = ["src/c.test.ts", "src/a.test.ts", "src/b.test.ts"];
    const mixed = runProbe(project, join(scratch, "mixed.junit.xml"), { dialect: "agent", files: everyFile });
    const mixedPlain = runProbe(project, join(scratch, "mixed-plain.junit.xml"), { dialect: "plain", files: everyFile });
    const loadFailure = runProbe(project, join(scratch, "load-failure.junit.xml"), { dialect: "agent", files: ["src/a.test.ts"] });
    if (mixed.junit === null) throw new Error("Bun wrote no JUnit report for the mixed probe run");
    const normalize = (text: string) => normalizeBunOutput(text, project);
    return {
      version,
      recordings: {
        "mixed.console.txt": normalize(mixed.console),
        "mixed.plain.console.txt": normalize(mixedPlain.console),
        "mixed.junit.xml": normalize(mixed.junit),
        "load-failure-only.console.txt": normalize(loadFailure.console),
      },
      loadFailureWroteJunit: loadFailure.junit !== null,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixtures = fileURLToPath(new URL("../tests/fixtures/", import.meta.url));
  const capture = captureBunConsole();
  for (const kind of BUN_CONSOLE_FIXTURE_KINDS) {
    const path = join(fixtures, bunConsoleFixtureName(capture.version, kind));
    writeFileSync(path, capture.recordings[kind]);
    process.stdout.write(`recorded ${path}\n`);
  }
  if (capture.loadFailureWroteJunit) {
    process.stderr.write(`Bun ${capture.version} wrote a JUnit report for a run whose every file failed to load; ADR-0064 assumes it writes none\n`);
    process.exitCode = 1;
  }
}
