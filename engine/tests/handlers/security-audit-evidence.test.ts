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
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sandboxNonce, sandboxReceiptPrefix } from "../../src/core/security-sandbox";
import { aSandboxReceipt } from "../security/sandbox-fixtures";
import { aRun, removeRuns, seedFor, unitIdFor, writeArtifact, type Invocation, type Run } from "./security-audit-harness";

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
  run.invoke(["submit"], JSON.stringify({
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
    const fresh = ["run.json", "ledger.json", "findings.json", "verdicts.json", "lenses.json"];
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
