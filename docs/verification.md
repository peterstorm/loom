# Verification

What Loom runs to check a Task or a Wave, and how an operator configures it: the verification manifest, critical-repair checks, the three stop checks, owner verification at the Wave Gate, the distill pass, and Acceptance Contracts with their skeletons. The read-only views of this state are in [Helpers](reference/helpers.md#read-only-helpers).

## The verification manifest

`.loom/verification-manifest.json` is the operator's declaration of the commands Loom may run in a project: the Wave completion checks, the two stop-check runners, the test-file classification, and two switches. Task population reads the file and freezes the result into the TaskGraph. A manifest change reaches only TaskGraphs populated after it, and the digest of a TaskGraph frozen earlier never changes. With no file, the engine default applies: only the engine-reserved checks, whose ids start `loom:`.

This is Loom's own manifest, with explicit values for the three optional settings it leaves out:

<!-- wire-example: verification-manifest -->
```json
{
  "schemaVersion": 2,
  "kind": "loom-verification-manifest",
  "checks": [
    {
      "id": "project:verify",
      "scope": "wave",
      "executable": "npm",
      "args": ["run", "verify"],
      "cwd": ".",
      "timeoutMs": 1800000,
      "report": { "kind": "required-file", "path": ".loom/completion-reports/verify.junit.xml" }
    }
  ],
  "acceptanceRunner": {
    "executable": "npm",
    "args": ["run", "test:acceptance", "--", "{files}"],
    "cwd": "engine",
    "timeoutMs": 120000,
    "report": { "kind": "required-file", "path": ".loom/completion-reports/acceptance.junit.xml" }
  },
  "affectedRunner": {
    "executable": "npm",
    "args": ["run", "test:affected", "--", "{files}"],
    "cwd": "engine",
    "timeoutMs": 200000,
    "report": { "kind": "required-file", "path": ".loom/completion-reports/affected.junit.xml" }
  },
  "testFileSuffixes": [".test.ts", ".spec.ts"],
  "distillPass": "on",
  "taskMutationCheck": "on"
}
```

| Key | Schema | Value |
|---|---|---|
| `schemaVersion` | 1, 2 | `1` or `2`. Schema 1 takes only `kind` and `checks` and refuses every optional key below. |
| `kind` | 1, 2 | Exactly `"loom-verification-manifest"`. |
| `checks` | 1, 2 | The project's Wave checks; `[]` is allowed. Each check has exactly `id`, `scope` (`"wave"`), `executable`, `args`, `cwd`, `timeoutMs` (an integer from 1 through 86400000) and `report`. Duplicate ids and the reserved `loom:` prefix are refused. `report` is `{"kind":"not-required"}`, or `{"kind":"required-file","path":…}` with the path beneath `.loom/completion-reports/`. A check that critical remediation may select must use `required-file` ([Enrolling a critical-repair check](#enrolling-a-critical-repair-check)). |
| `acceptanceRunner` | 2 | Optional. The runner of the [Acceptance Stop Check](#acceptance-stop-check-claimants): exactly `executable`, `args`, `cwd`, `timeoutMs` and `report`. |
| `affectedRunner` | 2 | Optional, same form. The runner of the [Affected-Test Stop Check](#affected-test-stop-check), of the [Task mutation check](#task-mutation-check) and of [owner verification](#owner-verification-blocks-a-wave-gate)'s mutation runs. |
| `testFileSuffixes` | 2 | Optional. A non-empty list of distinct suffixes, none containing a path separator. Without it, the freeze records the engine default (`.test.ts`, `.spec.ts`, `.test.tsx`, `.spec.tsx`) as `testFiles: { source: "engine-default", … }`. The same classification decides I6's test and implementation files, the Distill Scope and the files the Task mutation check mutates. |
| `distillPass` | 2 | Optional, `"on"` or `"off"`; absent means on. Switches [the distill pass](#the-distill-pass-distill-task). |
| `taskMutationCheck` | 2 | Optional, `"on"` or `"off"`; absent means on. Switches the [Task mutation check](#task-mutation-check). |

Every key is frozen at population and covered by the manifest digest. The two switches are in the digest only when declared, so a manifest that does not declare one freezes to the digest it always had. Any other value for a switch is refused.

### Runner form

Both runners get the same form checks as a project check:

- `{files}` must be exactly one whole argument. The engine replaces it with the file paths, one argument each, written relative to the runner's `cwd`: with `"cwd": "engine"`, `engine/tests/x.test.ts` is passed as `tests/x.test.ts`.
- The executable and argv follow the project-check rules: the allowlist and no shell. The allowlist and the argv policy are listed in [Workflows](workflows.md#verification-manifest). `npx` is not on the allowlist, and `npm` must name a script (`run`, `run-script`, `test`, `check` or `build`), so Loom's `vitest related` goes through the engine's `test:affected` script. A project that calls its runner directly declares, for example, `"executable": "vitest"` with `"args": ["run", "--reporter=junit", "--outputFile=.loom/completion-reports/acceptance.junit.xml", "{files}"]` and `"cwd": "."`.
- `report` is a `required-file` beneath `.loom/completion-reports/`; the affected runner's is a JUnit report. Its path must differ from every Wave check's, and the two runners' paths must differ from each other.
- `timeoutMs` is at most 240000 for each runner, inside the SubagentStop hook's 300 s timeout. A change set touching a hub module can select thousands of related tests (Loom's own `handler-routes.ts` took 138 s). Because the affected runner launches only when the time left holds its whole timeout, its `timeoutMs` plus the acceptance run's actual duration must fit in 270 s. Loom's own manifest declares 200000, which leaves 70 s for the acceptance run.

### Installing the manifest

Direct writes to `.loom/verification-manifest.json` are blocked. Write the JSON to an unguarded temporary file and pass it through the helper, before Task population:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper write-verification-manifest < /tmp/loom-verification-manifest.json
# replace an installed manifest, still before population:
bun "$LOOM_DIR/engine/src/cli.ts" helper write-verification-manifest --replace < /tmp/loom-verification-manifest.json
```

The `helper write-verification-manifest` operation requires an existing loadable TaskGraph whose Task roster is empty. It compares authority, not bytes: a manifest that parses to the installed authority is an unchanged replay, however it is formatted. It refuses a different (or invalid) existing manifest unless called with `--replace`, which stages and atomically renames the new manifest into place, and it refuses every change after Task population, with or without the flag ([ADR-0065](adr/ADR-0065-manifest-helper-compares-authority-and-replaces-before-population.md)). Standalone remediation has no TaskGraph requirement; the helper's empty-TaskGraph requirement is a separate configuration-installation constraint.

**A manifest-only bootstrap.** The helper needs the empty TaskGraph that `init-state` creates; it is not a writer for arbitrary paths. An operator who only wants to install or inspect a manifest runs `init-state`, then the helper, then the sanctioned `cleanup-state`. Never manufacture Tasks or Waves, or hand-write state, to satisfy it (see [Workflows](workflows.md#verification-manifest)).

## Enrolling a critical-repair check

Critical remediation selects check IDs from the operator-owned `.loom/verification-manifest.json`. The selected fixed executable/argv must itself create a **new** report at the **exact** configured path on every run. The file must be a fresh parseable JUnit XML or Vitest/Jest JSON report beneath `.loom/completion-reports/`, remain untracked, and be Git-ignored. A normal process exit is insufficient: the parsed report must show more than zero executed tests, zero failures, and not an all-skipped run.

Before each selected critical check launches, the engine proves that exact literal report path is Git-ignored and untracked, then removes any old regular file through the anchored parent capability using no-follow: Linux unlinks through the retained parent descriptor; macOS re-proves the parent's whole path (`O_NOFOLLOW_ANY` plus identity) immediately before the unlink and refuses a planted-symlink parent with ELOOP (both reports survive a redirect attempt). Darwin retains the documented proof-to-use gap shared by every anchored leaf mutation. Only ENOENT counts as absence; directories, symlinks, and permission failures fail before launch with `required report reset failed before launch`. Merely touching seeded green bytes cannot pass. A newly written report may have identical bytes to the previous report. Zero-critical remediation launches no check, and Wave report freshness behavior is unchanged.

Strict reports are capped at **8 MiB (8,388,608 bytes)** and actual XML element depth **128** (root depth 1, including diagnostic elements). Structural XML parsing rejects malformed documents and DTDs; comments/CDATA do not create tests. Capture, persistence, and base64 replay enforce the report byte bound before oversized allocation/decoding. V2 remediation additionally caps each encoded event file at **12 MiB**, the aggregate encoded journal at **64 MiB**, and the journal at **1024 records**. These limits apply to retained-event reads, append reconciliation/new appends, and CLI inspection's event-tail read, before oversized file decoding/JSON parsing; enumeration is bounded too. They are not blanket limits on every Run artifact/checkpoint, or a claim that decoded heap usage equals encoded bytes. Legacy/default journal consumers retain their existing policy.

These are fresh structured engine observations, **not semantic proof**: an operator-owned fixed command can still fabricate a syntactically valid new report. Neither process success nor a report digest proves that tests exercised the declared invariant, root cause, sibling completeness, or Historical RED.

Enrolling a check makes it selectable for critical remediation. It does not establish a passing check.

## Stop checks

When an implementation agent stops, the engine runs up to three checks before it settles the Task, in this order: the Acceptance Stop Check, the Affected-Test Stop Check and the Task mutation check. Each can keep the same agent working. None is completion evidence, and on Pi each only reports. To see what the first two would run for a Task, print its [Stop-Check Plan](reference/helpers.md#what-will-the-stop-checks-run-at-a-tasks-stop).

### Acceptance Stop Check (claimants)

When an implementation agent that claims a frozen Acceptance Contract's Requirement tries to stop, the engine runs that contract's acceptance files before settling the Task. If a testcase the agent owes is still not passing, the stop is blocked and the same agent keeps working with the failures in front of it. A testcase is owed when it decides one of the agent's claims and all its anchors are due by the Task's Wave.

- **Opt in** by declaring an `acceptanceRunner` in the [verification manifest](#the-verification-manifest). The runner is frozen at population, like the project checks.
- **The command.** The engine replaces `{files}` with the acceptance file paths ([runner form](#runner-form)). An owed file outside the runner's `cwd` cannot be named, so the check notes it and does not decide.
- **Silent when off.** With no runner, or no owed testcase, the check does nothing and says nothing.
- **Fails open.** In each of these cases the stop proceeds, the operator gets a `systemMessage` saying why the check did not decide, and the orchestrating session gets the same note (see [Stop-check notes reach the orchestrator](#stop-check-notes-reach-the-orchestrator)):
  - another claimant's check holds the runner;
  - the runner cannot start or finish, times out, or is killed by a signal (a killed runner's report is partial, so it is not judged);
  - the report is missing or changed;
  - the report has no testcase of the acceptance files;
  - the block counter cannot be read;
  - the agent has reached its 3-block cap;
  - the check itself fails.

  A runner lock that will not release is appended to the note, or turns a pass into a note.
- **One run per repository at a time.** Every claimant shares the runner's one report path, and the runner resets that file before each launch. Checks are therefore serialized by a lock under the subagent directory. If a claimant stops while a sibling's check is running, its own check does not run, and the Wave Gate judges that claimant. A lock whose holder process has exited, or that is older than the longest permitted run plus 60 s, is reclaimed. Reclaiming renames the lock aside and deletes it only if it still holds the stale bytes. If another stop reclaimed it first and took a fresh lock, the renamed lock is linked back and this stop does not run.
- **Cap.** An agent is blocked at most 3 times; its next stop proceeds with a `systemMessage` naming the cap. The count is kept per spawned agent under the subagent directory, never in the TaskGraph, and is cleared once that agent's stop proceeds.
- **Not completion evidence.** Nothing is recorded as a test result or proof; the Wave Gate's completion suite stays the only authority.
- **Pi is report-only.** Pi settles after the subagent has ended, so the outcome is an operator note and part of the subagent result the parent model reads. It never blocks.

### Affected-Test Stop Check

Whenever any implementation agent stops, claimant or not, the engine runs the tests affected by the files that agent changed (I7). It runs them through the operator-declared `affectedRunner`, after the Acceptance Stop Check. If an affected test fails, the stop is blocked and the same agent keeps working, with each failing test and its file in front of it.

- **Opt in** by declaring an `affectedRunner` in the [verification manifest](#the-verification-manifest), and `testFileSuffixes` when the default suffixes do not fit. Both are frozen at population and covered by the manifest digest.
- **Changed files.** The changed files are the attempt epoch's ledger `FileWrite` paths, deduplicated in first-write order. Paths outside the repository are dropped, and so are paths absent at stop time, such as a deleted file. A renamed file appears under its new path, because a literal `mv`, `git mv` or `cp` mints a write for its destination. Only files beneath the runner's `cwd` are passed. Each is one argument, written relative to the `cwd`. A file written with no ledger event, for example by an interpreter or a generator, is not a changed file.
- **Silent when off.** With no `affectedRunner` frozen, the check does nothing and says nothing.
- **Fails open.** In each of these cases the stop proceeds, and a note names the cause to the operator (`systemMessage`) and to the orchestrating session:
  - no changed files, or none beneath the runner `cwd` (the note lists the files outside it);
  - the command cannot be formed for the changed files;
  - the runner cannot start or does not complete;
  - the runner times out or is killed;
  - the runner leaves no readable report;
  - another stop holds the runner lock;
  - the repository root is unavailable;
  - the block counter is unreadable;
  - the agent has reached its 3-block cap;
  - the check crashes.

  A report with zero testcases passes, and the stop notes it.
- **Expected-RED acceptance failures do not block.** A contract Wave writes acceptance tests that must fail until later Waves implement them, and an affected run can select them. The check excuses exactly the failures the Wave Gate excuses, by the same rule: a collected failure in an owed contract's acceptance file during the contract's Wave, or after it while every anchor the testcase names is still pending. When those are the only failures, the stop proceeds with a note naming them (`its only failing tests are acceptance tests this Wave expects to fail`), and no block is counted. When other tests also fail, the stop blocks for those alone, and the block message lists the excused acceptance failures under `Not blocking — acceptance tests this Wave expects to fail (the Wave Gate's rule):`. An acceptance file that fails to collect, a due or unanchored acceptance testcase, and a contract whose RED was never observed still block.
- **Budget.** Both checks run inside the SubagentStop hook's 300 s timeout, minus a 30 s reserve for settlement. The affected runner launches only if the remaining time holds its whole `timeoutMs`. Otherwise the stop notes that the budget was exhausted. The timeout is never clipped.
- **One lock, one message.** The acceptance check and the affected check run in sequence under one acquisition of the per-repository runner lock described above. Each report is read back digest-checked while the lock is held. When both checks fail, the agent gets one block message with an `## Acceptance stop check` section and an `## Affected-test stop check` section. Under the affected heading, each failure reads `- '<name>' (<file>) — failed` or `- '<name>' (<file>) — failed to collect`.
- **Separate caps.** Each check has its own per-agent counter (`*.acceptance-stop-check.json` and `*.affected-stop-check.json`), each capped at 3 blocks. A check's counter increases only when that check contributes failures to a block. Both counters clear when the stop proceeds.
- **Not completion evidence.** No affected-run fact reaches settlement, proof, receipts or Wave Gate evidence. A test proves this by settling the same Task under every affected outcome and finding byte-identical proof and receipts.
- **Pi is report-only.** The Pi parent runs both checks over the child's epoch in the parent ledger after the child has ended, and reports the outcome as below. It never blocks.
- **A handed-back agent is never blocked.** A Claude Code subagent that ends its turn with a delivered `SubagentHandback` has finished: the harness does not keep it working, so a block would only drop the stop's settlement and leave the Task stranded with live authority. When a check would block such a stop, the dispatcher reads the agent's transcript (`claudeFinalTurnHandedBack`), turns the block into a note (`… cannot be held open: it settles now, and the Wave Gate judges the Task.`) and settles. A failed or unanswered handback, a legacy final text, or a transcript it cannot read keeps the block.

### Task mutation check

While an implementer still holds its context, it can ask the engine which of the lines it changed its tests do not answer ([ADR-0071](adr/ADR-0071-the-task-mutation-check-names-surviving-mutants-before-the-stop.md)). The implementation brief tells it to, with the exact command and the package path filled in:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper mutation-check --task T5
```

The brief asks for one Bash call with a 600000 ms timeout, after the Task's tests pass and before its final verification run.

- **What it does.** For each TypeScript or JavaScript implementation file the Task declares (not a test file by the frozen `testFileSuffixes`, not a `.d.ts`, beneath the `affectedRunner`'s `cwd`), it diffs the file against the Task's `start_sha`, plans mutants on the changed lines, and keeps at most 8, evenly spaced over all the files. Per mutated file it opens one isolated worktree outside the repository, runs the frozen `affectedRunner` over the file unmutated, then once per mutant. The real workspace is only read.
- **Operators.** The Wave Gate's six, preceded by `guard-removal`: an `if` with no `else` whose body only exits (`throw`, `return`, `continue` or `break`) is replaced by an empty statement. The Wave Gate's Owner Verification keeps its six operators and its mutant ids unchanged.
- **What it prints.** One line per survivor: `- <file>:<line>:<column> <operator>: \`<original>\` → \`<mutant>\``, then `killed by:` and the test that kills a mutant of that operator. A file for which no test ran has every mutant reported as a survivor, marked `(no test ran for this file)`. A run with no survivor prints `clean`. The implementer adds the test and runs the check again, or names an equivalent mutant and says why in its final report. There is no waiver syntax.
- **`unavailable` never blocks.** The run does not decide when the unmutated tests fail (a sibling Task's half-written code is the usual cause), a run leaves no readable report, the runner cannot start, the worktree cannot be made, the Task records no `start_sha`, a file does not parse, the Task's files change while it runs, or its 480 s deadline cannot hold another run. A mutant whose run times out counts as killed.
- **The record.** The result is written to the runtime directory (beside the stop-check block counters) as `task-mutation.<repository hash>.<task id>.json`, with a digest of the Task's `start_sha` and the bytes of every file it declares, tests included. Any later edit to one of those files makes the record stale. It is not in the TaskGraph, and nothing reads it but the stop. Like other unsessioned runtime files it is removed by the session-start sweep once it is an hour old, after which the check reads as not run.
- **At the stop.** The third stop check reads the record; it runs no runner. On Claude Code it blocks the stop, at most 2 times per agent, when the record is missing, stale, or names survivors. The block appears under `## Task mutation check`, joined with the other two checks' sections when they also fail, and repeats the command. After 2 blocks the stop proceeds with a note. An agent that ended with a delivered hand-back is never blocked. Every fault (unreadable record, unreadable file, unreadable counter, no repository root) is a note. On Pi it is report-only, like the other two.
- **Not completion evidence.** Nothing the check observes reaches Proof, receipts or the Wave Gate. Its runner executions happen inside the helper, in a worktree, so the ledger records the one `helper mutation-check` call as an ordinary command: no test run, no file write. The implementer's own final verification run is still what its Proof reads.
- **Who owes it.** Every implementation Task of a TaskGraph that froze an `affectedRunner` and a test-file classification, except a Contract Task, an ADR Task and a Distill Task, and except a Task with no mutable file. `helper mutation-check` on a Task that owes nothing prints `not owed — <reason>` and exits 0.
- **Turn it off** for a project with `"taskMutationCheck": "off"` in the [verification manifest](#the-verification-manifest).
- **Limits.**
  - The record is a file an implementer's shell could write by hand. The check is advice to an agent that wants its tests to be good, not a control against one that does not.
  - Only TypeScript and JavaScript are mutated. A Task whose implementation files are all in another language owes nothing.
  - "Changed lines" are every line that differs from `start_sha`, so they include lines an earlier attempt or another Task changed in the same file since.
  - Files the Task changed but did not declare are neither mutated nor digested.
  - The 8 mutants are a sample. A clean run does not show that every changed line is tested.
  - Each mutant's run is limited to the `affectedRunner`'s `timeoutMs`, capped at 60 s as at the Wave Gate.

### Stop-check notes reach the orchestrator

A stop check that fails open, or reports only, leaves a note naming the cause. That note is the only trace of a check that did not decide, so it goes to the orchestrating session as well as the operator.

- **Claude Code.** A SubagentStop `systemMessage` reaches the operator's terminal but never the orchestrating model. So the dispatcher also writes the note to `<LOOM_SUBAGENT_DIR>/<session>.<agent>.stop-check-note.json` before settlement, so a settlement failure cannot lose it, and names it in any settlement or cleanup error. The `surface-stop-check-notes` PostToolUse hook on the orchestrator's `Task`/`Agent` calls takes every note of its session, deletes each one, and adds them to the model's context as `additionalContext`, under the heading "Loom stop checks did not decide, or reported only, for these Tasks". It also shows them to the operator.
  - A foreground spawn's note is waiting when its call returns.
  - A background spawn's PostToolUse fires at launch, before its stop, so its note arrives with the next `Task`/`Agent` result.
  - A claimed sidecar is renamed before it is read, so concurrent hooks never deliver a note twice. An unreadable sidecar is named once and removed. An undelivered note is swept with the other runtime files after the stale-subagent TTL.
  - The shim skips the bun spawn when no note sidecar exists at all.
- **Pi.** The parent settles after the child has ended. Each report line goes to the operator through the extension's operator sink: to the UI when there is one, otherwise to stderr as a `[loom]` line. The lines are also appended under the same heading to the subagent tool result the parent model reads. When settlement raises processing errors, the notes follow the error text that replaces the result.

### Pi evidence ledger recorder

A Pi implementation child records its own tool calls into the parent session's evidence ledger, under the epoch of its parent-issued write grant. It uses the same minting rule as Claude Code's PostToolUse recorder (`machine/tool-evidence-recorder.ts`), so red-then-green (I6) settlement and the affected-test (I7) stop check on Pi read the same kind of facts as on Claude Code.

- **Ledger address.** The parent puts the ledger address (its session and the spawn item's agent type) into the grant at spawn. The grant MAC binds it.
- **No valid grant, no record.** A child with no grant, a rejected grant, or a binding that survives only as cleanup debt records nothing. It prints one stderr note per reason. Plain Pi sessions and the parent stay quiet.
- **Exit codes.** Pi 0.83 and 0.84 expose no bash exit code. The recorder reads an error result as exit 1 and a clean one as exit 0. A result ending in Pi's abort or timeout status line counts as interrupted.
- **Plan view.** `helper stop-check-plan` cannot resolve a Pi child's epoch from a separate process, so for a Pi run it shows no changed files.
- **No live gate.** The live phase gate is still absent on Pi; only recording was added.

## Owner verification blocks a Wave Gate

A plan's owned invariants (`**Owner module:**` a path) are Wave Gate obligations. Population stamps each one into the TaskGraph as an Owner Obligation (`owner_obligations`, written on every population, `[]` included). Whenever that stamp is present, the Wave completion suite carries the engine-reserved check `loom:owner-verification`. A graph populated before owner enforcement existed has no stamp, owes nothing, and its suite roster and digest are unchanged.

**What the check does, in order:**

1. **Plan integrity, every Wave.** It re-reads the plan the graph names (`plan_file`) and re-derives the obligations. It blocks, as infrastructure, on a missing `plan_file` or an unreadable plan (`plan-unreadable`), on strays or malformed ownership (`plan-malformed`), and on any difference from the stamp (`plan-drift`). This runs even when the Wave owes nothing; then the check records `verified` with no verdicts.
2. **Scope.** It owes coverage and mutation only for the owned invariants the Wave owes: the owner is due (see step 3), and some Wave Task other than a contract Task has the owner or a sibling in its `file_list`. A contract Task writes at most a compiling stub, so its change owes nothing; verification starts with the first Wave whose implementation Task changes the family. A Wave that touched only the matrix test owes nothing; unowned invariants are never checked.
3. **Sibling coverage**, per owed invariant: the matrix test's direct imports, followed through `export … from` re-exports and resolved through relative paths and the matrix test's tsconfig `paths`, must include every family path due by the Wave. A path is due when no Task lists it (it exists already) or a Task of this Wave or an earlier one does; a sibling only a later Wave lists is not yet required. A due path the imports do not reach still blocks. Type-only edges (`import type`, `export type … from`, and imports or re-exports whose every specifier is `type`) are erased at runtime and never count.
4. **Mutation verification**, per owed invariant without a mutation exemption:
   - the Wave base is the `start_sha` of the Wave's implementation Tasks listing the owner, never a contract Task's (their octopus merge-base when several); the owner's lines changed since then are the only mutation sites, so lines a contract Task's stub wrote are part of the base;
   - the owner is parsed with the script kind its extension names (`.tsx`/`.jsx` with JSX), the same rule the coverage import graph uses; an owner with syntax errors blocks as `owner-unparseable` instead of being mutated from a recovered tree;
   - six fixed operators (condition negation, comparison flip, logical swap, boolean-literal flip, return-value replacement, expression-statement removal) generate a deterministic set of at most 24 mutants, evenly spaced over the candidates; the rest are reported as unmutated;
   - one detached git worktree per invariant holds HEAD plus every changed, untracked and deleted path of the real workspace, with `node_modules` shared by symlink; it is removed afterwards whatever happened;
   - the matrix test runs first unmutated (the baseline), then once per mutant, through the frozen `affectedRunner` with the matrix test as its only file and a per-run limit of 60 s, clamped to the runner's own `timeoutMs`;
   - the runner's JUnit report decides: a failing testcase kills, a timeout kills, collection or import errors only make the mutant invalid, an all-passing report with exit 0 means it survived. A run whose every generated mutant is invalid carries no mutation evidence and blocks as `no-valid-mutants`.
5. **Isolation proof.** The real workspace's digest is taken before and after; any difference blocks (`real-workspace-changed`).

The reported time bound is Σ over owed, non-exempt invariants of (1 baseline + selected mutants) × the per-run limit.

**Prerequisite.** Mutation runs through the operator's frozen `affectedRunner` (see [the verification manifest](#the-verification-manifest)); its report must be JUnit. Population refuses a plan with a non-exempt owned invariant and no `affectedRunner` (`owner-verification-runner-missing`). An exempt invariant needs no runner. Population refuses a plan whose matrix test first lands after the first Wave that owes its family (the gate would have no matrix test to run there). Population also refuses an owned invariant whose path plays two roles (the owner listed as a sibling, the matrix test as the owner or a sibling, a sibling listed twice) or an invariant owned twice (`invalid-owner-obligations`); the State File parser refuses such a stamp too.

**Reading the result.** `helper orchestration status` (human and `--json`, one status document) reports, per owned invariant of the latest completion result:

- coverage: pass, or the missing paths, or the infrastructure failure;
- mutation: the counts generated, killed, timed out, invalid, survived and unmutated; or the declared exemption and its reason; or the infrastructure failure;
- the time bound.

In `--json`, `ownerVerification` is the persisted observation itself: `{ "kind": "verified", "obligationsDigest", "boundMs", "verdicts": [ { "invariant", "title", "owner", "matrixTest", "coverage": { "kind": "covered" | "missing" | "infrastructure", … }, "mutation": { "kind": "verified" | "exempt" | "red-baseline" | "infrastructure", … } } ] }`, or `{ "kind": "unavailable", "failure" }`. A verified mutation half carries `survivors`; the survived count is their number.

With no owner verification to report, status says `not observed` and why (`--json`: `{ "kind": "not-observed", "reason": … }`), with exactly one of these reasons: `no persisted completion result`, `the persisted completion result carries no owner verification`, or `the persisted completion result is unavailable: …`.

When the suite rejected the Wave and the owner check contributed findings, the next action names each invariant and its remedy. The rejection itself carries those lines (`ownerVerificationRemedies` on the completion-suite readiness fact), and the gate's own diagnostic prints the same lines, so the two always match.

**Remedies:**

| Finding | Meaning | Remedy |
|---|---|---|
| missing siblings | the matrix test's imports do not reach the named owner/sibling paths, each due by this Wave | strengthen the matrix test to import each named path (directly, or through a re-export barrel); importing a module that itself imports the owner does not count. Siblings only a later Wave lists are never named |
| red baseline | the matrix test fails against the unmutated workspace, so no mutant ran | fix the failing testcases the diagnostic names |
| survivor | a mutant at `<owner>:<line>:<column>` (`<operator>`, original and mutated text shown) was not killed | strengthen the matrix test to kill it, or declare a mutation exemption with a reason on the invariant |
| `plan-unreadable`, `plan-malformed` | the named plan cannot be re-read, or it has strays or malformed ownership, or an owned invariant names a path in two roles | restore the plan file; fix the named declaration |
| `plan-drift` | the plan's owned invariants differ from the stamp, or a named owner is not a file in the workspace (the stamp names a path the Wave no longer has, so the stamp, not the filesystem, is what is out of date) | restore the plan's owned invariants (or the owner file), or re-populate the TaskGraph from the plan |
| `alias-config-unresolvable` | the matrix test's import graph cannot be resolved because the tsconfig that governs it does not parse, or has a malformed `extends`, `baseUrl` or `paths`; the plan itself is fine | fix the tsconfig/path alias configuration the detail names (the nearest `tsconfig.json` above the matrix test and its `extends` chain); re-run the gate |
| `runner-missing` | the frozen manifest has no `affectedRunner`, or it cannot run the matrix test | install the runner and re-populate, or exempt the invariant |
| `missing-wave-base` | a Wave Task listing the owner records no `start_sha`, or the base or the owner at it cannot be read, or the owner at the base is not a regular-file blob (a symlink, a gitlink or a directory: its bytes are not the owner's text, so the changed lines cannot be trusted) | make the recorded base commit reachable (fetch full history); a Task with no `start_sha` gets one when its implementation is dispatched; for an owner that was not a regular file at the base, name the real module as the owner, or declare a mutation exemption with a reason |
| `spawn-failed`, `report-missing`, `report-unreadable`, `matrix-test-not-collected`, `exit-unexplained-by-report`, `baseline-timed-out` | the runner could not give a trustworthy JUnit verdict for the matrix test | fix the runner (it must write a fresh JUnit report naming the matrix test's file, and exit 0 when it passes) or the matrix test's runtime; raise the runner timeout for a slow baseline |
| `worktree-failed` | the isolated copy could not be set up or removed, or failed during a run (the detail names a leftover worktree when a failed run also could not clean up) | check disk space, `git worktree list`, and stale worktrees (`git worktree prune` runs on each removal); remove a named leftover directory; re-run the gate |
| `coverage-bound-exceeded` | the matrix test's import walk read more than 512 files | import the entry points more directly |
| `owner-unparseable` | the owner module has syntax errors (the detail lists them as `line:column message`), so its mutation sites cannot be trusted | fix the syntax errors in the owner; a `.tsx`/`.jsx` owner must carry that extension to be parsed with JSX |
| `no-valid-mutants` | mutants were generated, but every one only failed to collect (a collection or import error), so the matrix test gave no mutation evidence | fix what makes the mutated owner fail to load in the matrix test (an import-time side effect, a module-level throw), or declare a mutation exemption with a reason |
| `repository-file-unreadable` | a file the check must read (a matrix test, an import it reaches, a tsconfig, the owner) exists but the filesystem refused it: `EACCES`, a symlink loop (`ELOOP`), `EIO`, `EMFILE`, `ENAMETOOLONG`; the detail names the path and the error. It is never reported as a missing sibling | fix the named path's permissions or link, free file descriptors, or shorten the path; re-run the gate |
| `real-workspace-changed` | the real workspace digest differs after the run, or could not be observed (the observer failed or threw) | find what changed the workspace during the gate (a parallel writer) and re-run |
| `unexpected-error` | a step built to return its failure as data threw anyway (an engine defect or an unanticipated exception), or an injected owner runner threw; the detail names the step and the error. The workspace digest is still compared, so a changed workspace reports `real-workspace-changed` instead | re-run the gate; if it repeats, report it with the detail, which names the throwing step |

Every infrastructure failure blocks and never counts as a kill. A rejection whose only infrastructure failures are the owner check's, with no semantic failure, is published as an attempt record beside the result slot (`completion-suites/<suite>/<workspace>.owner-infrastructure/<sha256>.json`), so the evidence persists and a retry at the same workspace runs the check again. There is no automatic retry: re-run the Wave Gate. A rejection that also carries a semantic failure is published in the result slot and replays as rejected.

**Declaring a mutation exemption after population is plan drift.** The exemption is part of the stamped obligation, so adding `**Mutation exemption:** <reason>` to the plan mid-flight makes the next gate block with `plan-drift` until the TaskGraph is re-populated, which resets every Task to `pending`. Prefer strengthening the matrix test; decide exemptions in the architecture phase.

**Limits, stated honestly:**

- A runtime import is proof of load, not of exercise. A matrix test that imports a sibling but never drives the rule through it passes coverage. A type-only import is erased at runtime and is not even proof of load, so it never counts.
- Mutation covers the owner's lines changed in the Wave only: never siblings, never unchanged lines, never other files. A Wave that changed only a sibling runs the baseline and zero mutants (`owner unchanged in Wave`). A changed line with no construct the six operators rewrite yields zero mutants and says so.
- Invalid mutants are neither killed nor survived; status and the verdict show the invalid count. A run whose every generated mutant is invalid blocks as `no-valid-mutants` (infrastructure, never a pass or a kill).
- A matrix-test-only change does not trigger coverage or mutation.
- Reviewers get the owner map and second-copy rule only in Wave review packets of the code-reviewer and architecture-tech-lead for Tasks touching an owned family. Such a Task is issued six reviewers, not five: architecture-tech-lead (profile `focused-review`, Skill `deepen`) is appended after the base five, and the Wave does not complete until it settles too (ADR-0047). A Contract Task whose contract declares a types file is issued the same six for its own reason (see [The Contract Task's review judges the contract surface](#the-contract-tasks-review-judges-the-contract-surface)); every other Task keeps exactly the base five. An identical second copy is advisory; whether a copy diverges is the reviewer's judgment, checked by the Refutation Panel. Standalone reviews carry no owner map.

## The distill pass (Distill Task)

Population adds one engine-owned Distill Task to every Wave that has implementation files ([ADR-0068](adr/ADR-0068-the-distill-pass-is-an-engine-added-task-per-wave.md)). A fresh `distill-agent` runs the `distill` skill in apply mode over the files the Wave's other Tasks implemented, before the Wave Gate reviews them. A decompose payload cannot author one: `validate-task-graph --decompose-payload` and `populate-task-graph` both refuse a Task whose agent is `distill-agent`.

**What you see.**

- `populate-task-graph` names what it added: `Task graph populated: 5 tasks (2 engine-added distill pass: T4, T5), waves: 1, 2`. Each Distill Task is numbered after the highest authored Task id, has no dependencies and no Requirement trace, and its `file_list` is its Distill Scope: the Wave's implementation files, never a test file and never an Acceptance Contract's frozen path.
- `helper orchestration status` lists the Distill Task among its Wave's pending Tasks from the start, but does not offer its dispatch while any other Task of the Wave is not yet `implemented` or `completed`, or still holds a reservation. Once they have all settled, it is the one dispatch status offers. Dispatch it from status like any other dispatch (`helper orchestration brief`); the Wave Gate cannot start before it settles.
- A spawn attempted early is refused at registration, on both harnesses: `T9 is its Wave's distill pass and runs after every other Task of the Wave is implemented; still outstanding: T1`.
- Its brief carries a `LOOM_DISTILL_PASS: 1` appendix that lists its files and replaces the implementation workflow. The spawn gate compares the appendix line for line with the Task's protected file list.
- At the Wave Gate it is registered with its Wave and issued no reviewer. Its review status reads `not required (exempt from Wave review: distill-task)`; the other Tasks' Review Packets read the distilled bytes. `helper store-review-findings --task <its id>` is refused for the same reason.

**How it settles.** Its Proof holds two obligations, `task-completed` and `behaviour-preserved`. The evidence of the second records which basis held:

| Basis | Meaning |
|---|---|
| `unchanged` | The pass left every file as it found it. No test run is owed. |
| `tests-passed` | The pass changed files, a trusted passing run follows its last edit, and no changed file breaks a frozen signature. |
| `restored` | The pass changed files and could not prove it preserved behaviour, so the engine wrote every file back. `after` lists the failure kinds that caused it, for example `"after": ["proof:regression-tests-failed"]`. |

- A restored pass settles `implemented`: its edits are gone, the Wave loses nothing, and no retry is dispatched. Read `after` to see what the pass could not prove.
- A write outside its file list is not restored, because the engine holds no bytes for it. It fails the attempt as it does for any Task: one retry, then escalation.
- A restore that fails, or that leaves a file differing from what the attempt started with, settles `infrastructure-blocked`. The message names the Git tree that still holds the attempt's starting bytes, `refs/loom/distill/<authority digest>`.

**Reopening.**

- `reopen-task` on any other Task of the Wave also returns the Wave's `implemented` Distill Task to revalidation, so the re-implemented code is distilled again. The command says so (`The engine reopened T9 with them: …`), and the audit lists T9 among `reopenedTaskIds` and again under `sweptDistillTaskIds`. Naming the Distill Task alone reopens only it. Naming it together with a sibling records no sweep.
- A Contract Revision returns it with the current Wave's implemented claimants.
- `reopen-completed-wave` derives a Task set that includes the Wave's Distill Task whenever it includes a sibling, and your exact payload must name it too (`reopening taskIds must exactly equal engine-derived …`). The audit marks it under `sweptDistillTaskIds`: it returned with a sibling and was never itself proven drifted.

**Requirement trace rosters.** The exact-roster JSON for `amend-spec-trace` covers every Task of the graph, Distill Tasks included, each as `{"id":"T9","spec_anchors":[],"spec_contributions":[]}`. A roster that leaves one out is refused as `roster is stale or partial; missing existing Tasks: T9`. A Distill Task never carries a trace: the State File refuses to load one that does.

**Claude Code and Pi.**

- On Claude Code, `machines/distill-agent.machine.json` denies Edit, Write and MultiEdit until one test run has passed with a parsed report: the skill's "green baseline first" rule. After that, edits and test runs are free.
- A Pi child runs without the live phase gate, so on Pi that rule is prose in the brief and the agent definition only.
- Settlement is the authority on both: it compares the files with the attempt's starting bytes and reads the test evidence from the ledger.
- Pi needs the rendered `distill-agent` definition before a Wave with a Distill Task can be dispatched: run `scripts/sync-pi-agents.sh`, then `/reload`.

**Turning it off.**

- Opt out for a project with `"distillPass": "off"` in the [verification manifest](#the-verification-manifest).
  - It reaches only TaskGraphs populated after it. To drop the Distill Tasks of a graph that has not started, set the key and re-run `populate-task-graph`: every population replaces the whole roster.
- Some Waves get no Distill Task whatever the key says:
  - A Wave whose Tasks list no implementation file. Test files (by the frozen `testFileSuffixes`) and an Acceptance Contract's frozen paths are never in a Distill Scope.
  - A Wave that holds only ADR Tasks or Tasks that write an Acceptance Contract. Their files are not distilled.
  - Every Wave of a TaskGraph whose verification manifest froze no test-file classification: a graph frozen before the classification existed, or one with no manifest. `populate-task-graph` says so in one line: `No distill pass: the verification manifest froze no test-file classification, so no Distill Scope can be derived and no Wave gets a Distill Task.`

## Acceptance Contracts

### The Contract Task's review judges the contract surface

A Contract Task's Wave review is the last review before any dependent Task implements against the contract's types file. When the contract declares a types file (not `**Types file:** none`) and the Wave Gate runs the current reviewer protocol (schema 2), that review changes in two ways (ADR-0069):

- **Six reviewers, not five.** `architecture-tech-lead` (profile `focused-review`, Skill `deepen`) is appended after the base five, exactly as for a Task touching an owned family. The Wave does not complete until it settles. A Task that is both is issued six, not seven.
- **One more packet section.** The `type-design-analyzer` and `architecture-tech-lead` packets of that Task carry a `contract-surface` section: each contract's id, title, statement, types file, `<plan file>#CT-n` and bound exports, then what to judge (states the types can represent that the statement forbids, primitive obsession, module shape and seams, duplicate policy across the bound exports) and that a defect is cheapest before the freeze. The Task's other four packets, every other Task's packets and the spec-check packet are byte-identical to a graph without the contract.

Nothing else moves: slot and request ids of the base five are unchanged, findings follow the existing severity rules and the Refutation Panel, and a critical finding on the types file blocks the contract Wave like any other. Fixing it there is an ordinary Task Reopening; after the freeze it is a Contract Revision (next section).

**A run in flight across an engine upgrade.** A Review Run that was installed with five reviewers on such a Task, before the engine issued the sixth, keeps its five and its issued packets and settles as issued. The limits:

- A Contract Task whose review already finished (no Review Run left) inside a Wave Gate that is still open derives six reviewers on the next resume, because a finished review records no roster. The five-reviewer batch on disk no longer matches that roster. If the gate then blocks or re-issues requests for that Task, abandon the run and start a fresh Wave Gate; the Contract Task is then reviewed by all six.
- A Contract Task that also touches an owned family already had six reviewers, so its installed roster does not say whether its packets carried the section. Its in-flight run continues on the packets it was issued. A batch that has to be re-derived (a crash part-way through publication) is re-derived with the section and differs from the issued one. Recover the same way.

### A frozen acceptance test or contract types file is wrong

An Acceptance Contract's frozen paths (its types file and acceptance tests) change only through an operator Contract Revision. A Wave Gate that finds them changed blocks with `frozen acceptance drifted: CT-n '<path>' changed`; a claimant that finds a frozen test wrong stops and reports it. Either restore the frozen bytes, or edit the frozen files yourself and record the revision:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper revise-contract \
  --contract CT-1 --reason "AS-003 asserted the wrong error variant"
```

The helper hashes the frozen paths as they are now, then commits under the TaskGraph lock. It refuses, without writing, when:

- the arguments are not exactly `--contract CT-<n>` and a non-blank `--reason` of at most 512 characters;
- the contract is not in the TaskGraph, or the graph is not in the execute Phase;
- any Task is executing or a subagent is active;
- a Wave Gate is live — abandon it with `helper orchestration abandon` first; an abandoned tombstone is accepted and retired;
- the contract is still `awaiting-red`: its contract Task owns the files until its Wave Gate observes them red;
- the contract Wave has not completed;
- any Task claiming a covered Requirement sits in a completed Wave — that Wave was verified against the old bytes, so reopen it first ([`helper reopen-completed-wave`](reference/recovery.md#completed-wave-has-post-review-workspace-integrity-loss));
- a frozen path is missing or unreadable (the refusal names the read error, e.g. a symlink the no-follow read refuses), or the bytes did not change;
- the contracts changed between the helper's observation and its lock, so it never read a path the locked contract freezes (`observation-stale`) — retry.

On success, one locked write:

- sets the freeze to `revised` with the new digests and appends a numbered revision (reason, previous and new digests, revalidated Task ids) — the old bytes stay auditable;
- returns the current Wave's `implemented` claimants to `pending` with `revalidation_required`, keeping their proof and incrementing their review generation, exactly as a reopened Wave does — re-spawn them before starting the Wave Gate;
- retires the current Wave's review and suite authority (`active_wave_completion_suite`, review runs, the Wave's spec-check) and resets its `tests_passed` and `reviews_complete` — and its `impl_complete` too when any claimant was returned to revalidation.

The next Wave Gate judges the contract green against the new bytes and re-records its roster, which freezes it again.

Before that locked write, the helper also settles the contract's engine-written **Skeletons** (below). It re-resolves the contract's **Export Bindings** against the revised types file, then, for each recorded skeleton of the contract:

- an untouched one (its bytes still equal the digest the engine wrote, or the canonical bytes) is refreshed in place to the revised signatures, through the writer's digest-guarded replace, and re-recorded with origin `revision` — printed as `skeleton refreshed <path> from the revised types`;
- a modified one is left exactly as it is and flagged stale — printed as `skeleton <path>: stale against revised contract (modified, left as it is)`. Status and the brief show the flag; completion still enforces the revised aliases on it, so the implementer adapts it;
- a binding the revised types no longer resolve is printed as `skeleton binding problem: …; the next spawn's stage two blocks on it`.
- a write that could not remove its prepared file is printed as `skeleton note: <path>: the prepared name <.name> beside it could not be removed (…); delete it` — the settlement stands, delete the dot-file.

The refresh writes precede the locked update; if the update is then refused, the refreshed bytes stay and the next spawn adopts them by content.

### Skeletons and contract stubs

A plan's `## File Structure` can bind each new implementation file to the exports it provides, as `**Export bindings:**` lines (`` - `path` — CT-n: name: Alias, … ``, one contract per file, and on a TypeScript binding no export name equal to an alias on its line — the `name-collides-with-alias` refusal (a Java binding may reuse an alias as a name, but no alias may be the file's own class name — `alias-collides-with-class`); see `references/executable-models.md`). Population stamps them into the TaskGraph (`export_bindings`), and the engine then writes, records and checks the files itself. Nothing here needs an operator action unless something is refused.

**Contract stubs at the contract Task's stop.** When the contract Task's agent stops, before the stop checks and before settlement, both stop shells (Claude Code's SubagentStop and Pi's) read the contract's not-yet-frozen types file and write a stub at every bound file of that contract, so the acceptance tests compile and fail by assertion. The contract Task never writes them, and validation refuses a bound path in its `file_list`. A binding that does not resolve writes no stub; it is reported as a stop note (`[loom] …`), never a block, and the contract Wave Gate then sees an uncollected acceptance file, which is no behavioral RED — fix the types file through the contract Task. Stubs are not frozen paths; in the Wave that owns their file they are ordinary skeletons with origin `contract-stub`.

**Skeletons at spawn.** When the spawn gate admits an implementation Task (Claude Code's `validate-task-execution`, Pi's spawn lifecycle — the same `registerTaskExecutionBatch`), it runs one step before any attempt baseline is captured:

1. **Stage two.** Every binding of the registering Tasks is resolved against its contract's types file, whose bytes must equal the freeze stamp. A missing alias, a non-function or generic alias, a Java holder of the wrong shape, an unfrozen contract or drifted bytes refuses the whole registration, every problem named, before a byte is written. Status reports the same problems as `skeleton-bindings-unresolved` in place of `spawn-wave-implementation`. When status itself cannot read a skeleton path or types file, it blocks nothing (registration reads them again and is the authority) but names the gap under the `skeletons-unobserved` reason beside the owed spawn.
2. **Write.** Registration writes each missing bound skeleton of the Task before the attempt starts, may refresh a skeleton that is still the engine's untouched bytes (one generated from an older types surface), and never modifies a file anyone has changed. Every write goes through the one no-clobber writer: repo-relative only, never a frozen path, no symlinked ancestor; a create never replaces an existing file, and a refresh replaces a file only while its bytes still equal the expected engine digest. Canonical bytes already on disk with no record (for example after a refused registration) are adopted as they are. This covers the first attempt, a retry whose skeleton was deleted and an infrastructure respawn alike.
3. **Record.** The engine-written digest (`engineSha256`) and the types digest are committed with the reservation (`skeletons`), with each path's outcome (`task.skeleton_outcomes`).

Because the bytes exist before the baselines, engine bytes are never the implementer's write. A file whose bytes equal the recorded engine digest never satisfies "changed", and never counts as an out-of-scope change of the contract Task.

**Skeleton outcomes.** Every non-test `file_list` path has exactly one outcome, the same in status and in the brief (`core/skeleton/outcomes.ts`):

| Outcome | Meaning |
|---|---|
| `skeleton written` | the engine wrote it (origin `spawn`, `contract-stub` or `revision`) and it is still untouched, or it is about to at spawn |
| `exists, not skeletonized` | the file already exists and is not an untouched engine skeleton; it is never modified |
| `contract has no types file, no skeletons` | the Task claims a `**Types file:** none` contract and the path is unbound |
| `no bound exports, no skeleton` | no binding names the path |
| `unsupported language, no skeleton` | bound, but neither TypeScript nor Java under a `src/main/java/` root |
| `absent, no skeleton owed` | a Distill Task's scope path that is bound and missing: a sibling deleted the file, and the engine writes no skeleton for a Distill Task |

**Status.** `helper orchestration status` (and `--json`, field `skeletons`) lists, per current-Wave Task and path, the outcome marked recorded (written at that Task's spawn) or projected (not spawned yet), every skeleton flagged `stale against revised contract`, and every stage-two problem.

**Completion.** For a Task binding or claiming a frozen contract, the `declared-artifact-changed` obligation fails `declared-artifact-contract-violated`, listing every violation, when a bound export is:

- `deleted` — not exported, or the file is missing;
- `renamed` — missing while another export carries its alias;
- `retyped` — not `export const name: Alias` (TypeScript) or `static final Alias name` (Java) with the alias imported from the types file;
- `still unimplemented` — its initializer still holds the exact string `unimplemented: <name>` (any other throw is fine);

or when a production file in the types file's language `shadows frozen ADT` (declares a type named like a **Frozen ADT** or one of its variants) or `re-lists frozen variants` (a local union or sealed hierarchy re-declaring two or more of them; the diagnostic names the `Extract<…>` remedy). The violations go into the semantic retry appendix. A read failure while judging is an `implementation-observation-unavailable` infrastructure failure: it never consumes a semantic attempt and never passes. Attested Tasks, test files, and Tasks waiving regression as `documentation-only` or `generated-artifact` owe nothing. Graphs populated before skeleton generation existed carry no bindings and run unchanged: their Tasks owe no conformance (`pre-g2-graph`).

**Stray prepared files.** Each skeleton write first writes a dot-file `.<file>.loom-skeleton-…` beside the target and removes it afterwards. When that removal fails, nothing is blocked: registration prints `[loom] skeleton note: …` on stderr and the contract stop adds a `note:` line to its stop note, both naming the dot-file. Delete it.

**Recovering.** A stage-two refusal means the plan and the frozen types disagree: add the missing signature to the types file through a Contract Revision (above), or correct the plan's bindings and re-populate. Never write or delete a skeleton by hand to get past it — a deleted skeleton is simply rewritten at the next spawn.
