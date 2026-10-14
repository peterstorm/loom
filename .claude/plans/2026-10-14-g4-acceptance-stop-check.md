# G4 slice 1: acceptance stop check (I7 for claimants)

**Date:** 2026-10-14
**Status:** built on `feat/g4-acceptance-stop-check` (see As built)
**Sequence:** G4 is "oracle inside the loop". Its narrow I5 type-check slice shipped in #72. This slice is I7 for G1 claimants. I6, the red-then-green proof obligation, follows on the same runner.

## Goal

A G1 claimant gets its frozen acceptance tests' verdict before it finishes, while its context is still loaded, rather than at the Wave Gate.

When a claimant's agent tries to stop, the engine:
- runs that contract's acceptance files with an operator-declared runner;
- blocks the stop if a testcase the claimant owes is failing, showing it the failures, so the same agent keeps going.

The Wave Gate's completion suite stays the only completion authority.

## Decisions (user, 2026-10-14)

1. **Trigger: at task stop.** It's an I8-shaped stop check. Per-edit runs come later, if they come at all.
2. **Runner: an operator-declared manifest entry.** Nothing is inferred and no command is chosen by a model. With no entry, the feature is off for that project.
3. **Scope: I7 only.** I6 is a later slice.

## Design

### 1. Manifest: an optional `acceptanceRunner`

`.loom/verification-manifest.json` gains one optional top-level object:

```json
"acceptanceRunner": {
  "executable": "vitest",
  "args": ["run", "--reporter=junit", "--outputFile=.loom/completion-reports/acceptance.junit.xml", "{files}"],
  "cwd": ".",
  "timeoutMs": 120000,
  "report": { "kind": "required-file", "path": ".loom/completion-reports/acceptance.junit.xml" }
}
```

- **The `{files}` placeholder.** It must be exactly one whole argument; the engine expands it into the acceptance file paths, one argument each. Nothing else is interpolated, and there is no shell.
- **Frozen at population** into `verification_manifest`, like the project checks, by the same `write-verification-manifest` → population path. Later source edits do not change it.
- **Parsing.** An exact-record parse. A field is either absent or a fully valid runner; a malformed runner refuses population.
- **Compatibility (P1 resolved 2026-10-14).** The source parser is an exact record (`schemaVersion`, `kind`, `checks`), and so is the frozen form (`schemaVersion`, `kind`, `source`, `manifestDigest`, `projectChecks`). So the runner needs source **schemaVersion 2**; v1 manifests stay valid and mean no runner. The frozen form gains an optional `acceptanceRunner`, which old graphs lack, so the feature is off for them.

### 2. Core: what a claimant owes at stop (pure)

`core/acceptance-contract/stop-check.ts`, enrolled as a pure module.

- **`stopCheckExpectation(contracts, tasks, task)`** returns either `none` or the testcases owed. It returns `none` unless the contract is `frozen` and the Task is a claimant.
  - The owed set is the roster testcases that decide at least one of the Task's claims and whose anchors are all due at or before the Task's Wave (`dueWaves`).
  - It also returns the acceptance files containing those testcases.
- **`judgeStopCheck(expectation, facts)`** reuses `observeAcceptanceFacts` over the JUnit report. It returns one of:
  - `passed`;
  - `failing` — a non-empty list of owed testcases, each failed (with its failure type), skipped, or did-not-run (its file ran but the testcase was absent or failed to collect); only the runner output shown with it is truncated;
  - `unobservable` — the report is missing or malformed or has no testcase of the owed files, or the runner timed out, with the reason.
- **Fail-open rule.** `unobservable` never blocks; it is an operator note. Only `failing` blocks.

### 3. Shell: the SubagentStop hook

- **Where it runs.** A new step in `subagent-stop/dispatch.ts`, for impl agents only. It runs before `runUpdateTaskStatus` settles the Task, so a blocked stop settles nothing.
- **How it runs the runner.** Through `orchestration/completion-check-runner.ts`'s project-command runner. That runner already owns process groups, timeouts, and fresh-report reset with no-follow reads; this slice adds no runner of its own.
- **What a block looks like.** Exit 2 with stderr. Claude Code keeps the agent running and shows it the stderr: the owed failing testcases, their messages, and the note that frozen files are read-only and a wrong test is reported, not edited.
- **Block cap.** At most 3 blocks per spawned agent. The count lives in a sidecar keyed by agent id under the session state dir, not in the TaskGraph, so the State File schema does not change. After the cap, the stop proceeds with an operator `systemMessage`, and the Wave Gate judges as today.
- **Deadline.** The runner's `timeoutMs` is capped below the hook's own timeout, which the dispatch shim's `hooks.json` entry sets explicitly. That entry has no timeout today, so Claude Code's 60 s default applies; the plan sets one. A run that misses it is `unobservable`, so it fails open.
- **Pi.** Settlement runs after the batch's subagents have ended, so it cannot resume one. Pi runs the same check and reports `failing` as an operator note in the settlement output; it never blocks. This limit is documented, not hidden.

### 4. What it never is

- Completion evidence: the result is never recorded as test evidence, proof, or acceptance.
- A gate on non-claimants, or on contracts that are not yet frozen.
- A writer of frozen files.

## Load-bearing assumptions → evidence → if false

| # | Assumption | Evidence / probe | If false |
|---|---|---|---|
| A1 | SubagentStop exit 2 keeps a Claude Code subagent running and shows it stderr | Hooks docs, 2026-10-14: "SubagentStop: prevents the subagent from stopping" on exit 2. **Probe P0:** a throwaway hook in a scratch project, run once | Fall back to an advisory `systemMessage` only (the Pi behaviour everywhere) |
| A2 | `completion-check-runner`'s project-command runner can run one ad-hoc command outside a Wave Gate run | Read `runCompletionCheck`'s inputs at implementation | Extract its process and report core into a shared function first |
| A3 | Running acceptance files alone is fast enough (well under the hook timeout) | Pilot: 5 testcases, CLI spawn ~1 s each | Raise `timeoutMs`/hook timeout per project; past the deadline it fails open |
| A4 | Sibling Tasks editing in the same Wave don't make a claimant's owed tests flap | Owed tests reach code through the entry point its own dependency chain built (#88); siblings in the same Wave don't own it | The cap bounds the cost; the block text names concurrent edits as a possible cause |
| P1 | The manifest parser rejects unknown top-level fields | **Resolved:** `exactRecord(raw, ["schemaVersion","kind","checks"])` in `core/verification-manifest.ts` | Source manifest schema v2, plus an optional frozen field |

## Tasks (a direct PR, or a small `/loom` run)

1. **T1 (manifest):** the `acceptanceRunner` grammar, freezing, and coverage rendering in `orchestration status`; `write-verification-manifest` and docs.
2. **T2 (core):** `stopCheckExpectation` and `judgeStopCheck`, with unit and property tests. The property: `failing` exactly when an owed testcase is failing in the facts.
3. **T3 (shell):** the dispatch step, the runner call, the exit-2 block, the cap sidecar, and the hook timeout; the Pi advisory path. Integration tests:
   - a claimant with a failing owed testcase is blocked, and nothing is settled;
   - a passing one settles;
   - an unobservable result fails open;
   - the cap releases;
   - non-claimants and unfrozen contracts are skipped.
4. **T4 (docs):** `docs/operations.md` (stop check, cap, Pi limit), the brief's claimant block ("the engine runs these at your stop"), `CONTEXT.md` (**Acceptance Stop Check**), and the vault.

## Measurement

On the next G1-shaped `/loom` run: the number of claimant stops blocked, the blocks that turned green before the cap, and the Wave Gate acceptance failures on claimants. The target is zero claimant acceptance failures reaching the gate.

## As built (2026-10-14)

- **P0 passed.** In a throwaway project, a SubagentStop hook exited 2 on the first stop. The subagent resumed and did the work named on stderr. The second stop arrived with the same `agent_id` and `stop_hook_active: true`.
- **P1 resolved.** The manifest gained source schema 2 with an optional `acceptanceRunner`. The frozen form adds the field only when it is present, so frozen manifest digests without a runner are unchanged.
- **Executable allowlist.** `npx` is not on the project-check allowlist, so the example runner uses `vitest` directly; an `npm run <script>` form also works. The runner reuses the project-command parser, which applies the allowlist, the no-shell rule and the report-path rules. The runner may not share a report path with a Wave check.
- **Hook timeout.** The SubagentStop `dispatch.sh` hook entry now sets `"timeout": 300`, and the runner's `timeoutMs` is capped at 240000.
- **Code:**
  - `core/acceptance-contract/stop-check.ts`: `stopCheckExpectation`, `judgeStopCheck`, `renderStopCheckBlock`; pure, and enrolled as a pure module.
  - `handlers/subagent-stop/acceptance-stop-check.ts`: the ports, the block cap sidecar, and the report-only Pi ports.
  - `subagent-stop/dispatch.ts`: the check runs before settlement and cleanup.
  - `pi/subagent-stop.ts`: report-only, before implementation settlement.
