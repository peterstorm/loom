/**
 * Validate that all lint rules (default + project) load fail-closed.
 * Usage: bun cli.ts helper validate-lint-rules [projectRulesDir]
 *
 * Phase C: the architecture phase writes checkable invariants as lint-rule
 * JSON files into the project rules dir. A malformed or ReDoS-unsafe rule
 * would otherwise only surface at the first PostToolUse lint — blocking
 * every edit with a loader error. This helper runs the same fail-closed
 * loader up front so the architecture phase can prove its rules load
 * before any implementation wave starts.
 */

import { existsSync } from "node:fs";
import type { HookHandler } from "../../types";
import { loadRules } from "../../linter/loader";
import { DEFAULT_RULES_DIR, PROJECT_RULES_DIR } from "../../config";

const handler: HookHandler = async (_stdin, args) => {
  const dirArg = args.find((a) => !a.startsWith("-"));
  const projectDir = dirArg ?? PROJECT_RULES_DIR;

  try {
    const rules = loadRules(DEFAULT_RULES_DIR, existsSync(projectDir) ? projectDir : null, "full");
    const projectCount = rules.filter((r) => r.source === "project").length;
    process.stderr.write(
      `Lint rules valid: ${rules.length} rules loaded (${projectCount} project rules from '${projectDir}')\n`
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
