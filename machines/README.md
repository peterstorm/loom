# Guarded Skill Machines

A machine is a small phase diagram for one agent type. The runtime enforces its phase order and tool availability, and the agent's own attributed tool calls are the events that advance it. Prose Skills stay responsible for judgment; a machine adds a hard gate. For the surrounding engine, see [`docs/architecture.md`](../docs/architecture.md); for what the whole system does and does not guarantee, see its [Guarantees and honest limits](../docs/architecture.md#guarantees-and-honest-limits).

This file also owns the description of the evidence ledger: what a fact is, how it is minted, when it is trusted and whom it is attributed to.

## How it works

- `<agent-type>.machine.json` here opts that agent type into gating. No file means no gating. Gating is active only during an orchestrated Loom run: the SubagentStart shim requires an active TaskGraph, so an ad-hoc subagent launch is ungated.
- **SubagentStart** binds the machine to the session with an **epoch** (`<agent_id>:<agent_type>`). An invalid machine file binds too, and the gate then fails closed with the parse error, so enforcement never switches off silently.
- **PostToolUse**, and for Bash **PostToolUseFailure** (`record-evidence`), append epoch-stamped records to the evidence ledger, `<session>.evidence.jsonl`. Claude Code reports a command that exits non-zero only through the failure event.
- **PreToolUse** (`enforce-phase-tools`) folds the agent's own epoch into the current phase and denies an enforced tool the phase does not list. It is deny-by-default within the machine's declared `enforcedTools`. An unexpected evaluation error fails closed once a binding exists.
- **SubagentStop** resolves the Task's `test_result` from the stopping agent's own epoch only.

## The evidence ledger

The ledger holds facts only. There are four kinds:

| Fact | Minted from |
|---|---|
| `FileRead` | a Read tool call. Context gathered only through Grep, Glob or Bash is not a `FileRead` |
| `FileWrite` | an Edit, Write or MultiEdit call (`via: "tool"`), or a shell write the command text names (`via: "shell"`) |
| `TestRun` | a Bash command with a test runner at head position: the real exit status plus a parsed report (Vitest or Jest JSON through `--outputFile` or stdout; JUnit XML from a JVM runner's conventional report directory, an explicit Bun `--reporter-outfile`, or `.loom/completion-reports/` for a JavaScript runner) |
| `SandboxRun` | a security sandbox receipt, minted only from the simple command that ran the sandbox script with its own `--nonce` |

Judgments such as passed, trusted or red-then-green are computed from the facts when they are read and are never stored. Transcript text never becomes a ledger fact; when no trusted ledger verdict exists, completion may use a separately labelled, explicitly untrusted transcript fallback.

### One minting rule

Both harnesses mint facts through one rule:

```text
Claude PostToolUse/PostToolUseFailure payload ─ claudeToolCall ─┐
                                                                ├─ HarnessToolCall ─ recordToolEvidence ─ extractEvidence (pure) ─ ledger append
Pi child tool_result event ─ piToolCall ────────────────────────┘
```

- **Adapters (pure, `core/harness-tool-call.ts`).** Each reduces its harness's event to one `HarnessToolCall`: the tool, its input, its outcome, the call id and the cwd. Claude Code's Bash payloads carry no exit field. A PostToolUse Bash success is exit 0, unless the harness reinterpreted a non-zero exit (`returnCodeInterpretation`, as for a `grep` that matched nothing) or the call ran in the background; an explicit exit field is honoured when present. A PostToolUseFailure `error` starts `Exit code N`, and a timeout or an interrupt is a kill. Pi reports no Bash exit code, so a Pi exit is `details.exitCode` when it is an integer and otherwise `isError` read as 1 or 0; an abort or a timeout is interrupted.
- **Extraction (pure, `machine/extract-evidence.ts`).** Command classification parses the command into segments and requires a runner at head position, so `echo "npm test: 5 passing"` and `git grep "npm test"` produce no `TestRun`. Shell write targets come from `core/shell-write-targets.ts`: redirects, `tee`, and the destinations of a literal `mv`, `git mv` or `cp`. A device stream (`/dev/null`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`, `/dev/tty`, `/dev/fd/<n>`) is never a target, so `cmd 2>/dev/null` mints no `FileWrite`; other paths under `/dev`, such as `/dev/shm`, stay targets.
- **The shell (`machine/tool-evidence-recorder.ts`).** It is the only production caller of `extractEvidence` and of the ledger append. It runs report discovery, resolves `FileWrite` paths against the call's cwd, and appends under the target epoch.
- **Targets.** Claude Code records into its own session ledger under the epoch attribution resolves (below). A Pi child's recorder (`pi/evidence-recorder.ts`) records into the parent session's ledger under the epoch its parent-issued write grant carries; a child without a valid grant records nothing and says so on stderr.
- **Per-file results.** A `TestRun` report summary always carries the per-file results its structured report lists. `parseReportSummary` is its only constructor and reconciles those results with the counts; a ledger record whose per-file data is malformed reads as untrusted as a whole. The strict byte parser behind completion checks and remediation yields counts alone (`ReportCounts`), so its output can never stand as a `TestRun` report.
- **Duplicates.** A record carries the harness `tool_use_id` as `callId`, and a fold drops a second delivery of the same call.

A matrix test feeds the same tool-call fixtures through both adapters and asserts identical records. Consumers read the ledger only through epoch folds: the SubagentStop test-result resolver, red-then-green settlement, the stop checks' changed files, and `helper stop-check-plan`.

### When a test run is trusted

A `TestRun` is trusted only when ground truth confirms it. A non-zero exit is a trustworthy failure on its own. A zero exit is trusted when a report artifact was parsed, and it counts as a pass only when that report shows at least one test and no failures; a zero-test report is a trusted non-pass, because nothing ran.

At SubagentStop a trusted run yields `{ verdict: "trusted-pass" }` or `{ verdict: "trusted-fail" }`. The transcript fallback yields `{ verdict: "untrusted", passed, label }`, and the label names how weak it is (`low-trust`, `degraded`, `fallback`, `snapshot-read-failed`), so an untrusted pass cannot pass for a trusted one. The `helper-reported` label is a separate untrusted source, minted only by the `store-test-evidence` helper from agent stdin.

Three rules decide whether a report may vouch for a run:

- **Freshness is call-scoped.** The PreToolUse Bash hook stamps the start of every Bash call (`<session>.callstart.json`, keyed by `tool_use_id`). A disk artifact may vouch only when its mtime is at or after that call's start, less about two seconds of filesystem slack, and inside a 15-minute cap. A missing stamp fails closed: artifact-backed sources are rejected loudly, and only reporter JSON printed to stdout, which is call-scoped by nature, can still vouch.
- **An agent cannot author its own report.** The recorder rejects an explicit `--outputFile` path the agent wrote in this epoch, by a file tool or by a shell write, including a write on the command line being judged. `printf '{…}' > r.json; npx vitest --outputFile=r.json` is vetoed, and so is `cp staged.json r.json`.
- **Exit ownership must be provable.** The line's exit is credited to the test segment only when it is the sole command, or the last command after `&&`, `;`, `&` or `|` for exit 0 (after `;` or `&` only for a non-zero exit). A backgrounded test never owns the exit, and neither does a runner inside `$(…)` or `<(…)`. `false && npx vitest …; true` and `npm test || true` yield `exit: null`, which is untrusted, while `cd engine && bun test` keeps its exit.

A later file write demotes an earlier pass.

## Attribution model (read this before adding a machine)

Evidence attribution is the pure `attributeEvidence` (evidence.ts). Claude
Code stamps `agent_id` on every hook fired inside a subagent (PreToolUse
and PostToolUse alike) and omits it for the main agent, while parallel
subagents share the parent's `session_id`. So:

- **Caller identity first.** A call carrying `agent_id` is recorded ONLY
  under that agent's own binding line — parallel bound subagents in one
  session each record into their own epoch. An `agent_id` that is
  reserved/path-unsafe, owns no binding line, or owns more than one
  records nothing (with a stderr audit line); it is never credited to a
  sibling.
- **Sole-active fallback.** A call with no `agent_id` (the main agent, or
  a harness that predates the field) falls back to the **sole-active
  rule**: evidence is recorded ONLY while exactly one subagent is active
  and exactly one machine is bound. Any contention stands it down with a
  stderr note. Pi needs neither rule: each Pi child is its own process and
  records under its grant's epoch, so its attribution is exact.

The live PreToolUse gate (`enforce-phase-tools`) uses the same attribution
through `phaseGateTarget`. A call carrying `agent_id` is judged against that
caller's own machine, so parallel bound subagents stay gated. A caller that
runs no machine passes through and is never judged by a sibling's machine.
An `agent_id` that is reserved/path-unsafe, or that owns two binding lines,
fails closed. Only a call with no `agent_id` uses the sole-active rule, and
it stands down when the session is contended. The recorder never blocks, so a bound-but-empty ledger surfaces
downstream as the `degraded` label. SubagentStop resolution is safe either
way, because it reads only the stopping agent's epoch.

**Binding liveness.** A binding is normally released by the agent's SubagentStop hook, but a gated subagent that dies without the hook firing must not gate the session until the next SessionStart sweep. Each binding line carries its bind timestamp, and the binding file's mtime is the activity anchor: the gate and the recorder refresh it on every tool call they see for the session. Because the anchor is one mtime per session binding file, this is session-activity liveness, not per-agent liveness: any activity in the session, the parent's included, keeps every binding fresh. A binding idle past `STALE_SUBAGENT_TTL_MS` (shared with the 60-minute SessionStart sweep) is treated as absent by every reader and reaped under the binding lock. Recovery therefore happens after the session idles for the TTL or at the next SessionStart sweep, not the moment the agent dies.

**The SessionStart sweep** deletes a whole session group (ledger, roster, bindings, sidecars) once all of it has idled past the TTL. It never deletes the session that is starting, because SessionStart also fires on resume, or a session whose `<session>.task_graph` pointer names a TaskGraph that still exists, so an orchestration paused overnight keeps its ledger. Every file of a session groups under one key (`sessionGroupOfTrackingFile`), so a session id with characters outside `[A-Za-z0-9_-]` cannot split into two groups. SessionStart input without a usable `session_id`, and a malformed pointer, are reported in the hook's diagnostics.

## Module layout (machine-checked purity)

`engine/src/machine/` is split into a pure core and an imperative shell, and the split is linted: `no-io-in-pure-modules` lists the pure core in its shipped defaults, and `engine/tests/linter/programmatic/machine-purity.test.ts` walks the import closure so the reducer can never re-acquire `node:fs` through a dependency.

- **Pure core** (no I/O, no env, no clock): `types.ts`, `advance.ts` (the reducer), `parse-machine.ts`, `extract-evidence.ts`, `mermaid.ts`, `test-report.ts` (report parsing and the trust judgment), `evidence.ts` (identity brands, binding and ledger line parsing, epoch attribution, the `SessionRegistry` port), `harness-tool-call-types.ts` (the normalized `HarnessToolCall`).
- **Imperative shell**: `ledger.ts` (binding, roster and ledger files with their locks), `tool-evidence-recorder.ts` (the one minting shell), `report-discovery.ts` (finding report artifacts on disk), `session-registry.ts` (the filesystem adapter of the `SessionRegistry` port; an in-memory fake lives with the tests).

## Known residual limits

- **The ledger covers logged facts only.** A write leaves a `FileWrite` only when a file tool made it or when the command text names its target. A file written through `dd of=`, a `$VAR` destination, an interpreter (`python -c 'open(…).write(…)'`), a code generator, a build step or a script leaves none. Every judgment over the ledger inherits this: the artifact veto, the demotion of a pass by a later write, the stop checks' changed files, and the red-then-green proof. Red-then-green proves that the logged history shows test-first work; it does not prove the agent wrote no code before its red run. It still makes the honest path the cheap one, because getting around it takes a deliberate unlogged write.
- **Shell writes are recorded, never prevented.** A Bash-minted `FileWrite` carries `via: "shell"` and never advances a phase, because the gate cannot deny a Bash call before it runs. Only tool writes (`via: "tool"`, or absent on older records) advance a machine.
- **A call with no `agent_id` runs ungated in a contended session.** Claude Code stamps `agent_id` on every subagent call, so parallel Waves stay gated; the limit applies to the main agent and to an older harness.
- **Pi children have no live phase gate.** Pi's `tool_call` guard cannot name the calling agent, so a machine's tool rule is prose there and settlement is the authority. Pi children do record facts (see [One minting rule](#one-minting-rule)).
- **A same-call forgery remains possible.** A "test" script that itself prints runner-shaped JSON, or one that stages a report during the judged call, can still vouch for itself.
- **The ledger is not a cryptographic log.** While orchestration authority is active, the state-file guard denies Bash writes to the ledger and binding paths. Full integrity would need HMACs or storage beyond an agent's reach.
- **The state-file guard judges command text, not the working directory.** `cd .claude; cd state; rm *.json` never names a guarded path, so no raw-text gate can see it. The single-hop form (`cd .claude/state && rm *.json`) is blocked on the `cd` segment.

## code-implementer-agent

<!-- Generated by machineToMermaid() from code-implementer-agent.machine.json — keep in sync via engine tests -->

```mermaid
stateDiagram-v2
    [*] --> read-context
    read-context --> implement : FileRead
    implement --> verify : FileWrite
    note right of implement : allows Edit, Write, MultiEdit
    verify --> done : TestRunPassed
    note right of verify : allows Edit, Write, MultiEdit
    done --> [*] : requires TestRunPassed
    note right of done : allows Edit, Write, MultiEdit
```

An agent that tries to Edit or Write before reading any file is blocked at the tool call, with an explanation of what advances the phase. The terminal phase's `requires` is consulted at settlement: the SubagentStop resolver folds the epoch's evidence through the machine and, when a terminal requirement is unmet, caps a trusted-pass verdict at untrusted with a `machine-incomplete` label naming what is missing. Unmet requirements demote the verdict; they do not block completion outright.

## distill-agent

<!-- Generated by machineToMermaid() from distill-agent.machine.json — keep in sync via engine tests -->

```mermaid
stateDiagram-v2
    [*] --> green-baseline
    green-baseline --> distill : TestRunPassed
    distill --> [*] : requires TestRunPassed
    note right of distill : allows Edit, Write, MultiEdit
```

The machine of a Distill Task's agent ([ADR-0068](../docs/adr/ADR-0068-the-distill-pass-is-an-engine-added-task-per-wave.md)). It makes one rule of the `distill` skill mechanical: no Edit, Write or MultiEdit before a test run that passed with a parsed report. Reads and Bash are outside its `enforcedTools`, so they are available from the start. After the baseline, writes and test runs are allowed in any order and any number.

The terminal requirement is the same single `TestRunPassed`, so an agent that ran a green baseline and changed nothing completes the machine, as does one that edited and passed again. The machine does not check that a pass follows the last write. Settlement does: a write after the last trusted pass demotes that pass, and the Distill Task's `behaviour-preserved` obligation then restores the files. Because the tool gate already requires the one passing run the terminal phase asks for, the `machine-incomplete` cap has nothing to demote for this machine.

On Pi the baseline rule is prose in the brief and the agent definition; settlement is the authority on both harnesses.

## security-hunter-agent

<!-- Generated by machineToMermaid() from security-hunter-agent.machine.json — keep in sync via engine tests -->

```mermaid
stateDiagram-v2
    [*] --> read-brief
    read-brief --> walk-boundary : FileRead
    walk-boundary --> demonstrate : FileRead >= 3
    demonstrate --> done : FileRead >= 5
    done --> [*] : requires FileRead >= 5
```

The machine of a security-audit hunter ([Running a security audit](../docs/security-audit.md)). Its `enforcedTools` are Edit, Write and MultiEdit, and no phase allows any of them, so a bound hunter cannot use a file tool at any point. The phases (`read-brief`, `walk-boundary`, `demonstrate`, `done`) advance on file reads and exist to name where the hunter is.

Bash is outside the machine's jurisdiction. A shell write is recorded as a `FileWrite` with `via: "shell"` and never advances a phase; it is not prevented. The only way a hunter claims an observed result is a sandbox receipt, which the ledger records as a `SandboxRun`.

A machine binds only while a TaskGraph is active. A standalone `/security-audit` therefore runs the hunter unbound, and what withholds the write tools there is the `tools:` list in `agents/security-hunter-agent.md` (Read, Glob, Grep, Bash).
