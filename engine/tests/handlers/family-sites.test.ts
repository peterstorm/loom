import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import familySites, { createFamilySitesHandler } from "../../src/handlers/helpers/family-sites";
import { FAMILIES } from "../../src/core/family-sites";
import { WHITELISTED_HELPERS } from "../../src/config";
import { KNOWN_HANDLERS, PI_RUNTIME_HANDSHAKE_ROUTES, piRuntimeHandshakeRequired } from "../../src/handler-routes";

const ENGINE_ROOT = resolve(__dirname, "../..");
const REPO_ROOT = resolve(ENGINE_ROOT, "..");
const CLI_PATH = join(ENGINE_ROOT, "src", "cli.ts");

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A throwaway repository root holding `files` (repo-relative path → text). */
function repository(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "loom-family-sites-"));
  cleanup.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const FIXTURE = {
  "engine/src/handlers/probe.ts": "import { existsSync } from 'node:fs';\nif (existsSync(p)) run();\n",
  "engine/src/core/words.ts": "const words = text.split(/\\s+/);\n",
  "engine/src/core/view.ts": "const patch = {\n  critical_findings: [],\n};\n",
  "engine/src/utils/path-presence.ts": "existsSync(owner);\n",
  "engine/src/handlers/probe.test.ts": "existsSync(test);\n",
  "engine/tests/probe.ts": "existsSync(outside);\n",
} as const;

type Run = Readonly<{ result: Awaited<ReturnType<ReturnType<typeof createFamilySitesHandler>>>; output: string }>;

async function run(args: string[]): Promise<Run> {
  const writes: string[] = [];
  const result = await createFamilySitesHandler((text) => { writes.push(text); })("", args);
  return { result, output: writes.join("") };
}

describe("helper family-sites", () => {
  it("is routed as a read-only helper: not whitelisted in the guard, no Pi runtime handshake", () => {
    expect(KNOWN_HANDLERS.helper?.has("family-sites")).toBe(true);
    expect(WHITELISTED_HELPERS).not.toContain("family-sites");
    expect(PI_RUNTIME_HANDSHAKE_ROUTES.has("helper/family-sites")).toBe(false);
    expect(piRuntimeHandshakeRequired("helper", "family-sites")).toBe(false);
    expect(typeof familySites).toBe("function");
  });

  it("AS-031: --json --root reports each family's count and path:line sites outside its owners", async () => {
    const root = repository(FIXTURE);

    const { result, output } = await run(["--json", "--root", root]);

    expect(result).toEqual({ kind: "passthrough" });
    const report = JSON.parse(output);
    expect(report.schema).toBe(1);
    expect(report.families.map((family: { family: string }) => family.family)).toEqual(FAMILIES.map(({ id }) => id));
    expect(report.families[0]).toMatchObject({ family: "fail-closed-path-probes", count: 1, sites: ["engine/src/handlers/probe.ts:2"] });
    expect(report.families[1]).toMatchObject({ family: "shell-tokenizing", count: 1, sites: ["engine/src/core/words.ts:1"] });
    expect(report.families[2]).toMatchObject({ family: "claim-conservation", count: 1, sites: ["engine/src/core/view.ts:2"] });
    expect(report.delta).toBeUndefined();
  });

  it("AS-031: prints the human report by default", async () => {
    const root = repository(FIXTURE);

    const { result, output } = await run(["--root", root]);

    expect(result).toEqual({ kind: "passthrough" });
    expect(output).toContain("fail-closed-path-probes: 1 raw site outside engine/src/utils/path-presence.ts");
    expect(output).toContain("  engine/src/handlers/probe.ts:2");
    expect(() => JSON.parse(output)).toThrow();
  });

  it("AS-031: does not follow a symlink out of the scanned tree", async () => {
    const outside = repository({ "elsewhere.ts": "existsSync(x);\n" });
    const root = repository(FIXTURE);
    symlinkSync(outside, join(root, "engine/src/linked"));

    const { output } = await run(["--json", "--root", root]);

    expect(JSON.parse(output).families[0].sites).toEqual(["engine/src/handlers/probe.ts:2"]);
  });

  it("AS-032: two runs over the same bytes print identical output", async () => {
    const root = repository(FIXTURE);

    const first = await run(["--json", "--root", root]);
    const second = await run(["--json", "--root", root]);
    const human = [await run(["--root", root]), await run(["--root", root])];

    expect(second.output).toBe(first.output);
    expect(human[1]!.output).toBe(human[0]!.output);
  });

  it("AS-032: the repository's own scan is identical across runs and sorted", async () => {
    const first = await run(["--json"]);
    const second = await run(["--json"]);

    expect(first.result).toEqual({ kind: "passthrough" });
    expect(second.output).toBe(first.output);
    for (const family of JSON.parse(first.output).families) {
      expect(family.count).toBe(family.sites.length);
      for (const site of family.sites) expect(site).toMatch(/^engine\/src\/.+\.ts:\d+$/);
    }
  });

  it("AS-033: --baseline reports the per-family delta in JSON and human output", async () => {
    const base = repository(FIXTURE);
    const baselinePath = join(repository({}), "baseline.json");
    writeFileSync(baselinePath, (await run(["--json", "--root", base])).output);
    const root = repository({
      ...FIXTURE,
      "engine/src/handlers/more.ts": "existsSync(a);\nexistsSync(b);\n",
      "engine/src/core/view.ts": "const x = 1;\n",
    });

    const json = await run(["--json", "--root", root, "--baseline", baselinePath]);
    const human = await run(["--root", root, "--baseline", baselinePath]);

    expect(json.result).toEqual({ kind: "passthrough" });
    expect(JSON.parse(json.output).delta).toEqual([
      { kind: "compared", family: "fail-closed-path-probes", baseline: 1, current: 3, delta: 2, patternsChanged: false },
      { kind: "compared", family: "shell-tokenizing", baseline: 1, current: 1, delta: 0, patternsChanged: false },
      { kind: "compared", family: "claim-conservation", baseline: 1, current: 0, delta: -1, patternsChanged: false },
    ]);
    expect(human.output).toContain("fail-closed-path-probes: 3 (baseline 1, +2)");
    expect(human.output).toContain("shell-tokenizing: 1 (baseline 1, ±0)");
    expect(human.output).toContain("claim-conservation: 0 (baseline 1, -1)");
  });

  it("AS-033: the recorded baseline parses and compares against the live repository", async () => {
    const baseline = JSON.parse(readFileSync(join(REPO_ROOT, "docs/family-sites.baseline.json"), "utf-8"));
    expect(baseline.families.map((family: { family: string }) => family.family)).toEqual(FAMILIES.map(({ id }) => id));

    const { result, output } = await run(["--json", "--baseline", join(REPO_ROOT, "docs/family-sites.baseline.json")]);

    expect(result).toEqual({ kind: "passthrough" });
    const delta = JSON.parse(output).delta;
    expect(delta.map((entry: { family: string }) => entry.family)).toEqual(FAMILIES.map(({ id }) => id));
    for (const entry of delta) expect(entry).toMatchObject({ kind: "compared", patternsChanged: false });
  });

  it("refuses an unreadable or malformed baseline, a missing root, and unknown arguments", async () => {
    const root = repository(FIXTURE);
    const dir = repository({ "bad.json": "{not json", "wrong.json": "{\"schema\":9,\"families\":[]}" });

    const missingBaseline = await run(["--root", root, "--baseline", join(dir, "absent.json")]);
    expect(missingBaseline.result).toMatchObject({ kind: "error" });
    expect(missingBaseline.output).toBe("");

    const badJson = await run(["--root", root, "--baseline", join(dir, "bad.json")]);
    expect(badJson.result).toMatchObject({ kind: "error", message: expect.stringContaining("bad.json") });

    const wrongSchema = await run(["--root", root, "--baseline", join(dir, "wrong.json")]);
    expect(wrongSchema.result).toMatchObject({ kind: "error", message: expect.stringContaining("schema") });

    const noSources = await run(["--root", join(dir, "nowhere")]);
    expect(noSources.result).toMatchObject({ kind: "error", message: expect.stringContaining("engine/src") });

    const unknown = await run(["--root", root, "--verbose"]);
    expect(unknown.result).toMatchObject({ kind: "error", message: expect.stringContaining("--verbose") });

    const valueless = await run(["--root"]);
    expect(valueless.result).toMatchObject({ kind: "error", message: expect.stringContaining("--root") });
  });

  it("runs through the CLI route", () => {
    const root = repository(FIXTURE);
    const { PI_CODING_AGENT: _pi, ...env } = process.env;

    const child = spawnSync("bun", [CLI_PATH, "helper", "family-sites", "--json", "--root", root], {
      env, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    });

    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout).families[0].sites).toEqual(["engine/src/handlers/probe.ts:2"]);
  }, 30_000);
});
