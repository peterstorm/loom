# `/loom` Phase 3.6: Plan Design Review Runbook

Read by the `/loom` orchestrator after plan alignment has settled and before it spawns the decompose agent. `{LOOM_DIR}` and `{date_slug}` mean what `commands/loom.md` Setup defines.

**When it runs.** Always, unless `--skip-plan-design-review` was passed to `init-state`, or the State File has no `plan_design_review` field (it was initialized before the gate existed). Any edit to the plan after acceptance closes the gate again, so run it only once plan alignment is done.

**What it is.** A gate on the decompose spawn, not a phase: `current_phase` does not change and no phase agent runs ([ADR-0070](../../docs/adr/ADR-0070-the-plan-design-review-gates-decompose.md)). The plan is reviewed by `code-reviewer`, `type-design-analyzer` and `architecture-tech-lead` as a Standalone Review of kind `plan-design`, each with a plan design lens in its Context Packet and each obliged to read the whole plan.

Run every command from the repository root.

## 1. Start the review

`files` names exactly the plan, as a path relative to the repository root. The runs root must exist; the engine never creates it. The engine creates the Run Directory itself and also accepts an empty one made in advance, so `mktemp -d` is used here to choose a fresh name:

<!-- wire-example: standalone-review-start -->
```bash
RUNS_ROOT=".claude/reviews/standalone-review-runs"
mkdir -p "$RUNS_ROOT"
RUN_DIR="$(mktemp -d "$RUNS_ROOT/run.XXXXXXXXXX")"
printf '%s\n' "$RUN_DIR"
bun "{LOOM_DIR}/engine/src/cli.ts" helper orchestration start standalone-review \
  --runs-root "$RUNS_ROOT" \
  --run "$RUN_DIR" <<'JSON'
{"kind":"plan-design","files":[".claude/plans/{date_slug}.md"],"dryRun":false}
JSON
```

Keep the printed Run Directory and substitute it, and the runs root, in the later calls; shell variables do not persist between Bash calls.

## 2. Drive it to `done`

Do exactly what [`/review-pr` step 4](../../commands/review-pr.md#4-execute-returned-actions) says: spawn each returned `spawn-batch`, then run

```bash
bun "{LOOM_DIR}/engine/src/cli.ts" helper orchestration resume \
  --runs-root ".claude/reviews/standalone-review-runs" --run "<run-dir>"
```

until the result is `done` or `blocked`.

## 3. Dispose of the advisories, if there are any

Triage them with the user and publish the complete ordered decisions with the `standalone-disposition` program ([operations: immediate advisory publication](../../docs/standalone-review.md#immediate-advisory-publication)). Any decision is enough; advisories never block. Keep the disposition's absolute Run directory, its Run id and its disposition digest.

## 4. Accept the review

```bash
bun "{LOOM_DIR}/engine/src/cli.ts" helper accept-plan-design-review \
  --runs-root ".claude/reviews/standalone-review-runs" --run "<run-dir>"
```

With advisories, add `--disposition <absolute disposition Run directory> --disposition-run <its Run id> --disposition-digest <its disposition sha256>`.

On success it prints `Plan design review accepted: <plan> sha256 <digest> (run <id>)` and records `plan_design_review: {"status":"accepted", ...}` bound to the plan's bytes. On refusal it names the one reason and what to do.

## Refusals

- **A critical survived refutation.** The helper refuses with the Finding ids. Present the findings to the user, edit the plan to resolve them (or loop back to architecture as in Phase 3.5), and start a fresh review at step 1. A `plan-design` review has no successor.
- **The plan was edited after acceptance.** The decompose spawn is blocked with both digests. Start a fresh review at step 1.

Never write `plan_design_review` yourself. After `init-state`, the helper is its only writer.
