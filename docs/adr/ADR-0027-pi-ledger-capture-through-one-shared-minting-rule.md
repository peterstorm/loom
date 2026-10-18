# ADR-0027: Pi ledger capture through one shared minting rule

## Status
Accepted (2026-10-17). Records AD-8 of the G4 slice 2 oracle plan
(`.claude/plans/2026-10-16-g4-slice-2-oracle.md`, interview Q1 C and Q4 A).

## Context

Two invariants in this slice read the evidence ledger. I6 (red-then-green) judges a Task's test runs at
settlement, and I7 (the affected-test stop check) derives the Task's changed files from that Agent's
FileWrite facts at stop time. On Claude Code, a PostToolUse hook (`handlers/post-tool-use/record-evidence.ts`)
minted those facts with `extractEvidence` and appended them to the session ledger. Pi had no equivalent. A Pi
subagent is its own `pi --no-session` process, so the parent session never saw a hook fire for the child's
tool calls. Pi settlement fell back to structured transcript evidence, and the child's ledger epoch was
empty. Without ledger facts, I6 and I7 would ship dead on Pi. NFR-002 rules that out.

The Claude recorder also broke the rule this slice sets for minting facts. It called `extractEvidence`
and `.appendEvidence` itself, and it wired report discovery, the agent-authored-artifact veto and the
call-start stamp inline. A second harness could only reach that logic by copying it, and two copies of a
minting rule drift apart. A fact that means "this test run passed, backed by a fresh runner-written
report" must mean the same thing on both harnesses, or I6 and I7 judge the same work differently
depending on where it ran (SC-007).

Three more constraints shaped the choice:

- **Pi exposes no bash exit code.** A probe of Pi 0.83, unchanged in 0.84.2, showed that the bash tool's
  `tool_result.details` holds only `{ truncation?, fullOutputPath? }`. A nonzero exit is reported as
  `isError: true` with a trailing `Command exited with code N`. Aborts and timeouts have their own status
  lines.
- **Rename and copy destinations were invisible.** `extractShellWriteTargets` did not mint `mv`, `git mv`
  or `cp` destinations, so I7 could not see a file that was renamed into place (FR-034).
- **The child must write where the parent reads.** Settlement and the stop check run in the parent, so the
  child's facts are useful only in a ledger the parent can address. Attribution to the right Agent epoch has
  to be exact, not inferred.

## Options Considered

1. **One shared minting rule with a Pi child recorder that writes into the parent's ledger (chosen)**
   - Pros: one pure rule (`extractEvidence`) and one shell (`recordToolEvidence`) mint facts for both
     harnesses, so the rules cannot diverge. A matrix test can prove parity by running the same fixtures
     through both adapters. Pi facts are captured live at the tool call, with the same call-start freshness
     stamp and artifact veto that Claude gets. The grant the parent already issues at spawn carries the
     ledger address, so attribution is exact by construction (one child process is one Agent). It also
     removes the existing INV-4 violation in `record-evidence.ts`.
   - Cons: `extractEvidence` changes signature, so the Claude hook path is refactored as well. The child
     process now does a cross-session write into the parent's ledger. The write grant gains a field, and the
     grant MAC must bind it. The Pi bash outcome stays an approximation (`isError` read as 1 or 0) until Pi
     exposes an exit code.

2. **A Pi-only transcript-to-ledger converter run at settlement**
   - Pros: no change to the Claude path. No child-side recorder or cross-session write. Settlement already
     holds the transcript.
   - Cons: it reads text after the fact, so it has no call-start stamp and cannot apply call-scoped report
     freshness or the agent-authored-artifact veto at the time of the call. It is a second minting rule
     that would drift from `extractEvidence`. It cannot serve the I7 stop check, which needs FileWrite facts
     at stop time. Transcript-derived facts would stay untrusted, which defeats the point.

3. **Record into the child's own session ledger**
   - Pros: the simplest child-side write. No ledger address in the grant and no cross-session write.
   - Cons: the parent cannot address the child's session. A `--no-session` child has no session the parent
     knows how to read, so settlement and the stop check could never find the facts. Attribution would
     need a second mapping from child session to Agent epoch.

## Decision

**Both harnesses normalize each finished tool call to a `HarnessToolCall` and hand it to one shared shell,
`recordToolEvidence`. The shell is the only caller of `extractEvidence` and of the ledger append. Pi
children record into the parent's ledger at an address the parent mints into the write grant.**

- **Normalized call (CT-3).** `engine/src/machine/harness-tool-call-types.ts` declares `HarnessToolCall`
  as a union over `tool: "Read" | "Write" | "Edit" | "MultiEdit" | "Bash" | "Other"`, with `input`, a
  nullable `callId`, `cwd`, and a per-tool outcome. File tools carry `succeeded | failed`. Bash carries
  `exited { exit, stdout } | exit-unknown { stdout } | interrupted`. `Other` carries none. Each tool therefore holds only its own
  outcome kind, and an illegal pairing cannot be represented.
- **Pure adapters.** `engine/src/core/harness-tool-call.ts` is on `DEFAULT_PURE_MODULES` and holds
  `claudeToolCall(payload)` and `piToolCall(event, cwd)`. Both are total and never throw: an unknown Claude
  Code Bash shape degrades to `exit-unknown`, the outcome that trusts least (a Pi bash result is always read as an exit, below), while an unknown file-tool shape counts as
  success so a harness format change cannot starve the ledger of writes. Pi's file tools use `input.path`, while Claude uses
  `input.file_path`. The Pi bash exit is `details.exitCode` when it is an integer (FR-033). Otherwise it is
  `isError` read as 1 or 0, and an error ending in Pi's abort or timeout status line becomes `interrupted`.
  The probed Pi 0.83 `tool_result` shape is pinned in that module's header comment.
- **Pure minting rule.** `extractEvidence` in `engine/src/machine/extract-evidence.ts` (already pure) now
  takes a `HarnessToolCall`. `extractShellWriteTargets` mints literal `mv`, `git mv` and `cp` destinations
  as FileWrites (FR-034). *(Moved 2026-10-18.)* `extractShellWriteTargets` now lives in
  `engine/src/core/shell-write-targets.ts`, beside the guard's redirect scanner; `extractEvidence` imports it.
- **Shared shell (INV-4 owner).** `engine/src/machine/tool-evidence-recorder.ts` exports
  `recordToolEvidence(target, call, { registry, nowMs })`. It wires `findReport` with two inputs. One is the
  call-start stamp read from `target.stamps`; a missing call id or stamp fails closed on artifact-backed
  sources. The other is the agent-authored-artifact veto, made of the target epoch's FileWrites plus this
  call's own write targets. The shell resolves FileWrite paths against `call.cwd` at mint time and appends
  to `target.ledger` under `target.epoch`, keyed by call id.
- **Claude adapter.** `engine/src/handlers/post-tool-use/record-evidence.ts` keeps attribution
  (`attributeEvidence`), maps the hook payload with `claudeToolCall`, and calls the shell. It no longer
  mints or appends anything itself.
- **Ledger address in the grant.** The `IssuedWriteGrant` in `pi/write-grant.ts` gains
  `evidenceLedger: { sessionId, agentType }`. The parent mints it at spawn from its own session and the
  spawn item's Agent type, and issuance rejects an address whose Agent type differs from the grant's Agent.
  The grant MAC binds the field, and it is carried through consumption. The write grant is not a new
  lifecycle: `pi/write-grant.ts` and `pi/child-write-grant.ts` keep their existing issue, consume and revoke
  mechanics and the `ActiveChildWriteGrant` ADT. This decision adds no state or transition to them.
- **Pi child recorder.** `pi/evidence-recorder.ts` has one decision, the pure total
  `piEvidenceTarget(grant, rejected, childSession)`. A rejected grant returns
  `no-record: grant-rejected`. An absent grant returns `no-record: no-grant`. A binding that survives only as
  cleanup debt returns `no-record: cleanup-pending`. An active grant without a ledger address also reads as
  `no-grant`. An active grant with an address returns `record` into the parent's ledger under
  `epochOf(grant.agentId, agentType)`, and the stamps come from the child's own session, where the
  `tool_call` guard wrote them. Each no-record outcome is explained once per session and reason on stderr
  (AS-039). A session that is not a Loom child stays quiet. The recorder never throws: an unexpected failure
  is reported on stderr and records nothing. It registers before every other `tool_result` handler,
  because Pi chains those handlers and a later one would see an earlier rewrite.
- **Parent read-back.** `piChildEvidence(parentSession, slotToken, agentType)` recomputes the granted Agent
  id from the slot's grant token with `piGrantedAgentId`, the same derivation consumption uses. It returns a
  `LedgerObservation`: either `read` with that epoch's events, or `unreadable` with a reason when the token
  names no identity or the ledger cannot be read. It never returns an empty epoch in place of a failure.
  Pi settlement (I6, T9) and the Pi report-only stop check (I7, T10) consume it (FR-035).
- **Enforcement.** The checkable lint rule `.claude/linter/rules/inv-4-one-evidence-minting-rule.json`
  refuses `extractEvidence(` and `.appendEvidence(` everywhere except `extract-evidence.ts`,
  `tool-evidence-recorder.ts` and test files. `engine/tests/machine/evidence-minting.matrix.test.ts` runs the
  same fixtures through both adapters and asserts identical records. The fixtures cover read, edit, write,
  multi-edit, a bash redirect, mv/cp, and a test run with JUnit or Vitest per-file results (SC-007, AS-036).
  `engine/tests/pi/evidence-recorder.test.ts` pins `piEvidenceTarget` with one case per grant state.

## Consequences

**Positive:**
- One rule mints ledger facts for both harnesses. The lint rule and the parity matrix catch drift at the
  linter and in tests, not in production.
- I6 and I7 run on Pi with real, call-time ledger facts instead of transcript inference (NFR-002).
- Attribution is exact by construction: the parent names the ledger and epoch, and the grant MAC binds both.
  Nothing has to infer which Agent a fact belongs to.
- Renamed and copied files are now visible to I7 on both harnesses through the `mv`/`cp` destinations.
- The pre-existing INV-4 violation in the Claude recorder is gone, and the hook shrinks to attribution plus
  one adapter call.
- Failure modes are explicit. Each no-record grant state is a named reason on stderr, and an unreadable
  ledger is `unreadable`, never a silent empty epoch that could pass for "no tests ran".

**Negative:**
- The Pi bash exit code is coarse. Pi 0.83 and 0.84 expose none, so any failure is exit 1, and kills are
  detected by matching Pi's status-line text. If Pi changes that wording, a kill could read as exit 1
  instead of `interrupted`. The `details.exitCode` branch is ready for a future Pi version but is untested
  against a real one.
- A child process now writes into another session's ledger. That depends on the parent and child sharing a
  filesystem registry, and it adds concurrency between parent and children appending to one ledger file.
- A child with no grant, a rejected grant or a cleanup-pending grant records nothing. Its I6 and I7
  judgments then see no facts and fall back to whatever settlement does with an absent observation. The
  stderr note is the only signal at record time.
- A grant issued without `evidenceLedger` (for example by an older parent) silently disables recording as
  `no-grant`. The field is optional on the wire, which keeps compatibility but weakens the guarantee.
- The recorder must stay first in Pi's `tool_result` handler chain. That ordering is a registration
  convention in `pi/extension.ts`, not something the type system enforces.
- `extractEvidence`'s signature change touched hook-imported files, so the switch had to ship as one atomic
  commit.
