# Guarded Skill Machines

Deterministic phase machines that **drive** subagent runs — the runtime
enforces phase order and tool availability; the agent's tool calls are the
events that advance the machine. Prose skills stay for judgment; machines
add hard gates. See the v2 convergence plan (vault:
`reclaw/plans/deterministic-core-convergence-v2`) for the design rationale.

## How it works

- `<agent-type>.machine.json` here opts that agent type into gating
  (no file → no gating; a one-file bugfix agent doesn't need a machine).
  Gating is active only during orchestrated loom runs (the SubagentStart
  shim requires an active task graph); ad-hoc subagent launches are ungated.
- **SubagentStart** binds the machine to the session with an **epoch**
  (`<agent_id>:<agent_type>`). An *invalid* machine file binds too — the
  gate then fails closed with the parse error instead of enforcement
  silently switching off.
- **PostToolUse** (`record-evidence`) appends epoch-stamped, **facts-only**
  records to `<session>.evidence.jsonl`: `FileRead`, `FileWrite`, and
  `TestRun` carrying the real exit status plus a parsed report artifact
  (vitest/jest JSON via `--outputFile`/stdout, JUnit XML — JVM runners
  only). Judgments (`passed`/`trusted`) are derived from the facts at read
  time, never stored. Transcript text is never evidence.
- **PreToolUse** (`enforce-phase-tools`) folds the agent's own epoch into
  the current phase and denies enforced tools the phase doesn't list —
  deny-by-default within the machine's declared `enforcedTools`
  jurisdiction. Unexpected evaluation errors fail **closed** once a binding
  exists.
- **SubagentStop** resolves the task's `test_result` from the stopping
  agent's own epoch only. A trusted `TestRun` (exit + report cross-checked)
  yields `{ verdict: "trusted-pass" }` or `{ verdict: "trusted-fail" }`;
  the transcript-regex fallback remains but yields
  `{ verdict: "untrusted", passed, label }` with the label naming exactly
  how weak it is (e.g. `low-trust` / `degraded` / `fallback` /
  `snapshot-read-failed` / `helper-reported`) — trust
  provenance lives in the data, so an untrusted pass can never masquerade
  as a trusted one.

A `TestRun` is trusted only when ground truth confirms it: a nonzero exit
is trustworthy failure on its own; a zero exit is trusted whenever a report
artifact was parsed — but it counts as a PASS only when that report shows
≥1 test and 0 failures (a zero-test report is a trusted non-pass: nothing
ran). Command classification parses the command into
segments and requires a runner at head position — `echo "npm test: 5
passing"` and `git grep "npm test"` produce no TestRun at all.

## Attribution model (read this before adding a machine)

The harness gives tool calls no agent identity, so evidence attribution
rests on the **sole-active rule**: evidence is recorded and the live gate
enforces ONLY while exactly one subagent is active and exactly one machine
is bound. Any contention — a second subagent of any type, a second binding
— stands both down, each with a stderr note (the recorder still never
blocks, so a bound-but-empty ledger surfaces downstream as the
`degraded` label). SubagentStop resolution is safe either way,
because it reads only the stopping agent's epoch.

**Binding liveness.** A binding is normally released by the agent's
SubagentStop hook — but a gated subagent that dies without the hook firing
must not gate the session until the next SessionStart sweep. Each binding
line carries its bind timestamp, and the binding file's mtime is the
activity anchor: the gate and the recorder refresh it on EVERY tool call
they see for the session. Because tool calls carry no agent identity, this
is **session-activity** liveness, not per-agent liveness — any activity in
the session (the parent's included) keeps every binding fresh, so a dead
subagent's binding survives while the session is being used. A binding
idle past `STALE_SUBAGENT_TTL_MS` (shared with the 60-minute SessionStart
sweep) is treated as absent by every reader and reaped under the binding
lock — recovery happens after the session idles for the TTL (or at the
next SessionStart sweep), not the moment the agent dies.

## Module layout (machine-checked purity)

`engine/src/machine/` is split along the FC/IS boundary and the split is
**self-linted** — `no-io-in-pure-modules` lists the pure core in its
shipped defaults, and `engine/tests/linter/programmatic/machine-purity.test.ts`
additionally walks the import closure so the reducer can never re-acquire
`node:fs` through a dependency:

- **Pure core** (no I/O, no env, no clock): `types.ts`, `advance.ts`
  (the reducer), `parse-machine.ts`, `extract-evidence.ts`, `mermaid.ts`,
  `test-report.ts` (report parsing + the trust judgment), `evidence.ts`
  (identity brands, binding/ledger line parsing, epoch attribution, the
  `SessionRegistry` port).
- **Imperative shell**: `ledger.ts` (binding/roster/ledger files + locks),
  `report-discovery.ts` (finding report artifacts on disk),
  `session-registry.ts` (the fs adapter of the `SessionRegistry` port; an
  in-memory fake lives with the tests for property-testing attribution
  invariants over interleavings).

Known residual limits, on purpose and documented:
- The sole-active rule means parallel waves run without the live gate:
  tool calls carry no agent identity, so with more than one subagent
  active the gate and recorder stand down rather than cross-credit. The
  per-epoch SubagentStop audit still applies to whatever the sole-active
  windows recorded.
- Report freshness checks *recency* (15-minute window), not that the
  artifact postdates the command — so it bounds, but does not eliminate,
  same-family cross-run artifact vouching, and a *planted* report can still
  work. The recorder rejects (loudly) an explicit `--outputFile` path that
  the agent itself wrote this epoch (a `FileWrite` in its own ledger —
  Edit/Write tools AND Bash redirect/`tee` targets, which mint `FileWrite`
  too, INCLUDING targets of the very command line being judged, so a
  one-call `printf '{…}' > r.json; npx vitest --outputFile=r.json` stage
  is vetoed), but a report staged via a Bash write with no static
  target in the command text — `cp`/`mv`, `dd of=`, or a file authored by
  an interpreter (`python -c 'open(...).write(...)'`) — mints nothing and
  can still vouch, as can a report written before the epoch began or
  produced by a "test" script that itself echoes runner-shaped JSON.
  Stamping reports with an mtime-≥-command-start bound is the known
  follow-up (needs PreToolUse timestamps).
- Bash-minted `FileWrite` events carry `via: "shell"` and never advance a
  guard (the gate cannot enforce Bash) — they exist for the artifact veto
  and the modified-after-pass demotion. Tool writes (`via: "tool"`, or
  absent on pre-`via` records) are the only guard-advancing writes.
- Exit-status attribution is composition-aware and fails closed: the
  line's exit is credited to the classified test segment only when
  ownership is provable (a sole command; or the LAST command after `&&`,
  `;`, `&`, or `|` for exit 0 — after `;`/`&` only for nonzero). A
  BACKGROUNDED test (`npx vitest &`) never owns the exit. Compositions
  like `false && npx vitest …; true` or `npm test || true` therefore yield
  `exit: null` (untrusted), while `cd engine && bun test` keeps its exit.
- Ledger records carry the harness `tool_use_id` as an optional `callId`;
  the fold boundary drops duplicated deliveries of the same call, so a
  re-sent PostToolUse cannot double-count guard evidence.
- A consistent forgery of ledger *facts* via Bash is blocked by the
  guard-state-file hook (the ledger and binding paths are guarded state
  files); full integrity (HMAC or out-of-agent-reach storage) is a
  follow-up.
- `FileRead` means the Read tool specifically — context gathered only via
  Grep/Glob/Bash does not advance `read-context`.

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

An agent that tries to Edit/Write before reading any file is blocked at
the tool call with an explanation of what advances the phase. The terminal
phase's `requires` can be computed (`missingRequirements` is exported for
it) but is not yet consulted anywhere at runtime; both surfacing it in
evidence labeling and hard-blocking completion on it are Phase A
follow-ups.
