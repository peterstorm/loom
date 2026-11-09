/**
 * The security-audit run registry (ADR-0067 D6): every writing `helper security-audit` operation registers a run
 * directory in the protected subagent dir; the subagent write guard reads the
 * set. Real filesystem, under a re-pointed LOOM_SUBAGENT_DIR.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import {
  registerSecurityAuditRun,
  registeredSecurityAuditRuns,
  MAXIMUM_ENTRIES,
} from "../../src/orchestration/security-audit-run-registry";
import {
  CAPTURE_ATTESTATION_ENTRY,
  PERSISTENT_SUBAGENT_DIR_ENTRIES,
  protectedDirs,
  SECURITY_AUDIT_RUN_REGISTRY_ENTRY,
  securityAuditRunRegistryDir,
  subagentDir,
} from "../../src/config";
import { staleEntries } from "../../src/handlers/session-start/cleanup-stale-subagents";
import { observeSubagentAuthorityContext, subagentAuthorityBlock } from "../../src/handlers/pre-tool-use/guard-subagent-authority";

let root: string;
let saved: string | undefined;

beforeEach(() => {
  root = canonicalTempDir("loom-run-registry-");
  saved = process.env.LOOM_SUBAGENT_DIR;
  process.env.LOOM_SUBAGENT_DIR = join(root, "subagents");
});

afterEach(() => {
  if (saved === undefined) delete process.env.LOOM_SUBAGENT_DIR;
  else process.env.LOOM_SUBAGENT_DIR = saved;
  rmSync(root, { recursive: true, force: true });
});

const runDir = (name: string): string => {
  const dir = join(root, "audits", name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const entryName = (dir: string): string => `${createHash("sha256").update(dir).digest("hex")}.json`;

describe("registerSecurityAuditRun", () => {
  it("records the run and reads it back", () => {
    const run = runDir("run-1");
    expect(registerSecurityAuditRun(run)).toEqual({ ok: true, value: undefined });
    expect(registeredSecurityAuditRuns()).toEqual([run]);
  });

  it("is idempotent: registering the same directory again succeeds and keeps one entry", () => {
    const run = runDir("run-1");
    expect(registerSecurityAuditRun(run).ok).toBe(true);
    expect(registerSecurityAuditRun(run).ok).toBe(true);
    expect(registerSecurityAuditRun(`${run}/`).ok).toBe(true);
    expect(registeredSecurityAuditRuns()).toEqual([run]);
    expect(readdirSync(securityAuditRunRegistryDir())).toHaveLength(1);
  });

  it("registers a symlinked run directory under BOTH spellings — as spelled and its realpath (C)", () => {
    const run = runDir("run-1");
    const alias = join(root, "alias");
    symlinkSync(run, alias);
    expect(registerSecurityAuditRun(alias).ok).toBe(true);
    expect(registeredSecurityAuditRuns()).toEqual([alias, run].sort());
    expect(registerSecurityAuditRun(run).ok).toBe(true);
    expect(registeredSecurityAuditRuns()).toEqual([alias, run].sort());
  });

  it("guards a /tmp ↔ /private/tmp-style alias and a symlinked --out, whichever spelling a write uses (C)", () => {
    // `private/tmp` is the real directory; `tmp` an alias of it, the way macOS spells /tmp.
    const real = join(root, "private", "tmp");
    mkdirSync(join(real, "audit", "agents", "h", "scratch"), { recursive: true });
    symlinkSync(real, join(root, "tmp"));
    const spelled = join(root, "tmp", "audit");
    expect(registerSecurityAuditRun(spelled).ok).toBe(true);
    // An alias created LATER (never registered) is canonicalised by the guard.
    symlinkSync(join(real, "audit"), join(root, "later-link"));
    const context = observeSubagentAuthorityContext("/repo");
    for (const target of [
      join(spelled, "ledger.json"),
      join(real, "audit", "verdicts.json"),
      join(root, "later-link", "findings.json"),
      join(root, "later-link", "verification-runs", "run.verify-w1-g1-x", "result.json"),
    ]) {
      expect(subagentAuthorityBlock(`echo x > ${target}`, context), target).toContain("authority path");
    }
    expect(subagentAuthorityBlock(`echo x > ${join(root, "later-link", "agents", "h", "scratch", "n.md")}`, context)).toBeNull();
  });

  it("prunes vanished runs once at the cap, and fails closed only while still over it (H)", () => {
    const live = runDir("live");
    const registry = securityAuditRunRegistryDir();
    mkdirSync(registry, { recursive: true });
    const vanished = (index: number) => join(root, "gone", `run-${index}`);
    for (let index = 0; index < MAXIMUM_ENTRIES; index++) {
      const dir = vanished(index);
      writeFileSync(join(registry, entryName(dir)),
        `${JSON.stringify({ schemaVersion: 1, kind: "security-audit-run-registration", runDirectory: dir })}\n`);
    }
    // Vanished directories do not count toward the cap when read…
    expect(registeredSecurityAuditRuns()).toEqual([]);
    // …and the registrar prunes them before it adds a live run.
    expect(registerSecurityAuditRun(live).ok).toBe(true);
    expect(readdirSync(registry)).toEqual([entryName(live)]);
    expect(registeredSecurityAuditRuns()).toEqual([live]);
  });

  it("fails closed when more live runs than the cap are registered", () => {
    const registry = securityAuditRunRegistryDir();
    mkdirSync(registry, { recursive: true });
    for (let index = 0; index <= MAXIMUM_ENTRIES; index++) {
      const dir = join(root, "many", `run-${index}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(registry, entryName(dir)),
        `${JSON.stringify({ schemaVersion: 1, kind: "security-audit-run-registration", runDirectory: dir })}\n`);
    }
    expect(() => registeredSecurityAuditRuns()).toThrow(`more than ${MAXIMUM_ENTRIES}`);
  });

  it("keeps every run, sorted", () => {
    const b = runDir("b");
    const a = runDir("a");
    expect(registerSecurityAuditRun(b).ok).toBe(true);
    expect(registerSecurityAuditRun(a).ok).toBe(true);
    expect(registeredSecurityAuditRuns()).toEqual([a, b]);
  });

  it.each([
    ["a relative directory", () => "audits/run-1", "must be absolute"],
    ["a missing directory", () => join(root, "nope"), "cannot resolve"],
    ["a file", () => { const file = join(root, "f"); writeFileSync(file, "x"); return file; }, "not a directory"],
  ])("refuses %s", (_name, path, message) => {
    const result = registerSecurityAuditRun(path());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
    expect(registeredSecurityAuditRuns()).toEqual([]);
  });

  it("refuses to overwrite a damaged entry under its own name", () => {
    const run = runDir("run-1");
    mkdirSync(securityAuditRunRegistryDir(), { recursive: true });
    writeFileSync(join(securityAuditRunRegistryDir(), entryName(run)), "{not json");
    const result = registerSecurityAuditRun(run);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("damaged");
  });

  it("refuses a registry directory that is a symlink (no-follow)", () => {
    const run = runDir("run-1");
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(subagentDir(), { recursive: true });
    symlinkSync(elsewhere, securityAuditRunRegistryDir());
    expect(registerSecurityAuditRun(run).ok).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe("registeredSecurityAuditRuns", () => {
  it("is empty when the subagent dir does not exist", () => {
    expect(registeredSecurityAuditRuns()).toEqual([]);
  });

  it("is empty when the registry directory does not exist", () => {
    mkdirSync(subagentDir(), { recursive: true });
    expect(registeredSecurityAuditRuns()).toEqual([]);
  });

  it("skips what an interrupted exclusive publish leaves behind", () => {
    const run = runDir("run-1");
    expect(registerSecurityAuditRun(run).ok).toBe(true);
    writeFileSync(join(securityAuditRunRegistryDir(), `${entryName(run)}.claim-123-456-abc`), "partial");
    expect(registeredSecurityAuditRuns()).toEqual([run]);
  });

  describe("fails CLOSED (throws) on a malformed registry", () => {
    const seed = (name: string, content: string): void => {
      mkdirSync(securityAuditRunRegistryDir(), { recursive: true });
      writeFileSync(join(securityAuditRunRegistryDir(), name), content);
    };
    const valid = (dir: string) => JSON.stringify({ schemaVersion: 1, kind: "security-audit-run-registration", runDirectory: dir });

    it.each([
      ["not JSON", () => seed(entryName("/a"), "{"), "not JSON"],
      ["not an object", () => seed(entryName("/a"), "[]"), "not an object"],
      ["extra keys", () => seed(entryName("/a"), JSON.stringify({ schemaVersion: 1, kind: "security-audit-run-registration", runDirectory: "/a", x: 1 })), "exactly"],
      ["wrong kind", () => seed(entryName("/a"), JSON.stringify({ schemaVersion: 1, kind: "other", runDirectory: "/a" })), "security-audit-run-registration"],
      ["relative directory", () => seed(entryName("a"), valid("a")), "absolute"],
      ["name not bound to its directory", () => seed(entryName("/a"), valid("/b")), "does not match"],
      ["unexpected file name", () => seed("notes.txt", "x"), "unexpected entry"],
    ])("%s", (_name, arrange, message) => {
      arrange();
      expect(() => registeredSecurityAuditRuns()).toThrow(message);
    });

    it("a symlinked registry directory", () => {
      const elsewhere = join(root, "elsewhere");
      mkdirSync(elsewhere);
      mkdirSync(subagentDir(), { recursive: true });
      symlinkSync(elsewhere, securityAuditRunRegistryDir());
      expect(() => registeredSecurityAuditRuns()).toThrow();
    });

    it("a DANGLING symlink in the registry's place (never read as 'no runs')", () => {
      mkdirSync(subagentDir(), { recursive: true });
      symlinkSync(join(root, "missing-target"), securityAuditRunRegistryDir());
      expect(() => registeredSecurityAuditRuns()).toThrow();
    });

    it("the guard turns the throw into a refusal of every authority-shaped write", () => {
      seed("notes.txt", "x");
      const context = observeSubagentAuthorityContext("/repo");
      expect(context.runs.kind).toBe("unreadable");
      expect(subagentAuthorityBlock("echo x > /anywhere/ledger.json", context)).toContain("registry is unreadable");
    });
  });
});

describe("the registry is protected", () => {
  it("lives inside the subagent dir, which is a protected Loom directory", () => {
    expect(securityAuditRunRegistryDir()).toBe(join(subagentDir(), SECURITY_AUDIT_RUN_REGISTRY_ENTRY));
    expect(protectedDirs()).toContain(subagentDir());
  });

  it("a subagent cannot rewrite, add or delete an entry through Bash", () => {
    const run = runDir("run-1");
    expect(registerSecurityAuditRun(run).ok).toBe(true);
    const context = observeSubagentAuthorityContext("/repo");
    const registry = securityAuditRunRegistryDir();
    for (const command of [
      `rm -rf ${registry}`,
      `rm ${registry}/${entryName(run)}`,
      `echo '{}' > ${registry}/forged.json`,
      `mv ${registry} /tmp/x`,
    ]) {
      expect(subagentAuthorityBlock(command, context), command).not.toBeNull();
    }
    expect(subagentAuthorityBlock(`ls ${registry}`, context)).toBeNull();
  });

  it("the SessionStart sweep never removes it, however old", () => {
    const mtimes = new Map<string, number>([
      [SECURITY_AUDIT_RUN_REGISTRY_ENTRY, 0],
      ["some-stray-file", 0],
    ]);
    expect(PERSISTENT_SUBAGENT_DIR_ENTRIES.has(SECURITY_AUDIT_RUN_REGISTRY_ENTRY)).toBe(true);
    expect(staleEntries(mtimes, Number.MAX_SAFE_INTEGER)).toEqual(["some-stray-file"]);
    // Nor the capture attestation store beside it (ADR-0067, amended).
    expect(staleEntries(new Map([[CAPTURE_ATTESTATION_ENTRY, 0]]), Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(protectedDirs()).toContain(subagentDir());
  });

  it("registered runs are protected for subagents end to end", () => {
    const run = runDir("run-1");
    expect(registerSecurityAuditRun(run).ok).toBe(true);
    const context = observeSubagentAuthorityContext("/repo");
    expect(subagentAuthorityBlock(`echo x > ${run}/ledger.json`, context)).toContain(`${run}/ledger.json`);
    expect(subagentAuthorityBlock(`echo x > ${run}/agents/h/scratch/notes.md`, context)).toBeNull();
  });
});
