/**
 * The installed Bun against the console grammar Loom reads (ADR-0064). The
 * grammar is pinned by fixtures recorded from a real Bun, so a release that
 * printed differently would leave every fixture-based test green while Loom
 * stopped seeing collection errors. This file runs the probe
 * (`scripts/bun-console-probe.ts`) against the `bun` on PATH on every suite:
 *
 *   - the pinned release (`.bun-version`) has a recording of every kind;
 *   - a `bun` is on PATH and prints its release (a named failure, not a
 *     collection error, when it does not; the probe tests then skip);
 *   - whatever Bun is installed, Loom reads from its real output exactly the
 *     facts the fixtures encode: one collection error, no JUnit report for a
 *     run that never loaded, and Bun's own totals once the two are joined;
 *   - on the pinned release (the one CI installs and `preverify` demands),
 *     the normalized output equals the recordings byte for byte.
 *
 * Moving the pin without recording the new release fails the first test; a
 * new Bun that prints differently fails the last.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BUN_CONSOLE_FIXTURE_KINDS,
  captureBunConsole,
  installedBunVersion,
  normalizeBunOutput,
  type BunConsoleCapture,
  type BunConsoleFixtureKind,
} from "../../scripts/bun-console-probe";
import { parseBunVersion } from "../../scripts/bun-version-pin";
import { bunRunSummary, parseBunConsoleCollectionErrors, parseJunitXml, type TestFileResult } from "../../src/core/structured-test-report";
import { optionalBunFixture } from "../fixtures/bun-console-fixtures";
import { REPOSITORY } from "../fixtures/repository-roots";

const PIN_FILE = readFileSync(join(REPOSITORY, ".bun-version"), "utf8");
const PINNED = parseBunVersion(PIN_FILE);
const INSTALLED = installedBunVersion();
const INSTALLED_RELEASE = INSTALLED.ok ? INSTALLED.value : null;

/** The pinned release's recording of `kind`, or null when the pin names no release or the release has none. */
const pinnedRecording = (kind: BunConsoleFixtureKind): string | null =>
  PINNED === null ? null : optionalBunFixture(PINNED, kind);

const result = (file: string, executed: number, failed: number, collectionError = false): TestFileResult =>
  ({ file, executed, failed, skipped: 0, collectionError });

describe("the pinned Bun release's console recordings", () => {
  it(".bun-version names one Bun release", () => {
    expect(PINNED, `.bun-version holds ${JSON.stringify(PIN_FILE)}`).not.toBeNull();
  });

  it.each(BUN_CONSOLE_FIXTURE_KINDS)(`.bun-version (${PINNED}) has a recorded %s`, (kind) => {
    expect(pinnedRecording(kind), `record it: bun engine/scripts/bun-console-probe.ts`).not.toBeNull();
  });
});

describe("the bun on PATH", () => {
  it("prints its release", () => {
    expect(INSTALLED.ok ? null : INSTALLED.error).toBeNull();
  });
});

describe.runIf(INSTALLED_RELEASE !== null)(`the installed Bun (${INSTALLED_RELEASE}) prints what Loom reads`, () => {
  let capture: BunConsoleCapture;
  beforeAll(() => {
    capture = captureBunConsole();
  }, 30_000);

  it("both consoles name exactly the file that never loaded; the plain one's passing sections are not errors", () => {
    expect(parseBunConsoleCollectionErrors(capture.recordings["mixed.console.txt"])).toEqual(["src/a.test.ts"]);
    expect(parseBunConsoleCollectionErrors(capture.recordings["mixed.plain.console.txt"])).toEqual(["src/a.test.ts"]);
    expect(parseBunConsoleCollectionErrors(capture.recordings["load-failure-only.console.txt"])).toEqual(["src/a.test.ts"]);
  });

  it("writes no JUnit report when every file of the run fails to load", () => {
    expect(capture.loadFailureWroteJunit).toBe(false);
  });

  it("joins its JUnit report and its console to Bun's own totals (5 tests, 2 failing)", () => {
    const summary = bunRunSummary(
      parseJunitXml(capture.recordings["mixed.junit.xml"]),
      parseBunConsoleCollectionErrors(capture.recordings["mixed.console.txt"]),
    );
    expect(summary).toMatchObject({ total: 5, failed: 2, source: "junit-xml" });
    expect(summary?.files).toEqual({
      kind: "recorded",
      results: [result("src/b.test.ts", 1, 0), result("src/c.test.ts", 3, 1), result("src/a.test.ts", 1, 1, true)],
    });
  });

  it.runIf(INSTALLED_RELEASE === PINNED).each(BUN_CONSOLE_FIXTURE_KINDS)("prints the pinned release's recorded %s byte for byte", (kind) => {
    expect(capture.recordings[kind]).toBe(pinnedRecording(kind));
  });
});

describe("normalizeBunOutput", () => {
  const project = "/tmp/loom-bun-probe-x/pkg";

  it("a duration Bun printed on a loaded machine and one it left out on an idle machine normalize alike", () => {
    expect(normalizeBunOutput("(pass) outer > inner > nested passes [0.12ms]", project))
      .toBe(normalizeBunOutput("(pass) outer > inner > nested passes", project));
  });

  it("replaces only the bytes that differ between two runs of one release", () => {
    const raw = [
      "bun test v1.4.4 (38afee6c8)",
      "src/a.test.ts:",
      "# Unhandled error between tests",
      `error: Cannot find module './missing' from '${project}/src/a.test.ts'`,
      "(fail) outer > fails [0.85ms]",
      "Ran 5 tests across 3 files. [1.20s]",
      '<testsuite name="src/b.test.ts" file="src/b.test.ts" time="0.0018" hostname="homelab">',
    ].join("\n");
    expect(normalizeBunOutput(raw, project)).toBe([
      "bun test v1.4.4 (0000000)",
      "src/a.test.ts:",
      "# Unhandled error between tests",
      "error: Cannot find module './missing' from '/repo/pkg/src/a.test.ts'",
      "(fail) outer > fails",
      "Ran 5 tests across 3 files.",
      '<testsuite name="src/b.test.ts" file="src/b.test.ts" time="0" hostname="probe">',
    ].join("\n"));
  });

  it("is idempotent, and never changes which files the console names (property)", () => {
    const line = fc.constantFrom(
      "src/a.test.ts:", "src/b.test.ts:", "# Unhandled error between tests", "(pass) ok > passes [3.10ms]",
      `at <anonymous> (${project}/src/c.test.ts:4:35)`, "bun test v1.4.4 (abc123)", " 3 pass", "",
    );
    fc.assert(fc.property(fc.array(line, { maxLength: 30 }), (lines) => {
      const raw = lines.join("\n");
      const once = normalizeBunOutput(raw, project);
      expect(normalizeBunOutput(once, project)).toBe(once);
      expect(parseBunConsoleCollectionErrors(once)).toEqual(parseBunConsoleCollectionErrors(raw));
    }));
  });
});
