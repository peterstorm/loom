/**
 * `SandboxRun` evidence: minting, wire parsing, and the fact that it advances
 * no guard.
 *
 * The claim this file proves is the one the audit depends on: "reproduced
 * locally" is a FACT only when the script's own receipt says so. A hunter that
 * prints the word "reproduced" mints nothing; a receipt with a false network
 * claim is invalid; a receipt that lost a line is absent; and a run under the
 * sandbox never advances a phase, so a hunter cannot buy progress with `true`.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_SANDBOX_LIMITS } from "../../src/core/security-sandbox";
import { extractEvidence } from "../../src/machine/extract-evidence";
import { parseEvidenceLine } from "../../src/machine/evidence";
import { tokensFor } from "../../src/machine/advance";
import type { HarnessToolCall } from "../../src/machine/harness-tool-call-types";
import type { SandboxReceipt } from "../../src/core/security-sandbox";
import { NONCE, aSandboxReceipt, boundReceipt } from "./sandbox-fixtures";

const noReport = () => null;

const bash = (command: string, stdout: string, exit = 0): HarnessToolCall => ({
  tool: "Bash",
  input: { command },
  outcome: { kind: "exited", exit, stdout },
  callId: null,
  cwd: ".",
});

const sandboxed = (stdout: string, command = `scripts/security-sandbox.sh --nonce ${NONCE} --target . -- scratch/run.sh`): HarnessToolCall =>
  bash(command, stdout);

const sandboxRuns = (call: HarnessToolCall): readonly SandboxReceipt[] =>
  extractEvidence(call, noReport).flatMap((event) => (event.kind === "SandboxRun" ? [event.receipt] : []));

describe("SandboxRun evidence", () => {
  it("mints a fact from the script's receipt, whatever exit the run had", () => {
    const ok = sandboxRuns(sandboxed(`log line\n${boundReceipt()}\n`));
    expect(ok).toHaveLength(1);
    expect(ok[0]?.exit).toBe(0);
    expect(ok[0]?.limits).toEqual(DEFAULT_SANDBOX_LIMITS);

    const failed = sandboxRuns(
      sandboxed(boundReceipt({ exit: 1 }), `bash scripts/security-sandbox.sh --nonce ${NONCE} -- true`),
    );
    expect(failed[0]?.exit).toBe(1);
  });

  it("mints nothing when the receipt is not bound to the call's own nonce", () => {
    // A receipt line the call printed itself, or one copied from another
    // artifact: the marker must carry the nonce this very command passed.
    const unbound = "scripts/security-sandbox.sh --target . -- repro";
    expect(sandboxRuns(bash(unbound, boundReceipt()))).toEqual([]);
    expect(sandboxRuns(bash(`${unbound} --nonce fedcba9876543210`, boundReceipt()))).toEqual([]);
  });

  it("mints nothing when the output carries no receipt", () => {
    expect(sandboxRuns(bash("scripts/security-sandbox.sh --target . -- repro", "the bug reproduced, trust me"))).toEqual([]);
  });

  it("mints nothing when the command does not name the one executor", () => {
    expect(sandboxRuns(bash("./my-security-sandbox.sh", boundReceipt()))).toEqual([]);
    expect(sandboxRuns(bash("sh -c 'echo hi'", boundReceipt()))).toEqual([]);
  });

  it("mints nothing for an interrupted call, whose receipt describes an unfinished run", () => {
    const interrupted: HarnessToolCall = {
      tool: "Bash",
      input: { command: `scripts/security-sandbox.sh --nonce ${NONCE} -- repro` },
      outcome: { kind: "interrupted" },
      callId: null,
      cwd: ".",
    };
    expect(sandboxRuns(interrupted)).toEqual([]);
  });

  it("never advances a machine guard", () => {
    const [receipt] = sandboxRuns(sandboxed(boundReceipt()));
    expect(receipt).toBeDefined();
    expect(tokensFor({ kind: "SandboxRun", receipt: receipt as SandboxReceipt })).toEqual([]);
  });

  it("re-mints the receipt at the ledger boundary, refusing a false claim", () => {
    const line = (receipt: unknown): string =>
      JSON.stringify({ epoch: "hunter-a:security-hunter-agent", event: { kind: "SandboxRun", receipt } });

    const parsed = parseEvidenceLine(line(JSON.parse(aSandboxReceipt())));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.event.kind).toBe("SandboxRun");

    expect(parseEvidenceLine(line(JSON.parse(aSandboxReceipt({ networkNamespace: false })))).ok).toBe(false);
    expect(parseEvidenceLine(line(JSON.parse(aSandboxReceipt({ unexpected: 1 })))).ok).toBe(false);
    // An environment the script never passes is a false claim, not a detail.
    expect(parseEvidenceLine(line(JSON.parse(aSandboxReceipt({ allowlistedEnv: ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"] })))).ok).toBe(false);
    // An open target is a recorded fact, kept as reported — never coerced to closed.
    const openTarget = parseEvidenceLine(line(JSON.parse(aSandboxReceipt({ targetReadOnly: false }))));
    expect(openTarget.ok && openTarget.value.event.kind === "SandboxRun" ? openTarget.value.event.receipt.targetReadOnly : null).toBe(false);
    expect(parseEvidenceLine(line(JSON.parse(aSandboxReceipt({ targetReadOnly: "yes" })))).ok).toBe(false);
    expect(parseEvidenceLine(line("not a receipt")).ok).toBe(false);
    expect(parseEvidenceLine(JSON.stringify({ epoch: "hunter-a:security-hunter-agent", event: { kind: "SandboxRun" } })).ok).toBe(false);
  });
});
