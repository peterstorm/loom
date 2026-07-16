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
