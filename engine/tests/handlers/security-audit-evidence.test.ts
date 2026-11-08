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

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSecurityAuditHandler } from "../../src/handlers/helpers/security-audit";
import { DEFAULT_SANDBOX_LIMITS, SANDBOX_RECEIPT_PREFIX } from "../../src/core/security-sandbox";
import { canonicalCoverageId, type CoverageRefs } from "../../src/core/security-audit-contract";
import { nSeeds } from "../security/fixtures";

type Run = Readonly<{
  out: string;
  stdout: () => string;
  invoke: (args: readonly string[], stdin?: string) => Promise<{ ok: boolean; error: string | null }>;
}>;

let dirs: string[] = [];

function aRun(): Run {
  const out = mkdtempSync(join(tmpdir(), "loom-security-audit-evidence-"));
  dirs.push(out);
  let printed = "";
  const handler = createSecurityAuditHandler((text) => { printed += `${text}\n`; });
  return {
    out,
    stdout: () => printed,
    invoke: async (args, stdin = "") => {
      printed = "";
      const result = await handler(stdin, [args[0] ?? "", "--out", out, ...args.slice(1)]);
      return { ok: result?.kind !== "error", error: result?.kind === "error" ? String(result.message ?? "") : null };
    },
  };
}

const unitIdFor = (index: number): string =>
  canonicalCoverageId(nSeeds(index + 1)[index].refs as unknown as CoverageRefs);


/** The seed the run is started with, so a unit id and its cell cannot drift. */
const seed = (): Record<string, unknown> => nSeeds(1)[0];

const start = async (run: Run, extra: readonly string[] = []): Promise<void> => {
  const started = await run.invoke(
    ["start", "--repo", run.out, "--source", "0".repeat(40), "--profile", "standard", "--budget", "12", ...extra],
    JSON.stringify({ units: [seed()], signals: { languages: ["typescript"], servesHttp: true } }),
  );
  expect(started.error).toBeNull();
};

const receipt = (overrides: Record<string, unknown> = {}): string =>
  `${SANDBOX_RECEIPT_PREFIX}${JSON.stringify({
    schemaVersion: 1,
    exit: 0,
    limits: { ...DEFAULT_SANDBOX_LIMITS },
    allowlistedEnv: ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"],
    scratchBytes: 512,
    networkNamespace: true,
    targetReadOnly: true,
    readOnlyRoot: false,
    enforced: { cpu: true, memory: true, processes: true, fileSize: true },
    ...overrides,
  })}`;

const aLocalCheck = (artifact: string): Record<string, unknown> => ({
  agent_id: "security-hunter-agent",
  reviewed_paths: ["src/subsystem-0/entry.ts"],
  invariant: "A quote in the email field cannot change the query.",
  method: "local",
  result: "The payload returned the admin row.",
  artifact,
});

const submitLocal = async (run: Run, artifact: string): Promise<{ ok: boolean; error: string | null }> =>
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

beforeEach(() => { dirs = []; });
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("a local check must name a receipt that proves a bounded run (INV-S1)", () => {
  it("accepts a check whose receipt is in limits", async () => {
    const run = aRun();
    await start(run);
    await assignOnly(run);
    const artifact = "agents/security-hunter-agent/artifacts/sqli.json";
    const dir = join(run.out, "agents", "security-hunter-agent", "artifacts");
    // mkdirSync via writeFileSync's parent creation is not available, so make it.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(run.out, artifact), `${receipt()}\n`);

    expect((await submitLocal(run, artifact)).error).toBeNull();
  });

  it("refuses a receipt from a run that exited non-zero", async () => {
    const run = aRun();
    await start(run);
    await assignOnly(run);
    const artifact = "agents/security-hunter-agent/artifacts/failed.json";
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(run.out, "agents", "security-hunter-agent", "artifacts"), { recursive: true });
    writeFileSync(join(run.out, artifact), `${receipt({ exit: 1 })}\n`);

    const refused = await submitLocal(run, artifact);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("does not prove a bounded run");
    expect(refused.error).toContain("exit 1");
  });

  it("refuses a receipt whose limits were not applied, and prose that is not a receipt", async () => {
    const run = aRun();
    await start(run);
    await assignOnly(run);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(run.out, "agents", "security-hunter-agent", "artifacts"), { recursive: true });

    const unenforced = "agents/security-hunter-agent/artifacts/unenforced.json";
    writeFileSync(join(run.out, unenforced), `${receipt({ enforced: { cpu: false, memory: true, processes: true, fileSize: true } })}\n`);
    const first = await submitLocal(run, unenforced);
    expect(first.ok).toBe(false);
    expect(first.error).toContain("cpu limit not applied");

    const prose = "agents/security-hunter-agent/artifacts/prose.md";
    writeFileSync(join(run.out, prose), "I ran it locally and it worked.\n");
    const second = await submitLocal(run, prose);
    expect(second.ok).toBe(false);
    expect(second.error).toContain("is not a sandbox receipt");

    // A missing receipt file is a refusal, not a pass.
    const missing = await submitLocal(run, "agents/security-hunter-agent/artifacts/absent.json");
    expect(missing.ok).toBe(false);
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
      JSON.stringify({ units: [seed()], signals: { languages: ["typescript"] } }),
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
      JSON.stringify({ units: [seed()], signals: { languages: ["typescript"] } }),
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
