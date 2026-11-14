/**
 * Sandbox contract tests, pure half: the receipt grammar, the argv a hunter is
 * told to run, and the judgement on a `local` check. Nothing here spawns a
 * process — the real bounded executions, which need `unshare` and a bash, are
 * `security-sandbox-execution.test.ts`, so these run and report on any host
 * whatever its sandbox probe says.
 */

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
  sandboxCommand,
  sandboxWithinLimits,
  type SandboxLimits,
  type SandboxRequest,
} from "../../src/core/security-sandbox";
import { loomCommandsAt } from "../fixtures/loom-package-root";
import { ok } from "./fixtures";
import { NONCE, aSandboxReceipt, boundReceipt } from "./sandbox-fixtures";

/** A parse bound to the fixture nonce. */
const parseBound = (stdout: string) => parseSandboxReceipt(stdout, NONCE);

const parseOk = (stdout: string) => {
  const parsed = parseBound(stdout);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
};

/** A Loom package somewhere a hunter is not: the script is named under it. */
const SCRIPT = loomCommandsAt("/opt/loom").sandboxScript;

const limits = (overrides: Partial<SandboxLimits> = {}): SandboxLimits => ({ ...DEFAULT_SANDBOX_LIMITS, ...overrides });

/** A request the script accepts; each case states only what it varies. */
const sandboxArgs = (overrides: Partial<SandboxRequest> = {}): SandboxRequest => ({
  script: SCRIPT,
  target: "/repo",
  scratch: "/scratch",
  command: ["true"],
  limits: limits(),
  ...overrides,
});

describe("sandbox receipt", () => {
  it("parses the script's own output", () => {
    const parsed = parseOk(`command log line\n${boundReceipt()}\n`);
    expect(parsed.exit).toBe(0);
    expect(parsed.limits.cpuSeconds).toBe(DEFAULT_SANDBOX_LIMITS.cpuSeconds);
    expect(sandboxWithinLimits(parsed)).toBe(true);
  });

  it("takes the LAST receipt line, because a command may print its own", () => {
    const parsed = parseOk(`${boundReceipt({ exit: 1 })}\n${boundReceipt({ exit: 0 })}`);
    expect(parsed.exit).toBe(0);
  });

  it("refuses a missing receipt instead of assuming success", () => {
    expect(parseBound("all good, promise").ok).toBe(false);
  });

  it("refuses an unknown field and a wrong literal", () => {
    expect(parseBound(boundReceipt({ sandboxed: true })).ok).toBe(false);
    expect(parseBound(boundReceipt({ networkNamespace: false })).ok).toBe(false);
    expect(parseBound(boundReceipt({ targetReadOnly: "yes" })).ok).toBe(false);
    expect(parseBound(boundReceipt({ exit: 300 })).ok).toBe(false);
    expect(parseBound(boundReceipt({ scratchBytes: -1 })).ok).toBe(false);
  });

  it("records loopback as an observed fact that is reported, not gated", () => {
    // A dead loopback leaves the isolation intact, so it does not fail the
    // bounded-run gate — but the receipt names it instead of reading healthy.
    const down = parseOk(boundReceipt({ loopbackUp: false }));
    expect(down.loopbackUp).toBe(false);
    expect(sandboxWithinLimits(down)).toBe(true);
    expect(parseBound(boundReceipt({ loopbackUp: "up" }))).toEqual({
      ok: false,
      error: { kind: "invalid-sandbox-receipt", message: "loopbackUp must be a boolean" },
    });
    const { loopbackUp: _omitted, ...withoutLoopback } = JSON.parse(aSandboxReceipt()) as Record<string, unknown>;
    expect(parseBound(`${sandboxReceiptPrefix(NONCE)}${JSON.stringify(withoutLoopback)}`).ok).toBe(false);
  });

  it("hands the value parser's refusal through unchanged", () => {
    expect(parseBound(boundReceipt({ schemaVersion: 2 }))).toEqual({
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
    const parsed = parseOk(boundReceipt({ scratchBytes: 128 * 1024 * 1024 }));
    expect(sandboxWithinLimits(parsed)).toBe(false);
    expect(sandboxWithinLimits(parseOk(boundReceipt({ exit: 1, scratchBytes: 0 })))).toBe(false);
    // An UNMEASURED footprint is not a passing one.
    expect(sandboxWithinLimits(parseOk(boundReceipt({ scratchBytes: null })))).toBe(false);
  });

  it("refuses a run whose limits were not all applied", () => {
    expect(sandboxWithinLimits(parseOk(boundReceipt({ enforced: { cpu: true, memory: false, processes: true, fileSize: true } })))).toBe(false);
    // A failed ROOT remount is recorded, not fatal: a user namespace cannot
    // remount a superblock it does not own. What that leaves open is reported.
    expect(sandboxWithinLimits(parseOk(boundReceipt({ readOnlyRoot: false })))).toBe(true);
  });

  it("requires the target to be closed read-only — a fact, not a literal", () => {
    // The script reports `target_ro` only once a write to the target FAILED, and
    // a missing facts line reads as `false`: the receipt carries what happened.
    const open = parseOk(boundReceipt({ targetReadOnly: false }));
    expect(open.targetReadOnly).toBe(false);
    expect(sandboxWithinLimits(open)).toBe(false);
    expect(describeUnboundedRun(open)).toBe("target not remounted read-only");
    expect(parseBound(boundReceipt({ targetReadOnly: "yes" }))).toEqual({
      ok: false,
      error: { kind: "invalid-sandbox-receipt", message: "targetReadOnly must be a boolean" },
    });
  });

  it("requires the home directory to be closed read-only", () => {
    // Home is the writable surface the uid mapping leaves open — the one a
    // command could use to reach the operator's own files — so it is gated,
    // unlike the root remount a user namespace cannot perform.
    expect(sandboxWithinLimits(parseOk(boundReceipt({ homeReadOnly: false })))).toBe(false);
    expect(parseBound(boundReceipt({ homeReadOnly: "yes" })).ok).toBe(false);
    expect(parseBound(boundReceipt({ unremountedMounts: -1 })).ok).toBe(false);
    expect(parseBound(boundReceipt({ unremountedMounts: 3 })).ok).toBe(true);
  });

  it("admits exactly the environment the script passes, in its order", () => {
    // The literal the script's ENV_ASSIGNMENTS passes: LC_ALL is not in it,
    // because `env -i` never handed it to the child.
    expect(SANDBOX_ENV_ALLOWLIST).toEqual(["PATH", "HOME", "TMPDIR", "LANG", "TERM"]);
    expect(parseOk(boundReceipt()).allowlistedEnv).toEqual(["PATH", "HOME", "TMPDIR", "LANG", "TERM"]);
    const refused = [
      ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"],
      ["PATH", "HOME", "TMPDIR", "LANG"],
      ["HOME", "PATH", "TMPDIR", "LANG", "TERM"],
      ["PATH", "HOME", "TMPDIR", "LANG", "TERM", "AWS_SECRET_ACCESS_KEY"],
      [],
      "PATH,HOME,TMPDIR,LANG,TERM",
    ];
    for (const allowlistedEnv of refused) {
      expect(parseBound(boundReceipt({ allowlistedEnv }))).toEqual({
        ok: false,
        error: { kind: "invalid-sandbox-receipt", message: "allowlistedEnv must be exactly [PATH, HOME, TMPDIR, LANG, TERM]" },
      });
    }
  });

  it("requires the caller's nonce in the marker", () => {
    const stdout = `${boundReceipt({ exit: 1 })}\n${boundReceipt({ exit: 0 })}\n`;
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
    expect(parseSandboxReceipt(boundReceipt({}, derived), sandboxNonce("other.txt")).ok).toBe(false);
  });

  it("bounds the nonce grammar", () => {
    expect(sandboxCommand(sandboxArgs({ nonce: "0123456789abcdef" })).ok).toBe(true);
    expect(sandboxCommand(sandboxArgs({ nonce: "nothex" })).ok).toBe(false);
    expect(sandboxCommand(sandboxArgs({ nonce: "0123" })).ok).toBe(false);
  });
});

describe("describeUnboundedRun", () => {
  it("names every gated condition that failed, in gate order", () => {
    const parsed = parseOk(boundReceipt({
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
    const parsed = parseOk(boundReceipt({ exit: 2, scratchBytes: 64 * 1024 * 1024 + 1 }));
    expect(describeUnboundedRun(parsed)).toBe(`exit 2; scratch ${64 * 1024 * 1024 + 1} B over its 64 MB allowance`);
    // Exactly at the allowance is inside it.
    expect(describeUnboundedRun(parseOk(boundReceipt({ scratchBytes: 64 * 1024 * 1024 })))).toBe("unknown");
  });

  it("reads 'unknown' for a run the gate accepts, and ignores the recorded residual exposure", () => {
    const parsed = parseOk(boundReceipt({ readOnlyRoot: false, unremountedMounts: 7 }));
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
    const command = sandboxCommand(sandboxArgs({
      scratch: "/runs/audit-1/agents/hunter-a/scratch",
      command: ["node", "--version"],
      limits: limits({ cpuSeconds: 3, wallClockSeconds: 5 }),
    }));
    if (!command.ok) throw new Error(JSON.stringify(command.error));
    // The script is named by its absolute path in the package: a hunter's
    // working directory is the audited repository, not the Loom package.
    expect(command.value[0]).toBe("/opt/loom/scripts/security-sandbox.sh");
    expect(command.value.slice(-3)).toEqual(["--", "node", "--version"]);
    expect(command.value).toContain("--scratch-mb");
    expect(command.value[command.value.indexOf("--cpu") + 1]).toBe("3");
  });

  it("refuses a scratch inside the target, an empty command, and bad limits", () => {
    expect(sandboxCommand(sandboxArgs({ scratch: "/repo/scratch" })).ok).toBe(false);
    expect(sandboxCommand(sandboxArgs({ command: [] })).ok).toBe(false);
    expect(sandboxCommand(sandboxArgs({ limits: limits({ cpuSeconds: 0 }) })).ok).toBe(false);
    expect(sandboxCommand(sandboxArgs({ command: ["a\u0000b"] })).ok).toBe(false);
  });

  const BINDING = {
    script: SCRIPT,
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
    const bound = bindSandboxRun({ script: SCRIPT, target: "/repo", runDir: "/runs/run-1/", owner: "security-hunter-agent--2", artifact });
    expect(bound).toEqual({
      ok: true,
      value: {
        script: SCRIPT,
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
    const refused = bindSandboxRun({ script: SCRIPT, target, runDir, owner: "security-hunter-agent", artifact: "agents/security-hunter-agent/artifacts/a.txt" });
    expect(refused.ok ? null : refused.error.kind).toBe("scratch-inside-target");
    expect(refused.ok ? "" : refused.error.message).toContain("outside the audited repository");
  });

  it("does not mistake a sibling directory sharing the target's prefix for the target", () => {
    expect(bindSandboxRun({ script: SCRIPT, target: "/repo", runDir: "/repo-audits/run-1", owner: "security-hunter-agent", artifact: "agents/security-hunter-agent/artifacts/a.txt" }).ok).toBe(true);
  });

  it("fills every placeholder from the binding: target, scratch, nonce, and the one artifact stdout lands in", () => {
    const text = renderSandboxInstructions(DEFAULT_SANDBOX_LIMITS, BINDING);
    expect(text).toContain(`  ${SCRIPT} --target ${BINDING.target} --scratch ${BINDING.scratch}`);
    expect(text).toContain(`> ${BINDING.artifactFile}`);
    expect(text).toContain(`Redirect the script's stdout to exactly ${BINDING.artifactFile}`);
    expect(text).toContain(`"${BINDING.artifact}"`);
    // No placeholder survives: a hunter cannot compute the nonce or guess the paths.
    expect(text).not.toMatch(/<repo>|<run>|<your-agent-id>/);
    // The printed command line is the argv `sandboxCommand` builds, flag for flag.
    const words = ok(sandboxCommand(sandboxArgs({ target: BINDING.target, scratch: BINDING.scratch, nonce: NONCE })));
    const flags = words.slice(1, words.indexOf("--"));
    expect(text.replace(/\\\n\s*/g, "")).toContain(flags.join(" "));
  });
});
