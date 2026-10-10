/**
 * The Bun version pin guard (`engine/scripts/bun-version-pin.ts`): the pure
 * comparison admits exactly the pinned release and names every refusal, and
 * the repository's own pin is the one CI installs and the local preflight
 * enforces.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { checkBunVersion, describeBunVersionRefusal, type BunVersion } from "../scripts/bun-version-pin";
import { canonicalTempDir } from "./fixtures/canonical-temp-dir";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const release = fc.tuple(fc.nat(99), fc.nat(99), fc.nat(99)).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);
const version = (raw: string): BunVersion => raw as BunVersion;

describe("checkBunVersion", () => {
  it("admits a local Bun equal to the pin, with or without each side's trailing newline (property)", () => {
    fc.assert(fc.property(release, fc.boolean(), fc.boolean(), (pinned, pinNewline, localNewline) => {
      expect(checkBunVersion(pinNewline ? `${pinned}\n` : pinned, localNewline ? `${pinned}\n` : pinned))
        .toEqual({ ok: true, value: pinned });
    }));
  });

  it("refuses any other local release, naming both (property)", () => {
    fc.assert(fc.property(release, release, (pinned, local) => {
      fc.pre(pinned !== local);
      expect(checkBunVersion(`${pinned}\n`, `${local}\n`))
        .toEqual({ ok: false, error: { kind: "mismatch", pinned, local } });
    }));
  });

  it("treats a pre-release or build suffix as a different release, not a match", () => {
    expect(checkBunVersion("1.4.2\n", "1.4.2-canary.1\n"))
      .toEqual({ ok: false, error: { kind: "mismatch", pinned: "1.4.2", local: "1.4.2-canary.1" } });
  });

  it.each(["", "\n", "1.4", "v1.4.2", " 1.4.2", "1.4.2 ", "1.4.2\n\n", "01.4.2", "1.4.2\n1.3.13\n", "latest"])(
    "refuses the malformed pin %j before consulting the local Bun",
    (raw) => {
      expect(checkBunVersion(raw, "also not a version")).toEqual({ ok: false, error: { kind: "malformed-pin", raw } });
    },
  );

  it.each(["", "bun 1.4.2\n", "1.4.2 (abc)\n", "error: unknown\n"])("refuses the malformed local output %j", (raw) => {
    expect(checkBunVersion("1.4.2\n", raw)).toEqual({ ok: false, error: { kind: "malformed-local", raw } });
  });
});

describe("describeBunVersionRefusal", () => {
  it("names the local and pinned releases and what to do about a mismatch", () => {
    expect(describeBunVersionRefusal({ kind: "mismatch", pinned: version("1.4.2"), local: version("1.3.13") })).toBe(
      "Verification blocked: local Bun is 1.3.13 but .bun-version pins 1.4.2; CI runs 1.4.2, so install that Bun (or update .bun-version deliberately) before verifying",
    );
  });

  it("names the raw text of a malformed pin or local output", () => {
    expect(describeBunVersionRefusal({ kind: "malformed-pin", raw: "latest\n" }))
      .toBe('Verification blocked: .bun-version must hold exactly one Bun version (MAJOR.MINOR.PATCH, as `bun --version` prints it), got "latest\\n"');
    expect(describeBunVersionRefusal({ kind: "malformed-local", raw: "" }))
      .toBe("Verification blocked: `bun --version` printed \"\", not a Bun version");
  });
});

/** A Bun release a text hard-codes: one right after "Bun" (through markup, a
 *  `v` or an `@`), or a workflow's `bun-version:` value. A release named in
 *  passing elsewhere in a sentence is not a claim about the pinned Bun. */
const BUN_VERSION_LITERAL = /\bbun(?:-version)?[\s*_`'"]*(?::\s*['"]?)?[v@]?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)/gi;
const hardCodedBunVersions = (text: string): readonly string[] =>
  [...text.matchAll(BUN_VERSION_LITERAL)].flatMap(([, release]) => (release === undefined ? [] : [release]));

describe("hardCodedBunVersions", () => {
  it.each([
    ["Use Bun **1.3.13** locally", ["1.3.13"]],
    ["requires bun 1.4.2-canary.1", ["1.4.2-canary.1"]],
    ["install bun@1.3.13 or Bun v1.4.2", ["1.3.13", "1.4.2"]],
    ["        bun-version: 1.3.13", ["1.3.13"]],
    ['        bun-version: "1.3.13"', ["1.3.13"]],
  ])("finds the release hard-coded in %j", (text, releases) => {
    expect(hardCodedBunVersions(text)).toEqual(releases);
  });

  it.each([
    "the Bun release pinned in the repository-root `.bun-version`",
    "          bun-version-file: .bun-version",
    "      - uses: oven-sh/setup-bun@v2",
    "a different Bun can pass where CI fails, as `fs.closeSync(1)` did on 1.3.13",
    'test "$(bun --version)" = "$(cat .bun-version)"',
  ])("finds none in %j", (text) => {
    expect(hardCodedBunVersions(text)).toEqual([]);
  });
});

describe("the repository's Bun pin", () => {
  const repository = resolve("..");
  const pin = readFileSync(join(repository, ".bun-version"), "utf8");
  const read = (path: string): string => readFileSync(join(repository, path), "utf8");
  const workflowsDir = ".github/workflows";
  /** The live operator docs and every CI workflow (historical plans and recorded evidence may name the Bun they ran on). */
  const pinConsumers = [
    "README.md",
    ...readdirSync(join(repository, "docs"), { recursive: true, encoding: "utf8" }).filter((path) => path.endsWith(".md")).map((path) => join("docs", path)),
    ...readdirSync(join(repository, workflowsDir)).filter((path) => /\.ya?ml$/.test(path)).map((path) => join(workflowsDir, path)),
  ];

  it("is one release on one line, the file CI installs and compares against", () => {
    expect(pin).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+\n$/);
    const workflow = read(join(workflowsDir, "ci.yml"));
    expect(workflow).toMatch(/^\s*bun-version-file:\s*['"]?\.bun-version['"]?\s*$/m);
    expect(workflow).toMatch(/\$\(bun --version\)"?\s*=\s*"?\$\(cat \.bun-version\)/);
  });

  it("is the only Bun release the operator docs and workflows hard-code", () => {
    const release = pin.trim();
    expect(pinConsumers).toEqual(expect.arrayContaining(["README.md", join("docs", "operations.md"), join(workflowsDir, "ci.yml")]));
    for (const path of pinConsumers) expect(hardCodedBunVersions(read(path)).filter((found) => found !== release), path).toEqual([]);
  });

  it("is named by file in the docs that state the Bun requirement", () => {
    for (const doc of ["README.md", "docs/operations.md"]) expect(read(doc), doc).toContain("`.bun-version`");
  });
});

describe("bun-version-pin CLI", () => {
  const realBun = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim();

  /** A copy of the guard beside a `.bun-version` holding `pin` (none when `null`), with a fake `bun` on PATH printing `local`. */
  function guard(pin: string | null, local: string): ReturnType<typeof spawnSync> {
    const root = canonicalTempDir("loom-bun-pin-");
    dirs.push(root);
    mkdirSync(join(root, "engine/scripts"), { recursive: true });
    mkdirSync(join(root, "bin"));
    cpSync(resolve("scripts/bun-version-pin.ts"), join(root, "engine/scripts/bun-version-pin.ts"));
    if (pin !== null) writeFileSync(join(root, ".bun-version"), pin);
    writeFileSync(join(root, "bin/version"), local);
    writeFileSync(join(root, "bin/bun"), `#!/usr/bin/env bash\nexec cat ${JSON.stringify(join(root, "bin/version"))}\n`);
    chmodSync(join(root, "bin/bun"), 0o755);
    // The real Bun runs the guard; only the `bun` the guard asks is the fake.
    return spawnSync(realBun, [join(root, "engine/scripts/bun-version-pin.ts")], {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
    });
  }

  it("passes silently when the local Bun is the pinned one", () => {
    const result = guard("1.4.2\n", "1.4.2\n");
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("fails fast naming both releases when the local Bun differs", () => {
    const result = guard("1.4.2\n", "1.3.13\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "Verification blocked: local Bun is 1.3.13 but .bun-version pins 1.4.2; CI runs 1.4.2, so install that Bun (or update .bun-version deliberately) before verifying\n",
    );
  });

  it("blocks verification naming the pin file when it is missing", () => {
    const result = guard(null, "1.4.2\n");
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^Verification blocked: cannot read the Bun pin \S+\/\.bun-version: ENOENT/);
  });
});
