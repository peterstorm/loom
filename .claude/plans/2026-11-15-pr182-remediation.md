# PR #182 remediation — read-only git invocations in the subagent authority guard

- **Branch:** `fix/guard-git-c-read-only`
- **Review run:** `.claude/reviews/review-and-fix-runs/run.pr182-review-20261115`
  (result digest `0ab28002a2cf58592683abfa315aa1a485ed301451d73f0d3d0c34523883d3ff`)
- **Policy run:** `.claude/reviews/review-and-fix-runs/run.pr182-policy-20261115`
  (disposition digest `7ab78a7b415a0ac63474d6097a0b42f6abe2c9b6b8d8da55eaf66be51e0c9926`)
- **Frozen scope:** `docs/adr/ADR-0067-security-ballots-are-bound-to-issued-verifier-spawns.md`,
  `docs/security-audit.md`, `engine/src/core/read-only-git.ts`,
  `engine/src/core/subagent-authority.ts`, `engine/tests/core/read-only-git.test.ts`,
  `engine/tests/core/subagent-authority.test.ts`, `engine/tests/utils/git-spawn-seam-guard.test.ts`
- **Support paths (outside the frozen scope):** this plan.

Engine inspection: 3 critical and 13 advisory emitted. After refutation, 3 critical survive, 0 are refuted, and 13 are advisory.

## Surviving criticals

| Finding | Disposition | Repair group |
| --- | --- | --- |
| `silent-failure-hunter-1` | repaired | `group.ls-remote-exec` |
| `type-design-analyzer-1` | repaired | `group.ls-remote-exec` |
| `architecture-tech-lead-1` | repaired | `group.ls-remote-exec` |

All three report one defect. `git ls-remote --exec=<cmd>` is a hidden synonym of
`--upload-pack`. `REMOTE_COMMAND_LONG_OPTIONS` did not list it, so
`isReadOnlyGitInvocation` accepted an invocation that runs a command. That let a
segment naming the protected checkout through the guard as a read.

Reproduced on git 2.56.0 (job scratch directory):
`git ls-remote --exec='touch …/EXEC_RAN; false' r` created `EXEC_RAN`.

### Declared repair group `group.ls-remote-exec`

- **Root cause (DECLARED):** the module's command-running option list was copied
  by hand from `git <sub> -h`, which omits hidden options. `ls-remote --exec` is
  hidden (`PARSE_OPT_HIDDEN`), so it was never listed.
- **Invariant (DECLARED):** for every allowed subcommand, every option that git
  accepts (hidden ones included) and that runs a command or writes a file
  outside `.git` is refused, in every abbreviation and value form. The table of
  such options is the single source for both the code and its property test.
- **Siblings (DECLARED, none-declared):** every allowed subcommand was audited
  with `git <sub> --git-completion-helper-all`, which lists hidden options. The
  only other command-running or file-writing options are `--output`,
  `--ext-diff`, grep's `--open-files-in-pager`/`-O`, and fetch's `--upload-pack`.
  All were already refused. fetch has no `--exec` ("unknown option" on 2.56).
- **Check:** `project:verify`.
- **Historical RED (DECLARED):** the new examples `git ls-remote --exec=rm origin`
  and `git -C /opt/loom ls-remote --exec=…` (guard integration), and the table
  property drawing `exec` prefixes, fail against the reviewed
  `read-only-git.ts`, which accepts them.

## Advisory dispositions (all published under `run.pr182-policy-20261115`)

| Finding | Decision | Fix |
| --- | --- | --- |
| `silent-failure-hunter-2` | accepted | Full hidden-option audit, one per-subcommand table, audit procedure documented in the header and ADR-0067. Commands named in repository config (textconv, diff.external) stay out of reach, as documented. |
| `pr-test-analyzer-1` | accepted | The property draws every command-running option from the table. Examples cover `ls-remote --exec` and `--upload-pack` prefixes. |
| `pr-test-analyzer-2` | accepted | Rows for `--exec-path`, `--config-env`, a `-C` value that looks like an option, `--` before the subcommand, and `-u` scoped to ls-remote. |
| `pr-test-analyzer-3` | accepted | Guard rows: a quoted `'git'` head, a `-C "$D"` value, git followed by a writing segment, and `ls-remote --exec`. |
| `type-design-analyzer-2` | accepted | `READ_ONLY_GIT_SUBCOMMANDS` becomes a `ReadonlyMap<subcommand, RiskyOptions>`. |
| `comment-analyzer-1` | accepted | `fetch -u` (`--update-head-ok`) is allowed. `-u` stays refused for ls-remote only, because older git documented `-u <exec>` there. Docs corrected. |
| `architecture-tech-lead-2` | accepted | Same table as `type-design-analyzer-2`. |
| `architecture-tech-lead-3` | accepted | A `segmentWords` helper. `executed.words` holds only the program words, so it cannot replace it. |
| `code-simplifier-1` | accepted | Dead `!startsWith("--")` conjunct removed. |
| `code-simplifier-2` | accepted | Unreachable `word === "--"` guard removed. Without it the function still fails closed. |
| `code-simplifier-3` | accepted | The subcommand gate is one map lookup, and the nullish checks are collapsed. |
| `code-simplifier-4` | accepted | Same as `architecture-tech-lead-3`. |
| `code-simplifier-5` | accepted | One-armed `fc.oneof` removed. |

## Refuted findings

None. The panel upheld all three criticals on intent, reproduction and blast radius.

## Validation

- `cd engine && npx tsc --noEmit`
- `npm run lint` (repository root)
- `cd engine && env -u PI_CODING_AGENT npx vitest run tests/core/read-only-git.test.ts tests/core/subagent-authority.test.ts tests/utils/git-spawn-seam-guard.test.ts`
- Full suite: `cd engine && env -u PI_CODING_AGENT npx vitest run`
- Registered remediation runs `project:verify` itself.

What is declared here, such as the root cause, the invariant and the Historical
RED, is distinct from what the engine observes: the check run and the candidate
witness.
