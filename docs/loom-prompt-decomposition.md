# `/loom` prompt layout

How the `/loom` orchestration prompt is split, when each part is loaded, and which tests pin it. This replaces the earlier decomposition proposal, which is now carried out; the proposal's text is in git history.

## Why it is split

`commands/loom.md` is expanded whole into the orchestrator's context on every `/loom` invocation, a `--status` query included. Before the split it was 79KB, most of it procedure that only one branch of a run ever reaches. Now the command holds what every run needs, and each single-branch procedure is a runbook the orchestrator reads on demand.

## What is where

| File | Size | Holds | Loaded |
|---|---:|---|---|
| `commands/loom.md` | ~19KB | Setup (bun check, package path, path notation, slug, `init-state`), arguments, spawn rules, the Phases table with each template's variables, the orchestrator's duties between phases (checkpoints, plan-alignment loop-back), Phase 5 status loop and implementation briefs, invariants, and one Mandatory read stanza per runbook | Every invocation |
| `references/loom/panel-runbook.md` | ~10KB | `/loom --panel`: flag validation, run directory, interview, lens selection and manifest, criteria, Panel Program, designers, judges, aggregation, finalize | Only with `--panel`, before Phase 3 |
| `references/loom/plan-design-review-runbook.md` | ~4KB | Phase 3.6: start the `plan-design` standalone review, drive it, dispose of advisories, `accept-plan-design-review`, refusals | After plan alignment, unless `--skip-plan-design-review` |
| `references/loom/decompose-runbook.md` | ~7KB | Phase 4: spawn, 4a validation and failure routing, 4b trace ownership, 4c approval, 4d manifest, issue and `populate-task-graph`, 4e `/clear` checkpoint | On reaching Phase 4 |
| `references/loom/recovery-runbook.md` | ~8KB | Status as authority, raw-state inspection, blocked Waves, false-positive overrides, the helpers that may be run directly, State File repair, completion, abort | Before any of those actions |

Each stanza in `commands/loom.md` says when to read the runbook, that it must be read in full before acting, and to stop if it cannot be read. Runbooks are named as `{LOOM_DIR}/references/loom/<name>.md`; `{LOOM_DIR}` is the package path printed in Setup, written out literally because shell variables do not survive between Bash calls.

The same layering holds one level down:

- Phase templates (`commands/templates/phase-*.md`) carry per-run values and the phase's process. Agent files (`agents/*.md`) own what does not vary by run: the interview digest labels, the candidate format and the judge verdict schema.
- `references/architecture-interview.md` owns the architecture questionnaire; the standard template and the panel interviewer both read it.
- `references/executable-models.md` owns the executable-model grammar. `phase-architecture.md` step 6 is a trigger list that sends the agent to one section of it. Enforcement mechanics and known limits are in `docs/executable-models-enforcement.md`, which no prompt loads.
- The hook table and the State File shape moved to the end of `docs/architecture.md`.

`engine/src/handlers/session-start/resume-after-clear.ts` still sends a resumed session to `commands/loom.md`, "Phase 5: Execute", so that heading stays in the command.

## Tests that pin the layout

| Test | Pins |
|---|---|
| `engine/tests/runbook-contract.test.ts` | `panel-runbook.md` names every `panel-contract` operation, in order, with every flag; the interviewer agent carries every digest label and enum value; the binding grammar and frozen-ADT refusals in `executable-models.md`; decompose rule 12; the skeleton outcomes in `commands/loom.md` Phase 5 |
| `engine/tests/panel-config.test.ts` | The panel counts in `panel-runbook.md` equal the config constants; the digest labels in the interviewer agent equal the parser's |
| `engine/tests/panel-templates.test.ts` | For every `phase-*.md`, the placeholders in the template equal the variables its row declares (the Phases table in `commands/loom.md`, or the template table in `panel-runbook.md`), and each template names its agent's required skill |
| `engine/tests/command-preflight-contract.test.ts` | The first Bash block under `## Setup` is the bun check and fails closed |
| `engine/tests/impl-agent-skill-contract.test.ts`, `implementation-loop-prompt-contract.test.ts`, `impl-agent-verification-forms.test.ts` | The brief template's variables, workflow order and final-run command forms |
| `engine/tests/docs/doc-wire-examples.test.ts` | Every JSON example in the command, runbooks, templates and agents carries a wire-example marker and parses |
| `engine/tests/core/parse-plan-models.test.ts` | `plan-template.md` and the examples in `executable-models.md` parse cleanly |
| `engine/tests/spec-template-contract.test.ts` | `spec-template.md` parses; `commands/specify.md` defers to it instead of restating the grammar |

## Adding to it

Put a procedure in `commands/loom.md` only if every run needs it. Anything a single branch reaches goes in a runbook with a Mandatory read stanza. State each format, table or grammar in one file and point to it from the others; if a test requires the same text in two files, re-pin the test to the owner.
