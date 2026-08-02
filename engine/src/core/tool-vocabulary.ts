/**
 * Tool + test-runner vocabulary — pure constants (the only import is the
 * pure machine/types module, for the gate-wired tool tuple).
 *
 * Lives outside config.ts so pure modules (the guarded-skill-machine core,
 * the transcript parsers) can use the vocabulary without transitively
 * importing config's node:fs / node:child_process machinery. config.ts
 * re-exports these for its existing consumers — one definition, one truth.
 */

import { GATE_WIRED_TOOLS } from "../machine/types";

/**
 * Tools that modify files — DERIVED from GATE_WIRED_TOOLS (machine/types.ts,
 * the single source of truth pinned against hooks.json by
 * tests/machine/hooks-sync.test.ts) so the two sets can never drift apart.
 */
export const FILE_MODIFYING_TOOLS: ReadonlySet<string> = new Set(GATE_WIRED_TOOLS);

/**
 * Every tool name a harness uses to SPAWN A SUBAGENT.
 *
 * This is harness vocabulary, not loom's: Claude Code calls it `Agent` (it was
 * `Task`), Pi calls it `subagent`. Loom's five spawn gates — phase order, wave
 * order/dependencies, template substitution, agent model, agent skill — are the
 * only enforcement point for wave ordering, and they are reachable ONLY through
 * whichever name the running harness emits.
 *
 * One set, two layers: hooks.json's PreToolUse matcher decides whether the hook
 * fires at all, and each handler re-checks `tool_name` before doing work, so a
 * name known to one layer and not the other is a gate that reports healthy and
 * enforces nothing. tests/machine/hooks-sync.test.ts pins the matcher to this
 * set in BOTH directions, because that exact drift already happened once and
 * cost a full session to notice — a comment would not have caught it.
 *
 * `subagent` is inert under Claude Code (it never emits that tool_name) and
 * `Task` is inert under Pi; both stay listed so the vocabulary has one home
 * rather than one per harness.
 */
export const SUBAGENT_SPAWN_TOOLS: ReadonlySet<string> = new Set(["Task", "Agent", "subagent"]);

/** Test command patterns (for bash test output parsing) */
export const TEST_COMMAND_PATTERNS: readonly string[] = [
  "mvn test", "mvn verify", "mvn -pl",
  "mvnw test", "mvnw verify",
  "./gradlew test", "./gradlew check",
  "gradle test", "gradle check",
  "npm test", "npm run test",
  "npx vitest", "npx jest",
  "yarn test", "pnpm test", "bun test",
  "pytest", "python -m pytest", "python3 -m pytest",
  "cargo test", "go test", "dotnet test",
  "mix test", "make test", "make check",
] as const;
