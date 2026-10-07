import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureLoomRuntimeIdentity, PI_EXTENSION_RUNTIME_ROOT_ENV, PI_EXTENSION_RUNTIME_REVISION_ENV } from "../../src/runtime-compatibility";
import { canonicalTempDir } from "./canonical-temp-dir";
import { scrubAmbientIssueRoute } from "./issue-route-env";

// This fixture is the seam that propagates ambient state: `fixturePiEnvironment`
// spreads process.env into every CLI child, and `withFixturePiSession` runs
// native APIs that read the issue-route election from process.env. So the
// fixture owns the invariant that an ambient Pi handshake (a wrapper session
// running the suite under the qualified-local model) never leaks into either:
// importing it pins this worker's ambient issue route to the catalog route,
// before any suite body runs. A suite opts into another route explicitly with
// `withRouteEnv` from ./issue-route-env.
scrubAmbientIssueRoute();

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

function ownedEnvironment(repository: string) {
  const session = fixtureSession(repository);
  const runtime = captureLoomRuntimeIdentity(packageRoot);
  return { PI_CODING_AGENT: "true", PI_SESSION_ID: session.sessionId, PI_SESSION_FILE: session.sessionFile,
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
