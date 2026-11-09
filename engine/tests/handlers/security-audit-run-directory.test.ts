/**
 * The security-audit run directory as the helper reads it: every read is
 * fail-closed (an absent or degenerate document is a REFUSAL, never an empty
 * list), a read-only projection never creates the run it was asked to read,
 * and a run under a symlinked BASE works while every symlink inside the run is
 * still refused. Driven through the CLI seam (`security-audit-harness.ts`).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSecurityAuditHandler } from "../../src/handlers/helpers/security-audit";
import type { CoverageUnit } from "../../src/core/security-coverage";
import { registeredSecurityAuditRuns } from "../../src/orchestration/security-audit-run-registry";
import { aVerdict } from "../security/fixtures";
import { STARTED, aRun, claimPayload, isolateSubagentDir, readJson, removeRuns, seedFor, startRun, unitIdFor } from "./security-audit-harness";

beforeEach(() => { isolateSubagentDir(); });
afterEach(removeRuns);

describe("the run directory reads", () => {
  // Treating absence as `[]` would let a lost or deleted file read as "the run
  // has no findings", so `publish` would emit an empty result and the operator
  // would never learn the run directory was damaged.

  it("refuses a run directory whose ledger is not JSON", async () => {
    const run = await startRun(aRun());
    writeFileSync(join(run.out, "ledger.json"), "{not json");
    const status = await run.invoke(["status"]);
    expect(status.ok).toBe(false);
    expect(status.error ?? "").toContain("not valid JSON");
  });

  it("refuses to follow a symlinked run file", async () => {
    const run = await startRun(aRun());
    const elsewhere = join(run.out, "..", `${run.out.split("/").pop()}-elsewhere.json`);
    writeFileSync(elsewhere, "[]");
    // Replace a document the run itself wrote, so the read is the symlinked one.
    rmSync(join(run.out, "ledger.json"));
    symlinkSync(elsewhere, join(run.out, "ledger.json"));
    const status = await run.invoke(["status"]);
    expect(status.ok).toBe(false);
    expect((status.error ?? "").toLowerCase()).toMatch(/symlink|symbolic|eloop/);
    rmSync(elsewhere, { force: true });
  });

  it("refuses an empty ledger instead of claiming coverage of nothing", async () => {
    const run = await startRun(aRun());
    writeFileSync(join(run.out, "ledger.json"), "[]\n");
    const status = await run.invoke(["status"]);
    expect(status.ok).toBe(false);
    expect(status.error).toContain("a run always seeds at least one unit");
  });

  it.each(["findings.json", "verdicts.json"])("refuses a run directory with no %s document", async (document) => {
    const run = await startRun(aRun());
    rmSync(join(run.out, document));
    const status = await run.invoke(["status"]);
    expect(status.ok).toBe(false);
    expect(status.error ?? "").toContain(join(run.out, document));
    expect(status.error ?? "").toContain("is missing");
  });

  it("refuses a missing findings document on a WRITING path too, with the same words", async () => {
    // `submit` reads findings through the same reader the snapshot uses: the
    // refusal must not depend on which operation met the damage.
    const run = await startRun(aRun());
    rmSync(join(run.out, "findings.json"));
    const submitted = await run.invoke(["submit"], claimPayload(0));
    expect(submitted.ok).toBe(false);
    expect(submitted.error ?? "").toContain(`${join(run.out, "findings.json")} is missing`);
  });

  it("parses the ballot document rather than trusting it", async () => {
    const run = await startRun(aRun());
    // A hand-edited ballot document is the case that matters: the read path
    // must run the same parser `verify` does, so an invented key is named here
    // and not discovered by whichever operation reads it first.
    writeFileSync(join(run.out, "verdicts.json"), `${JSON.stringify([{ ...aVerdict(), voteReason: "because" }], null, 2)}\n`);
    const status = await run.invoke(["status"]);
    expect(status.ok).toBe(false);
    expect(status.error ?? "").toContain("verdicts[0].voteReason");
  });

  it("parses the findings document rather than trusting it", async () => {
    const run = await startRun(aRun());
    writeFileSync(join(run.out, "findings.json"), `${JSON.stringify([{ verdict: "confirmed", fingerprint: "api/login:sqli-email" }], null, 2)}\n`);
    const status = await run.invoke(["status"]);
    expect(status.ok).toBe(false);
    expect(status.error ?? "").toContain("findings.json is malformed");
    expect(status.error ?? "").toContain("$[0].title");
  });
});

// --- Reads never create ---

describe("a read-only projection over a run directory that does not exist", () => {
  it.each([
    ["status", []],
    ["findings", []],
    ["nonce", ["--artifact", "agents/security-hunter-agent/artifacts/repro.txt"]],
  ] as const)("%s errors and creates nothing", async (operation, extra) => {
    const parent = mkdtempSync(join(tmpdir(), "loom-security-audit-missing-"));
    try {
      const out = join(parent, "mistyped-run");
      const handler = createSecurityAuditHandler(() => undefined);
      const result = await handler("", [operation, "--out", out, ...extra]);
      expect(result?.kind).toBe("error");
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("errors and creates nothing when even the run directory's base is missing", async () => {
    const parent = mkdtempSync(join(tmpdir(), "loom-security-audit-missing-"));
    try {
      const base = join(parent, "missing-base");
      const result = await createSecurityAuditHandler(() => undefined)("", ["status", "--out", join(base, "run")]);
      expect(result?.kind).toBe("error");
      expect(String(result?.kind === "error" ? result.message : "")).toContain("missing");
      expect(existsSync(base)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

// --- A run directory under a symlinked base ---

/**
 * macOS spells its temp root `/var/folders/…/T/…`, and `/var` is a symlink to
 * `/private/var`. The run's BASE may traverse such a system symlink; the run
 * directory itself and everything below it may not. `private/var` is the real
 * directory here and `var` the alias of it, the way macOS lays them out.
 */
describe("a run directory under a symlinked base (/var → /private/var)", () => {
  let scratch: string;
  let real: string;
  let alias: string;
  beforeEach(() => {
    scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-security-audit-alias-")));
    real = join(scratch, "private", "var");
    mkdirSync(real, { recursive: true });
    alias = join(scratch, "var");
    symlinkSync(real, alias);
  });
  afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

  const invokeAt = async (out: string, args: readonly string[], stdin = "") => {
    let printed = "";
    const result = await createSecurityAuditHandler((text) => { printed += `${text}\n`; })(stdin, [args[0] ?? "", "--out", out, ...args.slice(1)]);
    return { error: result?.kind === "error" ? String(result.message ?? "") : null, printed };
  };
  const startAt = (out: string, extra: readonly string[] = []) =>
    invokeAt(out, [...STARTED, "--repo", scratch, ...extra], JSON.stringify({ units: [seedFor(0)] }));

  it("start, assign, submit and status succeed through the aliased spelling, under one canonical locator", async () => {
    // `folders/T` does not exist yet: the base is created, then resolved.
    const spelled = join(alias, "folders", "T", "run");
    const canonical = join(real, "folders", "T", "run");
    const started = await startAt(spelled);
    expect(started.error).toBeNull();
    expect(started.printed).toContain(canonical);
    expect(started.printed).not.toContain(spelled);
    expect(existsSync(join(canonical, "run.json"))).toBe(true);
    // The guard registry carries the one canonical spelling.
    expect(registeredSecurityAuditRuns()).toEqual([canonical]);

    expect((await invokeAt(spelled, ["assign", "--unit", unitIdFor(0), "--agent", "security-hunter-agent", "--wave", "1"])).error).toBeNull();
    expect((await invokeAt(spelled, ["submit"], claimPayload(0))).error).toBeNull();
    expect(readJson<CoverageUnit[]>(canonical, "ledger.json")[0].status).toBe("candidate");

    const status = await invokeAt(spelled, ["status"]);
    expect(status.error).toBeNull();
    // Either spelling names the same run.
    expect((await invokeAt(canonical, ["status"])).printed).toBe(status.printed);
  });

  it("still refuses a run document symlinked inside the run directory", async () => {
    const spelled = join(alias, "run");
    expect((await startAt(spelled)).error).toBeNull();
    const elsewhere = join(scratch, "elsewhere-ledger.json");
    writeFileSync(elsewhere, "[]");
    rmSync(join(real, "run", "ledger.json"));
    symlinkSync(elsewhere, join(real, "run", "ledger.json"));

    const status = await invokeAt(spelled, ["status"]);
    expect((status.error ?? "").toLowerCase()).toMatch(/symlink|symbolic|eloop/);
    const assigned = await invokeAt(spelled, ["assign", "--unit", unitIdFor(0), "--agent", "security-hunter-agent", "--wave", "1"]);
    expect((assigned.error ?? "").toLowerCase()).toMatch(/symlink|symbolic|eloop/);
    expect(readFileSync(elsewhere, "utf8")).toBe("[]");
  });

  it("still refuses a run subdirectory symlinked inside the run directory", async () => {
    const spelled = join(alias, "run");
    expect((await startAt(spelled)).error).toBeNull();
    const elsewhere = join(scratch, "elsewhere-runs");
    mkdirSync(elsewhere);
    rmSync(join(real, "run", "verification-runs"), { recursive: true });
    symlinkSync(elsewhere, join(real, "run", "verification-runs"));

    // `start --force` re-prepares the verification runs root, no-follow.
    const restarted = await startAt(spelled, ["--force"]);
    // A no-follow directory open of a symlink: ENOTDIR on Linux, ELOOP on darwin.
    expect((restarted.error ?? "").toLowerCase()).toMatch(/symlink|symbolic|eloop|enotdir/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("still refuses a run directory that is itself a symlink", async () => {
    const target = join(real, "target-run");
    mkdirSync(target);
    const linked = join(alias, "linked-run");
    symlinkSync(target, join(real, "linked-run"));
    const started = await startAt(linked);
    // A no-follow directory open of a symlink: ENOTDIR on Linux, ELOOP on darwin.
    expect((started.error ?? "").toLowerCase()).toMatch(/symlink|symbolic|eloop|enotdir/);
    expect(readdirSync(target)).toEqual([]);
  });
});
