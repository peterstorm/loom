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
 * skipped test's name. With `LOOM_REQUIRE_SANDBOX=1` (CI sets it on the Linux leg,
 * after lifting Ubuntu's AppArmor user-namespace restriction) an
 * unavailable sandbox FAILS the suite instead of skipping. The script's own
 * documented fallback — a refusal naming the missing capability — is checked
 * unconditionally.
 */

import fc from "fast-check";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SANDBOX_LIMITS,
  bindSandboxRun,
  SANDBOX_ENV_ALLOWLIST,
  SANDBOX_RECEIPT_PREFIX,
  describeUnboundedRun,
  judgeLocalReceipt,
  sandboxNonce,
  sandboxReceiptPrefix,
  parseSandboxLimits,
  parseSandboxReceipt,
  renderSandboxInstructions,
  renderShellWords,
  sandboxCommand,
  sandboxWithinLimits,
  type SandboxLimits,
} from "../../src/core/security-sandbox";
import { aSandboxReceipt } from "./sandbox-fixtures";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "security-sandbox.sh");
/** Absolute bash: the fallback test hides `unshare` with a PATH that resolves nothing,
 *  which would also hide the interpreter if the spawn resolved it through that PATH. */
const BASH = (spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).stdout ?? "").trim();
/** The shell a sandboxed probe runs in when its assertions read bash semantics: a
 *  failed redirection exits 1 and `/dev/tcp` opens a socket. `sh` is dash on
 *  Ubuntu, which exits 2 and has no `/dev/tcp` — there a network probe would only
 *  ever measure a missing file. Absolute, so the probe never depends on PATH. */
const PROBE_SHELL = BASH;

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

  it("records loopback as an observed fact that is reported, not gated", () => {
    // A dead loopback leaves the isolation intact, so it does not fail the
    // bounded-run gate — but the receipt names it instead of reading healthy.
    const down = parseOk(receipt({ loopbackUp: false }));
    expect(down.loopbackUp).toBe(false);
    expect(sandboxWithinLimits(down)).toBe(true);
    expect(parseBound(receipt({ loopbackUp: "up" }))).toEqual({
      ok: false,
      error: { kind: "invalid-sandbox-receipt", message: "loopbackUp must be a boolean" },
    });
    const { loopbackUp: _omitted, ...withoutLoopback } = JSON.parse(aSandboxReceipt()) as Record<string, unknown>;
    expect(parseBound(`${sandboxReceiptPrefix(NONCE)}${JSON.stringify(withoutLoopback)}`).ok).toBe(false);
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
  });

  it("requires the target to be closed read-only — a fact, not a literal", () => {
    // The script reports `target_ro` only once a write to the target FAILED, and
    // a missing facts line reads as `false`: the receipt carries what happened.
    const open = parseOk(receipt({ targetReadOnly: false }));
    expect(open.targetReadOnly).toBe(false);
    expect(sandboxWithinLimits(open)).toBe(false);
    expect(describeUnboundedRun(open)).toBe("target not remounted read-only");
    expect(parseBound(receipt({ targetReadOnly: "yes" }))).toEqual({
      ok: false,
      error: { kind: "invalid-sandbox-receipt", message: "targetReadOnly must be a boolean" },
    });
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
      targetReadOnly: false,
      homeReadOnly: false,
      enforced: { cpu: false, memory: false, processes: false, fileSize: false },
    }));
    expect(describeUnboundedRun(parsed)).toBe(
      "exit null; scratch footprint unmeasured; cpu limit not applied; memory limit not applied; " +
        "process limit not applied; file-size limit not applied; target not remounted read-only; " +
        "home directory not remounted read-only",
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

  const BINDING = {
    nonce: NONCE,
    target: "/repo",
    scratch: "/runs/run-1/agents/security-hunter-agent/scratch",
    artifact: "agents/security-hunter-agent/artifacts/sqli.txt",
    artifactFile: "/runs/run-1/agents/security-hunter-agent/artifacts/sqli.txt",
  } as const;

  it("tells a hunter what it may not assume", () => {
    const text = renderSandboxInstructions(DEFAULT_SANDBOX_LIMITS, BINDING);
    expect(text).toContain("--scratch-mb");
    expect(text).toContain("--nonce " + NONCE);
    expect(text).toContain("No external network, no writable target or home");
    expect(text).toContain("record needs_validation naming the missing capability");
  });

  it("binds a run to one artifact: the judge's own nonce, the owner's scratch, and the artifact's file", () => {
    const artifact = "agents/security-hunter-agent--2/artifacts/sqli.txt";
    const bound = bindSandboxRun({ target: "/repo", runDir: "/runs/run-1/", owner: "security-hunter-agent--2", artifact });
    expect(bound).toEqual({
      ok: true,
      value: {
        nonce: sandboxNonce(artifact),
        target: "/repo",
        scratch: "/runs/run-1/agents/security-hunter-agent--2/scratch",
        artifact,
        artifactFile: `/runs/run-1/${artifact}`,
      },
    });
    // The nonce is the one `judgeLocalReceipt` derives for the cited artifact.
    const receiptText = `${sandboxReceiptPrefix(sandboxNonce(artifact))}${aSandboxReceipt()}`;
    expect(judgeLocalReceipt(receiptText, artifact).ok).toBe(true);
  });

  it.each([
    ["a run directory inside the target", "/repo", "/repo/.audit/run-1"],
    ["a run directory that is the target", "/repo", "/repo"],
  ])("refuses %s, whose scratch the script would refuse", (_case, target, runDir) => {
    const refused = bindSandboxRun({ target, runDir, owner: "security-hunter-agent", artifact: "agents/security-hunter-agent/artifacts/a.txt" });
    expect(refused.ok ? null : refused.error.kind).toBe("scratch-inside-target");
    expect(refused.ok ? "" : refused.error.message).toContain("outside the audited repository");
  });

  it("does not mistake a sibling directory sharing the target's prefix for the target", () => {
    expect(bindSandboxRun({ target: "/repo", runDir: "/repo-audits/run-1", owner: "security-hunter-agent", artifact: "agents/security-hunter-agent/artifacts/a.txt" }).ok).toBe(true);
  });

  it("fills every placeholder from the binding: target, scratch, nonce, and the one artifact stdout lands in", () => {
    const text = renderSandboxInstructions(DEFAULT_SANDBOX_LIMITS, BINDING);
    expect(text).toContain(`--target ${BINDING.target} --scratch ${BINDING.scratch}`);
    expect(text).toContain(`> ${BINDING.artifactFile}`);
    expect(text).toContain(`Redirect the script's stdout to exactly ${BINDING.artifactFile}`);
    expect(text).toContain(`"${BINDING.artifact}"`);
    // No placeholder survives: a hunter cannot compute the nonce or guess the paths.
    expect(text).not.toMatch(/<repo>|<run>|<your-agent-id>/);
    // The printed command line is the argv `sandboxCommand` builds, flag for flag.
    const argv = sandboxCommand({ target: BINDING.target, scratch: BINDING.scratch, command: ["true"], limits: DEFAULT_SANDBOX_LIMITS, nonce: NONCE });
    const flags = (argv.ok ? argv.value : []).slice(1, (argv.ok ? argv.value : []).indexOf("--"));
    expect(text.replace(/\\\n\s*/g, "")).toContain(flags.join(" "));
  });
});

describe("the printed sandbox command reads back as exactly its argv", () => {
  /** What a real shell makes of `line`: each word, NUL-separated. */
  const shellWords = (line: string): readonly string[] => {
    const echoed = spawnSync(BASH, ["-c", `printf '%s\\0' ${line}`], { encoding: "utf8" });
    return (echoed.stdout ?? "").split("\0").slice(0, -1);
  };
  const awkward = fc.string({ unit: fc.oneof(fc.constantFrom(" ", "'", "\"", "$", "`", "\\", "\n", "*", ";", "&", "|", "~", "(", "#"), fc.string({ minLength: 1, maxLength: 1 })) });

  it("round-trips any argv through one shell line (property, real bash)", () => {
    fc.assert(fc.property(fc.array(awkward.filter((word) => !word.includes("\0")), { minLength: 1, maxLength: 4 }), (argv) => {
      expect(shellWords(renderShellWords(argv))).toEqual(argv);
    }), { numRuns: 40 });
  });

  it("prints a run directory with a space or a metacharacter as the words the binding names", () => {
    const binding = {
      nonce: NONCE, target: "/srv/my repo", scratch: "/runs/it's here/agents/a/scratch",
      artifact: "agents/a/artifacts/x $y.txt", artifactFile: "/runs/it's here/agents/a/artifacts/x $y.txt",
    };
    const lines = renderSandboxInstructions(DEFAULT_SANDBOX_LIMITS, binding).split("\n");
    const mkdir = lines.find((line) => line.trimStart().startsWith("mkdir"))!;
    expect(shellWords(mkdir.trim())).toEqual(["mkdir", "-p", "/runs/it's here/agents/a/artifacts"]);
    const sandbox = lines.find((line) => line.includes("security-sandbox.sh"))!;
    const [invocation, redirect] = sandbox.trim().split(" -- <command> [args...] > ");
    const argv = sandboxCommand({ target: binding.target, scratch: binding.scratch, command: ["true"], limits: DEFAULT_SANDBOX_LIMITS, nonce: NONCE });
    const flags = (argv.ok ? argv.value : []).slice(0, (argv.ok ? argv.value : []).indexOf("--"));
    expect(shellWords(invocation!)).toEqual(flags);
    expect(shellWords(redirect!)).toEqual([binding.artifactFile]);
    // The script path and the hex nonce stay bare words. That the evidence
    // extractor recognises this printed line as an invocation bound to the
    // binding's nonce is pinned in tests/machine/sandbox-invocation.test.ts.
    expect(invocation).toMatch(/^scripts\/security-sandbox\.sh /);
    expect(invocation).toMatch(new RegExp(` --nonce ${NONCE}$`));
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
  unshareAvailable ? name : `${name} [skipped: unshare unavailable — ${String(unshareFailure)}]`;

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
        PROBE_SHELL,
        "-c",
        [
          "cat " + join(dirs.target, "answer.txt"),
          "echo tampered >> " + join(dirs.target, "answer.txt"),
          'echo "target_write=$?"',
          "printf kept > evidence.txt",
          'echo "scratch_write=$?"',
          "printf '%s\\n' 'LOOM-SANDBOX-LIMITS target_ro=1 root_ro=1 home_ro=1 cpu=1 mem=1 procs=1 files=1 lo=1 unremounted=0'",
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
      // Observed before the command ran: up exactly when the namespace could run `ip`.
      expect(parsed.loopbackUp).toBe(spawnSync(BASH, ["-c", "command -v ip"], { env: runEnv(dirs) }).status === 0);
      expect(parsed.allowlistedEnv).toEqual(["PATH", "HOME", "TMPDIR", "LANG", "TERM"]);
      expect(parsed.scratchBytes).toBeGreaterThan(0);
      // The command's own LOOM-SANDBOX-LIMITS line, its fake receipt and its
      // forged .enforcement file changed nothing: the facts travel on the INNER
      // shell's stdout and the receipt is bound to the call's nonce.
      expect(sandboxWithinLimits(parsed)).toBe(true);
    });
  });

  // Invariant: home is closed whatever the layout. With the target or the
  // scratch under it, a write to home still fails inside the sandbox and
  // `homeReadOnly` reports exactly that — a "bounded" run cannot edit the
  // operator's own files (a layout that once skipped home while reporting it
  // closed is the regression pinned here).
  describe.each(["scratch-in-home", "target-in-home"] as const)("with the %s layout", (layout) => {
    it.runIf(unshareAvailable)(isolated("closes home: a write to it fails, while the scratch stays writable"), () => {
      withSandboxDirs(layout, (dirs) => {
        const escaped = join(dirs.home, "escaped.txt");
        const run = runSandbox(dirs, [
          "--",
          PROBE_SHELL,
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

  // Invariant: the inner shell is PID 1 of the sandbox's pid namespace and
  // releases the capture pipe before the command starts, so no fd the command
  // can reach — `/proc/1/fd/1` included — carries a facts line into the
  // receipt. A forged line on any of them changes no enforcement fact.
  it.runIf(unshareAvailable)(isolated("ignores a facts line the command writes through any fd it can reach"), () => {
    const FORGED = "LOOM-SANDBOX-LIMITS target_ro=1 root_ro=1 home_ro=1 cpu=1 mem=1 procs=1 files=1 lo=1 unremounted=0";
    const PREVIOUS_FORGED = "LOOM-SANDBOX-LIMITS target_ro=1 root_ro=1 home_ro=1 cpu=1 mem=1 procs=1 files=1 unremounted=0";
    const LEGACY_FORGED = "LOOM-SANDBOX-LIMITS root_ro=1 home_ro=1 cpu=1 mem=1 procs=1 files=1 unremounted=0";
    const forge = (line: string): string =>
      [
        // PID 1 (the inner shell) and every process of the namespace, on every fd.
        `for fd in /proc/[0-9]*/fd/*; do printf '%s\\n' '${line}' > "$fd"; done`,
        `printf '%s\\n' '${line}' > /proc/1/fd/1`,
        `printf '%s\\n' '${line}' > /proc/1/fd/2`,
        `printf '%s\\n' '${line}' > /proc/self/fd/1`,
        `printf '%s\\n' '${line}' > /dev/stdout`,
      ].map((step) => `{ ${step}; } 2>/dev/null`).join("; ");
    withSandboxDirs("separate", (dirs) => {
      const genuine = parseOk(runSandbox(dirs, ["--", "sh", "-c", "exit 0"]).stdout ?? "");
      const forged = parseOk(
        runSandbox(dirs, ["--", "sh", "-c", `${forge(FORGED)}; ${forge(PREVIOUS_FORGED)}; ${forge(LEGACY_FORGED)}; exit 0`]).stdout ?? "",
      );
      // The footprint differs with what the command left behind; every
      // ENFORCEMENT fact must be the one the identical honest run reports.
      const facts = ({ scratchBytes: _scratchBytes, ...rest }: typeof genuine) => rest;
      expect(facts(forged)).toEqual(facts(genuine));
      expect(forged.targetReadOnly).toBe(true);
      expect(forged.homeReadOnly).toBe(true);
    });
  });

  // Invariant: no descriptor the caller holds reaches the command. A child
  // inherits every fd not marked close-on-exec, so an open file outside the
  // sandbox (or a CI runner's control pipe) would otherwise be writable past
  // every read-only mount — the CI regression this pins wrote garbage into the
  // runner's own pipe through exactly such an fd.
  it.runIf(unshareAvailable)(isolated("closes every descriptor the caller passed down before the command starts"), () => {
    withSandboxDirs("separate", (dirs) => {
      const outside = join(dirs.root, "inherited.txt");
      const handle = openSync(outside, "w");
      try {
        const run = spawnSync(
          BASH,
          [SCRIPT, "--target", dirs.target, "--scratch", dirs.scratch, "--nonce", NONCE, "--", PROBE_SHELL, "-c",
            // The descriptor list goes to a file first: a `$(…)` around `ls`
            // would itself hold a pipe in this shell while listing it.
            'echo leaked >&3 && echo "inherited_write=0" || echo "inherited_write=1"; ls /proc/$$/fd > fds.txt; echo "fds=$(tr "\\n" " " < fds.txt)"'],
          { encoding: "utf8", env: runEnv(dirs), timeout: 60_000, stdio: ["pipe", "pipe", "pipe", handle] },
        );
        const stdout = run.stdout ?? "";
        expect(stdout).toContain("inherited_write=1");
        // The command's own shell holds stdin, stdout and stderr — nothing else.
        expect(stdout).toMatch(/fds=0 1 2 \n/);
        expect(parseOk(stdout).exit).toBe(0);
      } finally {
        closeSync(handle);
      }
      expect(readFileSync(outside, "utf8")).toBe("");
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
      // A PATH that resolves nothing keeps the builtins but hides `unshare`: the documented
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
