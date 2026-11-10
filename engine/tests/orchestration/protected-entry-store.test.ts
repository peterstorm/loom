/**
 * The protected entry store adapter, tested at its own interface: the
 * fail-closed guarantees the run registry and the capture attestation store
 * both rest on. Real filesystem under a re-pointed LOOM_SUBAGENT_DIR — the
 * guarantees are no-follow and bound checks, which only a real directory
 * exercises.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { PERSISTENT_SUBAGENT_STORES } from "../../src/config";
import {
  MAXIMUM_ENTRY_BYTES,
  isEntryName,
  listEntryNames,
  publishEntryOnce,
  readEntryIfPresent,
  withExistingEntryStore,
  withWritableEntryStore,
} from "../../src/orchestration/protected-entry-store";

const STORE = PERSISTENT_SUBAGENT_STORES.securityAuditRunRegistry;
const ENTRY = `${"a".repeat(64)}.json`;
const OTHER = `${"b".repeat(64)}.json`;

let root: string;
let saved: string | undefined;
const subagents = (): string => join(root, "subagents");

beforeEach(() => {
  root = canonicalTempDir("loom-protected-entry-store-");
  saved = process.env.LOOM_SUBAGENT_DIR;
  process.env.LOOM_SUBAGENT_DIR = subagents();
});

afterEach(() => {
  if (saved === undefined) delete process.env.LOOM_SUBAGENT_DIR;
  else process.env.LOOM_SUBAGENT_DIR = saved;
  rmSync(root, { recursive: true, force: true });
});

/** Arrange the store directory with these files, as an existing state. */
const arrangeStore = (files: Readonly<Record<string, string>>): string => {
  mkdirSync(STORE.dir(), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(STORE.dir(), name), text);
  return STORE.dir();
};

const readExisting = <T>(use: Parameters<typeof withExistingEntryStore<T>>[1]): T | "absent" =>
  withExistingEntryStore<T | "absent">(STORE, use, () => "absent");

describe("entry names", () => {
  it("is exactly <64 lowercase hex>.json", () => {
    expect(isEntryName(ENTRY)).toBe(true);
    expect(isEntryName(`${"A".repeat(64)}.json`)).toBe(false);
    expect(isEntryName(`${"a".repeat(63)}.json`)).toBe(false);
    expect(isEntryName(`${ENTRY}.claim-123`)).toBe(false);
  });
});

describe("withWritableEntryStore", () => {
  it("creates an absent subagent dir and store, and a publish lands there", () => {
    const published = withWritableEntryStore(STORE, (directory) => publishEntryOnce(directory, ENTRY, "first\n"));
    expect(published).toEqual({ kind: "published" });
    expect(readFileSync(join(STORE.dir(), ENTRY), "utf-8")).toBe("first\n");
  });

  it("refuses a symlink in the store's place rather than writing through it", () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(subagents(), { recursive: true });
    symlinkSync(elsewhere, STORE.dir());
    expect(() => withWritableEntryStore(STORE, (directory) => publishEntryOnce(directory, ENTRY, "x"))).toThrow();
  });
});

describe("publishEntryOnce", () => {
  it("never replaces an entry and hands the stored text back", () => {
    withWritableEntryStore(STORE, (directory) => publishEntryOnce(directory, ENTRY, "original\n"));
    const second = withWritableEntryStore(STORE, (directory) => publishEntryOnce(directory, ENTRY, "different\n"));
    expect(second).toEqual({ kind: "exists", text: "original\n" });
    expect(readFileSync(join(STORE.dir(), ENTRY), "utf-8")).toBe("original\n");
  });
});

describe("withExistingEntryStore", () => {
  it("answers absent when the subagent dir does not exist", () => {
    expect(readExisting(() => "opened")).toBe("absent");
  });

  it("answers absent when the subagent dir exists but the store does not", () => {
    mkdirSync(subagents(), { recursive: true });
    expect(readExisting(() => "opened")).toBe("absent");
  });

  it("opens an existing store", () => {
    arrangeStore({ [ENTRY]: "x" });
    expect(readExisting(() => "opened")).toBe("opened");
  });

  it.each([
    ["a symlink to a real directory", (target: string) => { mkdirSync(target); }],
    ["a dangling symlink", () => undefined],
  ])("throws, never answers absent, for %s in the store's place", (_label, arrangeTarget) => {
    mkdirSync(subagents(), { recursive: true });
    const target = join(root, "planted");
    arrangeTarget(target);
    symlinkSync(target, STORE.dir());
    expect(() => readExisting(() => "opened")).toThrow();
  });
});

describe("readEntryIfPresent", () => {
  it("reads an entry's text, and null only when no entry has that name", () => {
    arrangeStore({ [ENTRY]: "stored\n" });
    expect(readExisting((directory) => readEntryIfPresent(directory, ENTRY))).toBe("stored\n");
    expect(readExisting((directory) => readEntryIfPresent(directory, OTHER))).toBeNull();
  });

  it("throws on an oversized entry rather than reading it as absent", () => {
    arrangeStore({ [ENTRY]: "x".repeat(MAXIMUM_ENTRY_BYTES + 1) });
    expect(() => readExisting((directory) => readEntryIfPresent(directory, ENTRY))).toThrow(/byte limit/);
  });

  it("throws on a symlinked entry rather than following it or reading it as absent", () => {
    const directory = arrangeStore({});
    const forged = join(root, "forged.json");
    writeFileSync(forged, "forged\n");
    symlinkSync(forged, join(directory, ENTRY));
    expect(() => readExisting((store) => readEntryIfPresent(store, ENTRY))).toThrow();
  });
});

describe("listEntryNames", () => {
  it("skips an interrupted publish's claim leftovers and leaves every other name for the caller to judge", () => {
    arrangeStore({ [ENTRY]: "x", [`${OTHER}.claim-12.ab`]: "partial", "stray.txt": "?" });
    const names = readExisting((directory) => listEntryNames(directory, 10));
    expect(names === "absent" ? names : [...names].sort()).toEqual([ENTRY, "stray.txt"].sort());
  });

  it("throws past the caller's bound rather than truncating", () => {
    arrangeStore({ [ENTRY]: "x", [OTHER]: "y" });
    expect(() => readExisting((directory) => listEntryNames(directory, 1))).toThrow();
  });
});
