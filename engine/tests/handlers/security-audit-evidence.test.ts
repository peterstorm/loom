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
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandboxNonce, sandboxReceiptPrefix } from "../../src/core/security-sandbox";
import { HUNTER_ENVELOPE } from "../security/fixtures";
import { aSandboxReceipt } from "../security/sandbox-fixtures";
import { aRun, isolateSubagentDir, removeRuns, seedFor, unitIdFor, writeArtifact, type Invocation, type Run } from "./security-audit-harness";

const start = async (run: Run, extra: readonly string[] = []): Promise<void> => {
  const started = await run.invoke(
    ["start", "--repo", run.out, "--source", "0".repeat(40), "--profile", "standard", "--budget", "12", ...extra],
    JSON.stringify({ units: [seedFor(0)], signals: { languages: ["typescript"], servesHttp: true } }),
  );
  expect(started.error).toBeNull();
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

const assignOnly = async (run: Run): Promise<void> => {
  const assigned = await run.invoke(["assign", "--unit", unitIdFor(0), "--agent", "security-hunter-agent", "--wave", "1"]);
  expect(assigned.error).toBeNull();
};

beforeEach(() => { isolateSubagentDir(); });
afterEach(removeRuns);

describe("a local check must name a receipt that proves a bounded run (INV-S1)", () => {
  it("accepts a check whose receipt is in limits", async () => {
    const run = aRun();
    await start(run);
    await assignOnly(run);
    const artifact = "agents/security-hunter-agent/artifacts/sqli.json";
    writeArtifact(run, artifact, receiptFor(artifact));

    expect((await submitLocal(run, artifact)).error).toBeNull();
  });

  it("refuses a receipt the artifact path does not bind", async () => {
    const run = aRun();
    await start(run);
    await assignOnly(run);
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
    const run = aRun();
    await start(run);
    await assignOnly(run);
    const artifact = "agents/security-hunter-agent/artifacts/failed.json";
    writeArtifact(run, artifact, receiptFor(artifact, { exit: 1 }));

    const refused = await submitLocal(run, artifact);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("does not prove a bounded run");
    expect(refused.error).toContain("exit 1");
  });

  it("refuses a receipt whose limits were not applied, and prose that is not a receipt", async () => {
    const run = aRun();
    await start(run);
    await assignOnly(run);

    const unenforced = "agents/security-hunter-agent/artifacts/unenforced.json";
    writeArtifact(run, unenforced, receiptFor(unenforced, { enforced: { cpu: false, memory: true, processes: true, fileSize: true } }));
    const first = await submitLocal(run, unenforced);
    expect(first.ok).toBe(false);
    expect(first.error).toContain("cpu limit not applied");

    // A receipt whose home directory stayed writable is not a bounded run.
    const openHome = "agents/security-hunter-agent/artifacts/open-home.json";
    writeArtifact(run, openHome, receiptFor(openHome, { homeReadOnly: false }));
    const openHomeResult = await submitLocal(run, openHome);
    expect(openHomeResult.ok).toBe(false);
    expect(openHomeResult.error).toContain("home directory not remounted read-only");

    // Nor is one whose target stayed writable: the script reports the target
    // closed only after a write to it failed, never as a literal.
    const openTarget = "agents/security-hunter-agent/artifacts/open-target.json";
    writeArtifact(run, openTarget, receiptFor(openTarget, { targetReadOnly: false }));
    const openTargetResult = await submitLocal(run, openTarget);
    expect(openTargetResult.ok).toBe(false);
    expect(openTargetResult.error).toContain("target not remounted read-only");

    const prose = "agents/security-hunter-agent/artifacts/prose.md";
    writeArtifact(run, prose, "I ran it locally and it worked.\n");
    const second = await submitLocal(run, prose);
    expect(second.ok).toBe(false);
    expect(second.error).toContain("is not a sandbox receipt");

    // A missing receipt file is a refusal, not a pass.
    const missing = await submitLocal(run, "agents/security-hunter-agent/artifacts/absent.json");
    expect(missing.ok).toBe(false);
  });

  it("refuses a receipt whose environment is not exactly the script's allowlist", async () => {
    const run = aRun();
    await start(run);
    await assignOnly(run);
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
    const run = aRun();
    await start(run);
    writeFileSync(join(run.out, "findings.json"), JSON.stringify([{ verdict: "rejected", fingerprint: "stale/one" }]));
    writeFileSync(join(run.out, "disposition.json"), JSON.stringify({ entries: [] }));
    writeFileSync(join(run.out, "REPORT.md"), "# stale report\n");
    writeFileSync(join(run.out, "verdicts.json"), JSON.stringify([{ fingerprint: "stale/one", vote: "critical" }]));

    const restarted = await run.invoke(
      ["start", "--repo", run.out, "--source", "0".repeat(40), "--profile", "standard", "--force"],
      JSON.stringify({ units: [seedFor(0)], signals: { languages: ["typescript"] } }),
    );
    expect(restarted.error).toBeNull();

    // Every document the new run owns is re-created empty; nothing stale survives.
    expect(JSON.parse(readFileSync(join(run.out, "findings.json"), "utf8"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(run.out, "verdicts.json"), "utf8"))).toEqual([]);
    // `verification-runs/` is the runs root a run's verification runs live in; an
    // old run's verification evidence stays, bound to the old run id, so
    // `verify --from` can never import it into the new run.
    const fresh = ["run.json", "ledger.json", "findings.json", "verdicts.json", "lenses.json", "verification-runs"];
    expect(readdirSync(run.out).filter((name) => !fresh.includes(name))).toEqual([]);
  });

  it("refuses to reuse a directory without --force", async () => {
    const run = aRun();
    await start(run);
    const again = await run.invoke(
      ["start", "--repo", run.out, "--source", "0".repeat(40), "--profile", "standard"],
      JSON.stringify({ units: [seedFor(0)], signals: { languages: ["typescript"] } }),
    );
    expect(again.ok).toBe(false);
    expect(again.error).toContain("--force");
  });
});

describe("findings reports the blockers alongside the findings (INV-S6c)", () => {
  it("names what still blocks publication instead of printing an empty list", async () => {
    const run = aRun();
    await start(run);

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

/** A target directory OUTSIDE the run directory: the sandbox refuses a scratch
 *  inside the target, so a run that wants bounded checks lives elsewhere. */
const withTarget = async (body: (target: string) => Promise<void>): Promise<void> => {
  const target = mkdtempSync(join(tmpdir(), "loom-security-target-"));
  try {
    await body(target);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
};

const startAt = async (run: Run, target: string): Promise<void> => {
  const started = await run.invoke(
    ["start", "--repo", target, "--source", "0".repeat(40), "--profile", "standard"],
    JSON.stringify({ units: [seedFor(0)] }),
  );
  expect(started.error).toBeNull();
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
    const run = aRun();
    await start(run);
    await assignOnly(run);
    expect(run.stdout()).toContain(
      `nonce: loom helper security-audit nonce --out '${run.out}' --artifact agents/security-hunter-agent/artifacts/<file>`,
    );
  });

  it("prints the artifact's nonce and a run filled in for this owner, writing nothing", async () => {
    await withTarget(async (target) => {
      const run = aRun();
      await startAt(run, target);
      await assignOnly(run);
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
    await withTarget(async (target) => {
      const run = aRun();
      await startAt(run, target);
      await assignOnly(run);
      expect((await run.invoke(["nonce", "--artifact", ARTIFACT])).error).toBeNull();
      const nonce = printedNonce(run.stdout());
      writeArtifact(run, ARTIFACT, `${sandboxReceiptPrefix(nonce)}${aSandboxReceipt()}\n`);

      expect((await submitLocal(run, ARTIFACT)).error).toBeNull();
    });
  });

  it.runIf(unshareAvailable)("binds a REAL sandbox run made exactly as printed, and submit accepts its receipt", async () => {
    await withTarget(async (target) => {
      const run = aRun();
      await startAt(run, target);
      await assignOnly(run);
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
    await withTarget(async (target) => {
      const run = aRun();
      await startAt(run, target);
      await assignOnly(run);
      const refused = await run.invoke(["nonce", "--artifact", artifact]);
      expect(refused.ok).toBe(false);
      expect(refused.error).toContain("nonce refused");
      expect(refused.error).toContain(expected);
    });
  });

  it("refuses before the unit is assigned, and requires --artifact", async () => {
    await withTarget(async (target) => {
      const run = aRun();
      await startAt(run, target);
      const unassigned = await run.invoke(["nonce", "--artifact", ARTIFACT]);
      expect(unassigned.error).toContain("no in_progress unit is owned by security-hunter-agent");
      const missing = await run.invoke(["nonce"]);
      expect(missing.error).toContain("--artifact is required");
    });
  });

  it("refuses a run directory inside the target, whose scratch the sandbox would refuse", async () => {
    const run = aRun();
    await start(run); // --repo is the run directory itself
    await assignOnly(run);
    const refused = await run.invoke(["nonce", "--artifact", ARTIFACT]);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("lies inside the target");
    expect(refused.error).toContain("outside the audited repository");
  });
});
