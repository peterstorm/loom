# ADR-0071: The Task mutation check names surviving mutants before the stop

## Status
Accepted (2026-11-12). Implemented in PR #160. Implements Q4 of the deterministic-implementation plan's Q-track.

## Context
A test that passes without asserting what the Task changed is the test-quality finding reviewers raise most:
a guard added with no test that makes it fire, a boundary tested on one side. Loom already finds some of
them by mutation, but late. Owner Verification (ADR-0036) mutates an Invariant's owner module at the Wave
Gate, after every Task of the Wave has settled and its implementer's context is gone. A file that owns no
Invariant is never mutated.

The implementer is the one agent that can write the missing test cheaply, and only before it stops.

## Options Considered

1. **Run the mutants inside the SubagentStop hook.**
   - Cons: the hook has 300 s, shared with the acceptance and affected-test checks and with settlement. Eight
     mutants at up to 60 s each do not fit. A stop that ran them would also have to hold the per-repository
     runner lock for minutes while sibling Tasks stop.

2. **Make it a Proof Obligation.**
   - Cons: mutation results are not deterministic evidence of completion. An equivalent mutant survives every
     test, a sibling's half-written code turns the baseline red, and a slow runner times out. An obligation
     would turn each of those into a failed attempt and a retry. It would also need a waiver grammar for
     equivalent mutants, which is a new thing to forge.

3. **An engine-added mutation Task after each implementation Task, as ADR-0068 added the Distill Task.**
   - Pros: enforceable on both harnesses, with attempt authority and settlement.
   - Cons: a fresh agent does not hold the implementer's context, which is the point. It doubles the agents
     per Task. Deferred; see Consequences.

4. **A step in the brief only.**
   - Cons: nothing observes that it ran.

5. **A helper the implementer runs, and a stop check that reads what it left (chosen).**
   - Pros: the long work happens in the implementer's own tool call, under its own timeout, where the result
     is in front of it. The stop reads one small file and runs nothing.
   - Cons: advisory. The record is a runtime file, and a stop check fails open by design (ADR-0028).

## Decision

### 1. The helper
`helper mutation-check --task <id>` is a shell around a pure core (`core/task-mutation-check.ts`).

- **Duty.** `taskMutationDuty` decides whether the Task owes the check and over which files. The helper, the
  stop check and the implementation brief all ask it. A Task owes nothing when the manifest sets
  `taskMutationCheck: "off"`, when no `affectedRunner` or no Test-File Classification is frozen, when it is
  a Distill Task (`TaskRolePolicy.taskMutationCheck`), an ADR Task or a Contract Task, or when it declares
  no mutable file.
- **Mutable files.** The Task's own `file_list` entries that are not test files by the frozen
  classification, are TypeScript or JavaScript source (never a declaration file), and lie beneath the
  runner's `cwd`.
- **Changed lines.** Each mutable file is diffed against the Task's `start_sha`.
- **Mutants.** At most 8 for the whole Task, chosen by the Wave Gate's evenly spaced selection over the
  candidates of all files in `file_list` order.
- **Runs.** Per mutated file, one isolated worktree (`withMutationWorkspace`, the Wave Gate's own): the
  frozen `affectedRunner` over that file unmutated, then once per mutant. The real workspace is only read.
- **Judgment.** Each JUnit report is judged by the affected-test stop check's judge, so a failure the Wave
  Gate excuses as expected RED is not a failure here. The runner's exit code is not read.
- **Runs.** The selection, the base read and the runner execution are the steps Owner Verification takes,
  from one shared shell module (`orchestration/mutation-run-steps.ts`), so the two checks cannot drift on
  how changed lines or runner commands are formed.
- **Output.** Each survivor on one line (`file:line:column operator: original → mutant`), then the test that
  kills a mutant of that operator.
- **Result.** One of five kinds, built only by one constructor (`taskMutationResult`) that the run's tally
  and the record parser share, so a result's kind always agrees with its counts. It counts `killed`,
  `invalid` and the survivors apart, against the `candidates` they were selected from:
  - `no-mutants`: no mutation site is on a changed line;
  - `clean`: no survivor, and the tests killed at least one mutant;
  - `survivors`: at least one mutant the tests did not kill;
  - `inconclusive`: mutants were selected and every one was invalid, so the tests judged none;
  - `unavailable`: the run could not decide.

### 2. One more operator, for Tasks only
`guard-removal` replaces an `if` with no `else` whose body only exits (`throw`, `return`, `continue`,
`break`) with an empty statement. It is first in the Task's operator order (`TASK_MUTATION_OPERATORS`). The
operator set is a parameter of candidate collection, so the Wave Gate's plan still holds exactly its six
operators and every mutant id it computed before. A test pins both.

### 3. The record
A run writes one runtime file per repository and Task, beside the stop checks' block counters. It holds the
result and a digest of the Task's `start_sha` and the bytes, or absence, of every file the Task declares,
tests included. The stop recomputes the digest; a record of other bytes is stale. The helper digests before
and after its run and records `unavailable` when the two differ. The file name holds the Task id encoded
injectively (letters, digits and `-` kept, every other UTF-8 byte written `_` and two hex digits), so no
two Tasks share a record. Only absence (`ENOENT`, `ENOTDIR`, `EISDIR`) reads as "not there", by the one
rule Owner Verification's reads use too (`utils/file-absence.ts`); any other refusal is a fault.

### 4. The stop check
The mutation check is a third arm of the one stop shell, with its own block counter, capped at 2. It runs
no runner and takes no lock.

- **Blocks** when the record is missing, stale, or names survivors. The block joins the other checks'
  sections in one message and repeats the command.
- **Passes** on a `clean` or `no-mutants` record of the current bytes.
- **Notes and proceeds** on an `inconclusive` or `unavailable` record, at the cap, and on every fault: an
  unreadable record, file or counter, a throwing observation, no repository root.
- A stop that ended with a delivered hand-back is never held, by the dispatcher's existing rule.
- On Pi the same decision is one report-only operator line.

### 5. The brief
An owing Task's implementation brief carries the command, a 600000 ms tool-call timeout, the files that
will be mutated, how to answer a survivor, and that the check's runs are not its test evidence.

### 6. Rulings
- **Cap 8, evenly spaced.** One cap for the Task, not per file.
- **Deadline 480 s.** A run launches only while the time left holds its whole timeout. Otherwise the result
  is `unavailable`. Eight mutants in eight files at the 60 s per-run limit need 16 runs and do not fit; that
  Task gets `unavailable`, not a partial answer.
- **A mutant's timeout is a kill.** The mutant changed what the tests do.
- **A red or unobservable baseline is `unavailable`,** never survivors. A sibling Task's unfinished work is
  the usual cause, and the message says so.
- **A file no test ran for** has every mutant reported as a survivor, unrun, and marked as such.
- **A mutant that only breaks collection, or runs no testcase, is no evidence.** It is counted as `invalid`,
  apart from kills, and is not a survivor. A run whose every mutant is invalid is `inconclusive`, never
  clean: a mutated file that fails to import would otherwise read as "your tests killed every mutant" when
  no test ran against one. It notes and proceeds, like `unavailable`, and its message says to check that the
  tests import the changed file and run.
- **TypeScript and JavaScript only.** The operators read the TypeScript parser's tree.
- **No waiver grammar.** An equivalent mutant is named in the implementer's final report. The cap of 2
  blocks is what lets the stop proceed.
- **`taskMutationCheck: "on" | "off"`** is an optional schema-2 manifest key, default on, frozen and
  digested only when declared, as `distillPass` is.

### 7. Shapes ruled out during implementation
- **A record keyed by agent.** The helper is a child process of the implementer's shell and is told no
  agent identity; on Pi there is no live attempt it can read. The record is keyed by repository and Task
  instead, and the digest binds it to the bytes.
- **The attempt's ledger Changed Files as the file set.** The stop has them and the helper does not, and on
  Pi the parent ledger is read only after the child ended. The Task's declared `file_list` and `start_sha`
  give the helper and the stop the same answer on both harnesses.
- **A separate decision path for the third check.** It is one more name in `STOP_CHECK_NAMES`, so the block
  decision, the counters, the cap notes and the combined message are the ones the other two checks use.
- **Loading the runner in the stop hook.** The record store is its own module, so the stop imports no
  worktree or runner code.
- **A result that counts only the mutants selected.** A `clean` result of `mutants: N` cannot tell kills
  from invalid runs, so a run that judged nothing printed and recorded "your tests killed all N mutant(s)".
  The result counts `killed` and `invalid` apart, and its kind follows from the counts alone.

## Consequences
- **Enforced within bounds on Claude Code, advisory on Pi.** Claude Code holds the stop at most twice. Pi
  settles after the child has ended, so it can only report. Enforcing it on Pi needs an engine-added Task
  after each implementation Task (option 3), which is deferred.
- **The record can be forged.** It is a file in a directory the implementer's shell can write, though
  `guard-subagent-authority` refuses the obvious write. Nothing reads it but the stop check, and it reaches
  no Proof, receipt or Wave Gate evidence, so a forged record buys only an unblocked stop.
- **Shared by a Task's attempts.** A re-dispatched attempt reads an earlier attempt's record as current
  only while the bytes are the same. Anything else that edits a file the Task declares makes the record
  stale, and the cost is one more run.
- **Changed lines are measured from `start_sha`.** They include lines changed in the Task's files by an
  earlier attempt, or by anything else since that commit. A Task with no `start_sha` is `unavailable`.
- **Undeclared files are invisible.** A file the Task changed but did not declare is neither mutated nor
  digested. The Task byte-scope check judges those writes at settlement.
- **A runner that selects no test may leave no report,** which reads as `unavailable`, not as an untested
  file. The untested-file ruling applies when the runner writes a report with no testcase.
- **Eight mutants are a sample.** A clean run is not coverage.
- **Cost.** Up to 8 mutant runs plus one baseline per mutated file, once per time the implementer runs the
  check, inside its own tool call.
- **Sweep.** The record is removed by the session-start sweep once it is an hour old. The worst case is one
  request to run the check again.
- **Owner Verification is unchanged** and stays the control over Invariant owners at the Wave Gate.
- A TaskGraph with no frozen `affectedRunner`, or frozen before the Test-File Classification existed, owes
  no Task mutation check.
