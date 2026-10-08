import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureLoomRuntimeIdentity, PI_EXTENSION_RUNTIME_ROOT_ENV, PI_EXTENSION_RUNTIME_REVISION_ENV } from "../../src/runtime-compatibility";
import { canonicalTempDir } from "./canonical-temp-dir";
import { FIXTURE_PI_AGENT_DIR_ENV } from "../setup/fixture-pi-route";
import { PI_AGENT_DIRECTORY_VARIABLE } from "../../src/core/pi-agent-directory";

// This fixture propagates ambient state: `fixturePiEnvironment` spreads
// process.env into every CLI child, and `withFixturePiSession` runs native APIs
// that read the Pi parent marker (and, for spawn-time routing, the parent
// model) from process.env. Importing it has no side effect: the ambient parent
// model is cleared by the Vitest setup file (tests/setup/scrub-parent-model.ts)
// before every test file, and a suite sets one explicitly with `withEnvOverlay`
// from ./issue-route-env. The Claude Code counterpart of
// `fixturePiEnvironment` is `claudeCodeParentEnvironment` there.

const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
type FixtureSession = Readonly<{ directory: string; sessionId: string; sessionFile: string; transport: string }>;
const sessions = new Map<string, FixtureSession>();

/** One persistent session per disposable repository, never inside its observed byte scope. */
export function fixtureSession(repository: string): FixtureSession {
  const existing = sessions.get(repository);
  if (existing !== undefined) return existing;
  const directory = canonicalTempDir("loom-fixture-pi-session-");
  const session = { directory, sessionId: randomUUID(), sessionFile: join(directory, "session.jsonl"), transport: join(directory, "subagents") };
  mkdirSync(session.transport);
  writeFileSync(session.sessionFile, JSON.stringify({ type: "session", id: session.sessionId }) + "\n");
  sessions.set(repository, session);
  return session;
}

/** The fixture Pi agent directory, whose models.json names the global setup's fake local route. */
function fixtureAgentDirectory(): string {
  const directory = process.env[FIXTURE_PI_AGENT_DIR_ENV];
  if (directory === undefined) throw new Error(`${FIXTURE_PI_AGENT_DIR_ENV} is unset: tests/setup/fixture-pi-route.ts did not run`);
  return directory;
}

function ownedEnvironment(repository: string) {
  const session = fixtureSession(repository);
  const runtime = captureLoomRuntimeIdentity(packageRoot);
  return { PI_CODING_AGENT: "true", [PI_AGENT_DIRECTORY_VARIABLE]: fixtureAgentDirectory(), PI_SESSION_ID: session.sessionId, PI_SESSION_FILE: session.sessionFile,
    LOOM_SUBAGENT_DIR: session.transport, LOOM_STATE_PATH: join(repository, ".claude/state/active_task_graph.json"),
    [PI_EXTENSION_RUNTIME_ROOT_ENV]: runtime.packageRoot, [PI_EXTENSION_RUNTIME_REVISION_ENV]: runtime.revision };
}

/** Admission uses the actual fixture package, not the invoking extension's handshake. */
export function fixturePiEnvironment(repository: string): NodeJS.ProcessEnv {
  return { ...process.env, ...ownedEnvironment(repository) };
}

// cwd/env are process-global: serialize scopes in a worker; other test workers own separate processes.
let pending: Promise<void> = Promise.resolve();
/** Non-nested native API scope. Restoration waits for the entire async operation, including rejection. */
export function withFixturePiSession<T>(repository: string, operation: () => Promise<T>): Promise<T> {
  const scoped = pending.then(async () => {
    const cwd = process.cwd();
    const environment = ownedEnvironment(repository);
    const previous = Object.keys(environment).map((key) => [key, process.env[key]] as const);
    try {
      Object.assign(process.env, environment);
      process.chdir(repository);
      return await operation();
    } finally {
      process.chdir(cwd);
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
  // A rejected caller must not prevent the next scope from acquiring the process globals.
  pending = scoped.then(() => undefined, () => undefined);
  return scoped;
}

export function disposeFixturePiSessions(): void {
  for (const session of sessions.values()) rmSync(session.directory, { recursive: true, force: true });
  sessions.clear();
}
