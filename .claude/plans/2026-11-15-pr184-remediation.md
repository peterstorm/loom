# PR #184 remediation — the subagent guard judges words with the environment the shell inherits

- **Branch:** `fix/guard-observed-environment`
- **Review run:** `.claude/reviews/review-and-fix-runs/run.pr184-review`
  (result digest `6f022e17ebe1bd5905e4a4f77d5e1367e98c933ee0fc1815a4fec5d58202cf7e`)
- **Policy run:** `.claude/reviews/review-and-fix-runs/run.pr184-policy`
  (disposition digest `af3f747d7ff5cf86e564139684bd9cd534ab79b72d0da804274767d5b9ccfec4`)
- **Frozen scope:** `README.md`,
  `docs/adr/ADR-0067-security-ballots-are-bound-to-issued-verifier-spawns.md`,
  `docs/development.md`, `docs/security-audit.md`,
  `engine/src/core/subagent-authority.ts`,
  `engine/src/handlers/pre-tool-use/guard-subagent-authority.ts`,
  `engine/src/utils/agent-transcript-path.ts`, `engine/src/utils/claude-config-dir.ts`,
  `engine/tests/core/subagent-authority-directories.property.test.ts`,
  `engine/tests/core/subagent-authority.test.ts`,
  `engine/tests/handlers/pre-tool-use/guard-subagent-authority.test.ts`,
  `engine/tests/utils/claude-config-dir.test.ts`, `engine/tests/verification-ci.test.ts`
- **Support paths (outside the frozen scope):** `engine/src/config.ts` (the new
  `subagentProtectedDirs`), `.claude/linter/rules/config.json` (config.ts may
  import `engine/src/utils/claude-config-dir`), and this plan.

Engine inspection: 12 findings emitted, all advisory. After refutation, 0 critical
survive and 0 are refuted. No defect family is declared (`not-required`).

## Advisory dispositions (all published under `run.pr184-policy`)

| Finding | Decision | Fix |
| --- | --- | --- |
| `pr-test-analyzer-1` | accepted | The inherited value counts toward the 16-spelling cap: 15 line bindings alone are allowed, 15 plus the inherited value fail closed, 14 plus it are allowed. |
| `pr-test-analyzer-2` | accepted | Handler test: with `CLAUDE_CONFIG_DIR` set to a symlink, the protected set holds both spellings, and a write through the realpath or the link is blocked. Mutation-checked: dropping `flatMap(spellings)` fails it. |
| `pr-test-analyzer-3` | accepted | One `it.each` row per builtin in the runtime-named binding rule (`read`, `unset`, `export`, `declare`, `typeset`, `local`, `readonly`, `let`, `((`, `eval`, `source`, `.`, `mapfile`, `readarray`, `printf -v`, `getopts`). Each row hands the name only at runtime (`"$N"`) and is allowed alone. Removing any one builtin from the regex fails exactly its row (mutation-checked for all 16 alternatives and `((`). |
| `type-design-analyzer-1` | dismissed | `InheritedEnvironment` is a branded `ReadonlyMap` built only by `parseInheritedEnvironment`; the mutable `Map` behind the brand never escapes the parser. |
| `type-design-analyzer-2` | dismissed | Smart constructors for pinned values and landings would wrap values the core derives itself from parsed input; no untrusted value enters there. |
| `comment-analyzer-1` | accepted | "which the shell protects" now says the guard refuses every subagent write into it and the hook passes it among `protectedDirectories`, in the core header and the test's describe comment. |
| `comment-analyzer-2` | accepted | ADR note L states the run count as evidence at amendment time, not as a standing guarantee. |
| `architecture-tech-lead-1` | deferred | Extracting a variable-binding module out of `core/subagent-authority.ts` changes module interfaces: a `deepen` session, not a remediation move. |
| `architecture-tech-lead-2` | accepted | `subagentProtectedDirs()` in `config.ts` owns the set (Loom's protected directories plus Claude Code's shell state); the handler reads it. `protectedDirs()` is unchanged, so guard-state-file and block-direct-edits are unaffected (tested). |
| `architecture-tech-lead-3` | accepted | The `environment` field's doc comment names its single legal source: the hook's own process environment. |
| `code-simplifier-1` | accepted | `withPinnedValues` looks each pinned value up once. |
| `code-simplifier-2` | accepted | `judgeSegment` passes its `pinnedValue` into `runsReadOnlyScript` instead of recomputing the bindings; `boundSpellings` per word stays (it is per word by design). |

## Refuted findings

None.

## Validation

- `cd engine && npx tsc --noEmit && npm run -s typecheck:unused && npm run -s lint`
- `cd engine && env -u PI_CODING_AGENT npx vitest run tests/core/subagent-authority.test.ts tests/handlers/pre-tool-use/guard-subagent-authority.test.ts tests/utils/claude-config-dir.test.ts`
- Full suite: `cd engine && env -u PI_CODING_AGENT npx vitest run`
- Registered remediation runs `project:verify` itself.
