/**
 * Sandbox contract tests, execution half: the printed command read back by a
 * real bash, and real bounded executions of `scripts/security-sandbox.sh`.
 * The receipt grammar and command rendering are pure, and live in
 * `security-sandbox.test.ts`.
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
  describeUnboundedRun,
  parseSandboxReceipt,
  renderSandboxInstructions,
  renderShellWords,
  sandboxCommand,
  sandboxReceiptPrefix,
  sandboxScriptPath,
  sandboxWithinLimits,
} from "../../src/core/security-sandbox";
import { ok } from "./fixtures";
import { NONCE } from "./sandbox-fixtures";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "security-sandbox.sh");
/**
 * Absolute bash, for the script and for every sandboxed probe. Absolute, because
 * the fallback test hides `unshare` with a PATH that resolves nothing, which
 * would also hide the interpreter if the spawn resolved it through that PATH.
 * Bash, because the probes' assertions read bash semantics: a failed redirection
 * exits 1 and `/dev/tcp` opens a socket. `sh` is dash on Ubuntu, which exits 2
 * and has no `/dev/tcp` — there a network probe would only ever measure a
 * missing file.
 */
const BASH = (spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).stdout ?? "").trim();

/** A parse bound to the run's nonce. */
const parseBound = (stdout: string) => parseSandboxReceipt(stdout, NONCE);

const parseOk = (stdout: string) => ok(parseBound(stdout));

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
      script: sandboxScriptPath("/opt/my plugins/loom"),
      nonce: NONCE, target: "/srv/my repo", scratch: "/runs/it's here/agents/a/scratch",
      artifact: "agents/a/artifacts/x $y.txt", artifactFile: "/runs/it's here/agents/a/artifacts/x $y.txt",
    };
    const lines = renderSandboxInstructions(DEFAULT_SANDBOX_LIMITS, binding).split("\n");
    const mkdir = lines.find((line) => line.trimStart().startsWith("mkdir"))!;
    expect(shellWords(mkdir.trim())).toEqual(["mkdir", "-p", "/runs/it's here/agents/a/artifacts"]);
    const sandbox = lines.find((line) => line.includes("security-sandbox.sh"))!;
    const [invocation, redirect] = sandbox.trim().split(" -- <command> [args...] > ");
    const words = ok(sandboxCommand({ script: binding.script, target: binding.target, scratch: binding.scratch, command: ["true"], limits: DEFAULT_SANDBOX_LIMITS, nonce: NONCE }));
    const flags = words.slice(0, words.indexOf("--"));
    expect(shellWords(invocation!)).toEqual(flags);
    expect(shellWords(redirect!)).toEqual([binding.artifactFile]);
    // The script is one word naming the package's own file by absolute path,
    // quoted because this package root holds a space; the hex nonce stays bare.
    // That the evidence extractor recognises this printed line as an invocation
    // bound to the binding's nonce is pinned in tests/machine/sandbox-invocation.test.ts.
    expect(invocation).toMatch(/^'\/opt\/my plugins\/loom\/scripts\/security-sandbox\.sh' /);
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

/**
 * A real-isolation test: run only where `unshare` works, and named with the
 * skip reason where it does not. One helper, so a new isolation test cannot
 * gate without naming its skip, or name it without gating.
 */
const isolatedIt = (name: string, body: () => void): void => {
  it.runIf(unshareAvailable)(unshareAvailable ? name : `${name} [skipped: unshare unavailable — ${String(unshareFailure)}]`, body);
};

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

  isolatedIt("keeps the target read-only, drops the network, and persists scratch", () => {
    withSandboxDirs("separate", (dirs) => {
      writeFileSync(join(dirs.target, "answer.txt"), "original\n");
      const run = runSandbox(dirs, [
        "--cpu",
        "5",
        "--wall",
        "20",
        "--",
        BASH,
        "-c",
        [
          "cat " + join(dirs.target, "answer.txt"),
          "echo tampered >> " + join(dirs.target, "answer.txt"),
          'echo "target_write=$?"',
          "printf kept > evidence.txt",
          'echo "scratch_write=$?"',
          "printf '%s\\n' 'LOOM-SANDBOX-LIMITS target_ro=1 root_ro=1 home_ro=1 cpu=1 mem=1 procs=1 files=1 lo=1 unremounted=0'",
          `printf '%s\\n' '${sandboxReceiptPrefix(NONCE)}{"schemaVersion":1}'`,
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
    isolatedIt("closes home: a write to it fails, while the scratch stays writable", () => {
      withSandboxDirs(layout, (dirs) => {
        const escaped = join(dirs.home, "escaped.txt");
        const run = runSandbox(dirs, [
          "--",
          BASH,
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

  isolatedIt("reports a home that IS the scratch as writable, and the gate refuses the run", () => {
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

  isolatedIt("reads an unset, empty or missing home as open, never as closed", () => {
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
  isolatedIt("ignores a facts line the command writes through any fd it can reach", () => {
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
  isolatedIt("closes every descriptor the caller passed down before the command starts", () => {
    withSandboxDirs("separate", (dirs) => {
      const outside = join(dirs.root, "inherited.txt");
      const handle = openSync(outside, "w");
      try {
        const run = spawnSync(
          BASH,
          [SCRIPT, "--target", dirs.target, "--scratch", dirs.scratch, "--nonce", NONCE, "--", BASH, "-c",
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

  isolatedIt("records a non-zero exit instead of pretending success", () => {
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

  isolatedIt("binds the receipt to the nonce the call carried", () => {
    withSandboxDirs("separate", (dirs) => {
      const stdout = runSandbox(dirs, ["--", "true"]).stdout ?? "";
      // Bound to the caller's nonce, and to no other.
      expect(parseBound(stdout).ok).toBe(true);
      expect(parseSandboxReceipt(stdout, "fedcba9876543210").ok).toBe(false);
    });
  });

  isolatedIt("records a limit that did not take effect as unenforced", () => {
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
