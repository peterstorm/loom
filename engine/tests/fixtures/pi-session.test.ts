import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureLoomRuntimeIdentity, PI_EXTENSION_RUNTIME_ROOT_ENV, PI_EXTENSION_RUNTIME_REVISION_ENV } from "../../src/runtime-compatibility";
import { canonicalTempDir } from "./canonical-temp-dir";
import {
  claudeCodeParentEnvironment, FIXTURE_CLAUDE_CODE_SESSION_ID, NO_PARENT_MODEL_ENV, scrubAmbientParentModel, withEnvOverlay,
} from "./issue-route-env";
import { disposeFixturePiSessions, fixturePiEnvironment, fixtureSession, withFixturePiSession } from "./pi-session";

/** A parent model a wrapper Pi session would announce. */
const PARENT_MODEL_ENV = Object.freeze({ PI_PROVIDER: "desktop-vllm", PI_MODEL: "glm-5.3-flash-spark-tp2-v14", PI_REASONING_LEVEL: "high" });

const roots: string[] = [];
const directory = () => { const root = canonicalTempDir("loom-session-test-"); roots.push(root); return root; };
afterEach(() => {
  disposeFixturePiSessions();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const identityKeys = ["PI_SESSION_ID", "PI_SESSION_FILE", "LOOM_SUBAGENT_DIR"] as const;
describe("fixture-owned Pi session scopes", () => {
  it.each(["absent", "poisoned"] as const)("owns identity/transport with an %s parent and restores async rejection exactly", async (parent) => {
    const previous = { ...process.env };
    const cwd = process.cwd();
    const poison = directory();
    const sessionFile = join(poison, "parent.jsonl");
    writeFileSync(sessionFile, "not a session; never read this\n");
    const transport = join(poison, "transport");
    mkdirSync(transport);
    const sentinel = join(transport, "parent.run-bindings.json");
    writeFileSync(sentinel, "invalid parent authority; never use this\n");
    try {
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
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  });

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

  it("the setup's scrub clears a leaked ambient parent model", () => {
    const previous = { ...process.env };
    try {
      Object.assign(process.env, PARENT_MODEL_ENV);
      scrubAmbientParentModel();
      for (const key of Object.keys(NO_PARENT_MODEL_ENV)) expect(process.env[key], key).toBeUndefined();
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  });

  it("a Claude Code parent environment carries the Claude session and no Pi announcement, without touching the process environment", () => {
    const previous = { ...process.env };
    try {
      Object.assign(process.env, { PI_CODING_AGENT: "true", PI_SESSION_ID: "ambient-pi", PI_SESSION_FILE: "/ambient/session.jsonl" });
      const before = { ...process.env };
      const root = directory();
      const env = claudeCodeParentEnvironment(root);
      expect(process.env).toEqual(before);
      expect(env).toMatchObject({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: FIXTURE_CLAUDE_CODE_SESSION_ID,
        LOOM_SUBAGENT_DIR: join(root, ".git", "loom-claude-session-bindings"),
        LOOM_STATE_PATH: join(root, ".claude", "state", "active_task_graph.json") });
      for (const key of ["PI_CODING_AGENT", "PI_SESSION_ID", "PI_SESSION_FILE"]) expect(env[key], key).toBeUndefined();
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  });

  it("importing the session fixture has no side effect on the process environment", async () => {
    const previous = { ...process.env };
    try {
      Object.assign(process.env, PARENT_MODEL_ENV);
      const before = { ...process.env };
      vi.resetModules();
      await import("./pi-session");
      expect(process.env).toEqual(before);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  });

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
