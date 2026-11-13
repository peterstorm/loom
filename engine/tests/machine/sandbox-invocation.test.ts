/**
 * SandboxRun minting binds the receipt to an INVOCATION, not to text: the
 * script word and its `--nonce` must come from the one simple command that
 * runs the script. A regex over the whole line paired a script named in an
 * `echo` with a nonce from anywhere else, so a call could print both and mint
 * a sandbox fact for a run that never happened.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SANDBOX_LIMITS,
  renderSandboxInstructions,
  sandboxReceiptPrefix,
  sandboxScriptPath,
  type SandboxReceipt,
} from "../../src/core/security-sandbox";
import { extractEvidence } from "../../src/machine/extract-evidence";
import type { HarnessToolCall } from "../../src/machine/harness-tool-call-types";
import { aSandboxReceipt } from "../security/sandbox-fixtures";

const NONCE = "0123456789abcdef";
const OTHER = "fedcba9876543210";

const receiptLine = (nonce: string): string => `${sandboxReceiptPrefix(nonce)}${aSandboxReceipt()}`;

const sandboxRuns = (command: string, stdout: string = receiptLine(NONCE)): readonly SandboxReceipt[] => {
  const call: HarnessToolCall = {
    tool: "Bash",
    input: { command },
    outcome: { kind: "exited", exit: 0, stdout },
    callId: null,
    cwd: ".",
  };
  return extractEvidence(call, () => null).flatMap((event) => (event.kind === "SandboxRun" ? [event.receipt] : []));
};

describe("SandboxRun — the receipt binds to the invocation that runs the script", () => {
  it.each([
    ["the script as the head", `scripts/security-sandbox.sh --nonce ${NONCE} --target . -- repro`],
    ["a ./ path", `./scripts/security-sandbox.sh --target . --nonce ${NONCE} -- repro`],
    ["an absolute path", `/opt/loom/scripts/security-sandbox.sh --nonce=${NONCE} -- repro`],
    ["a quoted nonce", `scripts/security-sandbox.sh --nonce '${NONCE}' -- repro`],
    ["bash running the script", `bash scripts/security-sandbox.sh --nonce ${NONCE} -- true`],
    ["sh with an option before the script", `sh -e scripts/security-sandbox.sh --nonce ${NONCE} -- true`],
    ["an env prefix", `LANG=C scripts/security-sandbox.sh --nonce ${NONCE} -- repro`],
    ["a wrapper", `timeout 60 scripts/security-sandbox.sh --nonce ${NONCE} -- repro`],
    ["a later segment of the line", `cd /repo && scripts/security-sandbox.sh --nonce ${NONCE} -- repro | tee log`],
  ])("mints from %s", (_form, command) => {
    expect(sandboxRuns(command)).toHaveLength(1);
  });

  it.each([
    // The forgery the finding names: the script is only echoed, and the nonce
    // rides along in the same echo, while the receipt is printed by hand.
    ["an echoed script name", `echo scripts/security-sandbox.sh --nonce ${NONCE}; echo '${receiptLine(NONCE)}'`],
    ["a printf of the script name", `printf '%s' "scripts/security-sandbox.sh --nonce ${NONCE}"`],
    ["the script named only as another command's argument", `cat scripts/security-sandbox.sh --nonce ${NONCE}`],
    ["the script and its nonce in different segments", `scripts/security-sandbox.sh --target . -- repro; echo --nonce ${NONCE}`],
    ["a nonce after `--` (the wrapped command's)", `scripts/security-sandbox.sh --target . -- repro --nonce ${NONCE}`],
    ["a nonce consumed as another option's value", `scripts/security-sandbox.sh --target --nonce ${NONCE} -- repro`],
    ["two nonces", `scripts/security-sandbox.sh --nonce ${NONCE} --nonce ${OTHER} -- repro`],
    ["a malformed nonce", `scripts/security-sandbox.sh --nonce ${NONCE}xyz -- repro`],
    ["bash -c naming the script as text", `bash -c 'true' scripts/security-sandbox.sh --nonce ${NONCE}`],
    ["a lookalike script", `scripts/my-security-sandbox.sh --nonce ${NONCE} -- repro`],
    ["a comment", `true # scripts/security-sandbox.sh --nonce ${NONCE}`],
  ])("mints nothing from %s", (_form, command) => {
    expect(sandboxRuns(command)).toEqual([]);
  });

  it("mints nothing when the receipt carries another invocation's nonce", () => {
    expect(sandboxRuns(`scripts/security-sandbox.sh --nonce ${OTHER} -- repro`)).toEqual([]);
  });

  // The hunter runs the line `renderSandboxInstructions` prints, so that exact
  // line — the absolute script path and every other path shell-quoted when it
  // holds a space or a metacharacter, bare otherwise — must read back as ONE
  // invocation bound to the binding's nonce, and to no other.
  it.each([
    ["plain paths", { script: sandboxScriptPath("/opt/loom"), target: "/repo", scratch: "/runs/r/agents/a/scratch", artifact: "agents/a/artifacts/x.txt", artifactFile: "/runs/r/agents/a/artifacts/x.txt" }],
    ["a space and metacharacters", { script: sandboxScriptPath("/home/o'brien/my plugins/loom"), target: "/srv/my repo", scratch: "/runs/it's here/agents/a/scratch", artifact: "agents/a/artifacts/x $y.txt", artifactFile: "/runs/it's here/agents/a/artifacts/x $y.txt" }],
  ])("mints from the printed instruction line with %s", (_form, paths) => {
    const printed = renderSandboxInstructions(DEFAULT_SANDBOX_LIMITS, { nonce: NONCE, ...paths })
      .split("\n").find((line) => line.includes("security-sandbox.sh"))!.trim()
      .replace("<command> [args...]", "repro");
    expect(sandboxRuns(printed)).toHaveLength(1);
    expect(sandboxRuns(printed, receiptLine(OTHER))).toEqual([]);
  });

  it("mints one fact per bound invocation whose own receipt is present", () => {
    const command = `scripts/security-sandbox.sh --nonce ${NONCE} -- a; scripts/security-sandbox.sh --nonce ${OTHER} -- b`;
    expect(sandboxRuns(command, `${receiptLine(NONCE)}\n${receiptLine(OTHER)}\n`)).toHaveLength(2);
    expect(sandboxRuns(command, receiptLine(OTHER))).toHaveLength(1);
  });
});
