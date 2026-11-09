/**
 * Sandbox contract tests: the receipt grammar, the argv a hunter is told to
 * run, the judgement on a `local` check, and real bounded executions.
 *
 * The real runs are the point. A parser test proves the engine can read a
 * claim; `unshare`-based execution proves the claim is true — the target and
 * home really are read-only, the network really is absent, writes really do
 * stay in scratch. Every real run spawns the script with an explicit
 * environment whose HOME is a temporary directory, so no test ever touches the
 * operator's own home.
 *
 * Where `unshare` is unavailable the real-isolation tests are skipped — but not
 * silently: the probe's failure reason is printed once and carried in each
 * skipped test's name. With `LOOM_REQUIRE_SANDBOX=1` (set it in CI) an
 * unavailable sandbox FAILS the suite instead of skipping. The script's own
 * documented fallback — a refusal naming the missing capability — is checked
 * unconditionally.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SANDBOX_LIMITS,
  SANDBOX_ENV_ALLOWLIST,
  SANDBOX_RECEIPT_PREFIX,
  describeUnboundedRun,
  judgeLocalReceipt,
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
import { aSandboxReceipt } from "./sandbox-fixtures";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "security-sandbox.sh");
/** Absolute bash: the fallback test hides `unshare` by emptying PATH, which would
 *  also hide the interpreter if the spawn resolved it through that PATH. */
const BASH = (spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).stdout ?? "").trim();

/** The nonce every fixture receipt is bound to: a receipt the caller cannot
 *  bind is not evidence, so the fixture is built the way the script builds it. */
const NONCE = "0123456789abcdef";

const receipt = (overrides: Record<string, unknown> = {}, nonce = NONCE): string =>
  `${sandboxReceiptPrefix(nonce)}${aSandboxReceipt(overrides)}`;

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

  it("hands the value parser's refusal through unchanged", () => {
    expect(parseBound(receipt({ schemaVersion: 2 }))).toEqual({
      ok: false,
      error: { kind: "invalid-sandbox-receipt", message: "schemaVersion must be 1" },
    });
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

  it("admits exactly the environment the script passes, in its order", () => {
    // The literal the script's ENV_ASSIGNMENTS passes: LC_ALL is not in it,
    // because `env -i` never handed it to the child.
    expect(SANDBOX_ENV_ALLOWLIST).toEqual(["PATH", "HOME", "TMPDIR", "LANG", "TERM"]);
    expect(parseOk(receipt()).allowlistedEnv).toEqual(["PATH", "HOME", "TMPDIR", "LANG", "TERM"]);
    const refused = [
      ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"],
      ["PATH", "HOME", "TMPDIR", "LANG"],
      ["HOME", "PATH", "TMPDIR", "LANG", "TERM"],
      ["PATH", "HOME", "TMPDIR", "LANG", "TERM", "AWS_SECRET_ACCESS_KEY"],
      [],
      "PATH,HOME,TMPDIR,LANG,TERM",
    ];
    for (const allowlistedEnv of refused) {
      expect(parseBound(receipt({ allowlistedEnv }))).toEqual({
        ok: false,
        error: { kind: "invalid-sandbox-receipt", message: "allowlistedEnv must be exactly [PATH, HOME, TMPDIR, LANG, TERM]" },
      });
    }
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

describe("describeUnboundedRun", () => {
  it("names every gated condition that failed, in gate order", () => {
    const parsed = parseOk(receipt({
      exit: null,
      scratchBytes: null,
      homeReadOnly: false,
      enforced: { cpu: false, memory: false, processes: false, fileSize: false },
    }));
    expect(describeUnboundedRun(parsed)).toBe(
      "exit null; scratch footprint unmeasured; cpu limit not applied; memory limit not applied; " +
        "process limit not applied; file-size limit not applied; home directory not remounted read-only",
    );
  });

  it("states the footprint against its allowance", () => {
    const parsed = parseOk(receipt({ exit: 2, scratchBytes: 64 * 1024 * 1024 + 1 }));
    expect(describeUnboundedRun(parsed)).toBe(`exit 2; scratch ${64 * 1024 * 1024 + 1} B over its 64 MB allowance`);
    // Exactly at the allowance is inside it.
    expect(describeUnboundedRun(parseOk(receipt({ scratchBytes: 64 * 1024 * 1024 })))).toBe("unknown");
  });

  it("reads 'unknown' for a run the gate accepts, and ignores the recorded residual exposure", () => {
    const parsed = parseOk(receipt({ readOnlyRoot: false, unremountedMounts: 7 }));
    expect(sandboxWithinLimits(parsed)).toBe(true);
    expect(describeUnboundedRun(parsed)).toBe("unknown");
  });
});

describe("judgeLocalReceipt", () => {
  const artifact = "agents/hunter-a/artifacts/finding-1.txt";
  const boundTo = (path: string, overrides: Record<string, unknown> = {}): string =>
    `command output\n${sandboxReceiptPrefix(sandboxNonce(path))}${aSandboxReceipt(overrides)}\n`;

  it("admits a receipt bound to the artifact path that proves a bounded run", () => {
    const judged = judgeLocalReceipt(boundTo(artifact), artifact);
    if (!judged.ok) throw new Error(judged.error);
    expect(judged.value.exit).toBe(0);
    expect(sandboxWithinLimits(judged.value)).toBe(true);
  });

  it("refuses text that holds no receipt bound to this artifact", () => {
    expect(judgeLocalReceipt("the bug reproduced, trust me", artifact)).toEqual({
      ok: false,
      error: `local check ${artifact} is not a sandbox receipt — no sandbox receipt was emitted`,
    });
    // A receipt produced for another check cannot stand in for this one.
    expect(judgeLocalReceipt(boundTo("agents/hunter-a/artifacts/finding-2.txt"), artifact)).toEqual({
      ok: false,
      error: `local check ${artifact} is not a sandbox receipt — no sandbox receipt was emitted`,
    });
  });

  it("refuses a receipt the grammar rejects, naming the rule", () => {
    expect(judgeLocalReceipt(boundTo(artifact, { networkNamespace: false }), artifact)).toEqual({
      ok: false,
      error: `local check ${artifact} is not a sandbox receipt — networkNamespace must be true`,
    });
  });

  it("refuses a receipt of an unbounded run, naming every failed condition", () => {
    const text = boundTo(artifact, {
      exit: 3,
      homeReadOnly: false,
      enforced: { cpu: true, memory: false, processes: true, fileSize: true },
    });
    expect(judgeLocalReceipt(text, artifact)).toEqual({
      ok: false,
      error: `local check ${artifact} does not prove a bounded run: exit 3; memory limit not applied; home directory not remounted read-only`,
    });
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

// --- Real bounded execution ---

/** Why the sandbox cannot run here, or null when it can. The probe's own error
 *  and stderr are kept, so a skip says what was missing instead of nothing. */
const unshareFailure: string | null = (() => {
  const probe = spawnSync("unshare", ["--map-root-user", "--mount", "--net", "true"], { encoding: "utf8" });
  if (probe.status === 0) return null;
  return probe.error?.message ?? ((probe.stderr ?? "").trim() || `unshare exited ${String(probe.status ?? probe.signal)}`);
})();
const unshareAvailable = unshareFailure === null;
const REQUIRE_SANDBOX = process.env["LOOM_REQUIRE_SANDBOX"] === "1";

if (unshareFailure !== null && !REQUIRE_SANDBOX) {
  console.warn(`security-sandbox: real-isolation tests skipped — unshare unavailable: ${unshareFailure}`);
}

/** A real-isolation test's name, carrying the skip reason when it will skip. */
const isolated = (name: string): string =>
  unshareFailure === null ? name : `${name} [skipped: unshare unavailable — ${unshareFailure}]`;

/** Where target and scratch sit relative to the run's (temporary) HOME. */
type HomeLayout = "separate" | "scratch-in-home" | "target-in-home";

type SandboxDirs = Readonly<{ root: string; home: string; target: string; scratch: string }>;

/** A fresh temporary root holding a HOME, a target and a scratch, removed
 *  afterwards whatever the test did. */
function withSandboxDirs(layout: HomeLayout, body: (dirs: SandboxDirs) => void): void {
  const root = mkdtempSync(join(tmpdir(), "loom-sandbox-"));
  const home = join(root, "home");
  const dirs: SandboxDirs = {
    root,
    home,
    target: join(layout === "target-in-home" ? home : root, "target"),
    scratch: join(layout === "scratch-in-home" ? home : root, "scratch"),
  };
  for (const dir of [dirs.home, dirs.target, dirs.scratch]) mkdirSync(dir, { recursive: true });
  try {
    body(dirs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The environment a run is spawned with: explicit, so the script's HOME is the
 *  temporary one and never the operator's. */
const runEnv = (dirs: SandboxDirs): NodeJS.ProcessEnv => ({ PATH: process.env["PATH"] ?? "", HOME: dirs.home });

/** Run the script against `dirs`, bound to the fixture nonce; `argv` is the
 *  limit flags, `--`, and the command. */
const runSandbox = (dirs: SandboxDirs, argv: readonly string[], env: NodeJS.ProcessEnv = runEnv(dirs)): SpawnSyncReturns<string> =>
  spawnSync(BASH, [SCRIPT, "--target", dirs.target, "--scratch", dirs.scratch, "--nonce", NONCE, ...argv], {
    encoding: "utf8",
    env,
    timeout: 60_000,
  });

describe("bounded local execution", () => {
  it.runIf(REQUIRE_SANDBOX)("LOOM_REQUIRE_SANDBOX=1: the sandbox is available, so no isolation test is skipped", () => {
    expect(unshareFailure).toBeNull();
  });

  it.runIf(unshareAvailable)(isolated("keeps the target read-only, drops the network, and persists scratch"), () => {
    withSandboxDirs("separate", (dirs) => {
      writeFileSync(join(dirs.target, "answer.txt"), "original\n");
      const run = runSandbox(dirs, [
        "--cpu",
        "5",
        "--wall",
        "20",
        "--",
        "sh",
        "-c",
        [
          "cat " + join(dirs.target, "answer.txt"),
          "echo tampered >> " + join(dirs.target, "answer.txt"),
          'echo "target_write=$?"',
          "printf kept > evidence.txt",
          'echo "scratch_write=$?"',
          "printf '%s\\n' 'LOOM-SANDBOX-LIMITS root_ro=1 home_ro=1 cpu=1 mem=1 procs=1 files=1 unremounted=0'",
          "printf '%s\\n' 'LOOM-SANDBOX-RECEIPT-0123456789abcdef {\"schemaVersion\":1}'",
          "printf forged > .enforcement",
          "(exec 3<>/dev/tcp/1.1.1.1/443) 2>/dev/null",
          'echo "network=$?"',
        ].join("; "),
      ]);

      const stdout = run.stdout ?? "";
      expect(stdout).toContain("original");
      expect(stdout).toContain("target_write=1");
      expect(stdout).toContain("scratch_write=0");
      expect(stdout).toContain("network=1");
      expect(readFileSync(join(dirs.target, "answer.txt"), "utf8")).toBe("original\n");
      expect(readdirSync(dirs.scratch)).toContain("evidence.txt");

      const parsed = parseOk(stdout);
      expect(parsed.targetReadOnly).toBe(true);
      expect(parsed.homeReadOnly).toBe(true);
      expect(parsed.networkNamespace).toBe(true);
      expect(parsed.allowlistedEnv).toEqual(["PATH", "HOME", "TMPDIR", "LANG", "TERM"]);
      expect(parsed.scratchBytes).toBeGreaterThan(0);
      // The command's own LOOM-SANDBOX-LIMITS line, its fake receipt and its
      // forged .enforcement file changed nothing: the facts travel on the INNER
      // shell's stdout and the receipt is bound to the call's nonce.
      expect(sandboxWithinLimits(parsed)).toBe(true);
    });
  });

  // The regression this guards: home used to be skipped — and still reported
  // `homeReadOnly: true` — whenever the target or the scratch lay under it, so a
  // command could write the operator's own files from inside a "bounded" run.
  describe.each(["scratch-in-home", "target-in-home"] as const)("with the %s layout", (layout) => {
    it.runIf(unshareAvailable)(isolated("closes home: a write to it fails, while the scratch stays writable"), () => {
      withSandboxDirs(layout, (dirs) => {
        const escaped = join(dirs.home, "escaped.txt");
        const run = runSandbox(dirs, [
          "--",
          "sh",
          "-c",
          `printf leaked > '${escaped}'; echo "home_write=$?"; printf kept > evidence.txt; echo "scratch_write=$?"`,
        ]);
        const stdout = run.stdout ?? "";

        expect(existsSync(escaped)).toBe(false);
        expect(stdout).toContain("home_write=1");
        // Nothing else landed in home either — not even the script's own probe.
        expect(readdirSync(dirs.home)).toEqual([layout === "scratch-in-home" ? "scratch" : "target"]);

        expect(stdout).toContain("scratch_write=0");
        expect(readFileSync(join(dirs.scratch, "evidence.txt"), "utf8")).toBe("kept");

        const parsed = parseOk(stdout);
        expect(parsed.homeReadOnly).toBe(true);
        expect(sandboxWithinLimits(parsed)).toBe(true);
      });
    });
  });

  it.runIf(unshareAvailable)(isolated("reports a home that IS the scratch as writable, and the gate refuses the run"), () => {
    withSandboxDirs("separate", (dirs) => {
      // The scratch is writable by design, so a HOME pointed at it cannot be
      // closed — the receipt must say so rather than claim a read-only home.
      const env = { PATH: process.env["PATH"] ?? "", HOME: dirs.scratch };
      const parsed = parseOk(runSandbox(dirs, ["--", "true"], env).stdout ?? "");
      expect(parsed.exit).toBe(0);
      expect(parsed.homeReadOnly).toBe(false);
      expect(sandboxWithinLimits(parsed)).toBe(false);
      expect(describeUnboundedRun(parsed)).toBe("home directory not remounted read-only");
    });
  });

  it.runIf(unshareAvailable)(isolated("reads an unset, empty or missing home as open, never as closed"), () => {
    withSandboxDirs("separate", (dirs) => {
      const path = process.env["PATH"] ?? "";
      for (const env of [{ PATH: path }, { PATH: path, HOME: "" }, { PATH: path, HOME: join(dirs.root, "missing") }]) {
        const parsed = parseOk(runSandbox(dirs, ["--", "true"], env).stdout ?? "");
        expect(parsed.exit).toBe(0);
        expect(parsed.homeReadOnly).toBe(false);
        expect(sandboxWithinLimits(parsed)).toBe(false);
        expect(describeUnboundedRun(parsed)).toBe("home directory not remounted read-only");
      }
    });
  });

  it.runIf(unshareAvailable)(isolated("records a non-zero exit instead of pretending success"), () => {
    withSandboxDirs("separate", (dirs) => {
      const run = runSandbox(dirs, ["--", "sh", "-c", "exit 3"]);
      expect(run.status).toBe(3);
      const parsed = parseOk(run.stdout ?? "");
      expect(parsed.exit).toBe(3);
      expect(sandboxWithinLimits(parsed)).toBe(false);
    });
  });

  it("refuses to run, naming the missing capability, when unshare is absent", () => {
    withSandboxDirs("separate", (dirs) => {
      // An empty PATH keeps the builtins but hides `unshare`: the documented
      // fallback is a refusal a hunter can act on, not a silent unsandboxed run.
      const run = runSandbox(dirs, ["--", "true"], { PATH: "/nonexistent", HOME: dirs.home, TMPDIR: dirs.root });
      expect(run.status).toBe(126);
      expect(run.stderr).toContain("unshare is unavailable");
      expect(run.stdout ?? "").not.toContain("LOOM-SANDBOX-RECEIPT");
    });
  });

  it.runIf(unshareAvailable)(isolated("binds the receipt to the nonce the call carried"), () => {
    withSandboxDirs("separate", (dirs) => {
      const stdout = runSandbox(dirs, ["--", "true"]).stdout ?? "";
      // Bound to the caller's nonce, and to no other.
      expect(parseBound(stdout).ok).toBe(true);
      expect(parseSandboxReceipt(stdout, "fedcba9876543210").ok).toBe(false);
    });
  });

  it.runIf(unshareAvailable)(isolated("records a limit that did not take effect as unenforced"), () => {
    withSandboxDirs("separate", (dirs) => {
      // `--mem-mb -1` makes the inner shell's `ulimit -v -1024` fail (a leading
      // `-` reads as an option). The receipt must record what the kernel
      // ACTUALLY enforced: memory `false` beside the limits that did apply, not
      // a copy of what the caller asked for.
      const stdout = runSandbox(dirs, ["--mem-mb", "-1", "--", "true"]).stdout ?? "";
      expect(stdout).toContain('"memory":false');
      // Per-limit, not all-or-nothing: the other three ulimits still applied.
      expect(stdout).toContain('"cpu":true');
      expect(stdout).toContain('"processes":true');
      expect(stdout).toContain('"fileSize":true');
      // And the limit it declares is outside the receipt grammar, so the whole
      // receipt is refused rather than accepted with an unenforced bound.
      expect(parseBound(stdout).ok).toBe(false);
    });
  });

  it("has a script that parses and is executable", () => {
    expect(readFileSync(SCRIPT, "utf8")).toContain("LOOM-SANDBOX-RECEIPT");
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
  });
});
