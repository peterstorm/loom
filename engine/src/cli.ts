#!/usr/bin/env bun
/**
 * Single CLI entry point for all loom hooks.
 * All bash shims call: exec bun cli.ts <hook-type> <handler-name> [extra-args...]
 *
 * Reads stdin (JSON from Claude Code), dynamic-imports handler, maps HookResult to exit code.
 */

import { match } from "ts-pattern";
import { writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { HookResult, HookHandler } from "./types";
import { nonEmptyMessage } from "./types";
import { resolveInitialState } from "./phase-init";
import { KNOWN_HANDLERS } from "./handler-routes";

/**
 * Failure polarity for the top-level catch, derived from argv BEFORE
 * anything can throw. Exit 1 is NON-blocking for PreToolUse hooks, so a
 * crash outside the handler (dynamic-import failure, stdin error) would
 * fail the enforce-phase-tools gate OPEN — for that route ANY crash must
 * exit 2 (blocking). Every other route keeps exit 1.
 */
function topLevelFailureExitCode(argv: readonly string[]): 1 | 2 {
  return argv[0] === "pre-tool-use" && argv[1] === "enforce-phase-tools" ? 2 : 1;
}
const FAILURE_EXIT_CODE = topLevelFailureExitCode(process.argv.slice(2));

// Eagerly buffer stdin before any async work (bun drains piped data during dynamic imports)
const stdinPromise: Promise<string> = process.stdin.isTTY
  ? Promise.resolve("")
  : new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      process.stdin.on("data", (chunk) => chunks.push(chunk));
      process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      process.stdin.on("error", reject);
    });
// A stdin error may fire before main() awaits the promise (e.g. during the
// dynamic import) — mark it handled so the crash routes through main's
// await → the top-level catch, not an unhandled-rejection abort.
stdinPromise.catch(() => {});

function resultToExit(result: HookResult): never {
  match(result)
    .with({ kind: "allow" }, () => process.exit(0))
    .with({ kind: "passthrough" }, () => process.exit(0))
    .with({ kind: "block" }, ({ message }) => {
      process.stderr.write(nonEmptyMessage(message) + "\n");
      process.exit(2);
    })
    .with({ kind: "error" }, ({ message }) => {
      process.stderr.write(nonEmptyMessage(message) + "\n");
      process.exit(1);
    })
    .exhaustive();

  process.exit(1); // unreachable, satisfies TS
}

function parseInitStateArgs(args: string[]): { skipBrainstorm: boolean; skipClarify: boolean; skipSpecify: boolean; skipPlanAlignment: boolean; specDir: string; output: string } {
  let skipBrainstorm = false, skipClarify = false, skipSpecify = false, skipPlanAlignment = false;
  let specDir = "", output = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--skip-brainstorm") skipBrainstorm = true;
    else if (args[i] === "--skip-clarify") skipClarify = true;
    else if (args[i] === "--skip-specify") skipSpecify = true;
    else if (args[i] === "--skip-plan-alignment") skipPlanAlignment = true;
    else if (args[i] === "--spec-dir" && args[i + 1]) specDir = args[++i];
    else if (args[i] === "--output" && args[i + 1]) output = args[++i];
  }
  if (!specDir || !output) {
    process.stderr.write("Usage: bun cli.ts init-state [--skip-brainstorm] [--skip-clarify] [--skip-specify] [--skip-plan-alignment] --spec-dir <dir> --output <path>\n");
    process.exit(1);
  }
  return { skipBrainstorm, skipClarify, skipSpecify, skipPlanAlignment, specDir, output };
}

async function main() {
  const [hookType, handlerName, ...extraArgs] = process.argv.slice(2);

  if (!hookType || !handlerName) {
    // Check for standalone commands
    if (hookType === "init-state") {
      const opts = parseInitStateArgs(process.argv.slice(3));
      const state = resolveInitialState(
        { skipBrainstorm: opts.skipBrainstorm, skipClarify: opts.skipClarify, skipSpecify: opts.skipSpecify, skipPlanAlignment: opts.skipPlanAlignment },
        opts.specDir,
      );
      mkdirSync(dirname(opts.output), { recursive: true });
      writeFileSync(opts.output, JSON.stringify(state, null, 2));
      chmodSync(opts.output, 0o444);
      process.exit(0);
    }
    process.stderr.write("Usage: bun cli.ts <hook-type> <handler-name> [extra-args...]\n");
    process.exit(1);
  }

  // Handle init-state even when parsed as hookType
  if (hookType === "init-state") {
    const opts = parseInitStateArgs([handlerName, ...extraArgs]);
    const state = resolveInitialState(
      { skipBrainstorm: opts.skipBrainstorm, skipClarify: opts.skipClarify, skipSpecify: opts.skipSpecify, skipPlanAlignment: opts.skipPlanAlignment },
      opts.specDir,
    );
    mkdirSync(dirname(opts.output), { recursive: true });
    writeFileSync(opts.output, JSON.stringify(state, null, 2));
    chmodSync(opts.output, 0o444);
    process.exit(0);
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
  process.exit(FAILURE_EXIT_CODE);
});
