/**
 * Deriving a subagent transcript path when the harness sends none.
 *
 * The fixtures build a real `<config>/projects/<slug>/<session>/subagents/`
 * tree rather than mocking the filesystem: the whole point of this module is
 * that it agrees with a layout it does not own, and a mock would only prove it
 * agrees with itself.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveAgentTranscriptPath,
  projectSlug,
  resolveAgentTranscriptPath,
} from "../../src/utils/agent-transcript-path";

const created: string[] = [];
const envBackup = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!envBackup.has(key)) envBackup.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function tmp(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  created.push(dir);
  return dir;
}

/** Build the harness layout and return the transcript path it wrote. */
function plantTranscript(configDir: string, projectDir: string, session: string, agentId: string): string {
  const dir = join(configDir, "projects", projectSlug(projectDir), session, "subagents");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `agent-${agentId}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: "assistant", message: { content: "Task ID: T1" } }) + "\n");
  return path;
}

afterEach(() => {
  for (const [key, value] of envBackup) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  envBackup.clear();
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("projectSlug", () => {
  // Pinned against a live ~/.claude/projects listing, not inferred: EVERY
  // non-alphanumeric character collapses to "-", which is why a dotfile
  // directory yields a doubled dash.
  it("replaces every non-alphanumeric character with a dash", () => {
    expect(projectSlug("/home/peterstorm/dev/web/chatbot")).toBe("-home-peterstorm-dev-web-chatbot");
    expect(projectSlug("/home/peterstorm/.dotfiles")).toBe("-home-peterstorm--dotfiles");
    expect(projectSlug("/a/b_c/d-e.f")).toBe("-a-b-c-d-e-f");
  });
});

describe("deriveAgentTranscriptPath", () => {
  it("finds the transcript the harness wrote for this session and agent", () => {
    const config = tmp("loom-cfg");
    const project = tmp("loom-proj");
    setEnv("CLAUDE_CONFIG_DIR", config);
    setEnv("CLAUDE_PROJECT_DIR", project);
    const expected = plantTranscript(config, project, "sess-1", "a0a0057138606bfd0");

    expect(deriveAgentTranscriptPath("sess-1", "a0a0057138606bfd0")).toBe(expected);
  });

  it("returns null when nothing is at the derived location — never a path that does not exist", () => {
    const config = tmp("loom-cfg");
    const project = tmp("loom-proj");
    setEnv("CLAUDE_CONFIG_DIR", config);
    setEnv("CLAUDE_PROJECT_DIR", project);

    expect(deriveAgentTranscriptPath("sess-1", "missing-agent")).toBeNull();
  });

  it("resolves a symlinked project dir the way the harness slugs it", () => {
    const config = tmp("loom-cfg");
    const real = tmp("loom-real");
    const link = join(tmp("loom-link-parent"), "link");
    symlinkSync(real, link);
    setEnv("CLAUDE_CONFIG_DIR", config);
    setEnv("CLAUDE_PROJECT_DIR", link);
    const expected = plantTranscript(config, real, "sess-2", "agent1");

    expect(deriveAgentTranscriptPath("sess-2", "agent1")).toBe(expected);
  });

  it("refuses ids that would address a file outside the session's subagent dir", () => {
    const config = tmp("loom-cfg");
    const project = tmp("loom-proj");
    setEnv("CLAUDE_CONFIG_DIR", config);
    setEnv("CLAUDE_PROJECT_DIR", project);
    plantTranscript(config, project, "sess-3", "agent1");

    expect(deriveAgentTranscriptPath("../../etc", "agent1")).toBeNull();
    expect(deriveAgentTranscriptPath("sess-3", "../../../etc/passwd")).toBeNull();
    expect(deriveAgentTranscriptPath("", "agent1")).toBeNull();
    expect(deriveAgentTranscriptPath("sess-3", "")).toBeNull();
  });

  it("does not throw when the projects root does not exist at all", () => {
    setEnv("CLAUDE_CONFIG_DIR", join(tmpdir(), "loom-no-such-config-dir-ever"));
    setEnv("CLAUDE_PROJECT_DIR", "/nonexistent/project/dir");
    expect(deriveAgentTranscriptPath("sess", "agent")).toBeNull();
  });
});

describe("resolveAgentTranscriptPath — precedence", () => {
  it("an existing supplied path WINS over the derivable one (harnesses that answer keep answering)", () => {
    const config = tmp("loom-cfg");
    const project = tmp("loom-proj");
    setEnv("CLAUDE_CONFIG_DIR", config);
    setEnv("CLAUDE_PROJECT_DIR", project);
    const derived = plantTranscript(config, project, "sess-4", "agent1");

    const elsewhere = join(tmp("loom-pi"), "pi-transcript.jsonl");
    writeFileSync(elsewhere, "{}\n");

    const resolved = resolveAgentTranscriptPath({
      session_id: "sess-4",
      agent_id: "agent1",
      agent_transcript_path: elsewhere,
    });
    expect(resolved).toBe(elsewhere);
    expect(resolved).not.toBe(derived);
  });

  it("falls back to derivation when the field is absent", () => {
    const config = tmp("loom-cfg");
    const project = tmp("loom-proj");
    setEnv("CLAUDE_CONFIG_DIR", config);
    setEnv("CLAUDE_PROJECT_DIR", project);
    const derived = plantTranscript(config, project, "sess-5", "agent1");

    expect(resolveAgentTranscriptPath({ session_id: "sess-5", agent_id: "agent1" })).toBe(derived);
  });

  it("falls back to derivation when the supplied path no longer exists", () => {
    const config = tmp("loom-cfg");
    const project = tmp("loom-proj");
    setEnv("CLAUDE_CONFIG_DIR", config);
    setEnv("CLAUDE_PROJECT_DIR", project);
    const derived = plantTranscript(config, project, "sess-6", "agent1");

    expect(
      resolveAgentTranscriptPath({
        session_id: "sess-6",
        agent_id: "agent1",
        agent_transcript_path: join(project, "gone.jsonl"),
      }),
    ).toBe(derived);
  });

  it("expands a tilde-prefixed supplied path before believing it", () => {
    const home = tmp("loom-home");
    setEnv("HOME", home);
    const path = join(home, "transcript.jsonl");
    writeFileSync(path, "{}\n");

    expect(resolveAgentTranscriptPath({ session_id: "s", agent_transcript_path: "~/transcript.jsonl" })).toBe(path);
  });

  it("returns null when neither route finds anything", () => {
    setEnv("CLAUDE_CONFIG_DIR", join(tmpdir(), "loom-no-such-config-dir-ever"));
    setEnv("CLAUDE_PROJECT_DIR", "/nonexistent/project/dir");
    expect(resolveAgentTranscriptPath({ session_id: "s", agent_id: "a" })).toBeNull();
    expect(resolveAgentTranscriptPath({})).toBeNull();
  });
});
