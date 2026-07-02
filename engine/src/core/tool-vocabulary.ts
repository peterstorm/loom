/**
 * Tool + test-runner vocabulary — pure constants with ZERO imports.
 *
 * Lives outside config.ts so pure modules (the guarded-skill-machine core,
 * the transcript parsers) can use the vocabulary without transitively
 * importing config's node:fs / node:child_process machinery. config.ts
 * re-exports these for its existing consumers — one definition, one truth.
 */

/** Tools that modify files */
export const FILE_MODIFYING_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

/** Test command patterns (for bash test output parsing) */
export const TEST_COMMAND_PATTERNS = [
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
];
