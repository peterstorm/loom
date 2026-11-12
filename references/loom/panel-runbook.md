# `/loom --panel`: Architecture Panel Runbook

Read by the `/loom` orchestrator when `--panel` or `--panel=N` was passed, before it spawns anything for Phase 3. It replaces the single architecture-agent spawn. `{LOOM_DIR}` and `{date_slug}` mean what `commands/loom.md` Setup defines.

Panel mode changes only how the plan is produced: an interviewer, N designers and K judges run first, and one final `architecture-agent` writes the one plan. `current_phase` stays `architecture` throughout. Panel agents are admitted only in that phase and never advance it; the final `architecture-agent` advances to plan alignment, or to decompose when `--skip-plan-alignment` is set.

Panel mode is driven by `helper panel-contract` plus `helper panel-program`. Do not also drive it through `helper orchestration start`.

## Validate the flag

- Reject more than one panel flag.
- Bare `--panel` uses `PANEL_DESIGNERS_DEFAULT` (currently 3) designers.
- `--panel=N`: `N` must match `^[0-9]+$`, be at least `PANEL_DESIGNERS_MIN` (currently 2) and at most `PANEL_LENS_COUNT` (currently 5), the number of distinct lenses (5). Reject anything else: malformed, fractional, duplicate, smaller or larger. Never reinterpret a bad value.
- Judges: K is `PANEL_JUDGES_DEFAULT` (currently 3), fixed at one judge per criterion.

## Templates and their variables

| Template | Variables |
|---|---|
| `phase-arch-interview.md` | `{feature_description}`, `{spec_file_path}`, `{interview_file_path}`, `{loom_dir}` |
| `phase-arch-design.md` | `{feature_description}`, `{lens_name}`, `{lens_prompt}`, `{spec_file_path}`, `{interview_file_path}`, `{candidate_output_path}` |
| `phase-arch-judge.md` | `{criterion}`, `{candidate_manifest_path}`, `{interview_json_path}` |
| `phase-arch-finalize.md` | `{feature_description}`, `{spec_file_path}`, `{interview_file_path}`, `{candidate_manifest_path}`, `{judge_verdicts}`, `{panel_ranking}`, `{date_slug}`, `{loom_dir}` |

Templates are in `{LOOM_DIR}/commands/templates/`. `{loom_dir}` is the resolved `LOOM_DIR`; the other values are given in the steps below. The spawn rules of `commands/loom.md` apply to every spawn here.

## Step 0: Create the run directory

Create a unique directory under the spec directory before spawning any panel agent:

```bash
PANEL_RUNS_DIR=".claude/specs/{date_slug}/panel-runs"
mkdir -p "$PANEL_RUNS_DIR" || exit 1
PANEL_RUN_DIR="$(mktemp -d "$PANEL_RUNS_DIR/run.XXXXXXXXXX")" || exit 1
mkdir "$PANEL_RUN_DIR/candidates" "$PANEL_RUN_DIR/verdicts" || exit 1
PANEL_RUN_ID="${PANEL_RUN_DIR##*/}"
printf '%s\n' "$PANEL_RUN_DIR"
```

Keep the printed path and substitute it for `<panel-run-dir>` in every later call; shell variables do not persist between Bash calls. Never reuse an existing run directory. Every interview, candidate, manifest and verdict artifact of this run lives under it. Older runs may stay on disk; never discover or read them implicitly.

## Step 1: Interview (once, interactive)

Fill `phase-arch-interview.md` with `{interview_file_path}` = `<panel-run-dir>/interview.md` and spawn `arch-interviewer-agent` (under Pi with `loom_interactive_subagent`). When it completes, require that exact file to be non-empty (`test -s`), then validate and canonicalize the digest:

```bash
bun "{LOOM_DIR}/engine/src/cli.ts" helper panel-contract interview \
  < "<panel-run-dir>/interview.md" \
  > "<panel-run-dir>/interview.json"
```

On a contract error (a missing, duplicate or empty label, or an invalid enum value), delete this run's invalid digest and JSON and re-spawn the interviewer with the field-level diagnostics. Retry once; if the digest is still invalid, stop panel mode and report the error. Lens selection and judging read only the validated JSON.

## Step 2: Select lenses and write the manifest

Read the lens fragments from `{LOOM_DIR}/references/panel-lenses.md`. Choose N distinct lenses from `<panel-run-dir>/interview.json`:

- Always include `simplicity-first` and `type-driven-fp`.
- Fill the remaining slots from validated interview signals, in this priority order:
  - `sensitiveBoundaries` begins `flagged` → `risk-security-first`
  - `primaryAxis` = `performance` → `performance-first`
  - `codebaseMaturity` = `brownfield` → `codebase-conventionist`
  - then the lens table's order.

Before any designer spawns, write `<panel-run-dir>/manifest.json` with `run_id`, `interview_file`, `interview_json` and a `candidates` array. Each candidate entry has `lens`, `path` (`<panel-run-dir>/candidates/candidate-<lens>.md`) and the bare `filename`. Build the JSON with `jq -n` and `--arg`, not string concatenation, then validate it at once:

```bash
bun "{LOOM_DIR}/engine/src/cli.ts" helper panel-contract manifest \
  --runs-root ".claude/specs/{date_slug}/panel-runs" \
  --manifest "<panel-run-dir>/manifest.json" \
  --designers "<N>"
```

Stop on failure. From here on this manifest is the only authority for the candidate set.

## Step 3: Derive the judge criteria

Get the ordered criteria from the helper; never derive them by hand. It needs no candidate files, so run it now:

```bash
bun "{LOOM_DIR}/engine/src/cli.ts" helper panel-contract criteria \
  --runs-root ".claude/specs/{date_slug}/panel-runs" \
  --manifest "<panel-run-dir>/manifest.json" \
  --designers "<N>"
```

It prints a JSON array of exactly K criteria: the digest's `primaryAxis` verbatim, its `testabilityBar` verbatim, then the fixed `codebase fit + effort`. Later steps reject any criterion outside this list.

## Step 4: Start the Panel Program

The Panel Program owns dispatch order, retries and LLM Profiles. Build its journal with all N manifest lenses and all K criteria, in order:

<!-- wire-example: architecture-panel-journal -->
```json
{
  "input": {
    "candidateLenses": ["<manifest lens 1>", "<manifest lens N>"],
    "judgeCriteria": ["<derived criterion 1>", "<derived criterion K>"]
  },
  "events": []
}
```

Pipe it to:

```bash
bun "{LOOM_DIR}/engine/src/cli.ts" helper panel-program architecture
```

The first returned action is the designer `spawn-batch`. After every spawn or engine operation, append its canonical `spawn-outcome` or `engine-outcome` event to `events` and replay the whole document; execute only the newly returned action. Completion order does not matter. The program allows one retry per failed slot and returns it as the next action. Stop on `blocked`; never advance a stage by hand.

## Step 5: Designers (parallel, headless)

For each manifest entry, fill `phase-arch-design.md` with `{lens_name}`, `{lens_prompt}` (that lens's fragment from `panel-lenses.md`), `{interview_file_path}` (the manifest's interview file) and `{candidate_output_path}` (that entry's exact `path`).

Spawn the exact `arch-designer-agent` batch the Panel Program returned, in ONE message (parallel Agent calls), using each request's resolved `modelProfile`. Wait for all of them. Then check every manifest path: it must be a non-empty regular file and not a symbolic link. For an entry that fails the check, delete this run's empty or invalid artifact and report the slot as failed in its `spawn-outcome`; when the program returns the retry, spawn only that designer and repeat the check.

Compare the candidate directory's bare filenames with `manifest.candidates[].filename` in both directions and stop on any missing or extra file. Judges and the finalizer still read only manifest paths, never the directory.

## Step 6: Judges (parallel, headless)

For each criterion from Step 3, fill `phase-arch-judge.md` with `{criterion}`, `{candidate_manifest_path}` (`<panel-run-dir>/manifest.json`) and `{interview_json_path}` (`<panel-run-dir>/interview.json`).

Spawn the exact `arch-judge-agent` batch the Panel Program returned, in ONE message, using each request's resolved `modelProfile`. Validate each raw output before it goes any further, in the same Bash call that defines the two shell variables:

```bash
printf '%s' "$RAW_JUDGE_OUTPUT" | bun "{LOOM_DIR}/engine/src/cli.ts" helper panel-contract verdict \
  --criterion "$EXACT_CRITERION" \
  --runs-root ".claude/specs/{date_slug}/panel-runs" \
  --manifest "<panel-run-dir>/manifest.json" \
  --designers "<N>" \
  > "<panel-run-dir>/verdicts/verdict-1.json"
```

Repeat with `verdict-2.json` and `verdict-3.json`: `verdict-N.json` holds criterion N, and aggregation fails on a swapped slot. The helper emits canonical JSON with curly braces stripped from the judge's prose. On a rejected output, report that judge's slot as failed with the diagnostics; when the program returns the retry, spawn only that judge. Then combine the three files in criterion order with `jq -s`, naming each path, not a directory glob. The result is `{judge_verdicts}`.

## Step 7: Aggregate (no agent)

```bash
bun "{LOOM_DIR}/engine/src/cli.ts" helper panel-contract aggregate \
  --runs-root ".claude/specs/{date_slug}/panel-runs" \
  --manifest "<panel-run-dir>/manifest.json" \
  --designers "<N>" \
  > "<panel-run-dir>/ranking.json"
```

`aggregate` re-reads and re-validates every verdict file itself and emits the ranking. Any failure is fatal: stop and report. Require `ranking.json` to be non-empty before continuing. Its contents are `{panel_ranking}`.

## Step 8: Finalize (interactive, writes the plan)

Fill `phase-arch-finalize.md` with `{interview_file_path}`, `{candidate_manifest_path}`, `{judge_verdicts}` (the canonical three-verdict JSON array, inlined), `{panel_ranking}` (the contents of `ranking.json`, inlined), `{date_slug}` and `{loom_dir}`.

Spawn `architecture-agent` with it (under Pi with `loom_interactive_subagent`). It presents the top-ranked candidates to the user, synthesizes the user's choice, writes `.claude/plans/{date_slug}.md` with `### AD-1: Approach selection (panel)`, and commits.

From here the flow is the standard one: return to `commands/loom.md` at the Phase 3 checkpoint. If plan alignment later sends the run back to architecture, that re-run uses the standard single-agent flow, never a second panel.
