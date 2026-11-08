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
  sandboxNonce,
  sandboxNonceInCommand,
  sandboxReceiptPrefix,
  parseSandboxLimits,
  parseSandboxReceipt,
  renderSandboxInstructions,
  sandboxCommand,
  sandboxWithinLimits,
  type SandboxLimits,
} from "../../src/core/security-sandbox";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "security-sandbox.sh");
/** Absolute bash: the fallback test hides `unshare` by emptying PATH, which would
 *  also hide the interpreter if the spawn resolved it through that PATH. */
const BASH = (spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).stdout ?? "").trim();

/** The nonce every fixture receipt is bound to: a receipt the caller cannot
 *  bind is not evidence, so the fixture is built the way the script builds it. */
const NONCE = "0123456789abcdef";

const receipt = (overrides: Record<string, unknown> = {}, nonce = NONCE): string =>
  `${sandboxReceiptPrefix(nonce)}${JSON.stringify({
    schemaVersion: 1,
    exit: 0,
    limits: { ...DEFAULT_SANDBOX_LIMITS },
    allowlistedEnv: ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"],
    scratchBytes: 12,
    networkNamespace: true,
    targetReadOnly: true,
    readOnlyRoot: false,
    homeReadOnly: true,
    unremountedMounts: 0,
    enforced: { cpu: true, memory: true, processes: true, fileSize: true },
    ...overrides,
  })}`;

/** A parse bound to the fixture nonce. */
const parseBound = (stdout: string) => parseSandboxReceipt(stdout, NONCE);

const parseOk = (stdout: string) => {
  const parsed = parseBound(stdout);
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
    expect(parseBound("all good, promise").ok).toBe(false);
  });

  it("refuses an unknown field and a wrong literal", () => {
    expect(parseBound(receipt({ sandboxed: true })).ok).toBe(false);
    expect(parseBound(receipt({ networkNamespace: false })).ok).toBe(false);
    expect(parseBound(receipt({ targetReadOnly: "yes" })).ok).toBe(false);
    expect(parseBound(receipt({ exit: 300 })).ok).toBe(false);
    expect(parseBound(receipt({ scratchBytes: -1 })).ok).toBe(false);
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
    // remount a superblock it does not own. What that leaves open is reported.
    expect(sandboxWithinLimits(parseOk(receipt({ readOnlyRoot: false })))).toBe(true);
    expect(parseBound(receipt({ targetReadOnly: false })).ok).toBe(false);
  });

  it("requires the home directory to be closed read-only", () => {
    // Home is the writable surface the uid mapping leaves open — the one a
    // command could use to reach the operator's own files — so it is gated,
    // unlike the root remount a user namespace cannot perform.
    expect(sandboxWithinLimits(parseOk(receipt({ homeReadOnly: false })))).toBe(false);
    expect(parseBound(receipt({ homeReadOnly: "yes" })).ok).toBe(false);
    expect(parseBound(receipt({ unremountedMounts: -1 })).ok).toBe(false);
    expect(parseBound(receipt({ unremountedMounts: 3 })).ok).toBe(true);
  });

  it("requires the caller's nonce in the marker", () => {
    const stdout = `${receipt({ exit: 1 })}\n${receipt({ exit: 0 })}\n`;
    // An unbound receipt line — what a command prints — is not even considered.
    expect(parseSandboxReceipt(`${stdout}${SANDBOX_RECEIPT_PREFIX}{"schemaVersion":1}`, NONCE).ok).toBe(true);
    expect(parseSandboxReceipt(stdout, "fedcba9876543210").ok).toBe(false);
    expect(parseSandboxReceipt(stdout, "not-hex").ok).toBe(false);
  });

  it("derives a deterministic nonce the hunter and the engine can both compute", () => {
    const artifact = "agents/hunter-a/artifacts/finding-1.txt";
    const derived = sandboxNonce(artifact);
    expect(derived).toMatch(/^[0-9a-f]{32}$/);
    expect(sandboxNonce(artifact)).toBe(derived);
    expect(sandboxNonce("agents/hunter-a/artifacts/finding-2.txt")).not.toBe(derived);
    // A receipt bound to one artifact cannot stand in for another.
    expect(parseSandboxReceipt(receipt({}, derived), sandboxNonce("other.txt")).ok).toBe(false);
  });

  it("reads the nonce a bash call bound into its own argv", () => {
    expect(sandboxNonceInCommand("bash scripts/security-sandbox.sh --nonce 0123456789abcdef -- node x")).toBe("0123456789abcdef");
    expect(sandboxNonceInCommand("bash scripts/security-sandbox.sh --nonce=0123456789abcdef -- node x")).toBe("0123456789abcdef");
    expect(sandboxNonceInCommand("bash scripts/security-sandbox.sh -- node x")).toBeNull();
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
    const text = renderSandboxInstructions(DEFAULT_SANDBOX_LIMITS, NONCE);
    expect(text).toContain("--scratch-mb");
    expect(text).toContain("--nonce " + NONCE);
    expect(text).toContain("No external network, no writable target or home");
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
          "--nonce",
          NONCE,
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
            "printf '%s\\n' 'LOOM-SANDBOX-LIMITS root_ro=1 home_ro=1 cpu=1 mem=1 procs=1 files=1 unremounted=0'",
            "printf '%s\\n' 'LOOM-SANDBOX-RECEIPT-0123456789abcdef {\"schemaVersion\":1}'",
            "printf forged > .enforcement",
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
      expect(parsed.homeReadOnly).toBe(true);
      expect(parsed.networkNamespace).toBe(true);
      expect(parsed.scratchBytes).toBeGreaterThan(0);
      // The command's own LOOM-SANDBOX-LIMITS line, its fake receipt and its
      // forged .enforcement file changed nothing: the facts travel on the INNER
      // shell's stdout and the receipt is bound to the call's nonce.
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
      const run = spawnSync(
        "bash",
        [SCRIPT, "--target", target, "--scratch", scratch, "--nonce", NONCE, "--", "sh", "-c", "exit 3"],
        { encoding: "utf8", timeout: 60_000 },
      );
      expect(run.status).toBe(3);
      const parsed = parseOk(run.stdout ?? "");
      expect(parsed.exit).toBe(3);
      expect(sandboxWithinLimits(parsed)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to run, naming the missing capability, when unshare is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-sandbox-"));
    const target = join(root, "target");
    const scratch = join(root, "scratch");
    mkdirSync(target);
    try {
      // An empty PATH keeps the builtins but hides `unshare`: the documented
      // fallback is a refusal a hunter can act on, not a silent unsandboxed run.
      const run = spawnSync(BASH, [SCRIPT, "--target", target, "--scratch", scratch, "--", "true"], {
        encoding: "utf8",
        env: { PATH: "/nonexistent", HOME: root, TMPDIR: root },
        timeout: 60_000,
      });
      expect(run.status).toBe(126);
      expect(run.stderr).toContain("unshare is unavailable");
      expect(run.stdout ?? "").not.toContain("LOOM-SANDBOX-RECEIPT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(unshareAvailable)("binds the receipt to the nonce the call carried", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-sandbox-"));
    const target = join(root, "target");
    const scratch = join(root, "scratch");
    mkdirSync(target);
    try {
      const run = spawnSync(
        "bash",
        [SCRIPT, "--target", target, "--scratch", scratch, "--nonce", NONCE, "--", "true"],
        { encoding: "utf8", timeout: 60_000 },
      );
      const stdout = run.stdout ?? "";
      // Bound to the caller's nonce, and to no other.
      expect(parseBound(stdout).ok).toBe(true);
      expect(parseSandboxReceipt(stdout, "fedcba9876543210").ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(unshareAvailable)("records a limit that did not take effect as unenforced", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-sandbox-"));
    const target = join(root, "target");
    const scratch = join(root, "scratch");
    mkdirSync(target);
    mkdirSync(scratch);
    try {
      // `--mem-mb -1` makes the inner shell's `ulimit -v -1024` fail (a leading
      // `-` reads as an option). The receipt must record what the kernel
      // ACTUALLY enforced: memory `false` beside the limits that did apply, not
      // a copy of what the caller asked for.
      const run = spawnSync(
        "bash",
        [SCRIPT, "--target", target, "--scratch", scratch, "--nonce", NONCE, "--mem-mb", "-1", "--", "true"],
        { encoding: "utf8", timeout: 60_000 },
      );
      const stdout = run.stdout ?? "";
      expect(stdout).toContain('"memory":false');
      // Per-limit, not all-or-nothing: the other three ulimits still applied.
      expect(stdout).toContain('"cpu":true');
      expect(stdout).toContain('"processes":true');
      expect(stdout).toContain('"fileSize":true');
      // And the limit it declares is outside the receipt grammar, so the whole
      // receipt is refused rather than accepted with an unenforced bound.
      expect(parseBound(stdout).ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("has a script that parses and is executable", () => {
    expect(readFileSync(SCRIPT, "utf8")).toContain("LOOM-SANDBOX-RECEIPT");
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
  });
});
