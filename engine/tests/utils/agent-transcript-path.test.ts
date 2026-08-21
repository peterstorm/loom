/**
 * Deriving a subagent transcript path when the harness sends none.
 *
 * The fixtures build a real `<config>/projects/<slug>/<session>/subagents/`
 * tree rather than mocking the filesystem: the whole point of this module is
 * that it agrees with a layout it does not own, and a mock would only prove it
 * agrees with itself.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveAgentTranscriptPath,
  deriveAgentType,
  projectSlug,
  resolveAgentTranscriptPath,
  resolveAgentType,
} from "../../src/utils/agent-transcript-path";

const created: string[] = [];
const envBackup = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!envBackup.has(key)) envBackup.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/**
 * Fixture roots are the REAL temp path. `projectSlug` slugs whatever path it is
 * given, and the module under test resolves symlinks before slugging — so a
 * root that is itself reached through a symlink (macOS resolves `/var` to
 * `/private/var`) would make the fixture and the module slug two different
 * strings and prove nothing. On Linux this is an identity.
 */
function tmp(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  created.push(dir);
  return realpathSync.native(dir);
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

  it("diagnoses an unreadable derived candidate instead of collapsing it into absence", () => {
    const config = tmp("loom-cfg");
    const project = tmp("loom-proj");
    setEnv("CLAUDE_CONFIG_DIR", config);
    setEnv("CLAUDE_PROJECT_DIR", project);
    const parent = join(config, "projects", projectSlug(project), "sess-loop", "subagents");
    const candidate = join(parent, "agent-agent1.jsonl");
    mkdirSync(parent, { recursive: true });
    symlinkSync(candidate, candidate);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(deriveAgentTranscriptPath("sess-loop", "agent1")).toBeNull();
      expect(stderr.mock.calls.map(([text]) => String(text)).join(""))
        .toMatch(/cannot inspect derived subagent file candidate.*(?:ELOOP|too many levels of symbolic links)/i);
    } finally {
      stderr.mockRestore();
    }
  });

  it("returns null while preserving realpath and long-slug scan diagnostics", () => {
    const missingRoot = join(tmp("loom-missing-root-parent"), "missing-config");
    const longMissingProject = `/${"missing-project-segment".repeat(12)}`;
    setEnv("CLAUDE_CONFIG_DIR", missingRoot);
    setEnv("CLAUDE_PROJECT_DIR", longMissingProject);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(deriveAgentTranscriptPath("sess", "agent")).toBeNull();
      const diagnostic = stderr.mock.calls.map(([text]) => String(text)).join("");
      expect(diagnostic).toContain("cannot resolve transcript project directory");
      expect(diagnostic).toContain(longMissingProject);
      expect(diagnostic).toContain("cannot scan transcript projects root");
      expect(diagnostic).toContain(join(missingRoot, "projects"));
    } finally {
      stderr.mockRestore();
    }
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

  it("diagnoses a missing supplied path before falling back to derivation", () => {
    const config = tmp("loom-cfg");
    const project = tmp("loom-proj");
    setEnv("CLAUDE_CONFIG_DIR", config);
    setEnv("CLAUDE_PROJECT_DIR", project);
    const derived = plantTranscript(config, project, "sess-6", "agent1");
    const supplied = join(project, "gone.jsonl");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(
        resolveAgentTranscriptPath({
          session_id: "sess-6",
          agent_id: "agent1",
          agent_transcript_path: supplied,
        }),
      ).toBe(derived);
      const diagnostic = stderr.mock.calls.map(([text]) => String(text)).join("");
      expect(diagnostic).toContain(`supplied agent transcript path ${supplied} is unavailable`);
      expect(diagnostic).toContain("falling back to derived lookup");
    } finally {
      stderr.mockRestore();
    }
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

/**
 * Every SubagentStop route gates on agent_type, and Claude Code does not send
 * it — so an implementation run categorises "unknown" and its entire result
 * (task status, test evidence, files_modified) is discarded in silence. The
 * harness records the role in `agent-<id>.meta.json` beside the transcript.
 */
describe("resolveAgentType", () => {
  /** Build the harness metadata file the way the harness writes it. */
  function plantedSession(body: string): { session: string; agentId: string } {
    const configDir = tmp("loom-config");
    const projectDir = tmp("loom-project");
    setEnv("CLAUDE_CONFIG_DIR", configDir);
    setEnv("CLAUDE_PROJECT_DIR", projectDir);
    const dir = join(configDir, "projects", projectSlug(projectDir), "sess-type", "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-agenttype1.meta.json"), body);
    return { session: "sess-type", agentId: "agenttype1" };
  }

  it("derives the namespaced agent type the harness recorded", () => {
    const { session, agentId } = plantedSession(JSON.stringify({
      agentType: "loom:code-implementer-agent",
      description: "Implement T8",
      model: "opus",
    }));

    expect(deriveAgentType(session, agentId)).toBe("loom:code-implementer-agent");
    expect(resolveAgentType({ session_id: session, agent_id: agentId }))
      .toBe("loom:code-implementer-agent");
  });

  it("believes a supplied agent_type over the metadata", () => {
    // Pi supplies the field; the fallback must never override a harness that
    // still sends it.
    const { session, agentId } = plantedSession(JSON.stringify({ agentType: "loom:code-implementer-agent" }));

    expect(resolveAgentType({ session_id: session, agent_id: agentId, agent_type: "code-reviewer" }))
      .toBe("code-reviewer");
  });

  it("ignores a blank supplied agent_type and falls back", () => {
    const { session, agentId } = plantedSession(JSON.stringify({ agentType: "loom:ts-test-agent" }));

    expect(resolveAgentType({ session_id: session, agent_id: agentId, agent_type: "   " }))
      .toBe("loom:ts-test-agent");
  });

  it("reports an empty type when no metadata exists", () => {
    setEnv("CLAUDE_CONFIG_DIR", join(tmpdir(), "loom-no-such-config-dir-ever"));
    setEnv("CLAUDE_PROJECT_DIR", "/nonexistent/project/dir");

    expect(deriveAgentType("s", "a")).toBeNull();
    expect(resolveAgentType({ session_id: "s", agent_id: "a" })).toBe("");
    expect(resolveAgentType({})).toBe("");
  });

  it("says so when the metadata cannot be parsed", () => {
    const { session, agentId } = plantedSession("{ not json");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(resolveAgentType({ session_id: session, agent_id: agentId })).toBe("");
      expect(stderr.mock.calls.map(([t]) => String(t)).join("")).toContain("cannot read agent metadata");
    } finally {
      stderr.mockRestore();
    }
  });

  it("reports an empty type for metadata with no usable agentType", () => {
    for (const body of [JSON.stringify({}), JSON.stringify({ agentType: "" }), JSON.stringify({ agentType: 7 })]) {
      const { session, agentId } = plantedSession(body);
      expect(resolveAgentType({ session_id: session, agent_id: agentId }), body).toBe("");
    }
  });

  it("refuses ids that would address a file outside the session directory", () => {
    // Same parse boundary the transcript lookup uses — these name paths.
    expect(deriveAgentType("../../etc", "agent1")).toBeNull();
    expect(deriveAgentType("sess", "../../etc/passwd")).toBeNull();
  });
});
