# Developing Loom

This guide is for people changing Loom itself: validating a change, keeping tests hermetic, the linter and model-policy commands, and what applies only when Loom orchestrates its own repository. Running an orchestration is in [Operations](operations.md#operating-loom). Commands here run from the Loom repository root; `$LOOM_DIR` is that root ([the CLI path](operations.md#prerequisites)).

## Development validation

### Locked bootstrap and mandatory full gate

The development/CI baseline is a full-history Git checkout on a non-root account with Node **22.23.2**, the Bun release pinned in the repository-root `.bun-version` (the one pin, never restated elsewhere: CI installs it through `oven-sh/setup-bun` `bun-version-file`, and the verification preflight blocks a local Bun that differs), npm, Git, and jq. Linux additionally requires Bash **4+** and GNU `timeout` on PATH. The macOS 13+ CI job uses Apple's Bash 3.2 and does not require GNU coreutils. Full history is required because deterministic tests resolve the committed model-calibration corpus against historical revisions available through remote refs. A normal full clone checked out on `main` contains those objects; for an existing single-branch shallow clone, fetch every remote head before verification:

```bash
git fetch --unshallow origin '+refs/heads/*:refs/remotes/origin/*' --tags
```

From the Loom repository root:

```bash
bun install --frozen-lockfile
(cd engine && bun install --frozen-lockfile)
npm run verify
```

Both locks are required: root dependencies supply Pi/runtime resources; engine dependencies supply the compiler and Vitest, and `typescript`, which the Wave Gate's owner verification also loads at runtime and which is therefore declared under `dependencies` (no new package: it was already the engine's compiler). An engine checkout without its locked install cannot run the Wave Gate. `preverify` checks required tools, that `bun --version` equals `.bun-version` (`engine/scripts/bun-version-pin.ts`), executable local Vitest/Pi, and that Pi resolves to the root-local locked CLI through npm's PATH. No global/latest Pi or network-fetching compiler fallback is accepted. Local preflight checks tool availability and the exact Bun pin (a different Bun can pass where the pinned one fails (`fs.closeSync(1)` is a silent no-op on 1.3.13 but not on the pinned release)); it does not pin Node, which CI checks explicitly alongside Bun.

The same **root `npm run verify`** runs locally, in `.github/workflows/ci.yml` for PRs/branch pushes/tags, and through this repository's runtime Verification Manifest. CI checks out full history with `fetch-depth: 0`, installs both frozen graphs, preserves failures through `pipefail`, and attempts log artifact upload even after failure. It has a 60-minute job budget; the manifest separately bounds its command to 30 minutes. Neither is proof of a successful hosted CI run.

Root `verify` delegates to engine `verify`: prerequisites (`preverify`) → typecheck → lint → `test`. The test script runs the entire Vitest suite (including property/integration tests) followed by all six smoke commands, once each on success:

1. `scripts/smoke-panel-mode.sh`
2. `scripts/smoke-review-panel.sh`
3. `scripts/smoke-standalone-review.sh`
4. `scripts/smoke-orchestration-facades.ts`
5. `scripts/smoke-pi-resources.sh`
6. `artifacts/tests/test-validate-task-graph.sh`

The review-panel and standalone helper smokes explicitly retain historical/manual
coverage. The façade smoke covers current issued payloads, bounded scope retries,
refutation, advisory decisions, durable replay and actual disposable index
installation; it supplies a matching runtime identity only to its CLI children.
These scripted smokes do not spawn live Agents.

The one Vitest invocation retains the default console reporter and also writes `.loom/completion-reports/verify.junit.xml` at the repository root. Its script uses `--reporter=default --reporter=junit --outputFile=../.loom/completion-reports/verify.junit.xml` because npm runs it from `engine/`. JUnit contains only Vitest test facts, including skipped/failed cases; it does not contain compiler or smoke testcases. Normal zero exit of the entire fixed command proves those other tiers passed too. A later smoke failure leaves the green unit report but the root command remains nonzero. Focused `test:unit` invocations overwrite the same file with focused facts: report existence alone is never full-gate or registered remediation evidence.

Failure stops later stages. The existing test scripts normalize `PI_CODING_AGENT` for their subprocesses; do not replace them with Bun's built-in test runner. The mandatory full gate has **no file/test selectors or omitted smoke tier**. Existing platform-dependent skips must be reported (for example the Darwin-only filesystem case on Linux), not hidden behind a universal zero-skips claim. Live-model calibration remains opt-in and outside this gate.

### Compiler boundary

`engine/scripts/typecheck.ts` uses the explicitly installed TypeScript API with `noEmit`, `noUnusedLocals`, and `noUnusedParameters`. `engine/tsconfig.json` owns all `src`, `tests`, `../pi`, and `scripts/typecheck.ts` roots. Standalone repository-root scripts are not all explicit compiler roots; imported portions may be checked transitively.

Only TS6133/TS6192/TS6196 unused diagnostics on compiler-proven external raw TypeScript, excluding declaration files and explicit roots, are non-fatal. Each original file/position/code/message remains visible. Owned diagnostics, ordinary external dependency errors, config/input failures, and compiler infrastructure failures remain fatal. `skipLibCheck` cannot suppress raw-source unused diagnostics. `typecheck:unused` is an alias of the same complete gate, not a weaker path.

### Test hermeticity

A test that passes or fails because of the machine, the run order, or the seed is a defect. Fix its cause; never add a retry.

- **Temp files.** The global setup `engine/tests/setup/run-temp-root.ts` points `TMPDIR` at one fresh `loom-vitest-run-*` directory per run before any worker starts. Workers and the `bun`/`git` children they spawn inherit it, and the directory is deleted when the run ends. A killed run leaves that one directory behind. When the code under test refuses symlinked paths, make the fixture directory with `canonicalTempDir`, because the macOS temp root sits behind the `/var` symlink.
- **Shared directories.** `LOOM_SUBAGENT_DIR` keeps its production default `/tmp/claude-subagents`, because the guard tests pin bypasses against that literal path. That is the directory a live Claude Code session's hooks use. A suite that writes there uses unique session ids and registers each session for cleanup at the moment it creates the id (see `record-evidence.test.ts`). `pi-extension-review-events.test.ts` keeps its shared fixture under the Git-ignored `.loom/completion-reports/`, because its paths must sit inside the project; a killed run leaves one directory there. Its tests that write Task artifacts each build a throwaway Git repository under the run's `TMPDIR` (`withTaskGraphRepository`) and assert each artifact path lies outside the checkout before writing it. A killed run once left `.tmp-pi-*` files in the checkout, and a live orchestration read them as a Task's out-of-scope writes.
- **Host prerequisites.** `tests/pi/emission-installed-launcher.test.ts` needs the installed Pi subagent launcher under `~/.pi/agent/extensions/`. It is skipped only when `CI=true`; elsewhere a missing launcher fails loudly.
- **Git config.** A test that fakes the operator's global Git config sets `GIT_CONFIG_GLOBAL` as well as `HOME`, because an ambient `GIT_CONFIG_GLOBAL` replaces `$HOME/.gitconfig`.
- **Order.** Every test must pass in any order. When two tests are one observation split across a test boundary, the suite declares `describe(name, { shuffle: false }, …)`.
- **Property tests.** Most property tests take a fresh random seed every run. A counterexample that turns up on CI is a real gap in the oracle or the code: add it as an explicit example and fix the cause. Never pin a seed to hide it.

To check for environment dependence, run the unit suite under varied conditions and compare which tests fail:

```bash
cd engine
npx vitest run --sequence.shuffle --sequence.seed=<n>      # run order
TMPDIR=<path-through-a-symlink> npx vitest run             # macOS-style temp root
TZ=Pacific/Kiritimati LC_ALL=C npx vitest run              # time zone and locale
npx vitest run --maxWorkers=1 --minWorkers=1               # one worker, then many
HOME=<empty-dir> GIT_CONFIG_GLOBAL=/dev/null npx vitest run # no operator config
```

A full sweep adds every property-test file twice at 20× its declared runs on fresh seeds, and a whole run with the clock moved 400 days ahead. A failing test in the empty-`HOME` run is expected only for the installed-launcher prerequisite above. A clock-shifting run cannot check file freshness, because Node reads file times with a system call that `libfaketime` does not intercept. Under it, a file written a moment ago looks as old as the shift.

### Documented wire examples

Every example of a wire shape in `agents/`, `commands/`, `skills/`, `docs/` and `references/` is put through the production parser that decides that shape ([ADR-0073](adr/ADR-0073-every-documented-wire-example-is-parsed-by-its-production-parser.md)). The suite is `engine/tests/docs/doc-wire-examples.test.ts`.

A marker line directly above the fence says what the fence is:

```text
<!-- wire-example: <shape-id> -->          the fence documents that shape
<!-- wire-example: none — <reason> -->     the fence shows JSON that is not a wire example
```

- **Which fences need one.** A `json` fence (the language is the first word of the info string, so ` ```json title="x" ` counts), and a shell fence with a heredoc whose body is JSON (one example per heredoc; the marker goes above the shell fence). Any other fence is an example only when it carries a shape marker, and its body is then the example text. The suite fails on an unmarked JSON fence, a marker with no fence below it, an unregistered shape id, and an opt-out with no real reason.
- **Placeholders.** A value the reader must replace is written `<…>`: `"criterion": "<your lens, verbatim>"`. Everything else is a literal the parser must accept as written. `"a | b"` documents a choice and is read as its first option. A placeholder whose hint says `null` is read as `null`. A list may be elided as `[ … ]`.
- **Adding an example of a registered shape.** Write the fence and put the marker above it. The shape ids are `WIRE_SHAPE_IDS` in `engine/tests/support/doc-wire-shape-ids.ts`. If the example uses a placeholder under a field the shape has no value for, the suite names the field; add the value to that shape's `placeholders`.
- **Adding a shape.** Add the id to `WIRE_SHAPE_IDS` and an entry to `WIRE_SHAPES` (`engine/tests/support/doc-wire-shapes.ts`) whose `parse` calls the function the engine itself calls on that input. The record is total over the ids, so an id without a parser does not compile. The suite refuses a registered shape no doc teaches, a shape whose parser admits a document that is not its shape, and an example that also parses under another shape's id. If the engine's parser for the input is not exported, export it from the functional core, returning a result the handler renders; do not restate its rules in the registry.
- **Opting out.** Use `none — <reason>` only for JSON that is not Loom input: another tool's file, or output nothing parses back in. The reason is at least 20 characters and says which of the two it is.

Not governed, each with its reason in `UNGOVERNED` (`engine/tests/support/doc-wire-examples.ts`): the stamped reviewer wire contract (the stamp check compares its bytes), `docs/adr/`, the archived reviewer protocols, and the `security-expert` and `nextjs-frontend-design` skills. The suite fails when an entry names a path that does not exist (a trailing slash names a directory). JSON written inline in a sentence or a table cell is not detected.

### Focused iteration (not full-gate evidence)

```bash
npm --prefix engine run typecheck
npm --prefix engine run test:unit -- tests/runbook-contract.test.ts tests/panel-config.test.ts
npm --prefix engine run test:unit -- tests/handlers/helpers/orchestration.test.ts
npm --prefix engine run test:unit -- tests/pi-extension-review-events.test.ts
npm --prefix engine run test:smoke
# entire test script without the compiler gate:
npm --prefix engine run test
# equivalent package-script invocation from engine/:
# bun run test
```

**Bare `bun test` is Bun's built-in runner, not `npm run test` / `bun run test`.** Report the exact command, exit status, test counts/skips, smoke completion or not-run stages, and environment. Focused green checks or separately green tiers are not a green canonical run. Do not claim full validation when concurrent work prevents a complete run on the final tree.

## Linter operations

### Scan the project

```bash
bun scripts/lint-project.ts            # the whole repository, from any directory in it
bun scripts/lint-project.ts engine/src # one directory (exclusions still apply)
```

Everything is linted; exclusions are explicit and reasoned. The scan reads every
lintable file — tests, `.mts`/`.cts`/`.mjs`/`.cjs` and declaration files
included — minus the `exclude` entries in `.claude/linter/rules/config.json`,
each with its reason. The full scan runs inside `npm run verify` (the engine's
`lint` script, between the compiler and the suite), so a violation or a stale
baseline, exclusion, purity shell, boundary or grant fails verification locally
and in CI. Loom's purity roots (`engine/src/core`, `machine`, `linter`,
`parsers`), its declared shells and its boundaries for every `engine/src`
directory and top-level file live in that config, not in the rule code. See
[the runner reference](../skills/lint-project/references/runner.md).

### Rule tiers

Each rule's tier is listed in [Lint Rules](../lint-rules/README.md): `immediate` rules run on every edit (the `lint-file` PostToolUse hook) and at the Wave Gate, `full` rules only at the Wave Gate.

### Validate rule files

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper validate-lint-rules                         # the project's rules directory
bun "$LOOM_DIR/engine/src/cli.ts" helper validate-lint-rules .claude/linter/rules    # or name one explicitly
```

With no argument the helper validates the project's one rules directory — the first present of `.claude/linter/rules`, then `.pi/linter/rules` (a Pi-only project) — the same directory Claude Code's edit hook, Pi's post-edit lint, the Wave Gate lint and `lint-project` read; the lookup does not depend on the harness. With none present it validates the bundled defaults and says 0 project rules were checked. A nonexistent directory is an error for explicit validation. Runtime loading, by contrast, treats an absent project rules directory as “no project overrides.”

See [Lint Rules](../lint-rules/README.md) for configuration and tiers.

## Model policy operations

```bash
# Inspect one Agent’s semantic profile and both bindings
bun "$LOOM_DIR/engine/src/cli.ts" helper model-profiles agent --agent code-reviewer

# Validate all source definitions
bun "$LOOM_DIR/engine/src/cli.ts" helper model-profiles validate

# Regenerate Pi Agent definitions
bash scripts/sync-pi-agents.sh
```

Generated Pi Agents live under `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/agents`. Regenerate after Agent, Skill, model-profile, or package-root changes, then `/reload` Pi.

## Model calibration

Calibration is live-model work and is opt-in:

```bash
cd /path/to/loom
LOOM_RUN_MODEL_CALIBRATION=1 bun scripts/run-model-calibration.ts \
  --profile focused-review \
  --corpus calibration/corpus.json \
  --output calibration/results/focused-review.json
```

Without `LOOM_RUN_MODEL_CALIBRATION=1`, the script exits without running models. Score predictions separately with the `helper model-calibration` operations. Read [Model profiles and calibration](model-profiles-and-calibration.md) before changing policy.

## Measuring second sites: the family-site metric

`helper family-sites` counts the raw sites each known invariant family still has outside its owner modules. It reads every `.ts` file under `<root>/engine/src`, excludes test files and each family's owners, skips comment lines, and matches line patterns defined once, in `FAMILIES` (`engine/src/core/family-sites.ts`). It is read-only: no State File, no writes.

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper family-sites            # human report
bun "$LOOM_DIR/engine/src/cli.ts" helper family-sites --json     # JSON, byte-identical for the same bytes
bun "$LOOM_DIR/engine/src/cli.ts" helper family-sites \
  --baseline docs/family-sites.baseline.json                             # per-family delta since the baseline
bun "$LOOM_DIR/engine/src/cli.ts" helper family-sites --json \
  --root /path/to/other/checkout                                         # measure another checkout
```

`--root` defaults to the Loom package that owns the engine, so the metric measures Loom itself wherever it is run from.

**Baseline.** `docs/family-sites.baseline.json` was recorded with `--root` against a detached worktree of `626db7fb`, the `main` merge the owner-enforcement feature started from:

| Family | Owner modules | Raw sites at `626db7fb` |
|---|---|---|
| `fail-closed-path-probes` | `engine/src/utils/path-presence.ts` | 124 |
| `shell-tokenizing` | `engine/src/core/shell-{quoting,command,normalize,substitution,write-targets,ansi-c}.ts` | 23 |
| `claim-conservation` | `engine/src/core/findings.ts` | 13 |

A delta marks a family whose patterns changed since the baseline, so a count moved by re-calibrated patterns is not mistaken for consolidation. The patterns are line regexes: the count is a gauge of consolidation progress, not a proof, and the metric blocks nothing. Consolidating the sites is separate work.

## Reviewer prompt fragments

`references/reviewer-wire/` holds the four fragments every reviewer agent carries: `wire-contract.md` (generated from `renderReviewerWireContract()`), `bootstrap.md`, `before-you-emit.md` and `read-coverage.md` (hand-written). Edit a hand-written fragment, or the generator for the wire contract, then run `bun scripts/stamp-wire-contract.ts`; `--check` reports drift without writing. Never edit a stamped region in an agent file. The wire-contract start marker in each agent names `agents/_shared/wire-contract.md`, because the byte-frozen schema-1 archive carries that marker and is read through the same extraction.

## Loom's own repository

**Loom's own verification manifest.** When Loom orchestrates its own repository, `/loom` Phase 4d keeps the existing `project:verify` check: executable `npm`, args `["run", "verify"]`, cwd `.`, scope `wave`, timeout `1800000`, and a required report at `.loom/completion-reports/verify.junit.xml` (the whole file is the example in [Verification](verification.md#the-verification-manifest)). It runs the same root `npm run verify` as local, CI and tag validation, and both frozen dependency installs are required. `verify` itself must never call the manifest runner or a Wave Gate, which would recurse.

**Piloting a refusal or a block.** An operator note (`brief --task <Task> --note`) cannot make an agent misbehave on purpose: the brief tells the agent that a note never overrides its rules, and agents keep to them. A pilot that must exercise a refusal or a block needs a scenario whose natural course triggers it: for the affected-test stop check (I7), a Task touching a widely imported hub file; for red-then-green (I6), a Task whose first test run genuinely passes.

## Repository map for operators

```text
.claude-plugin/plugin.json     Claude plugin metadata
package.json                   Pi package registration and runtime dependencies
commands/                      executable user runbooks
skills/                        reusable Skill runbooks and knowledge
agents/                        source Agent definitions
hooks/                         Claude Code hook registration and shims
pi/                            Pi adapter, renderer, transcript adapter, grants
engine/src/core/               parsers, policy, reducers, domain values
engine/src/orchestration/      anchored persistence, event journal, effects, Git remediation
engine/src/handlers/           harness/CLI shell
engine/tests/                  unit, property, integration, contract tests
scripts/                       sync, lint, calibration, smoke scripts
calibration/                   committed corpus; generated results are ignored
docs/family-sites.baseline.json  family-site metric baseline at 626db7fb
```
