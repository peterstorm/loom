# Operating Loom

This guide covers status, the Run Directory protocol, protected state, the rules gate, and what to do when an orchestration stops. For lifecycle semantics, read [Workflows](workflows.md); for module boundaries, read [Architecture](architecture.md).

| For | Read |
|---|---|
| Read-only helpers that print what the engine knows | [Helpers](reference/helpers.md#read-only-helpers) |
| The verification manifest, stop checks, owner verification, the distill pass, Acceptance Contracts and skeletons | [Verification](verification.md#verification) |
| The reviewer protocol, standalone lineage, the plan design review and remediation | [Standalone review](standalone-review.md#standalone-review-and-the-reviewer-protocol) |
| Validating and changing Loom itself | [Development](development.md#developing-loom) |

## Prerequisites

- Linux or macOS 13+. The runtime needs no-follow filesystem authority: `/proc/self/fd` descriptor-relative access on Linux, `O_NOFOLLOW_ANY` on macOS. An older Darwin kernel is refused at startup. Everything in these guides works on both, including the strict report reset before a critical-repair check ([how the two platforms do it](verification.md#enrolling-a-critical-repair-check)).
- Bun (engine runtime and tests)
- Git
- Claude Code or Pi
- GitHub CLI for `/loom`’s issue tracking and optional push/PR operations

Run commands from the repository being orchestrated unless a command explicitly changes into Loom’s `engine/` directory.

**The CLI path.** Every command in these guides is written `bun "$LOOM_DIR/engine/src/cli.ts" helper …`. `LOOM_DIR` is the root of the Loom package the harness loaded. The Loom commands set it with `LOOM_DIR="${CLAUDE_PLUGIN_ROOT}"`: Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` in command source, and under Pi the rendered resources replace that token and export `LOOM_PLUGIN_ROOT` for diagnostics. In your own shell, set `LOOM_DIR` to that package root, or to the checkout when you work in Loom's own repository.

## Canonical status

Prefer the engine-derived status over hand-written `jq` readiness checks:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration status \
  --runs-root ".claude/reviews/wave-gate-runs"
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration status --json \
  --runs-root ".claude/reviews/wave-gate-runs"
```

Both renderers project one `LoomStatus` value. Status reports:

- active Phase and Wave;
- exhaustive Task counts;
- failed proof obligations;
- test readiness;
- Wave completion-suite outcome and independent `projectVerificationCoverage`;
- owner verification per owned Invariant, when the latest completion result ran it (coverage, mutant counts or the exemption, the time bound; see [Owner verification](verification.md#owner-verification-blocks-a-wave-gate));
- Review Run roster gaps and evidence failures;
- active/advisory/resolved/refuted Finding counts;
- whether a Refutation Panel is needed;
- Wave Gate completion eligibility;
- exactly one next action and all reasons.

Unreadable or malformed authority is represented as `unavailable` and leads to `blocked`; status never fabricates empty/ready values. Status probes the conventional Wave Gate runs root by default; pass `--runs-root` when the active run was started under a different root. A missing active directory is reported as orphaned, never as a healthy suspended run.

Status re-proves accepted Review Packet authority the way the Wave Gate does: it reads each reviewed Task's declared bytes in the TaskGraph's own project and compares them with the reviewed snapshot. While a gate waits on an advisory decision, unchanged bytes therefore read as intact, and only real drift or a Git observation failure fails the `Review Packet workspace integrity` prerequisite.

Modern completion-suite readiness (`required`, `accepted`, `rejected`, or `stale`) includes `projectVerificationCoverage`. `configured` carries non-empty sorted `checkIds`, not a pass. `not-configured` distinguishes `engine-default` (source absent at population), `empty-operator-manifest` (explicit zero project checks), and `historical-unknown` (archived reserved-only receipt without source provenance). Reserved-only suites remain eligible to advance when the existing gates pass; report “Reserved checks accepted; Project verification NOT CONFIGURED,” not “project verification passed.” Completed schema-v2 coverage comes from the archived receipt roster, never today's manifest. `legacy-unavailable` remains unavailable without invented coverage. These are read-model facts, not new persisted authority or waivers.

Raw state inspection remains useful for diagnosis, but it is not gate logic:

```bash
jq '.' .claude/state/active_task_graph.json
jq '.tasks[] | {id, wave, status, proof, review_status}' \
  .claude/state/active_task_graph.json
```

Use `.pi/state/active_task_graph.json` under Pi.

## Run Directory operations

Registered programs require a fresh directory that is a direct child of the supplied runs root. A nested path or unrelated basename is rejected.

Typical roots:

| Program | Conventional root |
|---|---|
| Wave Gate | `.claude/reviews/wave-gate-runs/` |
| Standalone review/remediation | `.claude/reviews/review-and-fix-runs/` |
| Architecture panel evidence | `.claude/specs/<slug>/panel-runs/` |

Create the exact root and a fresh `run.*` child. Never reuse a completed or blocked run.

`helper orchestration start` resolves `--runs-root` and fails if it does not exist. It never creates the root, so a mistyped root cannot grow a second tree of runs. It then creates the run's own directory under that root, and tolerates one that is already there, which is why `mktemp -d` under the root also works.

### Registered program protocol

```bash
# Start with program-specific JSON on stdin
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration start <program> \
  --runs-root <root> --run <fresh-direct-child>

# After a returned spawn batch finishes
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration resume \
  --runs-root <root> --run <same-child>

# Supply a requested user decision
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration decide \
  --runs-root <root> --run <same-child> --request <decision-id>
```

`resume` is idempotent. Execute only the returned `spawn-batch`, `await-user`, `blocked`, or `done` action. Do not build request lists, Context Packets, verdict manifests, transcript files, model choices, or result artifacts by hand.

The façade also exposes `submit` and `correlate` for transport integration and compatibility. Normal Pi and Claude Code operation records native correlations and captures final bytes automatically, through the same mechanism on both harnesses: every `spawn-batch` (and every `done` with a `result.json`) the façade returns is first published as a **session run binding** — a registry file `<session-id>.orchestration-runs.json` under `LOOM_SUBAGENT_DIR` (default `/tmp/claude-subagents`) naming the run and the request ids it issued, stamped with the harness that owns the session. On Pi the session is `PI_SESSION_ID` (with `PI_CODING_AGENT=true`); on Claude Code it is `CLAUDE_CODE_SESSION_ID` (with `CLAUDECODE=1`), which Claude Code exposes to the main agent's Bash commands. A missing session id under either harness withholds the spawn batch with an error rather than issuing requests nobody could capture.

The harness side reads the binding back by its own session id, and a registry stamped with the other harness is refused. Pi's extension resolves the run from the request markers in its spawn batch. On Claude Code, hook payloads carry the parent session's `session_id` for subagents too: PostToolUse on `Agent` records the native `agent_id` against the one binding that issued the prompt's `LOOM_REQUEST_ID`, and SubagentStop captures into the bound run whose correlator records that `agent_id`. Because a foreground Agent call finishes before it returns, its SubagentStop can precede that PostToolUse; the stop then records the same correlator from the agent's own spawn prompt (the transcript's opening message) before capturing. Claude Code subagents that finish with `SubagentHandback` are captured from that call's `message`. An agent no binding claims is left alone; a marker no binding (or several) issued, an unreadable registry, or a correlator in several runs is a hook error, never silent passthrough. `LOOM_ORCHESTRATION_RUNS_ROOT` and `LOOM_ORCHESTRATION_RUN_DIR`, when set, take precedence and pin the hooks to that one run (both or neither). `complete` remains a compatibility adapter for historical panel callers; deterministic operations are executed internally in new façade runs.

To see what state one run is in, and whether it is recoverable or stale, use [`helper orchestration inspect`](reference/helpers.md#inspecting-one-run). It is a pure read.

### Retiring a superseded run

Run directories are never deleted — they hold the evidence. When a newer run replaces one, record it so the directory listing stays honest:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration abandon \
  --runs-root <root> --run <retired-run> \
  --superseded-by <replacement-run> \
  --reason "<why this run was retired>"
```

The marker removes nothing. It is written once and is immutable: an identical repeat succeeds, a different one is refused, a run may not supersede itself, and the replacement must already exist as a direct child of the same runs root. Afterwards `inspect` still reads the run’s evidence, but every operation that would advance it — `resume`, `submit`, `correlate`, `decide`, `restart`, `complete` — refuses, and no recovery can adopt it as a pristine replacement. `--superseded-by` is optional; omit it when a run is retired without a successor.

When the abandoned Run owns the matching protected Wave Gate, the same command also stamps that registration `terminal-abandoned` under the TaskGraph lock and clears its `active_wave_completion_suite`. This protected-state mutation authorizes a later successor start without deleting the tombstone audit. The immutable Run marker is published first; if the subsequent protected-state stamp fails, the command reports the marker-only partial outcome. Repeat the **identical** `abandon` command: marker publication reconciles idempotently and the helper retries the state stamp. Do not choose a new reason or successor, delete the marker, or edit protected state by hand.

`orchestration status` reports both leftover shapes (issue #50):

- **A marker without a stamp.** The run was abandoned before the stamp existed, or its stamp failed. Status reads the marker, refuses to call the run resumable, and prints the exact `abandon` to repeat, with the recorded reason and successor.
- **A tombstone that names a successor.** Status keeps the Wave in the implementation window and, once the Wave can start, returns the `start-successor-wave-gate` recovery carrying that successor's run id. Registration admits only that run, so start `/wave-gate` with exactly that id.

### Pi batch limit

Pi’s native subagent transport accepts at most eight requests per call. Partition a larger engine-issued batch into ordered chunks of at most eight without changing any request. Resume only after all chunks finish.

## Protected state rules

Do not write `active_task_graph.json`, machine bindings, or evidence ledgers directly.

Protection is layered:

1. TaskGraph mode is `0444` at rest.
2. `guard-state-file` denies Bash segments that may write guarded paths. The decision is pure (`core/guard-state-file.ts`); the hook (and Pi's `tool_call` twin) arms it only while a task graph exists and resolves the guarded directories — every task-graph state directory, the verification-manifest directory, `LOOM_SUBAGENT_DIR` and `LOOM_MACHINES_DIR` — at decision time, so a re-pointed directory is guarded without a restart.
3. `guard-subagent-authority` (ADR-0067 D6, amended; Claude Code `Bash` hook, Pi `bash` `tool_call` twin) fences every subagent off from the writing `helper security-audit|orchestration` operations (every operation whose table entry declares the `subagent: "parent-only"` trait), Loom hook entrypoints, nested harnesses and a registered audit run's authority files. The invariant this list relies on: the guard is a shell-string fence with documented gaps, not the proof — a ballot counts only when it matches the capture attestation the capturing harness persisted, and on Pi the parent's `helper security-audit verify --from <run>` is checked against those persisted attestations by the same proof `verify --from` runs, so a Pi restart does not strand a captured run. The full contract — the caller signal on each harness, what is refused and normalised, the run registry and the Pi import gate — is stated once, in [the subagent authority guard](security-audit.md#the-subagent-authority-guard).
4. Under Pi, a content-addressed Runtime Revision handshake rejects stale-extension/fresh-CLI mutations before dynamic import; `StateManager` repeats the check before chmod or lock creation.
5. `StateManager` serializes writes with a lock and atomic rename.
6. Only hooks and narrowly allowlisted helpers receive write authority.
7. Run-scoped programs publish immutable evidence outside the protected graph and commit protected state only through typed effects.

If a helper says a direct write is blocked, use the named canonical operation; do not use `chmod`, output redirection, an interpreter, or path obfuscation to bypass it.

## Rules gate (Claude Code and Pi)

One decision, two thin adapters. `engine/src/core/rules-gate.ts` (pure) holds the policy, full-read coverage, adherence check and block text; `engine/src/core/bash-code-mutation.ts` classifies Bash mutations. Each harness only maps its own evidence into the core's `TranscriptEvent`s:

| Harness | Adapter | Entry |
|---|---|---|
| Claude Code | `engine/src/handlers/pre-tool-use/claude-transcript-events.ts` (transcript JSONL → events) | `rules-gate` PreToolUse hook, `hooks/scripts/rules-gate.sh`, matcher `Edit\|Write\|MultiEdit\|Bash` |
| Pi | `pi/rules-gate.ts` (`buildContextEntries()` → events) | standalone Pi extension; an operator installs a one-line shim in their Pi extensions directory that loads it through the runtime loader |

`engine/tests/pi/rules-gate-parity.test.ts` runs one scenario matrix through both adapters and requires the same decision — change policy in the core only, and a drifting adapter fails there.

The gate blocks a code mutation until the Loom rules and skills are in the main agent's **current context**:

1. `rules/architecture.md` and the language rule for the target extension (`typescript-patterns.md`, `java-patterns.md`, `rust-patterns.md`) were fully `Read` — a `limit` skim does not count, and a read in the same assistant message as the edit does not count.
2. The `deepen` and `distill` skills were loaded: with the `Skill` tool (Claude Code), by the user's skill command (`/loom:deepen` on Claude Code, `/skill:deepen` on Pi), or by a full read of the skill's own `skills/<name>/SKILL.md`. The SKILL.md read is the path a Pi agent takes — Pi has no Skill tool. The block text names the mechanisms of the harness that raised it.
3. An existing target file was fully read, or written earlier in the session.
4. An assistant text line `LOOM: applying <rule|skill> — <how>` names a required rule or skill. A completed shell command carrying the marker (`: 'LOOM: applying …'`) also counts — commands are stored verbatim, while a harness may persist a rewritten copy of assistant prose that drops the line.

Evidence is read from the session transcript (`transcript_path`) and resets at the last compaction boundary, so after `/compact` the rules must be read and stated again. Non-code targets (`.md`, `.json`, …) are not gated. Bash is gated only through a path heuristic (redirects, `tee`, `cp`, `mv`, `sed -i`, `patch`, `rsync`, `install` onto a code file); an interpreter opening a file for write is not recognized.

Subagents are exempt — the orchestrator owns their compliance (Claude Code: `agent_id` present in the hook input; Pi: only a provable child agent — the explicit `LOOM_PI_SUBAGENT=1` marker, or a headless launch (`json`/`rpc`/`print` mode) whose inherited `LOOM_PI_PARENT_PID` names another process — or `LOOM_GATE_MODES` to choose modes explicitly. A headless parent started without the marker, an interactive `pi` that merely inherited a parent marker, and any malformed marker are gated; an interactive process the subagent authority guard treats as a subagent gets a stderr notice saying so). The Claude Code hook fails **closed**: an unreadable transcript or a missing runtime blocks the call.

| Env | Effect |
|---|---|
| `LOOM_GATE=off` | Disable the gate |
| `LOOM_GATE_MODES=tui,rpc` | Pi only: gate just these modes (overrides the subagent exemption) |
| `LOOM_RULES_DIR=/path` | Rules directory (default: `rules/` of the owning Loom package) |
| `LOOM_SKILLS_DIR=/path` | Skills directory whose `<name>/SKILL.md` satisfies a skill requirement (default: `skills/` of the owning Loom package) |

The gate proves context and articulation, never genuine adherence; the substance of the `LOOM:` line is judged in review.

## Common operating states

Find what you see in the first column. An entry that has mechanics of its own is linked; the short ones follow the table.

| You see | It means | Do |
|---|---|---|
| A Task stays `pending` | its Agent is still running, it crashed, or its proof failed | [Task remains `pending`](#task-remains-pending) |
| `proof:red-then-green-unproven:<gap>` in a settlement line | the attempt did not show a red run, then a write, then a green run | [Task fails I6](#task-fails-i6-red-then-green) |
| `implementation-escalation-required` in status | both semantic attempts failed, or an attestation drifted | [Implementation escalation](reference/recovery.md#implementation-escalation-semantic-attempt-2-exhausted) |
| A stop blocked under `## Acceptance stop check`, `## Affected-test stop check` or `## Task mutation check` | a stop check found failing tests or surviving mutants, and the same agent keeps working | [Stop checks](verification.md#stop-checks) |
| The Wave Gate reports critical Findings, or waits on advisories | reviewers found work to do | [Critical Findings](#wave-gate-reports-critical-findings), [advisory disposition](#wave-gate-awaits-advisory-disposition) |
| The Wave Gate rejects with owner-verification findings | an owned invariant's matrix test misses a sibling or leaves a mutant alive | [The remedy table](verification.md#owner-verification-blocks-a-wave-gate) |
| `loom:full-tier-lint` refuses an import the branch's own rules allow | the loaded runtime's lint rules are older than the branch's | [Full-tier lint](#wave-gate-full-tier-lint-refuses-imports-the-branch-allows) |
| `frozen acceptance drifted: CT-n '<path>' changed` | a frozen Acceptance Contract path changed | [Contract Revision](verification.md#a-frozen-acceptance-test-or-contract-types-file-is-wrong) |
| `skeleton-bindings-unresolved` in status | the plan's export bindings and the frozen types disagree | [Skeletons](verification.md#skeletons-and-contract-stubs) |
| A decompose spawn refused with `plan-design-review (…)` | the plan has no accepted design review, or changed after it | [Plan design review](standalone-review.md#decompose-is-blocked-on-the-plan-design-review) |
| A reviewer result refused for unread units | the reviewer did not page through the whole frozen diff | [Read coverage](standalone-review.md#read-coverage-reviewer-protocol-v4) |
| Remediation returns `blocked`, or `required report reset failed before launch` | the candidate drifted, a check failed, or its old report could not be removed | [Remediation and Git safety](standalone-review.md#remediation-and-git-safety), [enrolling a check](verification.md#enrolling-a-critical-repair-check) |
| Status reports the active Wave Gate run as orphaned | its Run Directory is missing | [Active Wave Gate Run Directory is missing](#active-wave-gate-run-directory-is-missing) |
| A completed Wave's reviewed bytes drifted | a remediation invalidation was missed | [Reopen the completed Wave](reference/recovery.md#completed-wave-has-post-review-workspace-integrity-loss) |
| Pi refuses a mutation for runtime version skew | the loaded extension and the checkout differ | [Reload](#pi-reports-runtime-version-skew) |
| `populate-task-graph` refuses the spec or a Requirement id | the authored trace cannot be proved against the Spec Index | [Population refuses](#population-refuses-the-spec-or-a-requirement-id) |
| The load boundary directs a repair | the State File is malformed | [State is malformed](#state-is-malformed) |

### Task remains `pending`

- If its Agent is still in `executing_tasks`, wait or diagnose a hang.
- If the Agent crashed, SubagentStop/cleanup clears execution attribution; respawn the exact Task.
- If proof is unsatisfied, inspect `proof.obligations` rather than trusting completion prose.
- The settlement line (`Task T1 settlement: …` on Claude Code, `loom(pi): T1 settlement: …` on Pi) and the Task's `failure_reason` both say why a failed attempt was not implemented. A `task-byte-scope-violation` names the paths written outside the Task's declared files: the first 10, then `and N more`. Remove stray files that are not the Task's work, such as a killed test run's leftovers, before the retry, or that retry fails the same way.
- An `infrastructure-blocked` settlement names each failure's own reason in parentheses (a longer reason is cut to its first 1,000 characters followed by `…`), for example `implementation-observation-unavailable (Claude JSONL transcript record 16 is malformed or truncated: …)`. A reason that repeats an earlier one is named once. Infrastructure blocks never use up the retry: fix the named cause, then dispatch what `orchestration status` lists.
- Claude Code writes harness records into a subagent transcript beside the conversation: `attachment`, `system`, and request telemetry (`api-request`, `api-request-shape`, `api-request-blob`). An `api-request-blob` carries a copy of earlier turns, sometimes with a `system` role. Only `user` and `assistant` records are read as the agent's activity (`core/claude-record-kind.ts`). Harness records are accepted without reading their message and never count as written files, test output or tool results. A transcript that a strict check still refuses names the exact record in its reason.

### Test evidence is missing or degraded

The implementation Agent must run recognizable tests. For trusted Claude evidence, prefer a supported machine-readable report. A nonzero exit is trusted failure; a zero exit without an acceptable report may remain untrusted. Pi structured tool results retain their distinct provenance.

Do not use `mark-tests-passed` to fabricate evidence. It is an evidence/status operation, not an escape hatch.

### Task fails I6 (red-then-green)

A Task owes the red-then-green obligation (I6) when it requires new tests, is neither an Acceptance Contract claimant nor a contract Task, and its TaskGraph was populated after I6 existed, which means its frozen manifest carries `testFiles`. A contract Task is exempt because it cannot satisfy I6: its contract Wave Gate requires every acceptance testcase it writes to be collected and failing, so those tests never go green in its attempt, and a test-only contract has no implementation file to write. The gate's observed red window is the contract Task's red evidence. Its Proof still owes `new-tests`, and its brief carries no I6 section. A Task that owes I6 settles `implemented` only when its attempt epoch's ledger shows three things in order:
1. a qualifying red on one of its test files;
2. then its first write to an implementation file;
3. then a qualifying green covering every one of its test files.

A qualifying run is a ledger `TestRun` with an exit code and a parsed structured report that records per-file results. The obligation, the gaps and the soundness limit are defined in [Deterministic implementation, I6](roadmap.md#during-the-loop--put-the-oracle-inside-the-agents-iteration).

A failure reads `proof:red-then-green-unproven:<gap>` in the settlement line and in the retry receipt. Each gap points to a likely cause:

- `no-test-files`: the `file_list` matches no frozen test suffix. Re-scope the Task, or declare `testFileSuffixes` in the manifest before the next population.
- `implementation-write-missing`: the ledger holds no write to a non-test `file_list` entry. Either the agent wrote only through an unlogged path, such as an interpreter or a generator, or it wrote nothing.
- `red-missing` or `green-missing` with `untrustedOnly: true`: tests ran, but no run was qualifying. Usual causes are a chained, piped or redirected command, a missing report option, or Pi-structured evidence with no ledger run. On Claude Code a failing run reaches the ledger only through the `PostToolUseFailure` hook; a runtime whose `hooks/hooks.json` predates that wiring records no red at all.
- `red-missing` with `untrustedOnly: false`: qualifying runs exist, but none shows red on a Task test file. Either the tests never failed, or they only failed to collect in a Task that creates no implementation file. A collection or import error is red only when the Task creates an implementation file, meaning one whose Task-level `artifact_baseline` entry is `missing`. The brief names those files.
- `red-after-first-implementation-write`: the code came before the failing test.

The retry brief tells the agent to return its implementation files to the attempt baseline with one Bash call, observe red, and then implement. The call runs from the repository root and first checks that the baseline is a commit. The baseline is the Task's `start_sha`, or `HEAD` when none was recorded; the brief then says that the uncommitted changes are discarded. The call restores each file the baseline has (`git restore`) and deletes each file the Task created (`rm -f`). If the baseline is not a commit, it fails before changing anything. A `ledger-unavailable` gap, or an unreadable ledger at settlement, is infrastructure. It does not use up the semantic attempt.

To see the facts settlement judged, numbered the way the gap and the stored evidence cite them, read the attempt's epoch (see [Reading an attempt's ledger epoch](reference/helpers.md#reading-an-attempts-ledger-epoch)). For the I6 judgment itself, use [`helper red-then-green-status`](reference/helpers.md#where-does-a-task-stand-on-i6).

### Reviewer evidence is missing

Registered programs derive the exact missing slots and issue retry requests. Resume the program; do not re-run the whole roster or manually write a transcript.

A malformed semantic output gets one retry. Attempt-2 rejection is terminal for that run. Wave reviewer exhaustion has an explicit `orchestration restart` path; standalone runs should remain blocked audit evidence rather than be edited.

### Active Wave Gate Run Directory is missing

Do not recreate the old directory or edit `active_wave_gate`. Create a pristine
replacement direct child, copy the exact run ID/wave/digest from protected state,
and use the atomic recovery operation:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration recover-orphan \
  --runs-root ".claude/reviews/wave-gate-runs" \
  --run-id "<active-run-id>" --wave "<active-wave>" \
  --digest "<active-authority-digest>" \
  --new-run "<fresh-replacement-run-directory>"
```

It refuses if the old entry exists or any subagent is active, preserves review
history and generations, records the retirement, installs replacement authority
atomically, and returns the exact new spawn batch. `cleanup-state` remains a
history-discarding last resort, not normal recovery.

### Wave Gate reports critical Findings

Fix surviving criticals through implementation Agents, then open a new Wave Gate run. Each affected Task is `implemented`, so it is owed no dispatch until it is reopened (see [Reopening an implemented Task to fix a Wave Gate Finding](reference/recovery.md#reopening-an-implemented-task-to-fix-a-wave-gate-finding)). Reopening increments its Review Generation. Do not remove Findings from the graph. The next Review Run verifies every prior id against a new Review Packet.

### Wave Gate awaits advisory disposition

Present the advisories the engine's request references. The only decision a Wave Gate records is exactly `{"kind":"approve"}` through `decide`; any other object is refused without writing. To fix an advisory first, `abandon` the run with a reason, reopen the Task, re-dispatch it, and start a fresh Wave Gate (see [Reopening an implemented Task to fix a Wave Gate Finding](reference/recovery.md#reopening-an-implemented-task-to-fix-a-wave-gate-finding)). Do not classify advisories silently in parent reasoning.

In a contract Wave, `helper orchestration status` adds an `acceptance-freeze-pending` reason at this pause. It lists every advisory whose file is a frozen path of a contract still `awaiting-red` there. When the completion suite accepts, only its receipt is installed. The Acceptance Freeze is stamped by the locked completion commit, so the contract is still `awaiting-red` at the pause, and abandoning the run freezes nothing ([ADR-0044](adr/ADR-0044-the-acceptance-freeze-is-stamped-by-the-completion-commit.md)). Approval lets the gate complete and stamp the Acceptance Freeze over those bytes, so after it each fix needs a Contract Revision. Fix a relevant advisory before approving, by the same recipe on the contract Task. The fresh gate reports no frozen-path drift for the fixed files. The reason is a status projection only; the decision request and its identity are unchanged.

### Pi reports runtime version skew

Do not repair state. The mutating CLI route compared the Runtime Revision published by Pi's loaded extension with the current checkout and refused before writing. Run `/reload` (or fully restart Pi while preserving the session), then retry the same idempotent operation. Canonical `orchestration status` remains available during skew.

A missing handshake means the Pi session predates this protocol or did not load Loom; it is also resolved by reload/restart, not by deleting fields from the TaskGraph.

### Wave Gate full-tier lint refuses imports the branch allows

The Wave Gate's `loom:full-tier-lint` check runs against the branch's files (the completion suite changes into the worktree), but the lint rule code is the loaded runtime's, not the branch's. A branch that changes a rule, for example a new per-file capability grant in `no-cross-boundary-imports` for a `node:` builtin or an exact-specifier package, therefore fails the gate with a boundary refusal that its own rule would admit. The branch's files are correct; the runtime is older.

This is the Runtime Revision design working as intended: infrastructure the gate depends on must be loaded before the gate can use it. Land the rule change on the checkout Loom is installed from (merge it, or port it there), run `/reload` (or restart Pi), then start a fresh Wave Gate. Do not weaken the branch's imports or its rules to get past the check.

The refusal names this case itself. When the full-tier lint fails, the gate's diagnostic carries the lint's refusal (`loom:full-tier-lint: …`). If the gated repository is a Loom checkout whose `lint-rules/` or `engine/src/linter/` files differ from the loaded runtime's, the refusal opens with a `⚠` sentence naming the loaded runtime and the differing rule files. A plain project carries no lint rules of its own and never gets the sentence. A replayed rejection keeps only the lint's exit code, so its diagnostic tells you to run `helper lint-wave-gate`, which prints the same refusal and the same skew sentence.

### Population refuses the spec or a Requirement id

`populate-task-graph` proves the authored trace against the Spec Index before writing anything. It refuses, naming the cause:

- a declared `spec_file` that cannot be read, is not UTF-8, or does not parse as a canonical specification (every required section, including `## Appendix: Glossary`), even when no Task claims from it;
- a Task whose `spec_anchors` or `spec_contributions` name an id the Spec Index does not define as a completable FR or AS entry (`NFR-`, `SC-` and Out-of-Scope ids included), listed as `T3 → NFR-001`;
- any Requirement trace when the plan has no `spec_file`.

Fix the specification or the decompose output and re-run population. The rule is the one `amend-spec-trace` applies to added ids (`unprovenRequirementTrace`), so an id population admits is one the Implementation Brief can render.

### State is malformed

Use only when the load boundary explicitly directs recovery:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper repair-task-graph
```

The repair path parses rejected bytes, applies conservative repair, refuses loss of Findings/audit data, validates both full and typed forms, installs atomically, and restores mode `0444`.

## Recovery operations

The commands that change protected state to recover a run (remediation, reopening a Task or a completed Wave, upgrading or amending the spec trace) are in [Recovery operations](reference/recovery.md).

## Edit-time feedback

### Advisory type diagnostics

After an Edit/Write/MultiEdit on a TypeScript source (`.ts`, `.tsx`, `.mts`, `.cts`; not `.d.ts`), Loom runs the project's own `tsc --noEmit --incremental` and gives the model:

- the touched file's diagnostics, each with a remedy for common error codes;
- errors this edit introduced in other files, judged against the previous run, so errors that were already there are not repeated. A second identical error on another line counts as new.

When the same diagnostics survive 3, 5 and 8 consecutive edits of a file, an escalating repeat reminder tells the model to stop patching and change approach.

It is **advisory and fail-open**: it never blocks an edit. Claude Code receives it as PostToolUse `additionalContext` (`hooks/scripts/type-diagnostics.sh`, 45s hook timeout). Pi appends it to the edit's tool result. Both harnesses go through `adviceForEdit` (`engine/src/handlers/type-diagnostics-edit.ts`) to `engine/src/handlers/type-diagnostics-runner.ts`.

- **Project and compiler:** the project is the nearest `tsconfig.json` above the file; the compiler is the nearest `node_modules/typescript` above that. Without either, the check is silent. A `tsc` that exits nonzero without printing diagnostics (a crash) is reported to the operator, never treated as a clean program.
- **Deadline:** a run waits up to 30s. A cold build that misses the deadline keeps running in the background to warm the cache, and the operator sees one note. Later edits take the warm path (seconds on this repository).
- **One run per project at a time:** a run slot (`<key>.slot` in the cache; `engine/src/handlers/type-diagnostics-run-slot.ts`) allows one check per tsconfig. A run that misses the deadline hands the slot to its detached build. A second edit while a check, or a detached cold build, is still running gets no advisory. A slot whose owner has died, is older than 10 minutes, or is unreadable is reclaimed. Every run writes its own output file.
- **Memory window:** the baseline and repeat counts live in the user cache and outlive a session. They count only within a 30-minute window, so an earlier session's edits never escalate the reminder or get blamed on this edit. If memory cannot be saved, the model still gets the diagnostics and the operator gets a note.
- **Pi timing:** lint and the type check share one `tool_result` handler, so on a cold build Pi's lint feedback waits for the type check, up to the deadline.
- **Pi operator notes:** notes go to the UI, or to stderr in a headless session.

| Variable | Effect |
|---|---|
| `LOOM_TYPE_DIAGNOSTICS=off` | Disable the check on both harnesses |
| `LOOM_TYPE_DIAGNOSTICS_CACHE=/path` | Build-info and repeat memory location (default `$XDG_CACHE_HOME/loom/type-diagnostics`, else `~/.cache/loom/type-diagnostics`) |

## Ending an orchestration

### Completing an orchestration

After the final Wave Gate, retire the TaskGraph:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper complete-orchestration
```

The helper refuses, listing every reason, unless the graph has Tasks, all of them `completed`, and no Wave Gate run is registered as active. Under the TaskGraph lock it publishes the exact graph bytes beside the live graph as `.claude/state/completed_task_graph-<issue|no-issue>-<UTC stamp>.json`. The publish is exclusive and whole: the bytes are prepared under a temporary name and hard-linked into place, so an existing archive is never overwritten and a partial archive is never visible. It then removes the live graph. The archive is published before the removal, so a failure leaves both files, never neither.

Every Loom guard keys on the live graph path: `block-direct-edits`, the Task/Agent spawn gates and the state guard. So they all lift, and a post-gate `/review-and-fix` can run in the same checkout. While a finished graph stays live, those guards stay on: Write and Edit into the Orchestrated Repository are refused, and spawns are phase-checked. `block-direct-edits` guards the repository that owns the live graph, meaning the canonical root of the Git working tree holding the State File. It also always guards Loom's protected directories, wherever they lie: the subagent directory (`LOOM_SUBAGENT_DIR`, default `/tmp/claude-subagents`, holding the evidence ledger, `.active`, `.machine` and `.task_graph` files) and the machine-definitions directory (`LOOM_MACHINES_DIR`). A parent write there would forge evidence or rewrite the gate, and the state guard covers them only for Bash. Writes whose every symlink-resolved target lies outside that root and outside both protected directories are allowed. That covers a session scratchpad, another worktree of the same repository, and a sibling directory such as `<root>-other/`. Worktrees nested under the root (for example `.claude/worktrees/`) are still inside. A target or root the guard cannot resolve (a dangling symlink, malformed input, a `LOOM_STATE_PATH` outside Git and outside the documented layouts) stays guarded. The state directory keeps its separate state guard. See [ADR-0046](adr/ADR-0046-the-direct-edit-guard-protects-only-the-orchestrated-repository.md).

### Abandoning an orchestration

`/loom --complete` and `--abort` are not implemented lifecycle flags. To abandon an unfinished orchestration, use the guarded teardown, which keeps no copy:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper cleanup-state
```

Use it only with explicit operator intent. Preserve specs, plans, review runs, and the GitHub Issue as audit/recovery material.
