/**
 * `core/loom-cli-command`: the one module that spells a command or path naming
 * the Loom package, for someone working in ANOTHER repository to run.
 *
 * Four bindings: each spelling, byte for byte; a root holding a space or a
 * single quote stays one shell word (proved by a real `sh`, not by a regex);
 * the package-root parser's accept/refuse cases; and, against the running
 * package, that every printed path is absolute and names a file that exists —
 * so a printed line runs unchanged from any directory.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLoomPackageRoot, type LoomCommands } from "../../src/core/loom-cli-command";
import { SECURITY_LENSES } from "../../src/core/security-lens-select";
import { LOOM_COMMANDS, LOOM_PACKAGE_ROOT } from "../../src/utils/loom-package-root";
import { aPackageRoot, loomCommandsAt } from "../fixtures/loom-package-root";

const PLAIN = loomCommandsAt("/opt/loom");
const AWKWARD_ROOT = "/home/o'brien/my plugins/loom";
const AWKWARD = loomCommandsAt(AWKWARD_ROOT);

describe("every spelling that names the package", () => {
  it("mutationCheck: the Task mutation check for one Task", () => {
    expect(PLAIN.mutationCheck("T2")).toBe("bun '/opt/loom/engine/src/cli.ts' helper mutation-check --task 'T2'");
  });

  it("auditNonce: how the parent obtains a receipt binding for one owner's artifact", () => {
    expect(PLAIN.auditNonce("/runs/run 1", "security-hunter-agent--2")).toBe(
      "bun '/opt/loom/engine/src/cli.ts' helper security-audit nonce --out '/runs/run 1' " +
        "--artifact agents/security-hunter-agent--2/artifacts/<file>",
    );
  });

  it("verificationImport: the import of a finished verification run into its audit", () => {
    expect(PLAIN.verificationImport("/tmp/my audit", "run.verify-w1-g1-0123456789ab")).toBe(
      "bun '/opt/loom/engine/src/cli.ts' helper security-audit verify --out '/tmp/my audit' --from 'run.verify-w1-g1-0123456789ab'",
    );
  });

  it.each(["security-verification", "standalone-disposition"] as const)("orchestrationStart: the start of %s under a runs root", (program) => {
    expect(PLAIN.orchestrationStart(program, "/tmp/my audit's runs")).toBe(
      `bun '/opt/loom/engine/src/cli.ts' helper orchestration start ${program} --runs-root '/tmp/my audit'\\''s runs'`,
    );
  });

  it("sandboxScript: the one sandbox executor", () => {
    expect(PLAIN.sandboxScript).toBe("/opt/loom/scripts/security-sandbox.sh");
  });

  it("securityLens: a vendored lens document", () => {
    expect(PLAIN.securityLens("ATTACK-CLASSES.md")).toBe("/opt/loom/references/security-lenses/ATTACK-CLASSES.md");
  });

  it("each member works detached from the value it came from", () => {
    const { mutationCheck, securityLens } = PLAIN;
    expect(mutationCheck("T1")).toBe(PLAIN.mutationCheck("T1"));
    expect(securityLens("CLIENT-SIDE.md")).toBe(PLAIN.securityLens("CLIENT-SIDE.md"));
  });
});

/** The words `sh` reads `command` as, with `bun` replaced by a printer of its argv: run from `cwd`. */
function shellWords(command: string, cwd: string): readonly string[] {
  const printed = spawnSync("sh", ["-c", command.replace(/^bun /, "printf '%s\\n' ")], { cwd, encoding: "utf8" });
  expect(printed.status, printed.stderr).toBe(0);
  return printed.stdout.split("\n").slice(0, -1);
}

/** The commands that run as printed: `auditNonce` leaves `<file>` for the parent to fill in, so it is not one. */
const RUNNABLE: readonly (readonly [string, (commands: LoomCommands) => string])[] = [
  ["mutationCheck", (commands) => commands.mutationCheck("T'1")],
  ["verificationImport", (commands) => commands.verificationImport("/tmp/my audit", "run.verify-w1")],
  ["orchestrationStart", (commands) => commands.orchestrationStart("security-verification", "/tmp/it's runs")],
];

describe("a root holding a space or a single quote", () => {
  it.each(RUNNABLE)("%s: the CLI is one shell word, read back exactly, from any directory", (_name, print) => {
    const elsewhere = mkdtempSync(join(tmpdir(), "loom-cli-command-"));
    try {
      const [cli, helper] = shellWords(print(AWKWARD), elsewhere);
      expect(cli).toBe(`${AWKWARD_ROOT}/engine/src/cli.ts`);
      expect(helper).toBe("helper");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("every argument after the CLI reads back as given", () => {
    expect(shellWords(AWKWARD.orchestrationStart("standalone-disposition", "/tmp/it's runs"), tmpdir()).slice(1))
      .toEqual(["helper", "orchestration", "start", "standalone-disposition", "--runs-root", "/tmp/it's runs"]);
    expect(shellWords(AWKWARD.mutationCheck("T'1"), tmpdir()).slice(1)).toEqual(["helper", "mutation-check", "--task", "T'1"]);
  });

  it("the CLI is quoted the one way sh reads back", () => {
    expect(loomCommandsAt("/home/o'brien/loom").mutationCheck("T2"))
      .toBe("bun '/home/o'\\''brien/loom/engine/src/cli.ts' helper mutation-check --task 'T2'");
  });

  it("the sandbox script and lens paths keep the root verbatim", () => {
    expect(AWKWARD.sandboxScript).toBe(`${AWKWARD_ROOT}/scripts/security-sandbox.sh`);
    expect(AWKWARD.securityLens("AI-AND-LLM.md")).toBe(`${AWKWARD_ROOT}/references/security-lenses/AI-AND-LLM.md`);
  });
});

describe("parseLoomPackageRoot", () => {
  it.each(["/opt/loom", AWKWARD_ROOT, "/a"])("accepts the absolute root %j as given", (raw) => {
    const parsed = parseLoomPackageRoot(raw);
    expect(parsed).toEqual({ ok: true, value: raw });
  });

  it.each([
    ["", "relative"],
    ["loom", "relative"],
    ["./loom", "relative"],
    ["~/loom", "relative"],
    ["/opt/loom/", "trailing-separator"],
    ["/", "trailing-separator"],
    ["/opt/lo\nom", "control-character"],
    ["/opt/lo\u0000om", "control-character"],
  ] as const)("refuses %j as %s", (raw, kind) => {
    const parsed = parseLoomPackageRoot(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.kind).toBe(kind);
      expect(parsed.error.message).toContain(JSON.stringify(raw));
    }
  });

  it("the test fixture mints through it, and throws on a refusal", () => {
    expect(aPackageRoot("/opt/loom")).toBe("/opt/loom");
    expect(() => aPackageRoot("opt/loom")).toThrow(/refused/);
  });
});

describe("the running package", () => {
  it("its root parses as itself", () => {
    expect(parseLoomPackageRoot(LOOM_PACKAGE_ROOT)).toEqual({ ok: true, value: LOOM_PACKAGE_ROOT });
  });

  it("every printed path is absolute and names a file of this package", () => {
    const cli = shellWords(LOOM_COMMANDS.mutationCheck("T1"), tmpdir())[0];
    const paths = [cli, LOOM_COMMANDS.sandboxScript, ...SECURITY_LENSES.map(LOOM_COMMANDS.securityLens)];
    for (const path of paths) {
      expect(path?.startsWith("/"), path).toBe(true);
      expect(existsSync(path ?? ""), path).toBe(true);
    }
  });
});
