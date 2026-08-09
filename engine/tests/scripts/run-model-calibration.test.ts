import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { readonly dir: string; readonly corpus: string; readonly output: string; readonly bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "loom-model-calibration-"));
  tempDirs.push(dir);
  const corpus = join(dir, "corpus.json");
  const output = join(dir, "result.json");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(corpus, JSON.stringify({
    schema_version: 1,
    cases: [{
      id: "failing-pi",
      state: "fixed",
      revision: "4927f0c",
      expected_criticals: [{
        id: "known-finding",
        claim: "a known critical",
        file: "engine/src/core/findings.ts",
        line: null,
        aliases: [],
        match: { all_of: ["known"], any_of: ["critical"] },
      }],
      context: {},
    }],
  }));
  const pi = join(bin, "pi");
  writeFileSync(pi, "#!/bin/sh\necho 'simulated provider failure' >&2\nexit 7\n");
  chmodSync(pi, 0o755);
  return { dir, corpus, output, bin };
}

describe("run-model-calibration", () => {
  it("persists diagnostics but exits nonzero when any Pi case is not executed", () => {
    const f = fixture();
    const run = spawnSync("bun", [
      "scripts/run-model-calibration.ts",
      "--corpus", f.corpus,
      "--output", f.output,
    ], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        LOOM_RUN_MODEL_CALIBRATION: "1",
        PATH: `${f.bin}:${process.env.PATH ?? ""}`,
      },
    });

    expect(run.status).toBe(1);
    expect(run.stdout.trim()).toBe(f.output);
    expect(run.stderr).toContain("Calibration execution: 0/1 executed, 1 not executed.");
    expect(JSON.parse(readFileSync(f.output, "utf-8"))).toMatchObject({
      cases: [{ case_id: "failing-pi", status: "not-executed", reason: "simulated provider failure" }],
    });
  });
});
