import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureLoomRuntimeIdentity, PI_EXTENSION_RUNTIME_ROOT_ENV, PI_EXTENSION_RUNTIME_REVISION_ENV } from "../../src/runtime-compatibility";
import { canonicalTempDir } from "./canonical-temp-dir";
import { NO_PARENT_MODEL_ENV, scrubAmbientParentModel, withEnvOverlay } from "./env-overlay";
import {
  CLAUDE_CODE_PARENT_VARIABLES, claudeCodeParentEnvironment, facadeParentEnvironment, FIXTURE_CLAUDE_CODE_SESSION_ID,
  parentAnnouncement, PI_PARENT_VARIABLES, stubParentAnnouncement,
} from "./facade-parent";
import { LOCAL_PI_BINDING } from "./local-pi-binding";
import { disposeFixturePiSessions, fixturePiEnvironment, fixtureSession, withFixturePiSession } from "./pi-session";

/** A parent model a wrapper Pi session would announce. */
const PARENT_MODEL_ENV = Object.freeze({
  PI_PROVIDER: LOCAL_PI_BINDING.provider, PI_MODEL: LOCAL_PI_BINDING.model, PI_REASONING_LEVEL: LOCAL_PI_BINDING.thinking,
});

/** An ambient Pi parent, keyed by the announcement set itself: a variable added to it must be seeded here too. */
const AMBIENT_PI_PARENT: Readonly<Record<(typeof PI_PARENT_VARIABLES)[number], string>> =
  Object.freeze({ PI_CODING_AGENT: "true", PI_SESSION_ID: "ambient-pi", PI_SESSION_FILE: "/ambient/session.jsonl" });

/** Run `operation`, then restore the process environment exactly: variables it added are removed, and every prior value returns. */
async function withProcessEnvRestored<T>(operation: () => T | Promise<T>): Promise<T> {
  const previous = { ...process.env };
  try {
    return await operation();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

const roots: string[] = [];
const directory = () => { const root = canonicalTempDir("loom-session-test-"); roots.push(root); return root; };
afterEach(() => {
  disposeFixturePiSessions();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const identityKeys = ["PI_SESSION_ID", "PI_SESSION_FILE", "LOOM_SUBAGENT_DIR"] as const;
describe("fixture-owned Pi session scopes", () => {
  it.each(["absent", "poisoned"] as const)("owns identity/transport with an %s parent and restores async rejection exactly", (parent) => withProcessEnvRestored(async () => {
    const cwd = process.cwd();
    const poison = directory();
    const sessionFile = join(poison, "parent.jsonl");
    writeFileSync(sessionFile, "not a session; never read this\n");
    const transport = join(poison, "transport");
    mkdirSync(transport);
    const sentinel = join(transport, "parent.run-bindings.json");
    writeFileSync(sentinel, "invalid parent authority; never use this\n");
    if (parent === "absent") for (const key of identityKeys) delete process.env[key];
    else Object.assign(process.env, { PI_SESSION_ID: "poison-parent", PI_SESSION_FILE: sessionFile, LOOM_SUBAGENT_DIR: transport });
    const before = { ...process.env };
    const root = directory();
    const session = fixtureSession(root);
    expect(relative(root, session.directory).startsWith("..")).toBe(true);
    const env = fixturePiEnvironment(root);
    expect(process.env).toEqual(before);
    expect(env.PI_CODING_AGENT).toBe("true");
    expect(env.PI_SESSION_ID).toBe(session.sessionId);
    expect(env.PI_SESSION_FILE).toBe(session.sessionFile);
    expect(env.LOOM_SUBAGENT_DIR).toBe(session.transport);
    const runtime = captureLoomRuntimeIdentity(env[PI_EXTENSION_RUNTIME_ROOT_ENV]!);
    expect(env[PI_EXTENSION_RUNTIME_REVISION_ENV]).toBe(runtime.revision);
    const failure = new Error("fixture async failure");
    await expect(withFixturePiSession(root, async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(process.cwd()).toBe(root);
      expect(process.env.PI_SESSION_ID).toBe(session.sessionId);
      throw failure;
    })).rejects.toBe(failure);
    expect(process.cwd()).toBe(cwd);
    expect(process.env).toEqual(before);
    expect(readFileSync(sessionFile, "utf8")).toBe("not a session; never read this\n");
    expect(readFileSync(sentinel, "utf8")).toBe("invalid parent authority; never use this\n");
    disposeFixturePiSessions();
    expect(existsSync(session.directory)).toBe(false);
    expect(existsSync(poison)).toBe(true);
  }));

  it("serializes overlapping async native scopes with separate persistent identities", async () => {
    const first = directory();
    const second = directory();
    const before = { ...process.env };
    const cwd = process.cwd();
    const seen: string[] = [];
    await Promise.all([first, second].map((root) => withFixturePiSession(root, async () => {
      const session = fixtureSession(root);
      seen.push(root);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(process.env.PI_SESSION_ID).toBe(session.sessionId);
      expect(process.cwd()).toBe(root);
      seen.push(root);
    })));
    expect(seen).toEqual([first, first, second, second]);
    expect(fixtureSession(first)).toBe(fixtureSession(first));
    expect(fixtureSession(first).sessionId).not.toBe(fixtureSession(second).sessionId);
    expect(process.env).toEqual(before);
    expect(process.cwd()).toBe(cwd);
  });

  it("starts every test file with no parent model, so a CLI child sees only an explicitly chosen one", async () => {
    // The setup file ran before this file's imports: the ambient parent model
    // is already cleared, with no dependence on which fixture loaded first.
    for (const key of Object.keys(NO_PARENT_MODEL_ENV)) expect(process.env[key], key).toBeUndefined();
    const root = directory();
    const ambient = fixturePiEnvironment(root);
    for (const key of Object.keys(NO_PARENT_MODEL_ENV)) expect(ambient[key], key).toBeUndefined();
    await withEnvOverlay(PARENT_MODEL_ENV, async () => {
      expect(fixturePiEnvironment(root).PI_MODEL).toBe(PARENT_MODEL_ENV.PI_MODEL);
    });
    for (const key of Object.keys(NO_PARENT_MODEL_ENV)) expect(process.env[key], key).toBeUndefined();
  });

  it("the setup's scrub clears a leaked ambient parent model", () => withProcessEnvRestored(() => {
    Object.assign(process.env, PARENT_MODEL_ENV);
    scrubAmbientParentModel();
    for (const key of Object.keys(NO_PARENT_MODEL_ENV)) expect(process.env[key], key).toBeUndefined();
  }));

  it("a Claude Code parent environment carries the Claude session and no Pi announcement, without touching the process environment", () => withProcessEnvRestored(() => {
    Object.assign(process.env, AMBIENT_PI_PARENT);
    const before = { ...process.env };
    const root = directory();
    const env = claudeCodeParentEnvironment(root);
    expect(process.env).toEqual(before);
    expect(env).toMatchObject({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: FIXTURE_CLAUDE_CODE_SESSION_ID,
      LOOM_SUBAGENT_DIR: join(root, ".git", "loom-claude-session-bindings"),
      LOOM_STATE_PATH: join(root, ".claude", "state", "active_task_graph.json") });
    for (const key of PI_PARENT_VARIABLES) expect(env[key], key).toBeUndefined();
  }));

  it.each([
    ["claude-code", FIXTURE_CLAUDE_CODE_SESSION_ID, { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: FIXTURE_CLAUDE_CODE_SESSION_ID,
      PI_CODING_AGENT: undefined, PI_SESSION_ID: undefined, PI_SESSION_FILE: undefined }],
    ["claude-code", undefined, { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: undefined,
      PI_CODING_AGENT: undefined, PI_SESSION_ID: undefined, PI_SESSION_FILE: undefined }],
    ["pi", "pi-session", { PI_CODING_AGENT: "true", PI_SESSION_ID: "pi-session", PI_SESSION_FILE: undefined,
      CLAUDECODE: undefined, CLAUDE_CODE_SESSION_ID: undefined }],
  ] as const)("a %s parent announcing session %s silences every other announcement variable", (parent, sessionId, expected) => {
    const overlay = parentAnnouncement(parent, sessionId);
    expect(overlay).toStrictEqual(expected);
    expect(Object.isFrozen(overlay)).toBe(true);
    // Keyed by the announcement sets themselves: a variable added to either is covered here too.
    expect(Object.keys(overlay).sort()).toEqual([...PI_PARENT_VARIABLES, ...CLAUDE_CODE_PARENT_VARIABLES].sort());
  });

  it("the in-process adapters apply the same announcement and restore the environment", () => withProcessEnvRestored(async () => {
    Object.assign(process.env, AMBIENT_PI_PARENT);
    const before = { ...process.env };
    const announced = (): Readonly<Record<string, string | undefined>> => Object.fromEntries(
      [...PI_PARENT_VARIABLES, ...CLAUDE_CODE_PARENT_VARIABLES].map((key) => [key, process.env[key]]));
    const expected = parentAnnouncement("claude-code", FIXTURE_CLAUDE_CODE_SESSION_ID);
    await withEnvOverlay(expected, () => expect(announced()).toEqual(expected));
    expect(process.env).toEqual(before);
    stubParentAnnouncement("claude-code", FIXTURE_CLAUDE_CODE_SESSION_ID);
    try {
      expect(announced()).toEqual(expected);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(process.env).toEqual(before);
  }));

  it("a facade parent resolves to its own harness environment", () => {
    const root = directory();
    expect(facadeParentEnvironment("pi", root)).toEqual(fixturePiEnvironment(root));
    expect(facadeParentEnvironment("claude-code", root)).toEqual(claudeCodeParentEnvironment(root));
    expect(facadeParentEnvironment("pi", root).PI_CODING_AGENT).toBe("true");
    expect(facadeParentEnvironment("claude-code", root).CLAUDECODE).toBe("1");
  });

  it("importing the session fixture has no side effect on the process environment", () => withProcessEnvRestored(async () => {
    Object.assign(process.env, PARENT_MODEL_ENV);
    const before = { ...process.env };
    vi.resetModules();
    await import("./pi-session");
    expect(process.env).toEqual(before);
  }));

  it("restores a failed scope acquisition and does not strand subsequent native work", async () => {
    const root = directory();
    const before = { ...process.env };
    const cwd = process.cwd();
    await expect(withFixturePiSession(join(root, "missing"), async () => "unreachable")).rejects.toThrow();
    expect(process.env).toEqual(before);
    expect(process.cwd()).toBe(cwd);
    await expect(withFixturePiSession(root, async () => "recovered")).resolves.toBe("recovered");
  });
});
