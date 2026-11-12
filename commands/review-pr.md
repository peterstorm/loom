---
description: "Adjudicated multi-Agent review of an exact repository scope"
argument-hint: "[code|errors|tests|types|comments|architecture|simplify|all] [--files file1,file2] [--dry-run]"
allowed-tools: ["Bash", "Read", "Task", "Agent", "subagent"]
---

# Review PR

Run a registered Standalone Review Program. The engine owns scope derivation,
reviewer, model and Skill selection, Context Packets, request authority,
transcript capture, retries, aggregation, refutation of critical Findings and
publication of the result. You spawn what it returns and report what it
published. This workflow never changes the feature TaskGraph.

**Arguments:** "$ARGUMENTS"

Do not use this command to review one Wave Task. `/wave-gate` owns per-Task
review and Wave-wide adjudication.

## 1. Resolve Loom

```bash
LOOM_DIR="${CLAUDE_PLUGIN_ROOT}"
test -f "$LOOM_DIR/engine/src/cli.ts" || exit 1
```

Claude Code expands the token; Pi receives an absolute rendered path. Never
infer the package from the working directory or another harness installation.

## 2. Parse the arguments

One review kind per run; omit it for `all`:

- `code`, `errors`, `tests`, `types`, `comments`
- `simplify` — the `code-simplifier` reviewer. Under `all` the engine adds it
  when the scope changes source or test files.
- `architecture` — the `architecture-tech-lead` reviewer. Joins for
  `architecture` and `all`, and for any other kind when the scope has >500
  additions, >10 files or new structure.
- `all` (default)

`--files` is a comma-separated explicit scope. Without it the engine freezes
the sorted union of branch-committed, staged, unstaged tracked and untracked
non-ignored paths, excluding Loom run and state evidence. An empty scope is a
hard stop. `--dry-run` is recorded in the review authority; it does not weaken
review or adjudication.

## 3. Start one fresh run

The runs root must exist; the engine never creates it. `start` creates the Run
Directory itself, so `--run` only has to name a fresh direct child of the runs
root, as a bare run id or a full path. `mktemp -d` is a convenient way to pick
an unused name:

```bash
RUNS_ROOT=".claude/reviews/standalone-review-runs"
mkdir -p "$RUNS_ROOT"
RUN_DIR="$(mktemp -d "$RUNS_ROOT/run.XXXXXXXXXX")"
```

Pass only the parsed arguments:

<!-- wire-example: standalone-review-start -->
```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration start standalone-review \
  --runs-root "$RUNS_ROOT" \
  --run "$RUN_DIR" <<'JSON'
{"kind":"all","files":null,"dryRun":false}
JSON
```

For explicit files, `files` is a non-empty JSON string array. Never hand-build
scope metadata, reviewer rosters, model lookups, transcript slots, findings,
verdict manifests or panel events.

`start` refuses a scope that is too large for a reviewer to read in full,
before any reviewer runs:

- each reviewer packet's frozen source must fit the 16 MiB Context Packet
  bound;
- the scope's frozen diff must fit one reviewer's 240,000-unit read budget.
  Every reviewer is obliged to page the whole frozen diff, and the engine
  refuses and retries a result with unread pages
  ([ADR-0022](../docs/adr/ADR-0022-engine-observed-standalone-read-coverage.md)).

When `start` refuses for size, split the scope into explicit `files` slices of
at most about 230 KB of `git diff` each and start one run per slice.

## 4. Execute returned actions

Execute only the one typed action `start` or `resume` returns:

- `spawn-batch` — spawn every request exactly as given, preserving its Agent,
  model, required Skill, task text, Context Packet reference,
  `LOOM_REQUEST_ID` and cwd. Claude may send the batch in one message. Pi
  accepts at most eight requests per native subagent call: partition a larger
  batch into ordered chunks of at most eight, without changing, dropping or
  duplicating a request, and wait for every chunk before resuming.
- `blocked` — stop and report the complete diagnostic.
- `done` — report the result (step 5).

After a complete batch:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration resume \
  --runs-root "$RUNS_ROOT" \
  --run "$RUN_DIR"
```

Resume until `done` or `blocked`; resume is idempotent. The harness writes each
reviewer's final bytes into the engine's slot. Never copy Agent output into
files yourself.

Reviewers return one JSON payload; the engine admits or retries it. A
malformed payload is failed evidence, never a Finding. Surviving criticals
block.

This command only reports advisories. If you go on to triage them, publish the
decisions with `standalone-disposition` (see the
[review-and-fix skill, Phase 2](../skills/review-and-fix/SKILL.md#phase-2--plan)).
Do not publish anything just because the review finished.

## 5. Report only canonical results

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration inspect \
  --runs-root "$RUNS_ROOT" --run "$RUN_DIR"
```

Inspection re-proves the run's authority and reads the published `result.json`
at the Run Directory root. Relay its counts and Finding details; never compute
tallies of your own or write a summary artifact. Report:

- the exact frozen scope and the reviewer roster;
- surviving critical Findings;
- advisory Findings;
- refuted critical Findings, with lenses, votes and reasoning;
- evidence and retry diagnostics, if any;
- the Run Directory and the result path.

Do not fold refuted Findings into "fixed" or hide them. A blocked or incomplete
run is not a review result: a missing roster member, malformed attempt-2 output
or a publication failure is blocked evidence, not partial success.

## Successor reviews

A successor review is never automatic, and there is no slash flag for one. If
the user asks for one, follow
[operations: explicit successor review](../docs/standalone-review.md#explicit-successor-review).

## Examples

```text
/review-pr
/review-pr code
/review-pr tests
/review-pr architecture
/review-pr comments --files README.md,docs/architecture.md
/review-pr all --dry-run
```
