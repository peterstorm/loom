/**
 * The handler's own evidence rules — the ones a hunter can otherwise satisfy
 * with prose:
 *
 *   INV-S1  a `local` check is a claim that something was OBSERVED, so the
 *           engine reads the receipt that check names and refuses a run that
 *           did not stay inside its sandbox;
 *   INV-S2b `--force` starts a NEW run, so nothing from the previous one may
 *           survive into the new directory;
 *   INV-S6c `findings` reports what blocks publication alongside the findings,
 *           because a projection that drops the blockers reads as a green run.
 *
 * And the binding a local check rests on: a hunter cannot compute its sandbox
 * nonce, so `nonce` prints it — for an artifact of an owner hunting right now —
 * and a receipt made with what it printed is one `submit` accepts.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandboxNonce, sandboxReceiptPrefix } from "../../src/core/security-sandbox";
import { LOOM_PACKAGE_ROOT } from "../../src/utils/loom-package-root";
import { HUNTER_ENVELOPE } from "../security/fixtures";
import { aSandboxReceipt } from "../security/sandbox-fixtures";
import { aRun, assignUnit, isolateSubagentDir, removeRuns, startInvocation, startRun, unitIdFor, writeArtifact } from "./security-audit-harness";
import type { Invocation, Run } from "./security-audit-run-seam";

/** The start every evidence test begins with: one unit, a budget, typed signals, `--repo` the run itself. */
const EVIDENCE_START = { flags: ["--budget", "12"], signals: { languages: ["typescript"], servesHttp: true } } as const;

const start = (run: Run): Promise<Run> => startRun(run, EVIDENCE_START);

/** A started run whose unit 0 is in flight under the catalog hunter: where every receipt and nonce test begins. */
const assignedRun = async (): Promise<Run> => {
  const run = await start(aRun());
  await assignUnit(run, 0);
  return run;
};

/** A receipt is bound to the artifact path the ledger names — the same
 *  derivation the handler performs, because a receipt the engine cannot bind is
 *  not evidence. The body is the script's own shape (`aSandboxReceipt`). */
const receiptFor = (artifact: string, overrides: Record<string, unknown> = {}): string =>
  `${sandboxReceiptPrefix(sandboxNonce(artifact))}${aSandboxReceipt(overrides)}\n`;

const aLocalCheck = (artifact: string): Record<string, unknown> => ({
  agent_id: "security-hunter-agent",
  reviewed_paths: ["src/subsystem-0/entry.ts"],
  invariant: "A quote in the email field cannot change the query.",
  method: "local",
  result: "The payload returned the admin row.",
  artifact,
});

const submitLocal = async (run: Run, artifact: string): Promise<Invocation> =>
  run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE,
    units: [{
      coverageId: unitIdFor(0),
      agentId: "security-hunter-agent",
      wave: 1,
      status: "candidate",
      reviewedPaths: ["src/subsystem-0/entry.ts"],
      checks: [aLocalCheck(artifact)],
      fingerprints: ["api/login:sqli-email"],
    }],
    findings: [],
  }));

beforeEach(() => { isolateSubagentDir(); });
afterEach(removeRuns);

describe("a local check must name a receipt that proves a bounded run (INV-S1)", () => {
  it("accepts a check whose receipt is in limits", async () => {
    const run = await assignedRun();
    const artifact = "agents/security-hunter-agent/artifacts/sqli.json";
    writeArtifact(run, artifact, receiptFor(artifact));

    expect((await submitLocal(run, artifact)).error).toBeNull();
  });

  it("refuses a receipt the artifact path does not bind", async () => {
    const run = await assignedRun();
    const artifact = "agents/security-hunter-agent/artifacts/elsewhere.json";
    // A real receipt, but bound to a DIFFERENT artifact: the command that
    // produced it was not the command this check names.
    writeArtifact(run, artifact, receiptFor("agents/security-hunter-agent/artifacts/stolen.json"));

    const refused = await submitLocal(run, artifact);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("is not a sandbox receipt");
    expect(refused.error).toContain("no sandbox receipt was emitted");
  });

  it("refuses a receipt from a run that exited non-zero", async () => {
    const run = await assignedRun();
    const artifact = "agents/security-hunter-agent/artifacts/failed.json";
    writeArtifact(run, artifact, receiptFor(artifact, { exit: 1 }));

    const refused = await submitLocal(run, artifact);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("does not prove a bounded run");
    expect(refused.error).toContain("exit 1");
  });

  it.each([
    ["a limit that was not applied", "unenforced.json",
      (artifact: string) => receiptFor(artifact, { enforced: { cpu: false, memory: true, processes: true, fileSize: true } }), "cpu limit not applied"],
    // A receipt whose home directory stayed writable is not a bounded run.
    ["a home directory left writable", "open-home.json",
      (artifact: string) => receiptFor(artifact, { homeReadOnly: false }), "home directory not remounted read-only"],
    // Nor is one whose target stayed writable: the script reports the target
    // closed only after a write to it failed, never as a literal.
    ["a target left writable", "open-target.json",
      (artifact: string) => receiptFor(artifact, { targetReadOnly: false }), "target not remounted read-only"],
    ["prose that is not a receipt", "prose.md", () => "I ran it locally and it worked.\n", "is not a sandbox receipt"],
  ] as const)("refuses %s", async (_case, file, body, expected) => {
    const run = await assignedRun();
    const artifact = `agents/security-hunter-agent/artifacts/${file}`;
    writeArtifact(run, artifact, body(artifact));
    const refused = await submitLocal(run, artifact);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain(expected);
  });

  it("refuses a local check whose receipt file is missing: absence is not a pass", async () => {
    const run = await assignedRun();
    const missing = await submitLocal(run, "agents/security-hunter-agent/artifacts/absent.json");
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("absent.json");
  });

  it("refuses a receipt whose environment is not exactly the script's allowlist", async () => {
    const run = await assignedRun();
    // `LC_ALL` is not in what `env -i` hands the child, so a receipt naming it
    // was not written by the script.
    const artifact = "agents/security-hunter-agent/artifacts/lc-all.json";
    writeArtifact(run, artifact, receiptFor(artifact, { allowlistedEnv: ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"] }));
    const refused = await submitLocal(run, artifact);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("allowlistedEnv must be exactly");
  });
});

describe("--force starts a new run (INV-S2b)", () => {
  it("drops every document of the previous run, including published records", async () => {
    const run = await start(aRun());
    writeFileSync(join(run.out, "findings.json"), JSON.stringify([{ verdict: "rejected", fingerprint: "stale/one" }]));
    writeFileSync(join(run.out, "disposition.json"), JSON.stringify({ entries: [] }));
    writeFileSync(join(run.out, "REPORT.md"), "# stale report\n");
    writeFileSync(join(run.out, "verdicts.json"), JSON.stringify([{ fingerprint: "stale/one", vote: "critical" }]));

    const { args, stdin } = startInvocation(run, { signals: { languages: ["typescript"] }, flags: ["--force"] });
    const restarted = await run.invoke(args, stdin);
    expect(restarted.error).toBeNull();

    // Every document the new run owns is re-created empty; nothing stale survives.
    expect(JSON.parse(readFileSync(join(run.out, "findings.json"), "utf8"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(run.out, "verdicts.json"), "utf8"))).toEqual([]);
    const fresh = ["run.json", "ledger.json", "findings.json", "verdicts.json", "lenses.json", "verification-runs"];
    expect(readdirSync(run.out).filter((name) => !fresh.includes(name))).toEqual([]);
  });

  it("drops the previous run's verification runs: the new run's runs root starts empty", async () => {
    const run = await start(aRun());
    // A verification run of the previous run, bound to its ledger: left in
    // place it would sit under the new run's root as if this run had issued it.
    mkdirSync(join(run.out, "verification-runs", "run.verify-w1-g1-stale"), { recursive: true });
    writeFileSync(join(run.out, "verification-runs", "run.verify-w1-g1-stale", "program.json"), "{}\n");

    const { args, stdin } = startInvocation(run, { flags: ["--force"] });
    expect((await run.invoke(args, stdin)).error).toBeNull();
    expect(readdirSync(join(run.out, "verification-runs"))).toEqual([]);
  });

  it("leaves the previous run whole when a fresh document cannot be staged", async () => {
    const run = await start(aRun());
    const before = Object.fromEntries(["run.json", "ledger.json", "lenses.json"].map((file) => [file, readFileSync(join(run.out, file), "utf8")]));
    writeFileSync(join(run.out, "REPORT.md"), "# the previous run's report\n");
    // A symlink planted where one fresh document stages: its write is refused,
    // and that refusal must come BEFORE anything of the previous run is cleared.
    const decoy = join(run.out, "..", `${run.out.split("/").pop()}-decoy.json`);
    writeFileSync(decoy, "decoy\n");
    try {
      symlinkSync(decoy, join(run.out, "lenses.json.start-staged"));
      const { args, stdin } = startInvocation(run, { signals: { languages: ["typescript"] }, flags: ["--force"] });
      const refused = await run.invoke(args, stdin);
      expect(refused.ok).toBe(false);
      expect(refused.error).toContain("lenses.json.start-staged");
      for (const [file, text] of Object.entries(before)) expect(readFileSync(join(run.out, file), "utf8")).toBe(text);
      expect(readFileSync(join(run.out, "REPORT.md"), "utf8")).toBe("# the previous run's report\n");
      expect(readFileSync(decoy, "utf8")).toBe("decoy\n");
      // Nothing staged is left behind beside the run.
      expect(readdirSync(run.out).filter((name) => name.endsWith(".start-staged"))).toEqual([]);
    } finally {
      rmSync(decoy, { force: true });
    }
  });
});

describe("findings reports the blockers alongside the findings (INV-S6c)", () => {
  it("names what still blocks publication instead of printing an empty list", async () => {
    const run = await start(aRun());

    const projected = await run.invoke(["findings", "--json"]);
    expect(projected.error).toBeNull();
    const body = JSON.parse(run.stdout().trim()) as {
      findings: readonly unknown[];
      publicationBlockers: readonly { kind: string }[];
    };
    expect(body.findings).toEqual([]);
    // A planned unit that was never hunted blocks publication, and the
    // projection says so rather than reporting a clean, empty run.
    expect(body.publicationBlockers.length).toBeGreaterThan(0);
  });
});

// --- The nonce a local check is bound to ---

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const ARTIFACT = "agents/security-hunter-agent/artifacts/repro.txt";

/** A run started over a target directory OUTSIDE the run directory (the
 *  sandbox refuses a scratch inside the target, so a run that wants bounded
 *  checks lives elsewhere), its unit in flight unless `assigned: false`. The
 *  target is removed after `body`. */
const withTargetRun = async (
  body: (run: Run, target: string) => Promise<void>,
  options: Readonly<{ assigned?: boolean }> = {},
): Promise<void> => {
  const target = mkdtempSync(join(tmpdir(), "loom-security-target-"));
  try {
    const run = await startRun(aRun(), { repo: target });
    if (options.assigned ?? true) await assignUnit(run, 0);
    await body(run, target);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
};

/** The nonce `nonce` printed on its first line. */
const printedNonce = (stdout: string): string => {
  const found = /^nonce ([0-9a-f]{32}) for /m.exec(stdout);
  if (found === null) throw new Error(`no nonce line in:\n${stdout}`);
  return found[1]!;
};

const unshareAvailable = spawnSync("unshare", ["--map-root-user", "--mount", "--net", "true"]).status === 0;

describe("nonce: the engine hands out the binding a hunter cannot compute", () => {
  it("assign tells the parent how to obtain one, for the owner it minted", async () => {
    const run = await assignedRun();
    // Runnable as printed, from any directory: the executing package's own CLI
    // by absolute path. No `loom` binary exists to run a `loom helper …` line.
    expect(run.stdout()).toContain(
      `nonce: bun '${join(LOOM_PACKAGE_ROOT, "engine", "src", "cli.ts")}' helper security-audit nonce --out '${run.out}' ` +
        "--artifact agents/security-hunter-agent/artifacts/<file>",
    );
  });

  it("prints the artifact's nonce and a run filled in for this owner, writing nothing", async () => {
    await withTargetRun(async (run, target) => {
      const before = readdirSync(run.out).sort();

      const printed = await run.invoke(["nonce", "--artifact", ARTIFACT]);
      expect(printed.error).toBeNull();
      const stdout = run.stdout();
      expect(printedNonce(stdout)).toBe(sandboxNonce(ARTIFACT));
      expect(stdout).toContain(`owner security-hunter-agent; in flight: ${unitIdFor(0)}`);
      expect(stdout).toContain(`--target ${target} --scratch ${join(run.out, "agents", "security-hunter-agent", "scratch")}`);
      expect(stdout).toContain(`--nonce ${sandboxNonce(ARTIFACT)} -- <command> [args...] > ${join(run.out, ARTIFACT)}`);
      expect(stdout).toContain(`Redirect the script's stdout to exactly ${join(run.out, ARTIFACT)}`);
      expect(readdirSync(run.out).sort()).toEqual(before);
    });
  });

  it("binds a receipt submit accepts: assign → nonce → receipt under the printed nonce → submit", async () => {
    await withTargetRun(async (run) => {
      expect((await run.invoke(["nonce", "--artifact", ARTIFACT])).error).toBeNull();
      const nonce = printedNonce(run.stdout());
      writeArtifact(run, ARTIFACT, `${sandboxReceiptPrefix(nonce)}${aSandboxReceipt()}\n`);

      expect((await submitLocal(run, ARTIFACT)).error).toBeNull();
    });
  });

  it.runIf(unshareAvailable)("binds a REAL sandbox run made exactly as printed, and submit accepts its receipt", async () => {
    await withTargetRun(async (run) => {
      expect((await run.invoke(["nonce", "--artifact", ARTIFACT])).error).toBeNull();
      const lines = run.stdout().split("\n");
      const first = lines.findIndex((line) => line.trim().startsWith("mkdir -p "));
      const last = lines.findIndex((line) => line.includes("--nonce "));
      expect(first).toBeGreaterThanOrEqual(0);
      expect(last).toBeGreaterThan(first);
      const command = lines.slice(first, last + 1).join("\n").replace("<command> [args...]", "sh -c 'echo reproduced'");

      const home = mkdtempSync(join(tmpdir(), "loom-security-home-"));
      try {
        const ran = spawnSync("bash", ["-c", command], {
          cwd: REPO_ROOT,
          encoding: "utf8",
          env: { PATH: process.env["PATH"] ?? "", HOME: home },
          timeout: 60_000,
        });
        expect(ran.status, ran.stderr).toBe(0);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
      expect(readFileSync(join(run.out, ARTIFACT), "utf8")).toContain("reproduced");

      expect((await submitLocal(run, ARTIFACT)).error).toBeNull();
    });
  }, 90_000);

  it.each([
    ["a path outside any owner's artifacts root", "agents/security-hunter-agent/scratch/repro.txt", "is not an owned artifact path"],
    ["a traversal", "agents/security-hunter-agent/artifacts/../../../etc/passwd", "is not an owned artifact path"],
    ["an owner with no unit in flight", "agents/security-critic-agent/artifacts/repro.txt", "no in_progress unit is owned by security-critic-agent"],
  ])("refuses %s", async (_case, artifact, expected) => {
    await withTargetRun(async (run) => {
      const refused = await run.invoke(["nonce", "--artifact", artifact]);
      expect(refused.ok).toBe(false);
      expect(refused.error).toContain("nonce refused");
      expect(refused.error).toContain(expected);
    });
  });

  it("refuses before the unit is assigned, and requires --artifact", async () => {
    await withTargetRun(async (run) => {
      const unassigned = await run.invoke(["nonce", "--artifact", ARTIFACT]);
      expect(unassigned.error).toContain("no in_progress unit is owned by security-hunter-agent");
      const missing = await run.invoke(["nonce"]);
      expect(missing.error).toContain("--artifact is required");
    }, { assigned: false });
  });

  it("refuses a run directory inside the target, whose scratch the sandbox would refuse", async () => {
    const run = await assignedRun(); // --repo is the run directory itself
    const refused = await run.invoke(["nonce", "--artifact", ARTIFACT]);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("lies inside the target");
    expect(refused.error).toContain("outside the audited repository");
  });
});
