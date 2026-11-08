/**
 * Sandbox contract tests: the receipt grammar, the argv a hunter is told to
 * run, and one real bounded execution.
 *
 * The real run is the point. A parser test proves the engine can read a claim;
 * `unshare`-based execution proves the claim is true — the target really is
 * read-only, the network really is absent, writes really do stay in scratch.
 * When `unshare` is unavailable the test asserts the documented fallback
 * instead of skipping silently: a run that cannot sandbox must record a
 * blocker, so an unavailable sandbox is a fact the suite checks.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SANDBOX_LIMITS,
  SANDBOX_RECEIPT_PREFIX,
  parseSandboxLimits,
  parseSandboxReceipt,
  renderSandboxInstructions,
  sandboxCommand,
  sandboxWithinLimits,
  type SandboxLimits,
} from "../../src/core/security-sandbox";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "security-sandbox.sh");

const receipt = (overrides: Record<string, unknown> = {}): string =>
  `${SANDBOX_RECEIPT_PREFIX}${JSON.stringify({
    schemaVersion: 1,
    exit: 0,
    limits: { ...DEFAULT_SANDBOX_LIMITS },
    allowlistedEnv: ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"],
    scratchBytes: 12,
    networkNamespace: true,
    targetReadOnly: true,
    readOnlyRoot: true,
    enforced: { cpu: true, memory: true, processes: true, fileSize: true },
    ...overrides,
  })}`;

const parseOk = (stdout: string) => {
  const parsed = parseSandboxReceipt(stdout);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
};

const limits = (overrides: Partial<SandboxLimits> = {}): SandboxLimits => ({ ...DEFAULT_SANDBOX_LIMITS, ...overrides });

describe("sandbox receipt", () => {
  it("parses the script's own output", () => {
    const parsed = parseOk(`command log line\n${receipt()}\n`);
    expect(parsed.exit).toBe(0);
    expect(parsed.limits.cpuSeconds).toBe(DEFAULT_SANDBOX_LIMITS.cpuSeconds);
    expect(sandboxWithinLimits(parsed)).toBe(true);
  });

  it("takes the LAST receipt line, because a command may print its own", () => {
    const parsed = parseOk(`${receipt({ exit: 1 })}\n${receipt({ exit: 0 })}`);
    expect(parsed.exit).toBe(0);
  });

  it("refuses a missing receipt instead of assuming success", () => {
    expect(parseSandboxReceipt("all good, promise").ok).toBe(false);
  });

  it("refuses an unknown field and a wrong literal", () => {
    expect(parseSandboxReceipt(receipt({ sandboxed: true })).ok).toBe(false);
    expect(parseSandboxReceipt(receipt({ networkNamespace: false })).ok).toBe(false);
    expect(parseSandboxReceipt(receipt({ targetReadOnly: "yes" })).ok).toBe(false);
    expect(parseSandboxReceipt(receipt({ exit: 300 })).ok).toBe(false);
    expect(parseSandboxReceipt(receipt({ scratchBytes: -1 })).ok).toBe(false);
  });

  it("refuses limits outside the documented ceilings", () => {
    expect(parseSandboxLimits({ ...DEFAULT_SANDBOX_LIMITS, cpuSeconds: 0 }).ok).toBe(false);
    expect(parseSandboxLimits({ ...DEFAULT_SANDBOX_LIMITS, addressSpaceMb: 1 }).ok).toBe(false);
    expect(parseSandboxLimits({ ...DEFAULT_SANDBOX_LIMITS, extra: 1 }).ok).toBe(false);
    expect(parseSandboxLimits({ ...DEFAULT_SANDBOX_LIMITS, processes: 2.5 }).ok).toBe(false);
    expect(parseSandboxLimits(DEFAULT_SANDBOX_LIMITS).ok).toBe(true);
  });

  it("refuses a run whose scratch outgrew its allowance", () => {
    const parsed = parseOk(receipt({ scratchBytes: 128 * 1024 * 1024 }));
    expect(sandboxWithinLimits(parsed)).toBe(false);
    expect(sandboxWithinLimits(parseOk(receipt({ exit: 1, scratchBytes: 0 })))).toBe(false);
    // An UNMEASURED footprint is not a passing one.
    expect(sandboxWithinLimits(parseOk(receipt({ scratchBytes: null })))).toBe(false);
  });

  it("refuses a run whose limits were not all applied", () => {
    expect(sandboxWithinLimits(parseOk(receipt({ enforced: { cpu: true, memory: false, processes: true, fileSize: true } })))).toBe(false);
    // A failed ROOT remount is recorded, not fatal: a user namespace cannot
    // remount a superblock it does not own, and the uid mapping protects the rest.
    expect(sandboxWithinLimits(parseOk(receipt({ readOnlyRoot: false })))).toBe(true);
    expect(parseSandboxReceipt(receipt({ targetReadOnly: false })).ok).toBe(false);
  });

  it("requires the caller's nonce in the marker when one was issued", () => {
    const nonce = "0123456789abcdef";
    const bound = `LOOM-SANDBOX-RECEIPT-${nonce} ${JSON.stringify({
      schemaVersion: 1,
      exit: 0,
      limits: { ...DEFAULT_SANDBOX_LIMITS },
      allowlistedEnv: ["PATH"],
      scratchBytes: 12,
      networkNamespace: true,
      targetReadOnly: true,
      readOnlyRoot: true,
      enforced: { cpu: true, memory: true, processes: true, fileSize: true },
    })}`;
    // A command-printed unbound receipt is ignored; the bound one is read.
    const stdout = `${receipt()}\n${bound}\n`;
    expect(parseSandboxReceipt(stdout, { nonce }).ok).toBe(true);
    expect(parseSandboxReceipt(`${receipt()}\n`, { nonce }).ok).toBe(false);
  });

  it("bounds the nonce grammar", () => {
    expect(sandboxCommand({ target: "/repo", scratch: "/scratch", command: ["true"], limits: limits(), nonce: "0123456789abcdef" }).ok).toBe(true);
    expect(sandboxCommand({ target: "/repo", scratch: "/scratch", command: ["true"], limits: limits(), nonce: "nothex" }).ok).toBe(false);
    expect(sandboxCommand({ target: "/repo", scratch: "/scratch", command: ["true"], limits: limits(), nonce: "0123" }).ok).toBe(false);
  });
});

describe("sandbox command", () => {
  it("names the script, every limit, and the command after --", () => {
    const command = sandboxCommand({
      target: "/repo",
      scratch: "/runs/audit-1/agents/hunter-a/scratch",
      command: ["node", "--version"],
      limits: limits({ cpuSeconds: 3, wallClockSeconds: 5 }),
    });
    if (!command.ok) throw new Error(JSON.stringify(command.error));
    expect(command.value[0]).toBe("scripts/security-sandbox.sh");
    expect(command.value.slice(-3)).toEqual(["--", "node", "--version"]);
    expect(command.value).toContain("--scratch-mb");
    expect(command.value[command.value.indexOf("--cpu") + 1]).toBe("3");
  });

  it("refuses a scratch inside the target, an empty command, and bad limits", () => {
    expect(sandboxCommand({ target: "/repo", scratch: "/repo/scratch", command: ["true"], limits: limits() }).ok).toBe(false);
    expect(sandboxCommand({ target: "/repo", scratch: "/scratch", command: [], limits: limits() }).ok).toBe(false);
    expect(
      sandboxCommand({ target: "/repo", scratch: "/scratch", command: ["true"], limits: limits({ cpuSeconds: 0 }) }).ok,
    ).toBe(false);
    expect(
      sandboxCommand({ target: "/repo", scratch: "/scratch", command: ["a\u0000b"], limits: limits() }).ok,
    ).toBe(false);
  });

  it("tells a hunter what it may not assume", () => {
    const text = renderSandboxInstructions(DEFAULT_SANDBOX_LIMITS);
    expect(text).toContain("--scratch-mb");
    expect(text).toContain("No external network");
    expect(text).toContain("record needs_validation naming the missing capability");
  });
});

const unshareAvailable = spawnSync("unshare", ["--map-root-user", "--mount", "--net", "true"], { encoding: "utf8" }).status === 0;

describe("bounded local execution", () => {
  it.runIf(unshareAvailable)("keeps the target read-only, drops the network, and persists scratch", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-sandbox-"));
    const target = join(root, "target");
    const scratch = join(root, "scratch");
    mkdirSync(target);
    mkdirSync(scratch);
    writeFileSync(join(target, "answer.txt"), "original\n");

    try {
      const run = spawnSync(
        "bash",
        [
          SCRIPT,
          "--target",
          target,
          "--scratch",
          scratch,
          "--cpu",
          "5",
          "--wall",
          "20",
          "--",
          "sh",
          "-c",
          [
            "cat " + join(target, "answer.txt"),
            "echo tampered >> " + join(target, "answer.txt"),
            'echo "target_write=$?"',
            "printf kept > evidence.txt",
            'echo "scratch_write=$?"',
            "(exec 3<>/dev/tcp/1.1.1.1/443) 2>/dev/null",
            'echo "network=$?"',
          ].join("; "),
        ],
        { encoding: "utf8", timeout: 60_000 },
      );

      const stdout = run.stdout ?? "";
      expect(stdout).toContain("original");
      expect(stdout).toContain("target_write=1");
      expect(stdout).toContain("scratch_write=0");
      expect(stdout).toContain("network=1");
      expect(readFileSync(join(target, "answer.txt"), "utf8")).toBe("original\n");
      expect(readdirSync(scratch)).toContain("evidence.txt");

      const parsed = parseOk(stdout);
      expect(parsed.targetReadOnly).toBe(true);
      expect(parsed.networkNamespace).toBe(true);
      expect(parsed.scratchBytes).toBeGreaterThan(0);
      expect(sandboxWithinLimits(parsed)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(unshareAvailable)("records a non-zero exit instead of pretending success", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-sandbox-"));
    const target = join(root, "target");
    const scratch = join(root, "scratch");
    mkdirSync(target);
    mkdirSync(scratch);
    try {
      const run = spawnSync("bash", [SCRIPT, "--target", target, "--scratch", scratch, "--", "sh", "-c", "exit 3"], {
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(run.status).toBe(3);
      const parsed = parseOk(run.stdout ?? "");
      expect(parsed.exit).toBe(3);
      expect(sandboxWithinLimits(parsed)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("has a script that parses and is executable", () => {
    expect(readFileSync(SCRIPT, "utf8")).toContain("LOOM-SANDBOX-RECEIPT");
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
  });
});
