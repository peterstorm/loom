# Read-only helpers

These helpers print what the engine already knows. Use them before a mutating operation, or when a refusal needs explaining. `$LOOM_DIR` is defined in [Operations](../operations.md#prerequisites).

## Shared behaviour

- **Read-only.** No helper documented on this page writes the State File, the evidence ledger or the runtime directory, and none takes the TaskGraph lock. Each is safe to run while a Wave, a Wave Gate or a subagent is live. `ledger-epoch` never writes, truncates or creates a file, the ledger and the subagent directory included.
- **Which graph.** The TaskGraph helpers read the default State File. Set `LOOM_STATE_PATH` to read a non-default graph.
- **Shared refusals (exit 1).** `contract-status`, `stop-check-plan` and `red-then-green-status` exit 1 with `No task graph at <path>` when no TaskGraph exists, and with the load boundary's error when the graph is unreadable or corrupt. A corrupt graph is never reported as missing.
- **`--task <id>` helpers.** `stop-check-plan` and `red-then-green-status` take exactly one argument. They also exit 1 when `--task` is missing or has no value, when an argument is left unconsumed, and when the Task id is not in the TaskGraph (`No task <id> in the TaskGraph`). A typo never reads as "nothing owed" or "not owed".

| Helper | Answers | Documented |
|---|---|---|
| `helper orchestration status` | where the graph is, and the one next action | [Canonical status](../operations.md#canonical-status) |
| `helper orchestration inspect` | what state one run is in | [below](#inspecting-one-run) |
| `helper contract-status` | where each Acceptance Contract stands | [below](#where-does-each-acceptance-contract-stand) |
| `helper stop-check-plan --task <id>` | what the stop checks would run for a Task | [below](#what-will-the-stop-checks-run-at-a-tasks-stop) |
| `helper red-then-green-status --task <id>` | where a Task stands on red-then-green (I6) | [below](#where-does-a-task-stand-on-i6) |
| `scripts/ledger-epoch.ts` | the facts one attempt recorded | [below](#reading-an-attempts-ledger-epoch) |
| `helper family-sites` | how many second sites each invariant family has in Loom's own source | [Development](../development.md#measuring-second-sites-the-family-site-metric) |
| `helper lint-wave-gate` | the full-tier lint refusal a replayed rejection no longer carries | [Operations](../operations.md#wave-gate-full-tier-lint-refuses-imports-the-branch-allows) |
| `helper mutation-check --task <id>` | which changed lines a Task's tests do not answer. Not read-only: it writes one runtime record and only reads the real workspace | [Verification](../verification.md#task-mutation-check) |

## Inspecting one run

`status` answers “where is the graph”; `inspect` answers “what state is this run in, and is it recoverable or stale?”. It is a pure read — it advances nothing.

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration inspect \
  --runs-root <root> --run <run-directory> [--json]
```

It reports the registered program, the machine state read through that program’s own checkpoint shape, every issued slot with its attempt, capture status and the diagnostic that refused it, the event tail, and any abandonment marker. Facts it cannot read are reported as `unavailable` with the cause, never defaulted — so an unreadable checkpoint is distinguishable from a run that never wrote one. Prefer it over hand-reading `authority.json`, `program.json`, `checkpoint.json`, and `events/`. Like `status`, it stays available during a Pi runtime-revision skew, because it is exactly what diagnosing that skew needs.

For standalone review, `inspect` calls `inspectStandaloneFacade`, re-proving
independent registration, issued protocol, publication, checkpoint and actual
result/receipt bytes. Only an authenticated done result gets
`renderStandaloneReviewSummary`: emitted/admitted counts, after-refutation counts,
and escaped rows with IDs, reviewers, locations, claims and full current
basis/reason. The canonical result is `result.json` at the Run Directory root,
not `artifacts/result.json`. JSON inspection retains its existing shape; no
summary artifact or model-authored arithmetic becomes authority.

For a standalone review, `inspect` also takes `--lineage` (with the three `--disposition*` flags) and `--replay`; see [Immediate advisory publication](../standalone-review.md#immediate-advisory-publication) and [Native delivery, replay and remediation](../standalone-review.md#native-delivery-replay-and-remediation).

## Where does each Acceptance Contract stand?

Before revising a contract, or to see which acceptance testcases are still allowed to fail, print the Contract Status:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper contract-status
```

It takes no arguments. For each Acceptance Contract, in TaskGraph order, it prints:

- `CT-n  <title>  (contract Task Tn)`;
- the freeze state: `awaiting RED`, `frozen at Wave N` followed by every roster testcase as `<file> › <name> — <anchors>`, or `revised (k revisions); roster cleared until the next Wave Gate re-records it` followed by the re-stamped paths;
- each covered Requirement as `AS-00n due Wave N` (the latest Wave of a Task that claims it) or `AS-00n unclaimed`;
- `revisions: k` when the contract has any Contract Revision.

A TaskGraph without contracts prints the single line `no Acceptance Contracts`. It exits 0, or 1 on the [shared refusals](#shared-behaviour).

## What will the stop checks run at a Task's stop?

Before dispatching a Task, or when a stop check keeps an Agent working and you want to see why, print the Stop-Check Plan for that Task. It covers both the Acceptance Stop Check and the Affected-Test Stop Check:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper stop-check-plan --task T2
```

It takes exactly one argument, `--task <id>`. When the check is on, it prints:

- `T2 (Wave 2): acceptance stop check on`;
- each owed testcase, grouped under its contract id, as `  <file> › <name>`. A roster testcase is owed only when every anchor it carries is due by the Task's Wave;
- `files:` followed by each owed acceptance file, repository-relative;
- `cwd: <runner cwd>`, then `argv: [...]` as JSON, with `{files}` already expanded so each owed file is one argument relative to the cwd, then `report: <report path>`.

When the check is off, it prints one line, `T2 (Wave 2): acceptance stop check off — <reason>`. The reason is one of: no acceptance runner is frozen in the TaskGraph, the Task owes no frozen acceptance testcase due by its Wave (a contract still awaiting RED owes nothing), or the runner command could not be formed for the owed files. In the last case the runner's refusal follows on indented lines.

An `affected tests:` section follows the acceptance lines. When the affected check is on, the section prints:

```text
affected tests:
  changed files:
    <file>              one line per file the runner gets, in first-write order
  cwd: <affected runner cwd>
  argv: [...]           {files} expanded, each file relative to the cwd
  report: <report path>
```

When the affected check is off, the section prints `  affected stop check off — <reason>`. The reason is exactly one of these, in this precedence:
1. no affected runner is frozen in this TaskGraph;
2. this Task's attempt has no changed files beneath the affected runner cwd. Each changed file outside the cwd follows on its own line, as `outside the affected runner cwd: <file>`;
3. the affected runner command could not be formed for the changed files. The refusal follows on indented lines.

The helper reads the changed files from the Task's live attempt, read-only, through the same `changedFilesAtStop` derivation the hook uses. On Claude Code, the live attempt is the one implementation sidecar naming the Task, read from the session ledger. With no live attempt, which includes every Pi run, there are no changed files. A live attempt whose ledger epoch cannot be read exits 1 with the cause, so it never reads as "no changed files".

The plan is `planStopChecks`, the one pure function both live checks decide from, on Claude Code and on Pi. So whenever a check's plan reads `off`, that check skips, or for a refused command it notes the refusal and runs nothing. When it reads `on`, the check would launch exactly the printed argv from the printed cwd. A parity matrix test runs the hook, the Pi stop and the helper over the same fixtures to pin this. At the stop itself the live checks also consult per-stop state the plan does not read: each check's block counter (after 3 blocks that check stops blocking), the repository root, the runner lock (another stop may hold it), and, for the affected check, the remaining hook budget. When one of those stops the check, the hook emits a note, the stop proceeds, and the plan still reads `on`. The helper never runs the runner. It exits 1 only on the [shared refusals](#shared-behaviour) and on a live attempt whose ledger epoch cannot be read.

## Where does a Task stand on I6?

Use this before dispatching a Task, while its attempt is live, or after it fails with `proof:red-then-green-unproven:<gap>`. It prints the Red-Then-Green Status for that Task: whether the Task owes I6, how settlement splits its files, what the live attempt shows so far, and what the frozen Proof stores.

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper red-then-green-status --task T1
```

It takes exactly one argument, `--task <id>`. The output has four parts, always in this order.

**1. Header.** One line, `<id> (Wave N, <status>): ` followed by one of:

- `owes I6`;
- `I6 not owed — <reason>`, where the reason is the first of these that applies:
  - `TaskGraph predates I6`: the frozen manifest carries no `testFiles`;
  - `writes Acceptance Contract <id>'s frozen files; the contract gate's red window is its red evidence`: the Task is that contract's contract Task, which never owes I6 (see [Task fails I6](../operations.md#task-fails-i6-red-then-green));
  - `claimant (acceptance contract)`: the Task is an Acceptance Contract claimant, which waives its new tests;
  - `new tests waived: <reason>`: any other new-test waiver, for example `new tests waived: documentation-only`;
  - `the frozen Proof carries no red-then-green obligation`: the Task requires new tests, but its frozen Proof owes no I6. The State File's load check makes this unreachable for a graph it admits; the line exists so every not-owed answer has a reason;
- `I6 undeterminable — <reason>`: the Task's test-file classification or its Proof is not frozen yet, so settlement could not decide either.

The reason only explains a `not owed` answer. The decision itself is `redThenGreenDuty`, the function settlement uses.

**2. Files.** This part is printed only when the header reads `owes I6`. It shows the same split settlement judges by (`classifyTaskFiles`), with each list in `file_list` order:

```text
test files:
  <file>
implementation files:
  <file>
```

An empty list prints as a single line, `test files: none` or `implementation files: none`. When you see `test files: none`, the Task fails with `no-test-files` (see [Task fails I6](../operations.md#task-fails-i6-red-then-green)).

**3. Live attempt.** This is the I6 judgment over the epoch of the live Claude Code attempt so far, computed by `judgeRedThenGreen` exactly as settlement calls it. It prints one of:

- `live attempt not observable on this harness`: under Pi. The live attempt is never inspected;
- `live attempt: none`: no implementation sidecar names the Task;
- `live attempt: uninspectable — <reason>`: no readable sidecar names the Task, but some implementation attempt sidecars could not be read, so a live attempt may be missed;
- `live attempt: unreadable — <reason>`: an attempt is live but cannot be judged. Either several live attempts name the Task, the attempt is rostered without a parseable role, its ledger epoch cannot be read, or the repository root cannot be resolved;
- `live attempt: not judged (no I6 obligation to judge it by)`: an attempt is live, but the header reads `I6 not owed` or `I6 undeterminable`, so there is no obligation to judge it against;
- `live attempt: shown`, followed by the three facts in order:

  ```text
  live attempt: shown
    red #<index> <command>
    first implementation write <path>
    green #<index> <command>
  ```

- `live attempt: proof:red-then-green-unproven:<gap>`, with ` (untrusted runs only)` added when the gap's `untrustedOnly` is true. The gaps are listed in [Task fails I6](../operations.md#task-fails-i6-red-then-green).

Only a `shown` judgment carries ledger references. `#<index> <command>` names a qualifying run: `index` is the run's 0-based position in the epoch's ordered events, and `command` is that run's command. For an unproven judgment the helper prints only the gap. It does not show references for steps met before the gap, because the judge returns none and inferring them would re-derive the judgment.

**4. Stored result.** This is the red-then-green result recorded in the Task's frozen Proof. The Proof holds each obligation's latest evaluation, so a Task pending a retry shows its latest gap. It prints one of:

- `stored: no proof (legacy)`: the Task carries no frozen Proof;
- `stored: no red-then-green obligation`: the frozen Proof owes no I6;
- `stored: pending`;
- `stored: shown`, followed by the same three indented `red`, `first implementation write` and `green` lines as a live `shown`;
- `stored: proof:red-then-green-unproven:<gap>`: the failure kind settlement wrote to the receipt. A Proof failure other than an I6 gap reads `stored: proof:<kind>`.

Problems with the live attempt (an uninspectable sidecar set, several live attempts, an unreadable epoch, an unresolvable repository root) and an undeterminable duty each print as their own line, and the helper still exits 0. It exits 1 only on the [shared refusals](#shared-behaviour).

## Reading an attempt's ledger epoch

Use this when a red-then-green (I6) result, or a `red #3` / `green #5` reference, needs checking against what the agent actually ran and wrote. The script prints one epoch of a session's evidence ledger, or lists the session's epochs. It is a script in the Loom package, not a `helper` operation:

```bash
# List the session's epochs, with each epoch's fact count.
bun "$LOOM_DIR/scripts/ledger-epoch.ts" --session <session-id>

# Print one attempt's facts, numbered as I6 settlement numbers them.
bun "$LOOM_DIR/scripts/ledger-epoch.ts" --session <session-id> --agent <agent-id> --type <agent-type>
```

`--agent` and `--type` are given together or not at all. The session id is the Claude Code session that dispatched the Task (`CLAUDE_CODE_SESSION_ID` in the orchestrator's Bash commands).

**Which epoch is the attempt's.** An epoch is `<agentId>:<agentType>`, the same identity settlement builds with `epochOf` when it judges the attempt. The agent id is the `agentId` of the Task's implementation-attempt sidecar (`<session>.<hex agent id>.implementation-attempt.json` in the subagent directory). The agent type is the subagent type the Task was dispatched with, without its plugin namespace: `loom:code-implementer-agent` is `code-implementer-agent`. The settlement line names the Task, not the agent, and cleanup removes the sidecar once the attempt settles. When neither is at hand, run the index form first: it prints each epoch in the order it first appears in the ledger, as `<agentId>:<agentType> — <n> fact(s)`, below a `<n> epoch(s)` header.

**Positions.** The epoch view opens with `epoch <agentId>:<agentType> — <n> fact(s)` and prints one line per fact, `#<N> <Kind> …`. `N` is the fact's 0-based position in the epoch's ordered events, the same array settlement hands the I6 judge, so it is the number I6 evidence cites. If the evidence reads red `#3`, first write `#4`, green `#5`, those are lines `#3`, `#4` and `#5` here. Duplicate deliveries (the same `callId` and event recorded twice) are already dropped, exactly as settlement drops them, so the numbering never counts a fact twice. Records are printed as recorded. Nothing is reordered, escaped or truncated, and no `callId` is shown.

**How each fact reads.**

- `#N FileWrite <path> (via tool)` or `(via shell)`: a write through an edit tool, or one a shell command minted (such as `mv`, `cp` or a redirect).
- `#N FileRead <path>`.
- `#N TestRun <command>`, followed by indented detail lines:
  - `exit <code>`, or `exit none recorded` when the ledger holds no exit code for the run;
  - `no structured report` when no runner report was parsed for the run, or `report <source>: total <t>, failed <f>` when one was, followed by:
    - `per-file results not recorded` when the report carries no per-file results;
    - otherwise one line per test file, in report order: `<file>: executed <e>, failed <f>, skipped <s>`, with `, collection error` added when the file failed to collect. A report with an empty result list reads `no per-file results`.

A run that reads `exit none recorded`, `no structured report` or `per-file results not recorded` is never a qualifying run, because a qualifying run needs an exit code and a parsed report with per-file results (see [Task fails I6](../operations.md#task-fails-i6-red-then-green)). Such runs are what a `red-missing` or `green-missing` gap with `untrustedOnly: true` means: tests ran, but no run qualified. The view shows the facts; it does not mark which runs qualify.

**Where the ledger is.** The script reads `$LOOM_SUBAGENT_DIR/<session>.evidence.jsonl`, with `LOOM_SUBAGENT_DIR` defaulting to `/tmp/claude-subagents`, the same file the hooks append to and settlement reads. Set `LOOM_SUBAGENT_DIR` to read a ledger elsewhere. The SessionStart stale sweep deletes old ledgers, so read the epoch while the session's files are still there.

**Outcomes and exit codes.**

- **0**: the view was printed on stdout. An epoch with no facts prints `epoch <agentId>:<agentType> holds no facts`, and an existing ledger with no records prints `ledger holds no epochs`. Both are statements, not refusals: they mean the ledger exists and holds nothing for that query.
- **1**: a ledger refusal on stderr, with empty stdout. `ledger-epoch: no evidence ledger at <path>` names the path it looked for. A missing ledger is refused rather than read as empty, so it never looks like "the agent recorded nothing". An unreadable or corrupt ledger relays the engine's own message, `ledger-epoch: evidence ledger <path> is corrupt; refusing partial evidence: line N: <error>`. `line N` counts non-blank lines, which in practice is the physical line.
- **2**: a usage refusal on stderr, with empty stdout: the reason, then the usage line. It covers a missing `--session`, `--agent` without `--type` or the reverse, an unknown or leftover argument, and an id the engine's identity parsers reject, such as `--session ../x`. No argument can address a file outside the subagent directory.

**What it does not do.** It never judges I6: it does not say whether a run qualifies or whether the Task's red-then-green order holds. For that judgment, run [`helper red-then-green-status`](#where-does-a-task-stand-on-i6). It covers only Claude Code attempt epochs. A Pi implementation child's epoch, recorded under its parent-issued write grant, is not covered, and the script prints no machine-readable output.
