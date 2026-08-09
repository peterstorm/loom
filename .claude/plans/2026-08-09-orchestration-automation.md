# Plan: Engine-Owned Loom Orchestration Automation

**Spec:** `.claude/specs/2026-08-09-orchestration-automation/spec.md`
**Created:** 2026-08-09

## Summary

Move deterministic Wave Gate, panel, Standalone Review Run, status, context, capture, and remediation mechanics behind persistent engine-owned domain programs. The selected type-driven functional approach uses closed reducers as policy, Fugue 0.4.0 as the in-process state-machine/static-DAG runtime, immutable request/effect receipts at authority boundaries, and one minimal parent-facing action contract. Semantic Agent work and genuine user decisions remain explicit.

This is an incremental brownfield extension of `panel-program.ts`, `standalone-review.ts`, Wave Gate checks, `StateManager`, existing no-follow Run Directory operations, and both harness adapters. It adds no workflow DSL, daemon, queue, database, Redis, BullMQ, or second protected State File writer.

---

## Architectural Decisions

### AD-1: Approach selection (panel)

**Choice:** Use candidate 2, `candidate-type-driven-fp.md`, as the base even though the panel recommended candidate 1. Implement separate closed domain programs with pure reducers, parser-produced authority proofs, immutable effect intents/receipts, and persistent Fugue execution. Expose only `spawn-batch`, `await-user`, `blocked`, and `done` through one minimal shared transport envelope—not a workflow language.

**Why:** The user explicitly selected the type-driven candidate for its 10/10 pure-functional-core result and requested substantially more Fugue. Control its additional type/module cost by grafting the simplicity candidate's single façade/minimal contract and the risk candidate's narrow authority boundaries rather than adding a registry, generic program descriptor, broad broker, or monolithic runner.

**Panel record:**
- Manifest: `.claude/specs/2026-08-09-orchestration-automation/panel-runs/run.RIzvYedN0m/manifest.json`
- Run id: `run.RIzvYedN0m`
- Manifest lenses, in order: `simplicity-first`, `type-driven-fp`, `risk-security-first`
- Canonical verdicts: `.claude/specs/2026-08-09-orchestration-automation/panel-runs/run.RIzvYedN0m/verdicts/verdict-1.json`, `verdict-2.json`, `verdict-3.json`
- Ranking: `.claude/specs/2026-08-09-orchestration-automation/panel-runs/run.RIzvYedN0m/ranking.json`

**Criterion verdicts:**
- `simplicity`: simplicity-first 8, type-driven-fp 4, risk-security-first 2; one façade/session won, while the selected candidate's ADTs, brands, receipts, and capability machinery were judged substantially more complex.
- `pure functional core`: type-driven-fp 10, risk-security-first 9, simplicity-first 8; total reducers plus immutable effect data/typed receipts won, while the simple runner retained too much imperative policy.
- `codebase fit + effort`: simplicity-first 9, type-driven-fp 6, risk-security-first 5; direct reuse of reducers, storage, `StateManager`, and helpers won, while the selected candidate's original 12–16 week shape was too broad.

**Computed ranking (authoritative):**

| Rank | Candidate | Total | Scores (`simplicity`, `pure functional core`, `codebase fit + effort`) |
|---:|---|---:|---|
| 1 | `candidate-simplicity-first.md` | 25 | 8 / 8 / 9 |
| 2 | `candidate-type-driven-fp.md` | 20 | 4 / 10 / 6 |
| 3 | `candidate-risk-security-first.md` | 16 | 2 / 9 / 5 |

**User selection:** `candidate-type-driven-fp.md` (rank 2, total 20).

**Panel recommendation:** `candidate-simplicity-first.md` (rank 1, total 25), because it best matched the primary simplicity axis and brownfield effort while retaining a strong pure core.

**Compatible grafts:**
- From simplicity-first: one parent-facing façade and one minimal external-action contract; reuse existing reducers, stores, `StateManager`, and helpers rather than creating a workflow registry.
- From type-driven-fp's strongest judged idea: only an exact-roster parser produces `CompleteRoster<AcceptedResult>`, which aggregation/tally require.
- From risk-security-first: an anchored `RunDirHandle` exposes fixed artifact operations, Fugue validation/routing nodes remain capability-free, reducers stay pure, and narrow adapters own filesystem/protected-state/harness/Git effects.
- From risk-security-first's fit verdict: every spawn binds immutable engine-issued `AgentRequestAuthority`, `BatchPublishedReceipt`, harness `SpawnReceipt`, and `CaptureReceipt`; no request is executable before its artifact batch is durable.
- From all candidates and local-source inspection: use only Fugue 0.4.0's shipped public APIs. Agent-call nodes, nested subgraphs, cross-node loops, and dynamic fan-out remain explicit absent boundaries.

**Executable-model decision:** Do not author a plan-level AuthoredDag sidecar. Local `AuthoredDag` v1 permits one DAG in one of five single shapes (`linear`, `fan-out`, `diamond`, `router`, `sources`), requires each node to occupy exactly one structural role, and Loom permits one sidecar per plan. This feature needs several distinct operation DAGs plus persistent event-driven machines and roster-sized semantic batches represented as values. Combining them would require a generic DSL or absent nested/dynamic/cyclic/Agent primitives. The executable sources are the imported lifecycle machines below and direct use of Fugue's public `Machine`, `JobLike`, `runStateMachine`, `replayEvents`, `defineDag`/shape helpers, `runDag`, `runResumableDagJob`, capability, conditional-edge, HITL, and tracing APIs. No decorative graph artifact is created.

**Rejected:**
- `candidate-simplicity-first.md` as base — lower effort, but publication, persistence, dispatch, and Fugue adaptation remain insufficiently explicit in its replayable core.
- `candidate-risk-security-first.md` as base — strongest hardening, but mandatory DAG execution for every query and hash-linked/write-ahead machinery conflict with the simplicity axis.
- Generic workflow registry/DSL — violates FR-004 and erases distinct domain vocabularies.
- One AuthoredDag for the feature — cannot truthfully express this architecture under Fugue 0.4.0 and Loom's one-pipeline rule.

---

## File Structure

### Shared kernel and domain programs

```text
engine/src/core/orchestration-contract.ts                         — authority brands, rosters, effects, receipts, actions, errors (new)
engine/tests/core/orchestration-contract.property.test.ts         — conservation/binding/terminal properties (new)
engine/src/core/panel-program.ts                                  — persistent architecture/refutation reducers and Machine adapters
engine/src/handlers/helpers/panel-program.ts                       — legacy journal compatibility adapter
engine/tests/core/panel-program.test.ts                            — panel transition/authority tests
engine/tests/handlers/helpers/panel-program.test.ts                — compatibility/resume tests (new)
engine/src/core/wave-gate-machine.ts                               — Wave Gate machine and canonical status (new)
engine/src/types.ts                                                — protected active-run registration/status types
engine/src/state-manager.ts                                        — parse registration; remains sole State File writer
engine/src/handlers/helpers/complete-wave-gate.ts                  — compatibility commit adapter
engine/tests/handlers/complete-wave-gate.test.ts                   — readiness/status/locked-commit parity
engine/src/core/standalone-review.ts                               — byte-aware complete-roster aggregate/finalization
engine/src/core/standalone-review-machine.ts                       — Standalone Review machine (new)
engine/src/handlers/helpers/standalone-review.ts                   — versioned legacy adapter
engine/tests/core/standalone-review.test.ts                        — aggregate/lifecycle tests
engine/tests/handlers/helpers/standalone-review.test.ts            — historical/new format tests
engine/src/core/remediation-machine.ts                             — remediation lifecycle/path algebra (new)
engine/tests/core/remediation-machine.property.test.ts             — path/transition properties (new)
```

### Fugue runtime, DAGs, and effect boundaries

```text
package.json                                                       — exact Fugue/Zod runtime dependencies
engine/package.json                                                — exact engine dependencies
engine/bun.lock                                                    — resolved lock
engine/src/orchestration/fugue-program-runtime.ts                  — Machine/JobLike/replay/HITL/tracing adapter (new)
engine/tests/orchestration/fugue-program-runtime.test.ts           — crash/resume/replay tests (new)
engine/src/orchestration/run-directory-handle.ts                   — anchored fixed-operation handle and JobLike (new)
engine/src/orchestration/context-packets.ts                        — immutable byte-aware context packets (new)
engine/src/orchestration/effect-runner.ts                          — closed effects and receipt reconciliation (new)
engine/tests/orchestration/publication-faults.test.ts               — atomicity/no-follow fault injection (new)
engine/src/orchestration/dags/panel-operations.ts                  — architecture/refutation validation and aggregate/tally DAGs (new)
engine/src/orchestration/dags/wave-gate-operations.ts              — preparation and advisory HITL DAGs (new)
engine/src/orchestration/dags/standalone-review-operations.ts      — start/aggregate/critical-route DAGs (new)
engine/src/orchestration/dags/remediation-operations.ts            — path-audit/staged-set DAGs (new)
engine/tests/orchestration/fugue-operation-dags.test.ts             — topology/routing/capability/HITL tests (new)
```

### Git, façade, harnesses, and migration

```text
engine/src/orchestration/git-remediation.ts                        — fixed argv/NUL pathspec temporary-index adapter (new)
engine/tests/orchestration/remediation-index.test.ts                — exact set/deletion/rename/rollback tests (new)
engine/tests/orchestration/remediation-faults.test.ts               — index/worktree fault injection (new)
.gitignore                                                         — exclude ephemeral Wave Gate/Refutation run evidence
engine/src/handlers/helpers/orchestration.ts                       — start/resume/submit/decide/status/remediate façade (new)
engine/src/cli.ts                                                  — façade routes
commands/loom.md                                                   — status/actions; delete state/journal recipes
commands/wave-gate.md                                              — external actions only
skills/review-and-fix/SKILL.md                                     — external actions only
pi/transcript-adapter.ts                                           — exact final-result byte extraction
pi/extension.ts                                                    — request reservation/context lowering/direct capture
engine/src/handlers/subagent-stop/capture-orchestration-result.ts  — Claude request-bound capture (new)
engine/src/handlers/subagent-stop/dispatch.ts                      — capture before legacy routing
engine/tests/orchestration/orchestration-acceptance.test.ts         — parity, benchmark, bytes, interruption (new)
```

---

## Component Design

### Shared Authority and Action Kernel

**Responsibility:** Make run, slot, request, roster, effect, and receipt authority explicit without defining workflow stages.
**Files:** `engine/src/core/orchestration-contract.ts`
**Depends on:** existing panel/model/path parsers.

**Interface:**

```typescript
type OrchestrationRunId = string & { readonly __brand: "OrchestrationRunId" };
type RequestId = string & { readonly __brand: "RequestId" };
type SlotId = string & { readonly __brand: "SlotId" };
type ContextDigest = string & { readonly __brand: "ContextDigest" };
type EffectId = string & { readonly __brand: "EffectId" };
type RepositoryPath = string & { readonly __brand: "RepositoryPath" };

type ExactRoster<S> = Readonly<{ orderedSlots: readonly [S, ...S[]]; byId: ReadonlyMap<SlotId, S> }>;
type CompleteRoster<R> = Readonly<{
  ordered: readonly [R, ...R[]];
  bySlot: ReadonlyMap<SlotId, R>;
  readonly __proof: "CompleteRoster";
}>;

type AgentRequestAuthority = Readonly<{
  runId: OrchestrationRunId; requestId: RequestId; slotId: SlotId;
  program: "architecture-panel" | "refutation-panel" | "wave-gate" | "standalone-review";
  role: string; attempt: 1 | 2; modelProfile: LlmProfileId;
  harnessBinding: Readonly<{ pi: PiModelBinding; claude: ClaudeModelBinding }>;
  requiredSkill: string; contextDigest: ContextDigest; outputSlot: FixedArtifactSlot;
}>;

type ExternalAction =
  | Readonly<{ kind: "spawn-batch"; runId: OrchestrationRunId; receipt: BatchPublishedReceipt; requests: NonEmpty<SpawnRequest> }>
  | Readonly<{ kind: "await-user"; runId: OrchestrationRunId; request: UserDecisionRequest }>
  | Readonly<{ kind: "blocked"; diagnostic: BlockedDiagnostic }>
  | Readonly<{ kind: "done"; runId: OrchestrationRunId; outcome: ArtifactRef }>;

type EffectIntent = PublishArtifactSet | CommitProtectedWaveState | ReserveAgentRequests
  | CaptureRawTranscript | InspectGitRemediation | InstallVerifiedIndex;
type EffectReceipt = ArtifactSetPublished | ProtectedWaveStateCommitted | AgentRequestsReserved
  | RawTranscriptCaptured | GitRemediationInspected | VerifiedIndexInstalled;
```

`parseCompleteRoster(exactRoster, results)` is its only constructor. It proves length, identity, uniqueness, canonical order, accepted attempt, request/context/model/Skill binding, and no surplus. Aggregate/tally APIs accept only this proof. `BlockedDiagnostic` is a closed union with run/category/request/slot/effect, retry eligibility, and one permissible recovery. Infrastructure retries never consume semantic attempts.

### Separate Domain Programs

**Responsibility:** Keep architecture, Refutation, Wave Gate, Standalone Review, and remediation state/event vocabularies distinct while sharing only authority envelopes and persistence mechanics.
**Files:** `engine/src/core/panel-program.ts`, `engine/src/core/wave-gate-machine.ts`, `engine/src/core/standalone-review-machine.ts`, `engine/src/core/remediation-machine.ts`
**Depends on:** Shared Authority and Action Kernel.

```typescript
const architecturePanelMachine: Machine<ArchitectureState, ArchitectureEvent, ProgramContext>;
const refutationPanelMachine: Machine<RefutationState, RefutationEvent, ProgramContext>;
const waveGateMachine: Machine<WaveGateState, WaveGateEvent, WaveGateContext>;
const standaloneReviewMachine: Machine<StandaloneState, StandaloneEvent, StandaloneContext>;
const remediationMachine: Machine<RemediationState, RemediationEvent, RemediationContext>;
```

Architecture/refutation lens types remain disjoint. Caller lens/criterion/candidate/Finding claims are compared but never authoritative; request authority supplies canonical identity. New sessions expose no parent `engine-operation`: deterministic operation DAGs run internally and return typed receipts. The legacy panel event helper translates historical/in-flight documents without rewriting them.

Wave Gate owns readiness, batch-atomic packet/request/context preparation, exact missing-slot recovery, critical routing, advisory decision, and completion. `deriveLoomStatus(graph, session)` calls the same pure readiness/action priority used by the machine and yields exactly one next action plus all reasons. The protected graph stores a parsed active Wave Gate registration (run/wave/authority digest/revision/terminal outcome); Run Directory progress cannot independently advance Tasks.

Standalone Review freezes exact scope, changed-path metadata, roster, model/context/request authority, and transcript slots before spawn. Absent scope becomes only the canonical changed-path union; empty/ambiguous/external/unsafe scope blocks. Aggregate accepts `CompleteRoster<CapturedReviewerResult>` and routes zero criticals directly to finalization.

Remediation makes `AuditedPathSet` the only staging input and a verified temporary index the only installation input. New test/support paths require an explicit registration event.

### Fugue Program Runtime and Run Directory Persistence

**Responsibility:** Execute domain machines and finite deterministic DAGs with Fugue's public API over existing local storage.
**Files:** `engine/src/orchestration/fugue-program-runtime.ts`, `engine/src/orchestration/run-directory-handle.ts`
**Depends on:** domain machines and existing `panel-run.ts` anchoring patterns.

```typescript
type RunDirHandle = Readonly<{
  readAuthority(): ParsedAuthority;
  appendProgramEvent(event: ProgramEvent, dedupKey: string): Promise<void>;
  replaceCheckpoint(checkpoint: SerializedCheckpoint): Promise<void>;
  publishContext(packet: ContextPacket): Promise<ContextPublishedReceipt>;
  publishArtifactSet(set: StagedArtifactSet): Promise<ArtifactSetPublished>;
  reserveTranscript(authority: AgentRequestAuthority): Promise<TranscriptReserved>;
  captureTranscript(authority: AgentRequestAuthority, bytes: Uint8Array): Promise<RawTranscriptCaptured>;
  readReceipt(effectId: EffectId): EffectReceipt | null;
}>;
```

The handle is constructed only from a parser-proven runs-root/run identity and retains descriptor anchors. It has no arbitrary path API. It consolidates Linux `/proc/self/fd`, `O_DIRECTORY`, `O_NOFOLLOW`, `O_EXCL`, exclusive immutable writes, and atomic rename.

```text
authority.json                        immutable run/roster/root authority
checkpoint.json                       atomic projection, not primary history
events/<sequence>-<dedup>.json        immutable Fugue/domain events
requests/<request-id>.json            immutable request authority
contexts/<sha256>.json                complete immutable context packets
transcripts/<slot>/attempt-<n>.raw    exact harness bytes
receipts/<effect-id>.json             typed effect/publication receipts
artifacts/...                         domain artifacts/final outputs
```

The file-backed `JobLike` guarantees dedup. Following Fugue's contract, `appendEvent` lands before `updateData`; a crash leaves one immutable event that retry recognizes, then checkpoint catches up. Checkpoints use public `toJson`/`fromJson` for Map/Set and are parsed before use. `replayEvents` proves/reconstructs state but never repeats effects.

For Wave publication, write/verify files first, then one `StateManager.update` registers every packet/context/request digest and batch authority. Pre-commit files are inert; matching receipts let resume finish without republishing. This is a safe commit-reference protocol, not a false multi-resource transaction claim.

### Fugue Operation DAGs

**Responsibility:** Execute stable deterministic preparation, validation, fan-out/fan-in, conditional routing, retry, HITL, and tracing without treating semantic Agents as nodes.
**Files:** `engine/src/orchestration/dags/*.ts`
**Depends on:** Fugue Program Runtime, domain machines, effect adapters.

| DAG | Public Fugue mechanisms | Purpose |
|---|---|---|
| Architecture operations | `defineFanOut`/`defineDag`, transforms, fan-in | validate candidates/verdicts and aggregate ranking |
| Refutation operations | transforms, fan-in, conditional/default edges | prove lens coverage and strict-majority tally |
| Wave preparation | fixed source + fan-out/fan-in | derive spec-check, packet set, models, contexts; join before publication |
| Advisory decision | `createHumanReviewNode`, `runResumableDagJob` | durable suspension only for genuine user triage |
| Standalone operations | conditional/default routing | explicit/derived scope and clean/critical route |
| Remediation operations | transforms and conditional route | authority/dirty/staged equality before installation intent |

Validation/set/routing nodes use `createTransformNode`, `requires: []`, and Zod contracts. Genuine edge effects use only a narrow custom capability (`runArtifacts`, `protectedStateCommit`, `gitIndex`); no node receives arbitrary filesystem/process/State File access, and only `protectedStateCommit` delegates to `StateManager`.

Roster/task-count work remains a `NonEmpty`/`ExactRoster` value inside static nodes, not dynamic fan-out. Semantic work is a returned `spawn-batch`; retry is machine state across resumes, not a back-edge; program composition is shell sequencing, not a nested graph. Fugue retries only classified transient idempotent operations. Authority/schema/path failures are non-retriable. Traces contain ids, hashes, counts, route labels, duration/retry/suspend outcomes—not prose/context bytes.

### Context, Harness Capture, and Request Receipts

**Responsibility:** Deliver complete immutable context by reference and bind exact raw completion bytes identically across harnesses.
**Files:** `engine/src/orchestration/context-packets.ts`, `pi/transcript-adapter.ts`, `pi/extension.ts`, `engine/src/handlers/subagent-stop/capture-orchestration-result.ts`, `engine/src/handlers/subagent-stop/dispatch.ts`
**Depends on:** request authority, context publication, model/Skill gates, Pi reservations.

```typescript
type ContextPacket = Readonly<{
  schemaVersion: 1; digest: ContextDigest; requestId: RequestId;
  role: string; requiredSkill: string; outputContract: string;
  fixedContext: readonly ByteSection[]; variableContext: readonly ByteSection[];
}>;
type SpawnReceipt = Readonly<{
  requestId: RequestId; harness: "pi" | "claude";
  nativeParentId: string; nativeAgentId: string; modelBindingDigest: string;
}>;
type CaptureReceipt = Readonly<{
  requestId: RequestId; spawnReceiptId: string; artifact: ArtifactRef;
  byteLength: number; sha256: string;
}>;
```

Packets contain fixed rules, variable Task/plan/spec/packet/manifest/lens/criterion data, Skill, exact model binding, output contract, and request identity. Parent actions carry only compact references. Pi lowers the packet inside the extension. Claude's compact prompt makes packet loading the child bootstrap's first context action; pre-spawn gates verify request/model/Skill/digest, and acceptance re-hashes it. Parent models never copy packet bytes.

Pi binds `toolCallId + result index + agent` to `RequestId`; Claude binds stored request authority to `session_id + agent_id + agent_type` and pre-spawn receipts. Each accepts exactly one unambiguous final text payload, encodes once as UTF-8 without trim/join/reformat, and calls the same capture port. Wrong run/Agent/request/model/context/attempt, missing identity, ambiguity, duplicate, stale, late, and surplus evidence is audited but cannot accept a slot. Capture runs before legacy dispatch and never resolves an unrelated State File for standalone runs.

### Remediation Git Boundary

**Responsibility:** Stage exactly authorized changes while preserving unrelated work and excluding Run Directories.
**Files:** `engine/src/core/remediation-machine.ts`, `engine/src/orchestration/git-remediation.ts`
**Depends on:** finalized standalone result.

Paths enter through one canonical POSIX-relative parser. Git uses fixed executable/argument templates, literal NUL pathspecs, canonical cwd, bounded output/time, and allowlisted environment; Agent prose never enters command text. Start from `result.json.scope`, register additions explicitly, snapshot index/worktree, and block before mutation when pre-existing staged paths are outside authority. Unrelated unstaged bytes remain unchanged.

Build a temporary index from the expected base, handle add/modify/rename/delete/absent paths, verify `audited == dirty == staged`, exclude every Run Directory root, then install only if index/worktree witnesses have not drifted. Failure removes the temporary index and leaves real index/worktree unchanged.

### Orchestration Façade and Migration

**Responsibility:** Give the parent one deep interface while retaining historical outcomes until parity is proven.
**Files:** `engine/src/handlers/helpers/orchestration.ts`, `engine/src/cli.ts`, command/Skill docs.
**Depends on:** all programs/adapters.

```text
helper orchestration start <architecture|refutation|wave-gate|standalone-review|remediation> ...
helper orchestration resume --run <registered-run>
helper orchestration submit --request <request-id> --capture-receipt <receipt-id>
helper orchestration decide --request <decision-id> < decision.json
helper orchestration status [--json] [--run <registered-run>]
```

Each mutating call locks one aggregate, parses authority, applies at most one event/receipt reconciliation, persists it, runs eligible internal DAGs, and returns one external action. Resume is idempotent and never silently spawns or decides policy.

Migration is format-detected, not a destructive flag: new sessions use versioned programs; old helpers remain adapters; historical/in-flight runs are never rewritten; Wave/status switch after replay parity; harness capture switches after attribution/byte parity; procedural Bash/`jq`/journal/transcript/staging recipes are deleted only after benchmark success. Existing artifacts remain readable indefinitely.

---

## Data Flow

### Start/resume

```text
unknown input → parse authority → anchored run/protected registration
→ parse checkpoint + immutable event prefix → replay consistency
→ domain Machine transition → reconcile EffectIntent by receipt
→ run eligible static Fugue DAG → event/checkpoint commit
→ exactly one ExternalAction
```

### Semantic request/result

```text
pure preparation → complete packet/context/request set staged → byte/hash verify
→ BatchPublishedReceipt (+ StateManager registration for Wave work)
→ spawn-batch → harness SpawnReceipt → visible semantic Agent
→ exact final bytes → exclusive transcript + CaptureReceipt
→ authority validation → accept/retry/terminal-block
→ parseCompleteRoster → Fugue aggregate/tally DAG
```

Completion order never selects slots. Attempt 1 failure emits only that slot's attempt 2; attempt 2 failure terminal-blocks the owning program. Valid siblings remain accepted. Done/terminal-blocked states audit but do not absorb late input.

### Wave Gate

```text
locked Task graph + active run → readiness → fixed preparation fan-out/fan-in
→ atomic publication/registration → review spawn batch → exact capture roster
→ critical route: empty → advisory HITL/completion; non-empty → Refutation Program
→ locked readiness recheck → StateManager completion → done
```

### Remediation

```text
final result scope + registered paths → repository/index witness → pure set audit
→ AuditedPathSet → temporary index → exact staged-set verify
→ witness compare-and-swap → install receipt → audit artifact
```

---

## Lifecycles

Architecture and Refutation reducers in `engine/src/core/panel-program.ts` are already executable and remain separate; implementation imports/adapts them rather than creating a descriptive duplicate. These declarations cover the three new machine files imported and run through Fugue.

### LC-1: Wave Gate program

**Machine file:** `engine/src/core/wave-gate-machine.ts`
**Kind:** typed-reducer
**States:** preparing, awaiting-review-results, awaiting-refutation, awaiting-advisory-decision, ready-to-complete, recoverable-blocked, done, terminal-blocked

| Event | From | To |
|---|---|---|
| preparation-published | preparing | awaiting-review-results |
| result-accepted (incomplete) | awaiting-review-results | awaiting-review-results |
| result-rejected (attempt 1) | awaiting-review-results | awaiting-review-results |
| result-rejected (attempt 2) | awaiting-review-results | terminal-blocked |
| complete-roster-with-criticals | awaiting-review-results | awaiting-refutation |
| complete-roster-with-advisories | awaiting-review-results, awaiting-refutation | awaiting-advisory-decision |
| complete-roster-clean | awaiting-review-results, awaiting-refutation | ready-to-complete |
| advisory-decision-accepted | awaiting-advisory-decision | ready-to-complete |
| completion-committed | ready-to-complete | done |
| recoverable-effect-failed | any non-terminal state | recoverable-blocked |
| recovery-receipt-accepted | recoverable-blocked | recorded predecessor state |

### LC-2: Standalone Review program

**Machine file:** `engine/src/core/standalone-review-machine.ts`
**Kind:** typed-reducer
**States:** preparing, awaiting-results, aggregating, awaiting-refutation, ready-to-finalize, recoverable-blocked, done, terminal-blocked

| Event | From | To |
|---|---|---|
| review-batch-published | preparing | awaiting-results |
| result-accepted (incomplete) | awaiting-results | awaiting-results |
| result-rejected (attempt 1) | awaiting-results | awaiting-results |
| result-rejected (attempt 2) | awaiting-results | terminal-blocked |
| complete-roster-proved | awaiting-results | aggregating |
| aggregate-clean | aggregating | ready-to-finalize |
| aggregate-has-criticals | aggregating | awaiting-refutation |
| refutation-completed | awaiting-refutation | ready-to-finalize |
| result-published | ready-to-finalize | done |
| recoverable-effect-failed | any non-terminal state | recoverable-blocked |
| recovery-receipt-accepted | recoverable-blocked | recorded predecessor state |

### LC-3: Remediation authority

**Machine file:** `engine/src/core/remediation-machine.ts`
**Kind:** typed-reducer
**States:** authority-frozen, paths-registered, audited, staged-temporary-index, verified, recoverable-blocked, done

| Event | From | To |
|---|---|---|
| support-path-registered | authority-frozen, paths-registered | paths-registered |
| audit-succeeded | authority-frozen, paths-registered | audited |
| temporary-index-staged | audited | staged-temporary-index |
| staged-set-verified | staged-temporary-index | verified |
| index-installed | verified | done |
| recoverable-effect-failed | any non-terminal state | recoverable-blocked |
| recovery-receipt-accepted | recoverable-blocked | recorded predecessor state |

---

## Implementation Phases

Eleven implementation slices occupy four implementation Waves. Decompose also emits the one AD-1 writer Task in a fifth/final Wave: twelve Tasks total.

### Phase 1: Authority foundation (no dependencies)

**Task 1 — Shared authority/roster/action/effect ADTs**
- Implement authority smart constructors, `ExactRoster`/`CompleteRoster`, immutable requests, minimal actions, typed effects/receipts, diagnostics, and properties.
- Brand only authority-bearing concepts; define no generic stages/workflow types.
- **Files:** `engine/src/core/orchestration-contract.ts`, `engine/tests/core/orchestration-contract.property.test.ts`

### Phase 2: Domain programs (depends on Phase 1)

**Task 2 — Persistent panel programs**
- Deepen separate architecture/refutation reducers, canonical request-slot binding, complete-roster aggregate/tally, Machine adapters, and legacy journal translation.
- **Files:** `engine/src/core/panel-program.ts`, `engine/src/handlers/helpers/panel-program.ts`, `engine/tests/core/panel-program.test.ts`, `engine/tests/handlers/helpers/panel-program.test.ts`

**Task 3 — Wave Gate machine/status/protected registration**
- Implement LC-1, shared readiness/status, active run parsing, and locked `complete-wave-gate` delegation.
- **Files:** `engine/src/core/wave-gate-machine.ts`, `engine/src/types.ts`, `engine/src/state-manager.ts`, `engine/src/handlers/helpers/complete-wave-gate.ts`, `engine/tests/handlers/complete-wave-gate.test.ts`

**Task 4 — Standalone Review machine/byte aggregation**
- Implement LC-2, frozen authority, raw byte metadata, complete aggregation, routing/finalization, and v1 reads.
- **Files:** `engine/src/core/standalone-review.ts`, `engine/src/core/standalone-review-machine.ts`, `engine/src/handlers/helpers/standalone-review.ts`, `engine/tests/core/standalone-review.test.ts`, `engine/tests/handlers/helpers/standalone-review.test.ts`

**Task 5 — Remediation authority machine**
- Implement LC-3 and pure path/index witness algebra; only audited state can stage and only verified state can install.
- **Files:** `engine/src/core/remediation-machine.ts`, `engine/tests/core/remediation-machine.property.test.ts`

### Phase 3: Fugue and authority adapters (depends on Phase 2)

**Task 6 — Fugue runtime and durable local JobLike**
- Pin `@fuguejs/framework` 0.4.0 and direct Zod 4.3.6; implement Machine HALT/replay/serialization/dedup/checkpoint/tracing without Redis/BullMQ.
- Test append→checkpoint crashes, replay, terminal monotonicity, and corruption.
- **Files:** `package.json`, `engine/package.json`, `engine/bun.lock`, `engine/src/orchestration/fugue-program-runtime.ts`, `engine/tests/orchestration/fugue-program-runtime.test.ts`

**Task 7 — RunDirHandle/context/effect receipts**
- Implement fixed anchored operations, immutable contexts, artifact-set markers, transcript slots, receipt reconciliation, and every publication fault point.
- **Files:** `engine/src/orchestration/run-directory-handle.ts`, `engine/src/orchestration/context-packets.ts`, `engine/src/orchestration/effect-runner.ts`, `engine/tests/orchestration/publication-faults.test.ts`

**Task 8 — Static Fugue operation DAGs**
- Implement separate panel, Wave/HITL, standalone, and remediation DAGs using real public APIs; test topology/routes/capabilities/retries/suspend/traces.
- **Files:** `engine/src/orchestration/dags/panel-operations.ts`, `engine/src/orchestration/dags/wave-gate-operations.ts`, `engine/src/orchestration/dags/standalone-review-operations.ts`, `engine/src/orchestration/dags/remediation-operations.ts`, `engine/tests/orchestration/fugue-operation-dags.test.ts`

**Task 9 — Safe remediation Git adapter**
- Implement fixed argv/NUL operations, temporary index, witnesses, exact equality, run-root exclusion, compare-and-swap, rollback/fault tests.
- **Files:** `engine/src/orchestration/git-remediation.ts`, `engine/tests/orchestration/remediation-index.test.ts`, `engine/tests/orchestration/remediation-faults.test.ts`, `.gitignore`

### Phase 4: Interface, harness parity, and cutover (depends on Phase 3)

**Task 10 — Façade/status/compatibility/runbook deletion**
- Implement deep commands and legacy adapters; remove parent `jq`, journals, packet/model loops, transcript copies, and staging recipes.
- **Files:** `engine/src/handlers/helpers/orchestration.ts`, `engine/src/cli.ts`, `commands/loom.md`, `commands/wave-gate.md`, `skills/review-and-fix/SKILL.md`

**Task 11 — Pi/Claude capture and replay benchmark**
- Implement request reservation/context lowering/exact-byte capture before legacy routing.
- Run all five fixtures, interruption points, invalid evidence classes, parity, and byte equality.
- Enforce ≥80% fewer command characters, ≥70% fewer deterministic parent calls, and all mandated zero counts.
- **Files:** `pi/transcript-adapter.ts`, `pi/extension.ts`, `engine/src/handlers/subagent-stop/capture-orchestration-result.ts`, `engine/src/handlers/subagent-stop/dispatch.ts`, `engine/tests/orchestration/orchestration-acceptance.test.ts`

### Phase 5: Decision record (depends on all implementation phases)

Decompose creates one `adr-writer-agent` Task from AD-1 after implementation, recording the panel outcome, selected base/grafts, direct Fugue runtime and sidecar rejection, authority model, migration constraints, and what shipped. Total: twelve Tasks, five Waves.

---

## Testing Strategy

| Component | Unit Tests | Integration Tests | Property Tests |
|---|---|---|---|
| Authority kernel | constructors, bindings, errors, action priority | disk/harness parser round trips | roster conservation; no partial proof; order independence |
| Panels | every state/event/attempt | legacy document → persistent same outcome | arbitrary order/duplicates/stale/surplus/retry/terminal/replay |
| Wave/status | readiness and action priority | locked registration/completion | status/program agreement; all-or-none batch |
| Standalone | scope, attribution, bytes, finalization | six reviewers → optional panel | exact slots; zero-critical skip; complete dispositions |
| Remediation | paths/witnesses/set algebra | temp Git add/modify/rename/delete/absent | staged=audited=dirty; unauthorized/run paths never install |
| Fugue runtime | Machine/HALT/checkpoint parsers | real file JobLike/runStateMachine/replay | prefix replay=checkpoint; no duplicate event/effect |
| Fugue DAGs | pure transforms/predicates | real runDag/runResumableDagJob/capability fakes | route totality; branch pruning; pure nodes require nothing |
| RunDir/effects | fixed operations/receipts | real descriptors/staging | every injected failure yields zero false completion |
| Harnesses | exact payload parser/attribution | Pi reservation/Claude Stop fixtures | equivalent outcomes; byte equality; malformed never accepts |
| Façade/benchmark | typed rendering | five legacy/new replay pairs | thresholds and forbidden-operation counts cannot regress |

At least 90% of policy is pure and mock-free. Use in-memory `JobLike`, plain capability fakes, fixed clock/RNG, and temp repositories. Compile-time negative tests reject cross-program events, unproved rosters, brand swaps, interactive requests in parallel batches, and staging without `AuditedPathSet`.

Approved replay fixtures:
1. two-Task Wave, no critical Findings;
2. Wave with missing reviewer and one retry;
3. Wave with surviving and refuted critical Findings;
4. six-reviewer Standalone Review, three refutation lenses;
5. remediation adding a regression test and deleting a scoped file.

Compare canonical transitions, request identities, slots, artifacts, Finding dispositions, next actions, and gate decisions across legacy/new and Pi/Claude runs. Persist measured baseline/new counters as fixtures; Agent prose is never measurement evidence.

---

## Security & NFR Notes

- **Authority:** request authority selects run/slot/attempt/model/Skill/context/destination; caller prose does not.
- **Filesystem:** descriptor-anchored fixed operations only; unsafe/external/redirected paths fail before use.
- **Protected state:** only `StateManager.update` writes it; every Wave commit rechecks locked authority.
- **Commands:** Git uses argument arrays/NUL pathspecs; Agent output appears in zero command strings.
- **Context/raw evidence:** digests recheck at spawn/acceptance; raw bytes are exclusive and separate from parsed evidence.
- **Concurrency:** semantic completion may reorder, but one writer and canonical slots make outcomes deterministic.
- **Recovery:** accepted events replay idempotently; receipts suppress duplicate effects; terminal states are monotonic.
- **Observability:** immutable events, requests, results, receipts, rejected evidence, retries, Fugue traces, Findings, status, and benchmark counters remain inspectable.
- **Performance:** fixed branches run concurrently and content-addressed packets remove repeated bytes; local JSON remains sufficient.
- **Deployment:** exact Fugue 0.4.0 in existing Bun package; no Fugue private/advanced imports when main public exports suffice; no Fugue repository changes.
- **Known boundary:** no Agent node, nested subgraph, cross-node loop, or dynamic fan-out. Any future addition requires a Fugue release and new decision.
- **Retention:** no automatic cleanup or expiry.

---

## Verification

1. `bun --cwd engine run typecheck` passes with no Fugue private-source imports.
2. `bun --cwd engine run test:unit` passes existing/new unit and property suites.
3. `bun --cwd engine run test:smoke` passes panel, Refutation, standalone, Pi, and compatibility smoke tests.
4. Fault injection after every event/checkpoint/artifact/context/transcript/StateManager/index boundary yields zero false completion/partial authority.
5. Five-scenario benchmark meets ≥80% character and ≥70% tool-call reductions plus every mandated zero count.
6. Pi/Claude fixtures have byte-equal raw captures and equivalent transitions, identities, artifacts, dispositions, actions, and completion.
7. Loom's model parser binds LC-1..LC-3 exactly and finds no Pipeline/invariant artifact requirement.
8. Remediation fixtures stage zero Run Directory evidence and no unauthorized paths.
