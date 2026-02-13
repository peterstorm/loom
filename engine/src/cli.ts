#!/usr/bin/env bun
/**
 * Single CLI entry point for all loom hooks.
 * All bash shims call: exec bun cli.ts <hook-type> <handler-name> [extra-args...]
 *
 * Reads stdin (JSON from Claude Code), dynamic-imports handler, maps HookResult to exit code.
 */

import { match } from "ts-pattern";
import type { HookResult, HookHandler } from "./types";

// Eagerly buffer stdin before any async work (bun drains piped data during dynamic imports)
const stdinPromise: Promise<string> = process.stdin.isTTY
  ? Promise.resolve("")
  : new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      process.stdin.on("data", (chunk) => chunks.push(chunk));
      process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      process.stdin.on("error", reject);
    });

/** Known handler routes — validated before dynamic import */
const KNOWN_HANDLERS: Record<string, Set<string>> = {
  "pre-tool-use": new Set([
    "block-direct-edits", "guard-state-file", "validate-phase-order",
    "validate-task-execution", "validate-template-substitution",
    "validate-agent-model",
  ]),
  "subagent-stop": new Set([
    "dispatch", "advance-phase", "update-task-status",
    "store-reviewer-findings", "store-spec-check-findings",
    "cleanup-subagent-flag", "validate-review-invoker",
  ]),
  "subagent-start": new Set(["mark-subagent-active"]),
  "session-start": new Set(["cleanup-stale-subagents"]),
  "helper": new Set([
    "complete-wave-gate", "populate-task-graph", "validate-task-graph",
    "store-review-findings", "store-spec-check", "mark-tests-passed",
    "suggest-spec-anchors", "extract-task-id", "store-test-evidence",
  ]),
};

function resultToExit(result: HookResult): never {
  match(result)
    .with({ kind: "allow" }, () => process.exit(0))
    .with({ kind: "passthrough" }, () => process.exit(0))
    .with({ kind: "block" }, ({ message }) => {
      process.stderr.write(message + "\n");
      process.exit(2);
    })
    .with({ kind: "error" }, ({ message }) => {
      process.stderr.write(message + "\n");
      process.exit(1);
    })
    .exhaustive();

  process.exit(1); // unreachable, satisfies TS
}

async function main() {
  const [hookType, handlerName, ...extraArgs] = process.argv.slice(2);

  if (!hookType || !handlerName) {
    process.stderr.write("Usage: bun cli.ts <hook-type> <handler-name> [extra-args...]\n");
    process.exit(1);
  }

  const typeSet = KNOWN_HANDLERS[hookType];
  if (!typeSet) {
    process.stderr.write(`Unknown hook type: ${hookType}\n`);
    process.exit(1);
  }

  if (!typeSet.has(handlerName)) {
    process.stderr.write(`Unknown handler: ${hookType}/${handlerName}\n`);
    process.exit(1);
  }

  // Dynamic import — path constructed from validated hookType/handlerName
  // "helper" CLI arg maps to "helpers" directory
  const dirName = hookType === "helper" ? "helpers" : hookType;
  const modulePath = `./handlers/${dirName}/${handlerName}.ts`;
  const module = await import(modulePath) as { default: HookHandler };

  const stdin = await stdinPromise;
  const result = await module.default(stdin, extraArgs);
  resultToExit(result);
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err?.message ?? err}\n`);
  process.exit(1);
});
