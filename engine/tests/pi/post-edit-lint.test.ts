/**
 * Pi's post-edit lint reads the rules of the project the edited file sits in,
 * not the session's: the `tool_result` handler in `pi/extension.ts` runs the
 * Claude Code hook's own `lintEditedFile`, with the session directory only as
 * the base a relative path resolves against. The last case drives the real
 * extension's handlers, so a Pi closure that went back to the session root's
 * rules fails here.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/core/plain-record";
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
  if (!isRecord(shipped)) throw new Error("lint-rules/no-any-type.json is not a JSON object");
  writeFileSync(join(rulesDir, "no-any-type.json"), JSON.stringify({ ...shipped, enabled }));
}

describe("Pi post-edit lint: the edited file's project, not the session's", () => {
  let session: string;

  beforeEach(() => {
    session = mkdtempSync(join(tmpdir(), "loom-pi-post-edit-"));
  });

  afterEach(() => {
    rmSync(session, { recursive: true, force: true });
  });

  /** The session's rules switch no-any-type off; the nested project at packages/shop switches it on and holds an `any`. */
  const nestedShopEdit = (): string => {
    projectWithAnyType(session, false);
    const nested = join(session, "packages", "shop");
    projectWithAnyType(nested, true);
    mkdirSync(join(nested, "src"), { recursive: true });
    writeFileSync(join(nested, "src", "loose.ts"), ANY_TYPED);
    return join("packages", "shop", "src", "loose.ts");
  };

  it("an edit in a nested project is linted under that project's rules, not the session root's", () => {
    const result = lintEditedFile(join(session, nestedShopEdit()), DEFAULT_RULES_DIR, session);
    expect(result.kind).toBe("violations");
    expect(result.kind === "violations" ? result.violations.map((v) => v.rule) : []).toContain("no-any-type");
  });

  it("an edit in the session's own project is linted under the session root's rules", () => {
    projectWithAnyType(session, false);
    mkdirSync(join(session, "src"), { recursive: true });
    writeFileSync(join(session, "src", "loose.ts"), ANY_TYPED);
    expect(lintEditedFile("src/loose.ts", DEFAULT_RULES_DIR, session)).toEqual({ kind: "pass" });
  });

  it("the Pi extension's tool_result lints each edit under its own project's rules, from the session directory", async () => {
    const nested = nestedShopEdit();
    mkdirSync(join(session, "src"));
    writeFileSync(join(session, "src", "loose.ts"), ANY_TYPED);
    const emit = await piToolResult();

    const previousCwd = process.cwd();
    process.chdir(session);
    try {
      expect(await emit(anEdit(nested))).toContainEqual(expect.objectContaining({
        isError: true,
        content: [expect.objectContaining({ text: expect.stringContaining("no-any-type") })],
      }));
      expect(await emit(anEdit("src/loose.ts"))).not.toContainEqual(expect.objectContaining({ isError: true }));
    } finally {
      process.chdir(previousCwd);
    }
  });
});

type Handler = (event: Record<string, unknown>, context: Record<string, unknown>) => unknown;

/** A Pi `edit` result for a path relative to the session directory. */
const anEdit = (path: string): Record<string, unknown> => ({ toolName: "edit", isError: false, input: { path, edits: [] }, content: [] });

/** The real extension's `tool_result` handlers, registered on a minimal Pi, run in order as Pi runs them. */
async function piToolResult(): Promise<(event: Record<string, unknown>) => Promise<readonly unknown[]>> {
  // A runtime-resolved import, as the extension suites load it, so the real entry point registers.
  const specifier = "../../../pi/extension.ts";
  const module = await import(/* @vite-ignore */ specifier) as { default: (pi: unknown) => void };
  const handlers: Handler[] = [];
  module.default({
    on: (event: string, handler: Handler) => { if (event === "tool_result") handlers.push(handler); },
    registerCommand: () => undefined,
    registerTool: () => undefined,
  });
  const context = { hasUI: false, sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad4f9" } };
  return async (event) => {
    const results: unknown[] = [];
    for (const handler of handlers) results.push(await handler(event, context));
    return results;
  };
}
