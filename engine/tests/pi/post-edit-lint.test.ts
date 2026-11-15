/**
 * Pi's post-edit lint reads the rules of the project the edited file sits in,
 * not the session's: the `tool_result` handler in `pi/extension.ts` runs the
 * Claude Code hook's own `lintEditedFile`, with the session directory only as
 * the base a relative path resolves against.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintEditedFile } from "../../src/handlers/post-tool-use/lint-file";
import { REPO_ROOT } from "../linter/loom-project-config";

const DEFAULT_RULES_DIR = join(REPO_ROOT, "lint-rules");
// Spelled in two pieces so this file does not trip the rule it exercises.
const ANY_TYPED = `export const loose: ${"any"} = 1;\n`;

/** A project at `root` whose own rules set the shipped no-any-type rule on or off. */
function projectWithAnyType(root: string, enabled: boolean): void {
  const rulesDir = join(root, ".claude", "linter", "rules");
  mkdirSync(rulesDir, { recursive: true });
  const shipped: unknown = JSON.parse(readFileSync(join(DEFAULT_RULES_DIR, "no-any-type.json"), "utf-8"));
  writeFileSync(join(rulesDir, "no-any-type.json"), JSON.stringify({ ...(shipped as object), enabled }));
}

describe("Pi post-edit lint: the edited file's project, not the session's", () => {
  let session: string;

  beforeEach(() => {
    session = mkdtempSync(join(tmpdir(), "loom-pi-post-edit-"));
  });

  afterEach(() => {
    rmSync(session, { recursive: true, force: true });
  });

  it("an edit in a nested project is linted under that project's rules, not the session root's", () => {
    projectWithAnyType(session, false);
    const nested = join(session, "packages", "shop");
    projectWithAnyType(nested, true);
    mkdirSync(join(nested, "src"), { recursive: true });
    const edited = join(nested, "src", "loose.ts");
    writeFileSync(edited, ANY_TYPED);

    const result = lintEditedFile(edited, DEFAULT_RULES_DIR, session);
    expect(result.kind).toBe("violations");
    expect(result.kind === "violations" ? result.violations.map((v) => v.rule) : []).toContain("no-any-type");
  });

  it("an edit in the session's own project is linted under the session root's rules", () => {
    projectWithAnyType(session, false);
    mkdirSync(join(session, "src"), { recursive: true });
    writeFileSync(join(session, "src", "loose.ts"), ANY_TYPED);
    expect(lintEditedFile("src/loose.ts", DEFAULT_RULES_DIR, session)).toEqual({ kind: "pass" });
  });

  it("the Pi extension's tool_result handler lints through lintEditedFile, from the session directory", () => {
    const extension = readFileSync(join(REPO_ROOT, "pi", "extension.ts"), "utf-8");
    expect(extension).toContain("lint: (filePath) => lintEditedFile(filePath, loomDefaultRulesDir, projectRoot),");
    expect(extension).not.toMatch(/\blintFile\(/);
  });
});
