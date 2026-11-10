/**
 * The security-audit run registry (ADR-0067 D6): every writing `helper security-audit` operation registers a run
 * directory in the protected subagent dir; the subagent write guard reads the
 * set. Real filesystem, under a re-pointed LOOM_SUBAGENT_DIR.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import {
  registerSecurityAuditRun,
  registeredSecurityAuditRuns,
  registrationEntryName,
  renderRegistration,
  MAXIMUM_ENTRIES,
} from "../../src/orchestration/security-audit-run-registry";
import {
  PERSISTENT_SUBAGENT_DIR_ENTRIES,
  PERSISTENT_SUBAGENT_STORES,
  protectedDirs,
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

/** The registry's declared store: its directory is read from here at every use,
 *  the one source of truth the final describe block is about. Arranged entries
 *  are built with the registry's own name rule and encoder (imported above). */
const REGISTRY = PERSISTENT_SUBAGENT_STORES.securityAuditRunRegistry;

/** Write a registration entry straight into the registry, as an arranged state. */
const seedRegistration = (dir: string): void => {
  mkdirSync(REGISTRY.dir(), { recursive: true });
  writeFileSync(join(REGISTRY.dir(), registrationEntryName(dir)), renderRegistration(dir));
};

/** A run directory that never existed: its entry is a vanished run. */
const vanishedRun = (index: number): string => join(root, "gone", `run-${index}`);

/** Register `count` run directories that exist, by writing their entries. */
const seedLiveRuns = (count: number): readonly string[] =>
  Array.from({ length: count }, (_, index) => {
    const dir = join(root, "many", `run-${index}`);
    mkdirSync(dir, { recursive: true });
    seedRegistration(dir);
    return dir;
  });

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
    expect(readdirSync(REGISTRY.dir())).toHaveLength(1);
  });

  it("registers a symlinked run directory under BOTH spellings — as spelled and its realpath", () => {
    const run = runDir("run-1");
    const alias = join(root, "alias");
    symlinkSync(run, alias);
    expect(registerSecurityAuditRun(alias).ok).toBe(true);
    expect(registeredSecurityAuditRuns()).toEqual([alias, run].sort());
    expect(registerSecurityAuditRun(run).ok).toBe(true);
    expect(registeredSecurityAuditRuns()).toEqual([alias, run].sort());
  });

  it("guards a /tmp ↔ /private/tmp-style alias and a symlinked --out, whichever spelling a write uses", () => {
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

  it("prunes vanished runs once at the cap, and fails closed only while still over it", () => {
    const live = runDir("live");
    for (let index = 0; index < MAXIMUM_ENTRIES; index++) seedRegistration(vanishedRun(index));
    // Vanished directories do not count toward the cap when read…
    expect(registeredSecurityAuditRuns()).toEqual([]);
    // …and the registrar prunes them before it adds a live run.
    expect(registerSecurityAuditRun(live).ok).toBe(true);
    expect(readdirSync(REGISTRY.dir())).toEqual([registrationEntryName(live)]);
    expect(registeredSecurityAuditRuns()).toEqual([live]);
  });

  it("fails closed when more live runs than the cap are registered", () => {
    seedLiveRuns(MAXIMUM_ENTRIES + 1);
    expect(() => registeredSecurityAuditRuns()).toThrow(`more than ${MAXIMUM_ENTRIES}`);
  });

  it("does not fail closed when vanished entries are what put the registry over the cap", () => {
    // cap + 1 entries, of which two are vanished: the LIVE count is under the cap.
    const lives = seedLiveRuns(MAXIMUM_ENTRIES - 1);
    seedRegistration(vanishedRun(0));
    seedRegistration(vanishedRun(1));
    expect(readdirSync(REGISTRY.dir())).toHaveLength(MAXIMUM_ENTRIES + 1);
    expect(registeredSecurityAuditRuns()).toHaveLength(MAXIMUM_ENTRIES - 1);
    // The registrar prunes exactly the vanished entries, and a run landing
    // EXACTLY at the cap is still read: only more than the cap fails closed.
    const newcomer = runDir("newcomer");
    expect(registerSecurityAuditRun(newcomer).ok).toBe(true);
    expect(readdirSync(REGISTRY.dir()).sort()).toEqual([...lives, newcomer].map(registrationEntryName).sort());
    expect(registeredSecurityAuditRuns()).toHaveLength(MAXIMUM_ENTRIES);
  });

  it("keeps failing closed when the live entries alone exceed the cap, vanished ones pruned or not", () => {
    seedLiveRuns(MAXIMUM_ENTRIES + 1);
    for (let index = 0; index < 3; index++) seedRegistration(vanishedRun(index));
    expect(() => registeredSecurityAuditRuns()).toThrow(`holds ${MAXIMUM_ENTRIES + 1} live runs`);
    // Pruning the vanished entries cannot bring the live set under the cap.
    expect(registerSecurityAuditRun(runDir("one-more")).ok).toBe(true);
    expect(readdirSync(REGISTRY.dir())).toHaveLength(MAXIMUM_ENTRIES + 2);
    expect(() => registeredSecurityAuditRuns()).toThrow(`holds ${MAXIMUM_ENTRIES + 2} live runs`);
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
    mkdirSync(REGISTRY.dir(), { recursive: true });
    writeFileSync(join(REGISTRY.dir(), registrationEntryName(run)), "{not json");
    const result = registerSecurityAuditRun(run);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("damaged");
  });

  it("refuses a registry directory that is a symlink (no-follow)", () => {
    const run = runDir("run-1");
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(subagentDir(), { recursive: true });
    symlinkSync(elsewhere, REGISTRY.dir());
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
    writeFileSync(join(REGISTRY.dir(), `${registrationEntryName(run)}.claim-123-456-abc`), "partial");
    expect(registeredSecurityAuditRuns()).toEqual([run]);
  });

  describe("fails CLOSED (throws) on a malformed registry", () => {
    const seed = (name: string, content: string): void => {
      mkdirSync(REGISTRY.dir(), { recursive: true });
      writeFileSync(join(REGISTRY.dir(), name), content);
    };
    /** `renderRegistration(dir)` with its fields edited — the malformations below. */
    const edited = (dir: string, edit: Record<string, unknown>): string => JSON.stringify({ ...JSON.parse(renderRegistration(dir)), ...edit });

    it.each([
      ["not JSON", () => seed(registrationEntryName("/a"), "{"), "not JSON"],
      ["not an object", () => seed(registrationEntryName("/a"), "[]"), "not an object"],
      ["extra keys", () => seed(registrationEntryName("/a"), edited("/a", { x: 1 })), "exactly"],
      ["wrong kind", () => seed(registrationEntryName("/a"), edited("/a", { kind: "other" })), "security-audit-run-registration"],
      ["relative directory", () => seed(registrationEntryName("a"), renderRegistration("a")), "absolute"],
      ["name not bound to its directory", () => seed(registrationEntryName("/a"), renderRegistration("/b")), "does not match"],
      ["unexpected file name", () => seed("notes.txt", "x"), "unexpected entry"],
    ])("%s", (_name, arrange, message) => {
      arrange();
      expect(() => registeredSecurityAuditRuns()).toThrow(message);
    });

    it("a symlinked registry directory", () => {
      const elsewhere = join(root, "elsewhere");
      mkdirSync(elsewhere);
      mkdirSync(subagentDir(), { recursive: true });
      symlinkSync(elsewhere, REGISTRY.dir());
      expect(() => registeredSecurityAuditRuns()).toThrow();
    });

    it("a DANGLING symlink in the registry's place (never read as 'no runs')", () => {
      mkdirSync(subagentDir(), { recursive: true });
      symlinkSync(join(root, "missing-target"), REGISTRY.dir());
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
    expect(REGISTRY.dir()).toBe(join(subagentDir(), REGISTRY.entry));
    expect(protectedDirs()).toContain(subagentDir());
  });

  it("a subagent cannot rewrite, add or delete an entry through Bash", () => {
    const run = runDir("run-1");
    expect(registerSecurityAuditRun(run).ok).toBe(true);
    const context = observeSubagentAuthorityContext("/repo");
    const registry = REGISTRY.dir();
    for (const command of [
      `rm -rf ${registry}`,
      `rm ${registry}/${registrationEntryName(run)}`,
      `echo '{}' > ${registry}/forged.json`,
      `mv ${registry} /tmp/x`,
    ]) {
      expect(subagentAuthorityBlock(command, context), command).not.toBeNull();
    }
    expect(subagentAuthorityBlock(`ls ${registry}`, context)).toBeNull();
  });

  it("the SessionStart sweep never removes any persistent store, however old — by construction", () => {
    const stores = Object.values(PERSISTENT_SUBAGENT_STORES);
    // Not vacuous: the registry and the capture attestation store beside it (ADR-0067, amended).
    expect(stores.map((store) => store.entry).sort()).toEqual(["security-audit-runs", "security-capture-attestations"]);
    // The exemption set is exactly the declared stores, nothing hand-listed beside them.
    expect([...PERSISTENT_SUBAGENT_DIR_ENTRIES].sort()).toEqual(stores.map((store) => store.entry).sort());
    const mtimes = new Map<string, number>([...stores.map((store) => [store.entry, 0] as const), ["some-stray-file", 0]]);
    expect(staleEntries(mtimes, Number.MAX_SAFE_INTEGER)).toEqual(["some-stray-file"]);
    for (const store of stores) {
      expect(store.dir(), store.entry).toBe(join(subagentDir(), store.entry));
    }
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
