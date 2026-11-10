/**
 * Validate that all lint rules (default + project) load fail-closed.
 * Usage: bun cli.ts helper validate-lint-rules [projectRulesDir]
 *
 * Executable-models policy: the architecture phase writes checkable invariants as lint-rule
 * JSON files into the project rules dir. A malformed or ReDoS-unsafe rule
 * would otherwise only surface at the first PostToolUse lint — blocking
 * every edit with a loader error. This helper runs the same fail-closed
 * loader up front so the architecture phase can prove its rules load
 * before any implementation wave starts.
 */

import { existsSync } from "node:fs";
import type { HookHandler } from "../../types";
import { loadRules } from "../../linter/loader";
import { DEFAULT_RULES_DIR, projectRulesDir } from "../../config";

const handler: HookHandler = async (_stdin, args) => {
  const dirArg = args.find((a) => !a.startsWith("-"));

  // An explicitly-passed directory that doesn't exist is an error, not "no
  // project rules" — this helper exists to PROVE rules load; a typo'd path or
  // wrong cwd must not read as success.
  if (dirArg && !existsSync(dirArg)) {
    return {
      kind: "error",
      message: `Lint rule validation FAILED: project rules directory '${dirArg}' does not exist (wrong path or wrong cwd — pass the directory the rules were written to)`,
    };
  }

  // No argument: the project's one rules directory — the one both harnesses'
  // edit hooks read — or none.
  const projectDir = dirArg ?? projectRulesDir();

  try {
    const rules = loadRules(DEFAULT_RULES_DIR, projectDir, "full");
    const projectCount = rules.filter((r) => r.source === "project").length;
    if (projectDir === null) {
      process.stderr.write(
        "NOTE: no project rules directory (.claude/linter/rules or .pi/linter/rules) under cwd — 0 project rules validated. If you just wrote invariant rules, pass their directory explicitly.\n"
      );
    }
    process.stderr.write(
      `Lint rules valid: ${rules.length} rules loaded (${projectCount} project rules from '${projectDir ?? "none"}')\n`
    );
    return { kind: "passthrough" };
  } catch (e) {
    return {
      kind: "error",
      message: `Lint rule validation FAILED: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
};

export default handler;
