# Loom engine internals

The complete technical reference for how a Loom run works: every stage of `/loom`, and the machinery underneath all of them — identity, packets, capture, reviewer scheduling, attempts, settlement, the Wave Gate, and recovery. This is the single document to read when you want to know *how the engine actually does it*, not just what you as an operator must do.

**Status of this document.** It explains shipped behaviour as of the revision noted in the repository tip. When prose and code differ, the normative precedence is (see [docs/README.md](README.md#normative-sources)):

1. Parsed types, reducers, validators, and policy catalogs in `engine/src/core/`.
2. The orchestration façade and adapters in `engine/src/handlers/helpers/orchestration.ts` and `engine/src/orchestration/`.
3. User-facing runbooks in `commands/` and `skills/`.
4. Explanatory documents in `docs/` and the root README.

Companion documents: [Workflows](workflows.md) (what each command does), [Operations](operations.md) (operating and recovery), [Verification](verification.md) (checks and proofs), [Standalone review](standalone-review.md) (reviewer protocol and remediation), [Feature & Guard Map](feature-guard-map.md) (mechanism-by-mechanism map with residuals), [Architecture](architecture.md) (layers and boundaries), and the [ADR index](adr/README.md) (why each decision was made).

---

## 1. The design in one sentence

> Language models perform semantic work and users make genuine policy decisions. Loom code owns deterministic routing, identity, validation, persistence, retries, aggregation, and state transitions.

Every mechanism in this document exists to replace one predictable prompt-only failure. The pattern, stated once ([Architecture §Guarantees](architecture.md#guarantees-and-honest-limits)):

| Concern | Prompt-only failure | Deterministic replacement |
|---|---|---|
| Task completion | Agent says "done" | Engine-derived proof obligations |
| Tests | Transcript text looks green | Provenance-preserving ledger/structured evidence |
| Review rerun | Old blocker omitted | Generation + packet + exact prior-id assessments |
| Panel | Caller swaps or skips verdicts | Exact slots and complete-roster parser |
| Retry | Parent improvises | Typed attempt-1/attempt-2 lifecycle |
| Workflow order | Markdown sequence | Reducer state/event algebra |
| Transcript persistence | Parent copies output | Harness captures exact bytes into fixed slots |
| State writes | Agent edits JSON | Guard + StateManager + typed commit effect |
| Run artifacts | Prompt chooses paths | Anchored fixed-layout RunDirHandle |
| Git staging | Broad `git add` | Audited temporary index and witness recheck |

---

## 2. The layers, and where code lives

```text
commands / skills / agents / templates / rules      ← Layer 1: product resources
                    |
          harness adapter boundary
       +------------+-------------+
Claude Code hooks            Pi extension
hooks/hooks.json              pi/extension.ts          ← Layer 2: adapters
       +------------+-------------+
                    |
        handlers + parsers (shell boundary)             ← Layer 3
       pure domain cores and typed reducers             ← Layer 4: engine/src/core/
                    |
      orchestration façade + program drivers            ← Layer 5: engine/src/orchestration/
       +------------+-------------+
protected TaskGraph       immutable Run Directory
(StateManager)            (RunDirHandle)               ← the two persistence domains
```

- **Layer 1 — product resources.** `commands/` (slash-command runbooks), `commands/templates/` (parameterized phase/task/panel prompts), `agents/` (Agent definitions with model profiles and required Skills), `skills/`, `rules/`, `references/` (templates, lens catalogs, on-demand runbooks), `lint-rules/` and `machines/` (executable policy). Claude Code consumes them from the plugin; Pi renders them into a content-addressed cache and renders Agent definitions into the user agent directory (`scripts/sync-pi-agents.sh`, byte-compared at spawn time).
- **Layer 2 — harness adapters.** Small shell shims per Claude Code hook, each delegating to `bun engine/src/cli.ts <hook-type> <handler>`; `engine/src/handler-routes.ts` is the closed routing table, with a `FAIL_CLOSED_ROUTES` set that blocks when the handler crashes. Pi's `pi/extension.ts` maps `tool_call`, `tool_result` and agent-lifecycle events onto the same core decisions and adds the three things Claude Code does not need: one-time write grants for children, batch-item→request binding, and a recorder that writes a child's tool calls into the parent's evidence ledger.
- **Layer 3 — handler shell.** `engine/src/handlers/` turns untrusted harness payloads and CLI args into calls to the core. The rule is *parse, do not cast*: nothing becomes a domain value until a parser has reconstructed its invariants.
- **Layer 4 — pure cores.** `engine/src/core/` holds harness-neutral policy and reducers. No I/O, no env, no clock; `core/` never imports `config.ts`. Enforced by the shipped lint rules (`no-io-in-pure-modules`, `no-cross-boundary-imports`) and `machine-purity.test.ts`, which walks the import closure.
- **Layer 5 — orchestration shell.** `engine/src/orchestration/` is the imperative shell: program drivers over journals, the effect runner, and the filesystem adapters (`run-directory-handle.ts`, `artifact-probe.ts`, `owner-verification-runner.ts`, …).

Dependency direction: `core ← handlers/orchestration ← adapters/runbooks`. A new module under `engine/src` must state its boundary before it can hold code (`no-cross-boundary-imports`).

---

## 3. Persistence: the two domains

Everything Loom persists lives in exactly one of two domains with opposite tamper properties.

### 3.1 The protected TaskGraph (the State File)

One JSON file is the orchestration authority for a feature run: the State File at .claude/state/active_task_graph.json under Claude Code, .pi/state/active_task_graph.json under Pi.

It holds the phase, phase artifacts, skipped phases, the plan/spec bindings, Tasks and Waves, proof results, review generations and runs, Findings, Wave Gate registrations, advisory dispositions, Acceptance Contracts with their freeze and revisions, owner obligations, the frozen verification manifest, GitHub tracking metadata, and the friction record (retros).

**Shape at `init-state`** — nobody authors it by hand; `cli.ts init-state` writes it before the first phase:

| Field | At `init-state` | Later |
|---|---|---|
| `current_phase` | `init`, or the first phase the skip flags leave | Advanced by `advance-phase`; `populate-task-graph` moves `decompose` → `execute` |
| `phase_artifacts` | `{}` | One entry per completed phase |
| `skipped_phases` | From `--skip-*` flags | Unchanged |
| `plan_design_review` | `{"status":"required"}`, or `not-required` with `--skip-plan-design-review` | `accepted` bound to the plan's SHA-256, only via `accept-plan-design-review` |
| `spec_dir` | `.claude/specs/<date-slug>` | Unchanged |
| `spec_file`, `plan_file` | `null` (`spec_file` set at once with `--skip-specify`) | Recorded when the phase artifact appears |
| `tasks`, `wave_gates` | `[]`, `{}` | Installed by `populate-task-graph` |

**Legacy shapes are refused at load** (ADR-0098). `parseTaskGraph` refuses, with one operator message naming the shape, a State File only a retired engine writes: an executing Task without `active_implementation_attempt`, an `implemented` or `completed` Task without a frozen `proof`, an `execute`-phase graph without `verification_manifest`, a Task carrying a field replaced long ago, and a `wave_gate_history` entry archived without a Wave completion suite. The way forward is to finish the run on the engine that wrote it, or to re-populate from the spec and plan.

**The loaded graph holds parsed values only.** Every Task and TaskGraph field has a parser, and `parseTaskGraph` builds the graph and each Task from those values, never from a spread of the raw document. A key no `Task` or `TaskGraph` field names is refused at load (`unknown Task field "…"`, `unknown TaskGraph field "…"`), judged after every other rule; a field added to either type does not compile until its parser installs it (ADR-0098 addendum).

Task status moves `pending` → `implemented` (attempt satisfies proof within its byte scope) → `completed` (its Wave Gate passed). A Task stays `pending` through infrastructure blocks, a failed attempt 1 (one retry), and a failed attempt 2 (terminal escalation; there is no attempt 3).

**Protection is layered** ([Operations §Protected state rules](operations.md#protected-state-rules)):

1. Mode `0444` at rest.
2. `guard-state-file` — deny-by-default Bash guard over the state file, evidence, binding and machine paths. The decision is pure (`core/guard-state-file.ts`); the hook and Pi's `tool_call` twin arm it only while a graph exists and resolve the guarded directories at decision time. It judges shell text through a reveal-monotonic view pipeline (quotes, ANSI-C strings, parameter expansion, brace/glob forms, substitutions, heredocs; wrappers and fused spellings normalized; unparseable forms fail closed; each segment judged by what it can *write*, not what it mentions). Read-only `git`/`gh`/`sort`/`uniq`/`find` forms and the whitelisted helpers pass.
3. `guard-subagent-authority` — fences subagents off from parent-only helper operations, hook entrypoints, nested harnesses, and security-audit authority (defence in depth; the real proof is capture attestation, §4.4).
4. Under Pi, a content-addressed **Runtime Revision handshake**: the extension hashes `engine/src/`, `pi/` and package metadata at load; mutating CLI routes re-hash the checkout before dynamic import and `StateManager` repeats the check before any chmod/lock/write. Skew refuses the mutation with a `/reload` diagnostic; status stays readable.
5. **Engine revision pin** (`core/engine-revision-pin.ts`): the State File records the engine revision that wrote it; a different revision refuses to write until `helper orchestration adopt-engine-revision` moves the pin under audit (loom#198, Cause 4).
6. `StateManager` serializes writes under a lock (`.task_graph` leaf beside the file) with temporary-file + atomic rename; it parses the *complete* graph before use.
7. Only hooks and narrowly allowlisted helpers hold write authority. Run-scoped programs publish evidence outside the graph and commit protected state only through typed effects.

**Every guard keys on the live graph path**: `block-direct-edits`, the spawn gates, the state guard, the machine gate. `complete-orchestration` archives the graph and removes the live file, which lifts them all. `block-direct-edits` guards the Git root owning the State File plus, always, the protected directories (`LOOM_SUBAGENT_DIR`, `LOOM_MACHINES_DIR`); writes whose every symlink-resolved target lies outside both pass — so worktrees of the same repo and sibling directories are writable (ADR-0046).

### 3.2 Immutable Run Directories

Every registered program — Wave Gate, standalone review, disposition, remediation, security verification — writes its evidence into a **fresh, direct-child Run Directory** under a runs root (`mktemp -d`-style; `start` never creates the root, so a mistyped root cannot grow a second tree):

```text
run.<id>/
├── authority.json      # the run's issued authority
├── abandoned.json      # present only once an operator retires the run
├── program.json
├── checkpoint.json     # a projection; never the history
├── events/             # append-only journal, dedup-keyed events
├── requests/           # issued request records; correlators/
├── contexts/           # packet files: section identity only
├── blobs/              # section bytes, one file per section digest
├── transcripts/        # captured final bytes, per fixed output slot
├── receipts/           # capture receipts, effect receipts
└── artifacts/          # published artifacts (result.json, dispositions, read coverage, …)
```

`orchestration/run-directory-handle.ts` anchors every access: direct-child relation verified, unsafe identity/path shapes rejected, path components reopened **no-follow** (Linux `/proc/self/fd` descriptor-relative; macOS `O_NOFOLLOW_ANY`). Authority, request, context, section-blob, transcript, event and receipt slots are immutable/exclusive — a symlink swap, a duplicate publication or a mismatched run identity fails closed.

**Program durability** (ADR-0029): durable history is an append-only journal of dedup-keyed events (`orchestration/program-journal.ts`); the checkpoint is only a projection beside it. Because an append is idempotent on its dedup key, a crash between publishing an artifact and journalling its event resumes by republishing the same bytes and journalling once. Refutation panels persist as a checkpoint whose event prefix must replay exactly to the recorded state and is re-proved on every read; the architecture panel is not a registered program (ADR-0096).

**Effects and idempotency**: reducers emit typed effect intents; `orchestration/effect-runner.ts` executes them and records receipts. On resume, an already-receipted effect is *reconciled*, not run again. This separates "the domain authorizes this effect" from "the shell performed it". Each effect reaches only the adapter it needs (RunDirHandle for artifacts, StateManager for protected state, the Git adapter for index operations).

**Retirement**: runs are never deleted. `helper orchestration abandon` writes `abandoned.json` once, immutably (optionally naming the successor); afterwards the evidence stays readable but every advancing operation refuses, and no recovery can adopt the run as a pristine replacement. When the retired run owned the matching protected Wave Gate registration, the same command stamps that registration `terminal-abandoned` under the TaskGraph lock and appends a `retired_wave_review_runs` provenance record (§6.9.9).

---

## 4. Identity and authority: requests, packets, captures

This is the machinery the informal phrase "signed packets" points at. Loom has no asymmetric signatures; it has something stricter in practice for its threat model: **content-addressed digests chained from the bytes up to the protected state record that proves issuance**, plus harness-persisted capture attestations and one HMAC (Pi write grants). Nothing is trusted because a model or a parent said so.

### 4.1 Agent request authority — what one spawn is allowed to be

Every engine-issued semantic request is one `AgentRequestAuthority` (`core/orchestration-contract/roster.ts`):

```text
runId            which Run Directory this request belongs to
requestId        unique per request
slotId           which roster slot (role + lens/criterion + attempt identity)
program          wave-gate | standalone-review | refutation | architecture | …
role             the Loom Agent name (code-reviewer, decompose-agent, …)
attempt          1 | 2 (the semantic attempt)
modelProfile     the profile the request was issued under (recorded; may be retired)
harnessBinding   the EXACT bindings: Pi (provider, model, thinking) + Claude (model)
requiredSkill    the Skill the prompt must name (or null)
contextDigest    SHA-256 of the exact Context Packet this request is bound to
outputSlot       the fixed transcript slot the final bytes are captured into
```

The type is **minted, not built**: `mintAgentRequestAuthority` is the only constructor, and it checks the request against today's Agent Catalog (`core/model-profiles.ts`) at the moment of issuance — profile exists, Pi binding is the profile's current lowering (Pi is local-only, ADR-0023), Claude frontmatter matches, required Skill resolves. Every issuing seam takes the minted type or mints what it issues itself (`mintAgentRosterSlot` for a fresh roster slot, `issueExactRoster` which mints every slot of an exact roster and refuses one the catalog will not mint, naming the slot id and the catalog's reasons). A builder that skipped the catalog check does not compile. Coverage stops at aggregates persisted as issued and only read back — recorded history may name a retired profile or a retired cloud Pi target, and a panel issued before a catalog change is never re-minted.

What this kills: a parent (or a prompt-injected child) substituting a cheaper model, dropping a required skill, or pointing a request at a packet that was not issued for it. The spawn hooks re-validate the binding again at the harness seam (`validate-agent-model`, `validate-agent-skill`).

### 4.2 Context Packets — the "signed" content

A Context Packet (`core/context-packets.ts`) is the complete context one semantic request receives, **addressed by content digest**. Structure:

- The packet file carries `schemaVersion`, `digest`, `requestId`, `role`, `requiredSkill`, `outputContract`, `fixedContext`, `variableContext`.
- Content is a list of **ByteSections**: `{label, byteLength, digest, bytes}` — one labelled, digested run of exact bytes.
- The packet **digest covers section identity (label, length, digest), not an inline byte encoding**; section bytes live once in the run's blob directory, one file per section digest, and every read restores them through one resolver and re-hashes each section. (A 34 MB Wave Gate run stores 1.9 MB because the frozen Wave source is one blob shared by a Task's reviewers and their retries, not a byte array copied per packet.)
- Publication is write-once, before the spawn action is returned. A packet whose identity/section bytes change gets a different digest — and its request's `contextDigest` would no longer match, so it cannot be silently swapped.

Reviewer packets assemble a fixed inventory of sections, exact per protocol version:

| Section | Carries |
|---|---|
| `reviewer-payload-schema` | the frozen JSON schema of the reviewer's response, per protocol version |
| `reviewer-impact-rubric` | the frozen rubric (what blocking means, severity rules) |
| `wave-frozen-source` | (Wave) the Task's declared/modified review scope as frozen postimage bytes, from the same dirty/untracked/absent snapshot as `workspaceHeadSha` |
| `standalone-frozen-diff` | (Standalone) one unified diff per scoped file, baseline → exact frozen bytes |
| `owner-map` | (Wave, code-reviewer + architecture-tech-lead on owner-family Tasks) the second-copy rule and the Task's owned-family duties |
| `contract-surface` | (Wave, type-design-analyzer + architecture-tech-lead on contract Tasks) the Acceptance Contract surfaces to judge |
| `plan-design-lens` | (Plan design review) the design lens text |
| `standalone-lineage`, `standalone-assessment-roster` | (Successor v3) the inherited origins, each row's standing, citable decisions and allowed verdicts |
| `refutation-authority` / `wave-refutation-authority` | (Verifiers) the lens name and the complete critical set |

Lens definitions and wire contracts are not prose copies: `scripts/stamp-wire-contract.ts` stamps them into the Agent definitions from `references/review-lenses.md` and the executable schemas, and tests pin the stamp (ADR-0073: every documented wire example is parsed by its production parser).

**The read path.** The issued task carries a concrete `LOOM_CONTEXT_READ_COMMAND`: a shell-quoted `bun` invocation of the package's `scripts/read-context-packet.ts` with the packet path and the *expected* request id, digest, role and Skill. The reviewer runs it with Bash; there is no `readContextPacket` harness tool. Paging: first a bounded section index (≤32 entries/page), then `--section LABEL` or `--file EXACT_SOURCE_PATH`, then `--offset/--limit` (4096 UTF-16 units per page; 48 KiB encoded output bound). The reader uses no-follow reads, fatal UTF-8, and re-checks the expected identity; a mismatch fails visibly. Expected IDs in the task are *not* the publication proof — that proof belongs to engine delivery.

**What a digest proves and does not.** Digests prove the bytes are the issued bytes. They do not attest that a child *read* them (that is read coverage, §7.5, standalone-only) or that a result belongs to the request (that is the capture boundary, §4.4).

### 4.3 Review Packets — the Wave review subject

Distinct from the Context Packet: a **Review Packet** (`core/review-packet.ts`) is the immutable snapshot of *what is being reviewed* for one Task at one Review Generation:

- Task ↔ base/head Git revisions ↔ exact path scope ↔ per-file diffs ↔ postimage bytes ↔ plan context ↔ proof obligations.
- Scope covers Git-visible leaves at either revision (deleted leaves included, ignored excluded, symlinks by target); every scoped path must cover ≥1 artifact; **empty scope fails rather than broadening to the Wave**.
- Self-hashes prove integrity; the **registration of the packet in the protected TaskGraph, created atomically with the Review Run, proves issuance**. A caller-authored file with recomputed hashes is not authority.
- **Review Generation** is monotonic per Task: any implementation byte change increments it and invalidates in-progress review runs — late evidence for older bytes cannot mutate current review state.
- A **Review Run** freezes: packet identity, the exact reviewer roster, the ordered active Finding ids, generation and repository revisions.

### 4.4 Capture — how a result comes home, provably

The parent never copies transcripts. The harness captures exact final bytes into the request's fixed output slot, and the engine accepts a result only against the issued authority.

**The session run binding.** Every `spawn-batch` (and every `done` with a `result.json`) the façade returns is first published as a registry file `<session-id>.orchestration-runs.json` under `LOOM_SUBAGENT_DIR` (default `/tmp/claude-subagents`), naming the run and the request ids it issued, stamped with the owning harness. A missing session id withholds the batch — no request is ever issued that nobody could capture. Claude Code: `CLAUDE_CODE_SESSION_ID` (`CLAUDECODE=1`); Pi: `PI_SESSION_ID` (`PI_CODING_AGENT=true`). The SessionStart sweep keeps the registry while a run it names is open (no recorded result, no `abandoned.json`, no terminal checkpoint state), for at most `OPEN_RUN_GRACE_MS` past the idle TTL (ADR-0101); a run idle beyond that loses its binding and needs `orchestration resume`.

**The request identity and the issuing run.** Every engine-issued task carries two authority markers, `LOOM_REQUEST_ID` and `LOOM_CONTEXT_DIGEST`, written only by `renderSpawnTaskText` and read only by `parseIssuedTaskIdentity` beside it (`core/spawn-task-text.ts`, ADR-0099): `unbound` (no line claims either), `malformed` (incomplete, two different values, or not canonical) or `bound` (a branded request id and Context Packet digest). Identical repeated marker lines name one identity. Both harnesses then ask one pure rule, `resolveIssuingRun` (`orchestration/session-run-bindings.ts`): the explicit `LOOM_ORCHESTRATION_RUNS_ROOT`/`LOOM_ORCHESTRATION_RUN_DIR` run when set (both or neither, `explicitRun`), otherwise exactly one session binding whose run issued every named request under its exact digest (`resolveIssuingSessionBinding`). Request ids are not unique across runs, so the digest is part of the match; none or several matches fail closed. Claude reads the run's location; Pi's `piIssuingRun` keeps the binding (its reservations and review witnesses carry it) and returns the issuing run opened once, with the requests it issued. The lint rule `.claude/linter/rules/inv-11-one-request-marker-parser.json` refuses a second reader.

**Claude Code capture.** `record-orchestration-spawn` (PostToolUse on `Task`/`Agent`) records the native `agent_id` against the one run that issued the prompt's request identity; the correlator write refuses an issued request whose digest differs from the prompt's, explicit run or not. At SubagentStop, `capture-orchestration-result` writes the exact final bytes into the run's transcript slot and a durable `raw-transcript-captured` receipt. A foreground Agent call can finish before its PostToolUse fires; the stop then reads the correlator from the agent's own spawn prompt (the transcript's opening message) before capturing. A `SubagentHandback` final is captured from the call's `message`.

**Pi capture.** Each spawn reserves a **ReservedSlot** storing the exact request authority; Pi's native batch-item identity binds to the engine's request identity; the extension captures at the native boundary with a run-bound short-circuit, plus current-session process witnesses for standalone runs. A Pi child that ends without the parent's involvement is captured from its reserved slot.

**Manual/compat paths.** `submit` (bounded at 16 MiB stdin; accepts `--tool-outputs PATH` for non-capturing harnesses) and `correlate` exist for transport integration; native operation on both harnesses goes through the capture boundary, and neither harness routes current reviewers into legacy concatenation or `CRITICAL_COUNT` polling.

**Capture attestations (the security-program proof).** For the security-audit verifier program (ADR-0067, amended), the *capturing harness process* writes one attestation per captured attempt into a store under the protected subagent directory (`core/capture-attestation.ts`): program, run, run directory, request, slot, attempt, role, the harness's native id, and the SHA-256 + length of the exact captured bytes. A verifier ballot is authoritative only when its binding's `captureDigest` equals the attested digest of its request and the transcript in the run still hashes to it. The shell-string subagent guard is defence in depth; the attestation is the proof — which is why a Pi restart cannot strand a captured run (`verify --from` re-proves ballots against persisted attestations).

**Pi write grants (the one HMAC).** A Pi child is a separate process that could otherwise write anything the parent session could. At spawn, the parent mints a one-time **write grant** (`pi/write-grant.ts`): a capability bound to the Task id and artifact scope (`core/pi-write-grant-plan.ts` decides, per batch item, none | session | scoped), with a random token and a **`bindingMac` = HMAC-SHA256** over the grant fields, verified with `timingSafeEqual` on every write. No valid grant → the child's writes are refused by the direct-edit gate twin. The same grant carries the child's evidence-ledger address (parent session + spawn item's agent type), MAC-bound, so a child without a valid grant records no evidence.

### 4.5 The evidence ledger — facts, not judgments

`<session>.evidence.jsonl` under the subagent directory holds **facts only**, stamped with an agent epoch (`<agent_id>:<agent_type>`); judgments (trusted, passed, red-then-green) are computed from facts when read and never stored.

| Fact | Minted from |
|---|---|
| `FileRead` | a Read tool call (Grep/Glob/Bash context is not a `FileRead`) |
| `FileWrite` | an Edit/Write/MultiEdit (`via: "tool"`), or a shell write the command text names (`via: "shell"`) |
| `TestRun` | a Bash command with a test runner at head position: real exit status + parsed structured report (per-file results always carried) |
| `SandboxRun` | a security sandbox receipt, minted only from the simple command that ran the sandbox with its own `--nonce` |

One minting rule for both harnesses (ADR-0027): `Claude PostToolUse(+Failure)` or `Pi child tool_result` → pure adapter (`core/harness-tool-call.ts`) → `HarnessToolCall` → `recordToolEvidence` (shell) → `extractEvidence` (pure) → ledger append. A duplicate `callId` folds away.

Trust rules for a `TestRun` (machines/README §When a test run is trusted):

- Non-zero exit = trusted failure on its own. Zero exit is trusted only when a report artifact was parsed, and passes only if the report shows ≥1 executed test and no failures (a report where nothing executed, zero tests or every test skipped, pending or todo, is a trusted non-pass; ADR-0100).
- **Freshness is call-scoped**: a disk report may vouch only if its mtime ≥ that Bash call's stamped start (the PreToolUse Bash hook writes `<session>.callstart.json` keyed by `tool_use_id`) minus ~2 s slack, within a 15-minute cap. Missing stamp → artifact-backed sources rejected loudly; only stdout reporter JSON still vouches.
- **An agent cannot author its own report**: an `--outputFile` path the agent itself wrote this epoch (tool or shell, including on the judged command line) is vetoed.
- **Exit ownership must be provable**: the exit belongs to the test segment only as sole command or last command after `&&`/`;`/`&`/`|` (non-zero after `;`/`&` only). `npm test || true` yields `exit: null` → untrusted; a runner inside `$(…)` owns nothing.
- A later file write demotes an earlier pass.

**Attribution** (`attributeEvidence`, pure): a call carrying `agent_id` records only under that agent's own binding (parallel subagents never credit siblings; a reserved/duplicate/unknown `agent_id` records nothing with a stderr audit line). A call with no `agent_id` falls back to the **sole-active rule**: recorded only while exactly one subagent is active and one machine is bound; contention stands it down. Pi children record under the grant's epoch — exact, no fallback needed.

**Attribution of failing tests across siblings** (ADR-0080): a trusted failing run counts against the settling Task unless every failing file is declared *only* by other same-Wave Tasks that have not settled, and at least one test outside those files ran without failure — then it is the settling Task's pass, labelled with each excused file and its owners.

### 4.6 Guarded Skill Machines — the per-agent hard gate

A machine (`machines/<agent>.machine.json`) is a small phase diagram per agent type; the agent's own attributed tool calls are the events that advance it. SubagentStart binds it with an epoch; PostToolUse evidence advances phases; PreToolUse (`enforce-phase-tools`) denies an enforced tool the current phase does not list (deny-by-default within the machine's `enforcedTools`; an unexpected evaluation error fails closed). The terminal phase's `requires` is consulted at settlement: an unmet requirement *demotes* the verdict (a trusted pass becomes untrusted, labelled `machine-incomplete`), it does not block completion outright.

Shipped definitions are admitted only when their bytes match the SHA-256 pins compiled into `engine/src/core/machine-pins.ts` (ADR-0076): rewriting, adding or deleting a definition loads as invalid, and that agent's gate blocks every enforced tool, naming the refusal — tampering can make a gate stricter, never weaker. Gating is active only while a TaskGraph exists. On Pi children there is no live phase gate (Pi cannot name a tool call's caller); the machine's rules are prose in the brief and the agent definition, and settlement is the authority.

Three shipped machines: `code-implementer-agent` (read-context → implement → verify → done; no write before a read; `TestRunPassed` to finish), `distill-agent` (no edit before a passing test run with a parsed report — the green baseline, mechanically), `security-hunter-agent` (read-brief → walk-boundary ≥3 reads → demonstrate ≥5 reads → done; no file tool in any phase).

---

## 5. The orchestration loop — how every registered program runs

### 5.1 The façade

`helper orchestration <operation>` (`engine/src/handlers/helpers/orchestration.ts`) is the parent-facing interface:

```text
status        brief         inspect        start <architecture|refutation|standalone-review|
                                           standalone-disposition|wave-gate|remediation|
                                           security-verification>
resume        restart       recover-orphan abandon       submit       correlate
complete      decide        disposition    remediate     attest
reopen-task   rescope-task  add-dependency amend-export-binding
add-task      withdraw-task
```

`status`, `brief`, `inspect` are read-only. `restart` is the exhausted-Wave-reviewer path; `recover-orphan` rebuilds a Wave Gate whose Run Directory vanished; `abandon` retires a run; the last six are audited protected-state edits (plan edits, reopenings) described in [Recovery operations](reference/recovery.md).

### 5.2 The four actions

Every program driver emits exactly one of:

- **`spawn-batch`** — a list of exact engine-issued Agent requests. The parent executes them verbatim (expanding nothing, choosing nothing) and calls `resume`.
- **`await-user`** — one explicit decision request. For a Wave Gate the only decision object is `{"kind":"approve"}`; anything else is refused without writing.
- **`blocked`** — stop with typed diagnostics; the run stays resumable when the cause is fixed and authority is unchanged.
- **`done`** — an authoritative completion receipt.

The parent does not build event arrays, retry policy, reviewer lists, model lookups, or result JSON. Every program is an algebraic state machine (closed state/event unions; terminal and illegal transitions explicit); each program driver is plain shell code over its journal and the pure reducer (ADR-0005). There is no workflow runtime.

### 5.3 Attempts: the one retry rule

Every semantic Agent request carries `attempt: 1 | 2`. A malformed/failed *semantic* result at attempt 1 emits `retry-required` and the engine issues a fresh attempt-2 spawn (with a context appendix naming exactly what failed). A semantic failure at attempt 2 is **terminal** for that slot. **Infrastructure** failures (unreadable transcript, missing authority, transport errors) are a different class: they never consume the attempt, stay at the same attempt, and are recovered by fixing the named cause. This single budget applies to reviewers, panel judges, refutation verifiers — and, with richer settlement semantics, to implementation Tasks (§6.8.6). Emission-tool and extraction failures share the same budget with separate diagnostic causes and no same-spawn correction protocol (ADR-0019): one refused emission call with a usable final message is `extraction-over-refused-call` (accepted, no retry consumed); two distinct emission calls in one attempt are a `duplicate-emission-call` ambiguity rejection even with valid final text.

### 5.4 Batching and transport limits

A batch may contain any number of requests; Pi's native subagent transport accepts at most **eight per call**, so the parent partitions a larger batch into ordered chunks of ≤8 without changing any request, and resumes only after all chunks finish. Before a Pi batch is emitted, every route its children will launch on is probed; an unreachable route refuses the batch (the route gate).

### 5.5 Resume is idempotent

`resume` re-derives the program state by replaying the journal against the reducer, reconciles already-receipted effects, and returns the next action. Calling it twice, or after a crash between artifact publication and journalling, yields the same bytes and one journal entry. `inspect` is the pure read of one run's program, state, captures and event tail.

---

## 6. A full `/loom` run, stage by stage

```text
brainstorm → specify → clarify? → architecture → plan alignment → plan design review → decompose
                                                                                       |
                                                                        Wave 1 implementation Tasks
                                                                                       |
                                                                                  Wave Gate
                                                                       Wave 2 … → final Wave Gate
                                                                                       |
                                                                        retro → complete-orchestration
```

### 6.0 `init-state` — arming the guards

`cli.ts init-state` (via `/loom`) writes the State File before the first phase, applying the skip flags. From this moment **every guard is live**: the direct-edit block (the orchestrating parent may no longer Edit/Write in the Orchestrated Repository — phase agents and implementation agents write, attributed), the Bash state guard, the spawn gates, the rules gate, the machine gate. The initial TaskGraph is created *before* the first phase precisely so nothing is ever ungated mid-run.

### 6.1 Phase 0 — brainstorm

`brainstorm-agent` explores intent, constraints, alternatives, scope; writes `.claude/specs/<date-slug>/brainstorm.md`. Skippable with `--skip-brainstorm` (which also skips specify/clarify via `--skip-specify`). The engine's involvement: the spawn gate checks phase order (an agent is placed in a phase by its *identity*, never its prompt), the direct-edit block confines the agent to its artifact roots, the machine gate (if bound) and the evidence ledger record its reads/writes, and `advance-phase` fires at SubagentStop once the artifact is on disk.

### 6.2 Phase 1 — specify

`specify-agent` turns the feature into WHAT/WHY requirements: prioritized user scenarios, `FR-NNN` functional requirements, measurable success criteria, non-functional constraints, out-of-scope boundaries, and `[NEEDS CLARIFICATION]` markers. Writes `.claude/specs/<date-slug>/spec.md`. The spec becomes the **Spec Index** later: `populate-task-graph` proves every Requirement trace against it and refuses ids it does not define as completable FR/AS entries.

### 6.3 Phase 2 — clarify

Mandatory when more than `CLARIFY_THRESHOLD` (3) unresolved markers remain, unless `--skip-clarify` is explicit. `clarify-agent` updates the spec and records the dialogue under the spec directory.

### 6.4 Phase 3 — architecture

**Standard mode.** `architecture-agent` reads the spec and codebase, runs the architecture questionnaire (interactive; on Pi through `loom_interactive_subagent`), presents 2–3 approaches with trade-offs, the user chooses, and it writes `.claude/plans/<date-slug>.md`. The plan may declare executable models — lifecycles, pipelines, invariants (with `**Owner module:**` ownership), Acceptance Contracts (`CT-n`, types files, acceptance tests, export bindings) — parsed by `core/parse-plan-models.ts` and enforced later (§6.8, §6.9.6, [Executable models: enforcement](executable-models-enforcement.md)).

**Panel mode** (`/loom --panel[=N]`) replaces only approach generation:

1. **Interview once** — `arch-interviewer-agent` writes a labeled digest; the panel contract rejects missing, duplicate, empty, or invalid fields.
2. **Distinct lenses** — `simplicity-first` and `type-driven-fp` are baseline; sensitive boundaries, performance priority, brownfield maturity select additional lenses from the five (`risk-security-first`, `performance-first`, `codebase-conventionist`). Panel size default 3, accepted 2–5, because every designer must have a distinct lens.
3. **Design in parallel** — one `arch-designer-agent` per lens, one manifest-bound candidate each.
4. **Judge in parallel** — three `arch-judge-agent` requests, each scoring *every* candidate against *one* criterion: the interview's primary axis, its testability bar, codebase fit + effort.
5. **Aggregate in code** — `core/panel-kernel.ts`/`panel-contract.ts` validate verdicts against exact slots (a slot's identity binds its lens/criterion; caller prose cannot swap it); verdicts must cover the exact candidate set; ranking by total, then ordered criterion scores, then lexical candidate filename.
6. **Choose and finalize** — ranking is a recommendation; the user still chooses; `architecture-agent` may graft compatible strongest ideas and records `AD-1: Approach selection (panel)`.

Panel evidence lives in a fresh run directory under `.claude/specs/<slug>/panel-runs/` (interview, manifest, candidates, verdicts, ranking). Dispatch order and retries come from the Panel Program: the parent appends each `spawn-outcome`/`engine-outcome` event to its journal and replays it through `helper panel-program architecture`, which returns the next action. The program starts at the candidate fan-out with the interview and candidate preparation recorded as complete, so a journal that replays an outcome for either is refused as a duplicate; `helper panel-contract` validates every artifact. The architecture panel is not a registered façade program (ADR-0096).

### 6.5 Phase 3.5 — plan alignment

`plan-alignment-agent` maps the plan back to every requirement; writes `.claude/specs/<date-slug>/plan-alignment.md`. Remaining gaps → the user loops back to architecture or explicitly proceeds (`--skip-plan-alignment`).

### 6.6 Phase 3.6 — plan design review (the first full review pipeline)

A **gate, not a phase**: `current_phase` does not move. Before decompose, the plan's design is reviewed by a **Standalone Review of kind `plan-design`** whose `files` is exactly the plan (ADR-0070). This is the first place the generic review machinery runs end to end, so here is the walkthrough that all standalone reviews share:

1. **Scope freeze.** The registered `standalone-review` program freezes the exact file bytes (here: the plan), computes metadata, and deterministically selects the fixed roster — `code-reviewer`, `type-design-analyzer`, `architecture-tech-lead` — each with the whole-document read obligation and the `plan-design-lens` packet section (`core/standalone-review-scope.ts` holds the one per-kind profile).
2. **Packet issuance.** Context Packets are built (schema, rubric, frozen source), digested, published into the run's contexts and blob directories, and each request minted (`AgentRequestAuthority` with attempt 1). The spawn batch comes back; the parent executes it.
3. **Read coverage.** Fresh standalone reviews register `loom-standalone-read-coverage v1` (ADR-0022): the packet carries `standalone-frozen-diff` (one unified diff per scoped file); the issued task lists every obligated file with unit/page counts; the reviewer pages through via `LOOM_CONTEXT_READ_COMMAND --diff <path>` until `nextOffset` is null (pages up to 12,000 units; piped/filtered/truncated pages earn nothing). At capture, the harness transcript's tool results are checked line-by-line — only exact reader pages whose text equals the frozen diff at their range count — and the verified ranges are written to `artifacts/read-coverage/<requestId>.json` *before* the transcript. A result with any unread unit is refused through the ordinary retry (attempt 2's task names every unread file and range); a capture without observed tool outputs refuses as well. A scope whose frozen diff exceeds 240,000 units is refused at `start`. Wave Gate reviews do **not** carry this policy; they get the frozen-source sections instead.
4. **Capture and admission.** The reviewer emits exactly one JSON object (`findings`; no fences, narrative, tallies, or self-minted ids). Admission (`core/review-output.ts`, `core/findings.ts`) rejects the *whole* response on malformed JSON, duplicate keys, missing basis, a foreign location, a wrong binding, or an incomplete prior roster — creating no synthetic Finding. Finding identity is **(agent, emission ordinal)**, never model-chosen. Bounds: 1,048,576 bytes, 32 nesting levels, 128 findings, 4,096 priors.
5. **Aggregation and refutation.** The complete roster is parser-produced; aggregation cannot accept a partial roster. Criticals go to the refutation panel (§6.9.5); advisories to a disposition.
6. **Result publication.** Authoritative `result.json` at the Run Directory root, separating `surviving_critical_findings`, `advisory_findings`, `refuted_critical_findings`; a missing roster member or invalid panel result blocks publication.
7. **Acceptance.** `helper accept-plan-design-review` re-hashes the plan under the State File lock, judges the evidence (`core/plan-design-review.ts`: `judgePlanDesignEvidence`), and records `accepted{planSha256, runId, resultDigest}`. A critical that survives refutation is resolved by editing the plan and reviewing again (no override, no successor review for this kind); advisories need a published disposition (`standalone-disposition` program, §7.2). **Any later edit to the plan blocks the decompose spawn** until a fresh review is accepted (`validate-phase-order` asks the gate with the plan's current digest). `populate-task-graph` asks the same gate on first population.

Skip only with `--skip-plan-design-review` at init (recorded `not-required`); there is no flag that skips it later.

### 6.7 Phase 4 — decompose and population

`decompose-agent` emits JSON. **Before any state change**, the engine validates: known implementation Agents; unique Task ids and valid dependencies; Wave order and bounded parallelism; declared files and test policy; spec anchors; executable lifecycle/pipeline/invariant/contract bindings from the plan. The user approves; Loom opens a GitHub Issue; `populate-task-graph` then installs the graph **and moves the phase to `execute` in one write** — the only transition into `execute`, so it can never hold an empty graph. A decompose agent with no usable output, or a plan rejected at approval, leaves the run in `decompose` for a re-spawn.

What population does, in the same locked write:

- **Freezes the verification manifest** (`.loom/verification-manifest.json`, installed beforehand via `helper write-verification-manifest` — direct writes blocked; `--replace` stages+renames; nothing may change after population). Schema v2 keys: `checks` (wave scope, allowlisted executables, `{files}` substitution, required-file reports beneath the .loom/completion-reports directory), `acceptanceRunner`, `affectedRunner` (JUnit/Vitest-JSON with per-file results), `testFileSuffixes` (default `.test.ts`, `.spec.ts`, `.test.tsx`, `.spec.tsx`), `distillPass`, `taskMutationCheck`. Every key frozen and covered by the manifest digest. Command policy: `shell: false`, bounded basename allowlist (`bun`, `vitest`, `mvn`, `pytest`, …), the npm, pnpm and yarn CLIs only in explicit `run|run-script|test|check|build` forms, no inline-eval modes, hook-invocation env vars (`CLAUDE_PROJECT_DIR` etc.) stripped so a command behaves identically at stop checks and at the gate.
- **Freezes `test_evidence: {kind: "engine-run", manifestDigest, adoptedBy: "population"}`** when an `affectedRunner` exists: in such a graph only engine-run test evidence is admitted (loom#198, Cause 3).
- **Stamps `owner_obligations`** from the plan's owned invariants (ADR-0032), `[]` included; refuses owner/sibling role conflicts and a matrix test landing after the Wave that first owes the family; refuses a non-exempt owned invariant with no `affectedRunner`.
- **Adds one Distill Task per Wave with implementation files** (ADR-0068): numbered after the highest authored id, no dependencies, no Requirement trace, `file_list` = the Wave's implementation files (never test files, never frozen contract paths). A decompose payload cannot author one.
- **Proves the roster** (loom#198, Cause 3): a Task owing red-then-green with no test file in `file_list` → refuse; red-then-green under a manifest with no `affectedRunner` → refuse (prints the runner to declare); a completable Requirement no Task anchors → refuse (spec-check would report an ownerless requirement). Package manifests and their lockfiles are one **coupled file set** (ADR-0082): no Task may hold part of a set another Task lists.
- **Stamps `export_bindings`** from the plan's `**Export bindings:**` lines (skeleton machinery, §6.8.2).

Planning bounds (guidance, not enforcement): 8–12 Tasks, 4–5 Waves, 4–6 parallel Tasks per Wave.

### 6.8 Phase 5 — execute: the wave dispatch loop

For each Wave, the orchestrator dispatches every dependency-ready implementation Task in parallel. Dispatch is derived, never improvised:

**Status and dispatch readiness.** `helper orchestration status` is the canonical read model (`core/loom-status.ts`): active phase/wave, exhaustive Task counts, failed proof obligations, test readiness, completion-suite outcome, roster gaps, Finding counts, refutation-panel need, exactly one next action and all reasons. It offers each Task's dispatch when its dependencies are `implemented`/`completed`, nothing is reserved, no dispatch hold applies (e.g. a judgement whose subject is still open, ADR-0077), and — for the Distill Task — every other Task of the Wave has settled.

**6.8.1 The spawn pipeline (Claude Code PreToolUse on `Task|Agent|subagent`; Pi's spawn lifecycle runs the same decisions).** In `hooks.json` order, each a separate fail-closed gate:

1. `validate-phase-order` — phase sequencing by agent identity; the decompose spawn additionally refused until the plan design review is accepted for the plan's *current* bytes. An unknown `loom:` name is refused; a foreign agent passes (what it may write is `block-direct-edits`' decision).
2. `validate-task-execution` — the heart (§6.8.2).
3. `validate-template-substitution` — refuses a parent-assembled prompt still holding an unfilled Loom template variable: a `{name}` that one of `commands/templates/*.md` declares (`LOOM_TEMPLATE_VARIABLES`, pinned to that corpus by a test). Any other `{word}` is the prompt's own text. It judges the spawn request, not the expanded brief: a marker must render, and the brief is engine-rendered, its template proven filled before protected Task, plan, Spec and rule text was spliced in, so a key pattern such as `ab:outcome:{incidentId}` in a Task's plan context never blocks its dispatch. In `validate-task-execution`'s veto composition each veto declares the payload it judges (`SpawnVetoEntry.judges`); on Pi, spawn preparation passes the admission the briefs it rendered.
4. `validate-agent-model` — refuses a model that does not match the Agent's LLM Profile binding.
5. `validate-agent-skill` — refuses a prompt not naming the Agent's required Skill.
6. `block-direct-edits` (matcher Edit/Write/MultiEdit) — the parent cannot edit; a phase agent writes only under its artifact roots; an implementation agent only once its exact attempt is bound (pending is a retriable block) and never while its Task is in attestation mode (ADR-0085).

Bash-side, always armed during a run: `guard-state-file`, `guard-subagent-authority`, `rules-gate` (§8.3).

**6.8.2 What `validate-task-execution` does, in order.** The parent sends only a marker — `LOOM_IMPLEMENTATION_BRIEF: T5`, optionally `LOOM_OPERATOR_NOTE: <text>` lines. The gate:

1. **Renders the brief** (`core/implementation-retry.ts` / brief rendering): Task/Wave identity and dependencies, required Skill, exact spec anchors and plan context, declared file list, architecture/stack rules, test and proof contract, and — per duty — the mutation-check / owner-check / red-then-green instructions with exact commands. Sibling gates expand the marker themselves (they see only the original input).
2. **Checks Wave and dependency order and path ownership** (declared files; coupled file sets; no overlap with another current-Wave Task's files).
3. **Runs skeleton stage two**: every export binding resolved against the contract's frozen types file (bytes must equal the freeze stamp); a missing alias, non-function/generic alias, wrong-shape Java holder, unfrozen or drifted contract refuses the whole registration, every problem named. Status shows the same problems as `skeleton-bindings-unresolved`.
4. **Writes skeletons** through the one no-clobber writer (`orchestration/skeleton-writer.ts`): repo-relative only, never a frozen path, no symlinked ancestor; create never replaces; refresh replaces only while bytes still equal the recorded engine digest. Engine bytes exist *before* the attempt baseline, so they are never the implementer's write and never count as "changed" or out-of-scope. Each write records `engineSha256` + types digest with the reservation, and a per-path outcome (`skeleton written | exists, not skeletonized | contract has no types file | no bound exports | unsupported language | absent, no skeleton owed`).
5. **Captures baselines**: the attempt's `artifact_baseline` (declared + previously attributed paths), `start_sha` (the commit the attempt starts from), and a repository boundary.
6. **Registers attempt and retry authority atomically**: a fresh attempt gets engine-issued authority (the Implementation Completion Oracle later settles only the engine-issued Implementation Attempt). For an attempt-2 spawn, the gate requires the exact `LOOM_IMPLEMENTATION_RETRY_CONTEXT` appendix bytes that status published — stale, altered, missing, duplicate, invented or representation-different retry context is refused; the prompt/context digest is frozen with the new attempt authority before dispatch.
7. Returns the rendered brief as the call's `updatedInput`.

**6.8.3 During execution.** SubagentStart binds the machine (epoch) and the attempt authority (Claude: session+Agent sidecar, no-replace; Pi: the ReservedSlot + MAC'd write grant). Every tool call lands in the evidence ledger; the machine gate denies out-of-phase tools; edits run immediate-tier lint and advisory type diagnostics (§8.4); test runs are stamped and classified. For engine-run evidence graphs, the brief tells the agent to run tests via `helper run-tests --files …`, whose receipt line `LOOM_TEST_RUN_RECEIPT {json}` is the only thing that mints an engine-run `TestRun` fact (sole bare call, real path; spilled-output files re-read whole, loom#241).

**6.8.4 The four stop checks** (SubagentStop → `dispatch.sh` → `handlers/subagent-stop/stop-checks.ts`; in this order; each can keep the same agent working; none is completion evidence; on Pi all are report-only):

1. **Acceptance Stop Check** (claimants of a frozen Acceptance Contract): runs the contract's acceptance files through the frozen `acceptanceRunner`; a testcase still failing that the agent owes (decides one of its claims, anchors due by its Wave) blocks the stop. Fails open (runner lock held by a sibling, runner crash, report missing/changed, 3-block cap, check failure) with a note.
2. **Affected-Test Stop Check** (every implementation agent, I7): runs the frozen `affectedRunner` over the changed files (attempt epoch's ledger `FileWrite` paths, first-write order, only beneath the runner `cwd`). A failing affected test blocks. Expected-RED acceptance failures are excused by the same rule the Wave Gate uses. Both first checks share one per-repository runner lock (serialized because they share report paths, which they reset before each launch; stale-holder reclaim rules specified); each has its own per-agent 3-block counter; the SubagentStop budget is 300 s minus a 30 s settlement reserve, and the runner launches only if the remaining time holds its whole `timeoutMs`.
3. **Task mutation check** (reads the record `helper mutation-check` left; runs nothing): up to 8 mutants on the changed lines of the Task's TS/JS implementation files, one isolated worktree, the frozen runner over the mutated file + the Task's tests; survivors named with the test that kills siblings of that operator. Missing/stale record or survivors block, ≤2 blocks per agent; `inconclusive`/`unavailable` are notes.
4. **Task owner check** (reads the record `helper owner-check` left; ADR-0092): the gate's own per-obligation run — sibling coverage over owner+settled siblings, then the gate's mutation plan (≤24 mutants, six operators) — for owned invariants whose owner and matrix test are both settled at this stop. Missing path or a survivor the Task answers blocks, ≤2; everything else is a note.

A Claude Code agent that ended with a delivered `SubagentHandback` is never blocked (the harness would not keep it working; the dispatcher turns the block into a note and settles). Fail-open notes are written to `<LOOM_SUBAGENT_DIR>/<session>.<agent>.stop-check-note.json` and surfaced to the orchestrating session by the `surface-stop-check-notes` PostToolUse hook (renamed before read, so never delivered twice).

**6.8.5 Completion of a Task — the settlement.** A Task reaches `implemented` only when **proof obligations are satisfied** and the **Implementation Completion Oracle accepts the engine-issued attempt's byte scope** (`update-task-status` at SubagentStop). Completion prose settles nothing, and neither does a harness result without engine-issued attempt authority: no Task is guessed (ADR-0098).

Proof obligations, per the Task's `verification_policy` (independent `regression` and `new_tests` arms, each `required` or `waived` with a typed reason — e.g. `existing-tests-sufficient`, `documentation-only`; neither waives declared-artifact proof or review):

- **Agent completion** (engine-observed, not prose).
- **Regression**: a trusted passing test result covering the Task's tests (attribution per ADR-0080, §4.5; a pass invalidated by later writes demotes).
- **New tests, red-then-green (I6)** — owed when new tests are required and the Task is neither a contract claimant nor a contract Task (a contract Task's red window is the gate's observed RED). Judged by the pure, total `judgeRedThenGreen` over the attempt epoch's ordered ledger facts, at settlement, never stored. The three steps, in order: (1) a *qualifying red* on one of the Task's test files (a ledger `TestRun` with real exit code + parsed per-file report; in an engine-run graph it must be an engine run); (2) then the first write to an implementation file; (3) then a *qualifying green* covering every one of the Task's test files (exit 0; every test file attributed, ≥1 executed testcase each, no failure/collection error; a partial run never greens). Unmet → `proof:red-then-green-unproven:<gap>` with gap precedence `no-test-files` → `implementation-write-missing` → `red-missing`/`red-after-first-implementation-write` → `green-missing`; `untrustedOnly` marks the case where only non-qualifying runs exist.
- **Declared artifacts changed**: every declared artifact differs from the `artifact_baseline`, with engine-written skeleton bytes subtracted; where conformance is owed (G2), each bound export must still be exported with its frozen alias/type (`export const name: Alias` / `static final Alias name`) and not hold the `unimplemented: <name>` string, and no production file may shadow a Frozen ADT or re-list its variants — violations fail as `declared-artifact-contract-violated` *before* the changed test runs, and ride the retry appendix. One exception to "differs": a contract writer re-freezing a revised contract may leave a frozen path of a contract it writes byte-identical. When that path holds a regular file at settlement (observed with the conformance verdict in one read by `observeContractTask`, without following links), the obligation is satisfied with `basis: { kind: "held-for-freeze", contract }` instead of failing `declared-artifact-not-changed`; the contract's Acceptance Freeze, not the Proof, judges those bytes at the gate. A missing path is never held ([ADR-0104](adr/ADR-0104-a-contract-writer-may-hold-frozen-bytes.md)).
- **Task-local byte scope** (one engine-observed outcome the shell hands the Oracle, never persisted: accepted, out-of-scope writes, or observation unavailable): the attempt's changed paths must lie in the current `attempt_artifact_baseline` (declared + previously attributed); a transcript path outside the allowed set is semantic failure regardless of ownership. Repository changes classify as engine-owned (the settlement's own State File and its lock/staging leaves), Task-local, inert (sibling-owned), or semantic out-of-scope; an unowned changed path invalidates the settlement even if the transcript omits it. Every exact settlement retires the repository boundary; a retried Task re-arms on a fresh one.

**Transcript facts per transport.** Both transports hand `settleExactImplementation` the same facts — transcript paths and a test result with its evidence, or none. Claude Code reads its JSONL transcript with `parsers/` (`parseFilesModified`; `parseBashTestOutput` → ledger resolution, whose transcript-regex fallback stays `unverified`). `parseFilesModified` refuses a Pi session (a `session` header record) rather than reading it as an empty write set, and `update-task-status` settles that refusal as an unusable transcript. Pi reads its message array once in `pi/transcript-adapter.ts`, through one message-level entry point, `piTranscriptEvidence(messages, cwd)` (parse, project, fold — the one order settlement and the evidence tests share): `piTranscriptToolCalls` projects it to `HarnessToolCall`s paired with their results through the same Pi tool vocabulary the ledger recorder and write guard use (`core/harness-tool-call.ts`), and two folds read that projection — `piWriteTargets` (every write/edit/multi-edit target, under the guard's path keys) and `piStructuredTestResult` (the latest classified, exit-attributable Bash test run, recorded as `untrusted`/`pi-structured`). With no structured run, a Pi attempt records **no** test result, so a required regression fails as `test-result-missing`; there is no regex fallback on the Pi path. An attempt that observed no result also clears an earlier attempt's untrusted one; only a trusted verdict the shared preservation rule keeps survives it.

Every applied transition appends one immutable **settlement receipt** and atomically updates lifecycle/evidence, clears only matching attempt fields, invalidates review/spec/Wave authority when required, and recomputes `impl_complete`. `executing_tasks` is parser-bound to the roster: an unknown reservation makes the graph corrupt until `repair-task-graph` removes it with a diagnostic.

**6.8.6 Retry and escalation.** Bounded retry is derived from immutable settlement history (protocol 2; wire-order-validated). A semantic attempt-1 failure emits `retry-required`; status publishes the exact `LOOM_IMPLEMENTATION_RETRY_CONTEXT` appendix (Task, attempt 2, predecessor receipt, sorted failure kinds; contract violations get their own section). The spawn gate accepts only those bytes. A semantic attempt-2 failure emits `escalation-required` — status becomes non-retryable, no attempt 3 exists; the operator exits via `helper orchestration remediate` (fix → reopen → re-dispatch). `infrastructure-blocked` settlements name each failure's own reason and never consume the semantic budget.

**6.8.7 The Distill Task.** Offered by status once every other Task of the Wave settled; its brief carries the `LOOM_DISTILL_PASS: 1` appendix (file list, replaces the implementation workflow; spawn gate compares the appendix line-by-line). Its machine enforces green-baseline-before-edit on Claude Code. Its proof: `task-completed` + `behaviour-preserved` — `unchanged` (no test owed), `tests-passed` (changed files + trusted passing run after last edit + no frozen-signature break), or `restored` (could not prove preservation → the engine wrote every file back from the Git tree `refs/loom/distill/<authority digest>`; settles `implemented`, no retry). The Wave Gate cannot start before it settles; at the gate it is registered with its Wave and issued **no reviewer**.

### 6.9 The Wave Gate, stage by stage

`/wave-gate` starts a fresh registered **Wave Gate program**. The engine — never the parent model — owns readiness checks, Review Packet publication, reviewer/model/Skill selection, retries, aggregation, refutation routing, advisory suspension, full-tier lint, and protected Wave advancement. The reducer (`core/wave-gate-machine.ts`) is proof-carrying: readiness snapshots and next-action proofs cross-check each other and can be minted only inside the module. Stage flow:

```text
preparing → review issuance → awaiting-review-results → awaiting-refutation? → awaiting-advisory-decision? → ready-to-complete → done
```

**6.9.1 Start and registration.** The parent creates a fresh direct-child Run Directory under the conventional runs root (.claude/reviews/wave-gate-runs) and calls `helper orchestration start wave-gate`. Registration decides, under the TaskGraph lock, exactly what this run is:

- **Fresh** — nothing to carry: plan the full roster.
- **Succession** (ADR-0091) — a fresh start after an abandon or a completed-Wave reopen *succeeds the Wave's latest retired run* (the abandoned tombstone, else the latest `retired_wave_review_runs` record). The pure `planSuccessorCarry` decides, per reviewed Task, whether its accepted review still judges its unchanged subject, bound by the **Subject Digest** sealed into the acceptance at finalization: protocol, roster, description, agent, plan context, Requirement anchors/contributions, declared and modified files, Review Generation, proof, test result, owner-map obligations, contract surfaces, plan file, reviewed workspace scope and head — with the seal binding the Task's active and refuted Finding ids (a Refutation Panel only moves Findings between those two sets, so it does not break the seal; any added Finding does). A Task carries only when: the acceptance is on the predecessor's recorded lineage, it has a `subject_digest`, the Task holds no unsettled Review Run, and everything the digest covers still holds. A legacy acceptance without the digest is reviewed in full once. The carry is frozen into the registration (`succession = {previousRunId, previousAuthorityDigest, kind, carry}`); a carryless start is byte-identical to before. `start wave-gate --fresh-review` plans nothing.
- **Restart** (ADR-0089) — for a *live* run whose Wave reviewer attempt 2 was durably rejected: `orchestration restart` creates a replacement Run Directory, retires stale authority, and issues fresh packet/epoch **only for spec-check and the exhausted slots**; every accepted reviewer slot carries by reference (original slot/request/context identity + `carried_from` provenance, never re-minted), admissible only under the same protocol, Review Generation, prior Finding ids, roster, workspace scope/head — and Subject Digest when present. A Task whose whole roster was accepted is not reissued.
- **Orphan recovery** — the active run's directory is missing: `recover-orphan` refuses if the old entry exists or any subagent is active, preserves review history and generations, records the retirement, installs replacement authority atomically, and returns the exact new spawn batch.
- **Tombstone successor** — after an `abandon` that stamped the protected registration `terminal-abandoned`, status returns `start-successor-wave-gate` naming the successor id; registration admits only that run.

`start` also lints the Wave's files (full tier) and **refuses to start on a violation**, and reports per-Task rosters on stderr (`wave-gate-start-roster`), each Task it reviews in full and why (`wave-gate-start-not-carried`), and narrowing widths (`wave-gate-narrowing-widened`).

**Narrowing** (ADR-0094): a re-reviewed Task is issued only the reviewers its change needs, judged against its **Review Basis** (its last accepted review, kept as `review_basis` by reopenings). The shell reads the basis run's frozen packet bytes; the core proves them against the accepted head and classifies the change (`core/review-change.ts`: `unchanged`, `scope-changed`, `context-changed`, or per-file `comment`/`doc`/`test`/`code` — comment-only via a conservative C-family lexer; anything unreadable counts as code). Role table: comment/doc-only → `comment-analyzer`; test-only → `code-reviewer` + `pr-test-analyzer`; any code or context change, or no change, or an unreadable basis → the full roster; always plus the owner of every prior Finding. The selection is frozen into the registration (`narrowedReviews`) and enforced by the locked install (a narrowed Task that lost its basis is refused, never silently widened); a narrowing that no longer fits the derived roster widens, loudly. A carried Task is never narrowed.

**6.9.2 Spec-check.** `spec-check-invoker` runs **once for the Wave**: its packet receives no source; it reads the spec and the plan and reports per-requirement drift findings (a completable requirement with no planned completion owner, an anchor the spec does not define, …). Spec-check evidence is judged at the completion commit; it is always issued, whatever carried.

**6.9.3 Review packet creation and roster derivation.** For every Wave Task except the Distill Task, the engine creates the immutable Review Packet at the Task's current Review Generation and derives the roster — never configured, always derived (`core/wave-review-authority.ts`):

- Base five: `code-reviewer`, `silent-failure-hunter`, `pr-test-analyzer`, `type-design-analyzer`, `comment-analyzer`.
- `architecture-tech-lead` appended last when the Task touches an owned Invariant's family (`owner-map` section, ADR-0047/ADR-0039) **or** writes an Acceptance Contract's types file (`contract-surface` section, ADR-0069) — six reviewers; a Task that is both gets six, not seven. Each reason is also a fixed, digest-bound packet section rendered from the same derivation, so a section and the roster cannot disagree.
- A re-reviewed Task: the narrowed roster of §6.9.1.

Wave packets carry the `wave-frozen-source` section (the Task's declared/modified scope, frozen from the same snapshot as `workspaceHeadSha`). Each reviewer's request is minted under reviewer protocol **v4** (fresh Wave registrations; ADR-0084): the payload is exactly `{"schemaVersion":4, "kind":"wave-review", "prior_findings", "findings"}` — the reviewer copies no packet identity; the engine binds the Review Packet ID and Review Generation from the issued subject. (A Wave Gate registered before v4 keeps v2 — payload echoes `packetId`/`generation` — until it ends; a restart/replacement issues v4. There is no protocol flag: the registration kind selects the descriptor. Standalone fresh reviews issue v2; v3 is the successor descriptor only.)

**6.9.4 Reviewer scheduling — the mechanics.** This is the part people mean by "how does it schedule reviewers":

- **Issuance.** All reviewer requests of the Wave are minted at once (`issueExactRoster` — every slot minted against today's catalog, each slot's identity binding its role and attempt) and returned in one `spawn-batch` (partitioned ≤8/call on Pi). The session run binding is published first; capture binds each native child to its request id; each result lands in its fixed transcript slot.
- **One slot budget.** Per reviewer slot: attempt 1, then one fresh engine-issued attempt-2 spawn on a semantic rejection, then terminal. The engine derives the exact missing/failed slots and issues only those on resume. A missing or ambiguous final output gets the retry; a transcript locator/read failure is infrastructure (no semantic rejection tombstone; result stays unavailable; no attempt consumed).
- **Admission.** Whole-response rejection on malformed JSON / duplicate keys / missing basis / foreign location / wrong binding / incomplete prior roster; finding identity = (agent, ordinal); counts derived by the engine, never trusted from the payload. Under v4 a payload that still carries `packetId` or `generation` is refused, naming the v4 envelope. Limits: 1 MiB / 32 containers / 128 findings / 4,096 priors.
- **Prior-finding assessment (remediation-aware reviews).** Implementation changes increment `review_generation`; a new Review Run snapshots prior active Finding ids and every expected reviewer must assess each prior id exactly once, in packet order. A prior retires into `resolved_findings` only when its **owner** (the role that raised it) assesses `resolved_by_remediation` and no other reviewer's `still_present` cites concrete counter-evidence (`file.ext:line`; a bare "not re-verified" or a file name without a line does not count); the owner's own `still_present` or a dissent with a reference keeps it active; a Finding whose owner is off-roster needs `resolved_by_remediation` from the complete roster. New Findings activate only at atomic finalization (old resolve and new activate together or not at all). This makes "a clean rerun silently erases the old blocker by omission" structurally impossible.
- **Aggregation.** Complete-roster parsing (a slot's identity binds its lens/role); aggregation cannot accept a partial roster. Finalization is atomic; stored, refuted, resolved, panel and remediation records retain the full basis.
- **Exhaustion.** Attempt-2 semantic rejection is terminal for the slot → the run can `restart` (§6.9.1) with carry.

**6.9.5 Refutation panel.** If critical Findings exist, the engine issues one `review-verifier-agent` per refutation lens; every verifier covers the *complete* critical set. Baseline lenses: `reproduction`, `intent`; signals can add `blast-radius`, `security`, `test-coverage`; default panel size three. The verifier's packet carries the lens in its one authority section (`wave-refutation-authority`); the lens definitions are stamped in the agent definition, never substituted into a task. Verdicts are validated against exact slots and the complete critical set; a strict majority must refute; `uncertain` is neutral and ties keep the Finding; refuted Findings move to `refuted_findings` with all reasoning, never deleted. The panel judges whether the *assertion* holds, including preconditions, contract and consequence; a true assertion is not refuted because fixing seems unimportant; no severity downgrade exists. Only criticals are refuted — advisories are the user's decision. (The explicit operator override, `helper store-review-findings`/`--dismiss-all`, is separately audited and never an automatic fallback for malformed evidence.)

**6.9.6 Advisory decision.** A Wave with surviving advisories reaches `await-user`. The decision request lists them; the operator records a disposition per advisory on the **TaskGraph** (not the run): `helper orchestration disposition` appends to `advisory_dispositions` — `fixed` (no anchor/target), `deferred` (anchor + optional target Wave/Task), `dismissed` (anchor, no target), each with a reason; the anchor is a sha256 over the reviewed bytes the advisory anchors to (its own file when that file is one of the Task's reviewed artifacts, else the Task's whole reviewed artifact set). Consequences: decisions survive abandoning the run; a deferred/dismissed advisory is omitted from a fresh review's prior Findings exactly while its anchor equals the anchor of the bytes now reviewed (an edited file puts it back in front of reviewers); approval (`decide` with exactly `{"kind":"approve"}`) is refused, naming them, while any advisory the pending decision request issues has no disposition. In a contract Wave, status adds `acceptance-freeze-pending` here: the contract is still `awaiting-red`, so fixing a relevant advisory before approving is cheaper than a Contract Revision after the freeze (ADR-0044).

**6.9.7 Completion suite.** After every implementation Agent of the Wave has stopped and Task proof passes, the engine runs the **frozen completion suite** against the integrated workspace — in an isolated worktree of the branch:

- the project's manifest checks (engine-run, frozen commands, required-file reports parsed);
- `loom:full-tier-lint` (the engine's full-tier lint over the Wave's files — the same rules that refused the start; runtime-skew diagnostics included);
- `loom:owner-verification` when the plan declared owned invariants (plan re-read under integrity check; sibling coverage through the import graph, type-only edges erased; deterministic mutation plan over the owner's changed lines since the Wave base — six operators, ≤24 mutants — run in one detached worktree per invariant through the frozen `affectedRunner` with the matrix test as its only file; outcome classification reads only the structured report and never throws; real-workspace digest before = after, else `real-workspace-changed`).

Exit code, timeout, signal, spawn failure and report production are recorded as **separate facts**; a missing, duplicate, stale, malformed or conflicting result fails closed; an infrastructure failure stays distinct from a failing check (owner-check infrastructure failures get their own attempt records beside the result slot so a retry re-runs the check). The exact result is published immutably in the Run Directory and, on acceptance, bound into protected state together with the **workspace digest**; resume reuses that receipt and never reruns commands over evidence it cannot tell apart. Status reports suite authority as `required | accepted | rejected | stale | unavailable` without executing anything.

**6.9.8 The final protected commit.** The last stage re-observes the workspace (against the bound digest) and checks: implementation proof, completion-suite authority, reviews (all rosters settled, all prior findings assessed), spec alignment (spec-check evidence), surviving criticals (none), and required lifecycle artifacts (Acceptance Contract RED observed and GREEN judged, contract Task rosters, distill settlement). Success marks Tasks `completed` and advances the Wave in one locked write; the Acceptance Freeze is stamped by this completion commit from the archived suite receipt (ADR-0044) — a contract's frozen paths become immutable from here, changeable only by Contract Revision (`helper revise-contract`, which returns the current Wave's implemented claimants to revalidation and retires the Wave's review/suite authority). Failure emits a typed diagnostic naming the block (e.g. `frozen acceptance drifted: CT-n '<path>' changed`).

**6.9.9 Ending or pausing a gate.**

- **Abandon**: `helper orchestration abandon --superseded-by <replacement> --reason "…"` writes the immutable tombstone, stamps the protected registration `terminal-abandoned`, clears `active_wave_completion_suite`, and appends the `retired_wave_review_runs` provenance record — the acceptances it recorded stay admissible to a successor (§6.9.1).
- **Advisory pause**: the run waits at `await-user`; dispositions are recorded on the TaskGraph and survive.
- **Blocked**: typed diagnostics; resumable idempotently when the cause is fixed and authority is byte-identical.
- **Wave advanced** → the loop returns to §6.8 for the next Wave, or the run ends (§6.10).

### 6.10 After the final Wave Gate

1. **`/retro`** reads the engine's friction record first (`helper retro-facts`: per-Wave gate runs, reopenings, plan edits, retries, escalations, remediations, Finding counts, threshold crossings), names root causes and the layer that fixes each, and writes `.claude/retros/<YYYY-MM-DD>-<slug>[-wave-<N>].md` (the one file the direct-edit guard admits while a graph is live). `helper record-retro --file …` binds the report to the sha256 of its bytes; `--skip --reason` records a deliberate skip. A retro never blocks.
2. **`helper complete-orchestration`** refuses unless: the graph has Tasks, all `completed`, no Wave Gate registered active, and a whole-run retro recorded. Under the lock it publishes the exact graph bytes beside the live graph as `.claude/state/completed_task_graph-<issue|no-issue>-<UTC stamp>.json` (prepared under a temp name, hard-linked into place — exclusive and whole: an existing archive is never overwritten, a partial never visible), then removes the live graph. Archive published before removal: a failure leaves both files, never neither.
3. **Guards lift** — every guard keys on the live graph path. A post-gate `/review-and-fix` can run in the same checkout.
4. **Abandoning instead**: `helper cleanup-state` is the guarded teardown that keeps no copy — explicit operator intent only; specs, plans, review runs and the GitHub Issue remain as audit material.

---

## 7. The standalone programs (share the machinery, not the TaskGraph)

### 7.1 Standalone review (`/review-pr`)

A standalone review never invents a synthetic Task or mutates the feature graph. The registered program: freezes explicit files or the canonical union of committed branch changes + staged + unstaged tracked + untracked non-ignored; excludes Loom state/evidence layouts; computes metadata and deterministically selects reviewers for the requested aspects (`code`, `errors`, `tests`, `types`, `comments`, `architecture`, `simplify`, `all`); publishes Context Packets and exact spawn requests; captures the complete transcript roster unchanged; aggregates identified Findings; runs the refutation panel when criticals exist; publishes authoritative `result.json`. Aspects: `simplify` → `code-simplifier` (distill in review mode; joins under `all` when source/test files change); `architecture` → `architecture-tech-lead` (deepen in review mode; under `all` always; otherwise when >500 additions, >10 files, or new structure). Fresh issuance is protocol v2 **with read coverage** (§6.6 step 3).

### 7.2 Standalone lineage (ADR-0010)

- **Advisory publication**: the `standalone-disposition` program records the parent's complete ordered accepted/deferred/dismissed decisions immediately, without Agents. The policy is *declared, not observed*; corrections are a fresh run with `revision: {"kind":"correction","previousDigest"}`; historical imports are attested as declared-now, never as historical fact.
- **Successor review**: an explicitly selected successor (`start standalone-review` with a `successor` input naming the exact source result + disposition publication) joins one exact predecessor, keeps scope/roster (may expand, never silently narrow), freezes source bytes/modes/absence with porcelain-v2 witnesses, and conserves every original Finding — id, assertion, severity, evidence, votes. Every current reviewer assesses **all** inherited origins exactly once (the `standalone-assessment-roster` section gives each origin's standing and allowed verdicts; refusal names the row). Resolution requires every expected reviewer to say `repaired` with a reason and a scoped implementation change against the same frozen snapshot. Only new criticals and evidence-bound critical reopenings reach a fresh full panel; an unchanged upheld blocker stays active without re-adjudication. No automatic predecessor, similarity merge, severity override, or review reuse — a digest or a formally phrased claim is not semantic proof.

### 7.3 Review and fix (`/review-and-fix`) — the remediation machine

Composes a standalone review + adjudication with the registered **remediation** program (schema v2; requires `defectFamily` even at zero criticals): preflight authenticates the source review and published result, parses complete critical-Finding accounting (every surviving-critical id exactly once; unresolved/out-of-scope allowed but blocking), selects operator-declared `required-file` checks, captures the candidate baseline; then: proves each selected report path Git-ignored and untracked and resets it (anchored no-follow unlink; Linux via retained parent descriptor, macOS re-proves the whole path; only ENOENT is absence), runs the fixed commands, parses fresh reports (>0 executed, 0 failed, not all-skipped; ≤8 MiB, depth ≤128), binds observations to unchanged candidate bytes, audits paths (no Loom state/evidence, no unrelated dirty paths, no symlinks), stages into a **temporary index** with literal path semantics, verifies it, and installs under the real index lock only after the opaque **Defect-Family Assessment** exists (`repair-checked`, or `not-required` at zero criticals — neither proves family closure; the grouping, root cause, invariant and sibling accounting are the parent's declarations). `done.outcome.kind` is `remediation-installed` with the actual receipt; commit only after reading it; never force-push. Any drift → immutable `blocked` evidence; fresh run after correcting the cause.

### 7.4 Security audit (`/security-audit`)

A registered program: enumerates coverage units; one hunter per unit (machine-gated: no file tools; claims need `SandboxRun` receipts); an independent verifier on a different model profile tries to refute each claim (ballots bound to issued verifier spawns; a ballot counts only with a matching **capture attestation**, §4.4); a critic checks the coverage claim against recorded work. A claim is *confirmed* only with a sandbox receipt + verifying ballot; anything less is a lead without severity. Publication refuses while coverage is unsettled. The subagent authority guard (§3.1 layer 3) plus attestations make the parent-session trust boundary explicit (feature-guard-map §8.5: the parent session itself is trusted — the known residual).

### 7.5 Spec-check standalone (`/spec-check`)

Read-only implementation/spec comparison with machine-readable finding counts. Inside `/loom` it is the Wave Gate's spec-check stage; standalone it reads the active context when present and produces findings without a program run.

---

## 8. Cross-cutting determinism devices

### 8.1 Model profiles and issuance

`core/model-profiles.ts` is the executable catalog: nine profiles (`implementation`, `architecture-finalize`, `general-review`, `focused-review`, `panel-design`, `panel-judge`, `refutation`, `mechanical`, `spec-check-review`), each binding Claude Code (haiku/sonnet/opus) and Pi (one exact local provider/model/thinking, ADR-0023) as one policy value. Every Agent maps to exactly one profile; no implicit fallback; issuance mints against today's catalog (§4.1); recorded history may name retired bindings, and retargeting a profile moves one place. Pi launcher routing (`model-routing.json`) may inherit a local parent model or name an exact/served target — launcher policy at the spawn boundary, which cannot reinterpret an issued request's frozen binding.

### 8.2 Emission tools (grammar-constrained decoding)

On a qualified route, a producer (reviewer/judge/verifier) may return its payload as tool arguments under the frozen schema instead of (or alongside) the final message. Route classes: **constrained** (schema enforced at sampling), **unconstrained** (exact schema bytes accepted, not enforced — the recorded class of the qualified local route; the engine parser stays authoritative), **extraction-only** (no tool advertised; no schema rewritten). Qualification is bound to route identity (provider, served model, frozen schema digest) and re-qualified on model/schema/serialization changes; selection follows ADR-0019 (§5.3): one closed `EmissionObservation` per attempt (`absent | single-call | multiple-calls | unusable`), pure selection kernel (`core/emission-ingestion.ts`), containment law property-tested.

### 8.3 The rules gate

Blocks a code mutation until the Loom rules/skills are in the current context: `rules/architecture.md` + the language rule fully Read (a `limit` skim doesn't count; a same-message read doesn't count), `deepen` + `distill` loaded, the target file fully read (or written earlier), and an assistant line `LOOM: applying <rule|skill> — <how>`. Evidence comes from the session transcript and resets at the last compaction boundary. Non-code targets (.md/.json) are not gated. One policy (`core/rules-gate.ts`, pure), two adapters (Claude Code transcript events; Pi context entries) held to identical decisions by a parity test matrix. Subagents are exempt (the orchestrator owns their compliance); the Claude hook fails closed. `LOOM_GATE=off`, `LOOM_GATE_MODES`, `LOOM_RULES_DIR`, `LOOM_SKILLS_DIR` are the operator knobs.

### 8.4 Edit-time feedback

- **Immediate-tier lint** after every Edit/Write/MultiEdit (regex + immediate programmatic rules); full tier at Wave Gate.
- **Advisory type diagnostics** for TypeScript edits: the project's own `tsc --noEmit --incremental`; touched-file diagnostics with remedies; errors this edit introduced elsewhere (judged against the previous run); escalating repeat reminders at 3/5/8 consecutive edits (30-minute memory window). One run slot per tsconfig; a missed 30 s deadline keeps a detached warm-up build running; fail-open, never blocks. `LOOM_TYPE_DIAGNOSTICS=off` disables.
- **Session-start lint coverage** check: one line when the project has no Loom lint setup or an unconfigured, undeclined opt-in rule family; `helper lint-coverage ignore --reason` silences per repository.

### 8.5 The linter

Regex rules plus programmatic rules (import boundaries, purity, governance) with project configuration under `.claude/linter/rules/`; every rule family is on or explicitly declined (ADR-0075). Purity of the declared core is proven by import-closure tests, not just declared. The `family-sites` metric (with a committed baseline) counts second sites of engine-owned facts.

### 8.6 Determinism self-tests

Loom tests its own determinism: parser goldens, reducer property tests, wire-contract stamps pinned to executable schemas (every documented wire example parsed by its production parser, ADR-0073), machine pins byte-compared, docs facts programmatically verified (`facts.test.ts`), the parity matrix for the rules gate, and the emission containment property tests. See [Development](development.md) and feature-guard-map §7.

---

## 9. Guarantees and honest limits

Determinism is scoped to what Loom can observe and own ([Architecture §Honest limits](architecture.md#honest-limits)); the verified residuals and weak spots are catalogued in [feature-guard-map §8](feature-guard-map.md#8-what-doesnt-work--verified-residuals-and-weak-spots). The load-bearing ones:

- **Semantic quality is still model work.** The engine proves structure, issuance, completeness and evidence provenance — not that a finding is true, a design is good, or a test exercises the invariant. Refutation panels, review rubrics and calibration exist to make model judgment adversarial and measurable, not to replace it.
- **The ledger sees logged facts only.** A write through an interpreter, generator or `$VAR` destination mints no `FileWrite`; red-then-green proves the logged history shows test-first work, not that no code preceded the red. A same-call report forgery remains possible; the demotion rules make the honest path the cheap one.
- **The shell guards judge text, not an execution graph.** `cd dir; rm …` across separate commands and interpreter-driven writes are outside any text guard; the state guard covers its paths for Bash and the write gates cover tool writes — a Git hook or package script can still touch guarded files (the machine pin raises forgery to a coordinated engine-code change; OS isolation would close it).
- **The pin boundary is the user account**; the parent session is trusted (security audit); report artifacts live in an agent-writable environment; contended sessions with unattributable tool calls record nothing rather than guess.
- **`repair-checked` ≠ family closure.** Engine-observed fresh reports prove the checks ran on unchanged candidate bytes; the parent's declared grouping/root-cause/sibling accounting remain declarations.

---

## 10. Source map — where each mechanism lives

| Mechanism | Primary source |
|---|---|
| CLI routing, fail-closed route table | `engine/src/handler-routes.ts`, `engine/src/cli.ts` |
| Spawn gates | `core/validate-phase-order.ts`, `core/validate-task-execution.ts`, `core/validate-template-substitution.ts` |
| Implementation brief & retry context | `core/implementation-retry.ts` (`renderImplementationRetryContext`), `handlers/pre-tool-use/implementation-brief-marker.ts` |
| Direct-edit block, write grants | `core/block-direct-edits.ts`, `core/artifact-write-scope.ts`, `core/pi-write-grant-plan.ts`, `pi/write-grant.ts` |
| State guard (Bash) | `core/guard-state-file.ts` over `core/shell-quoting.ts` (the quote lexer), `core/shell-command-head.ts`, `core/shell-redirects.ts`, `core/shell-heredoc.ts`, `core/shell-substitution.ts` |
| StateManager, engine revision pin, runtime revision | `engine/src/state-manager.ts`, `core/engine-revision-pin.ts`, `runtime-compatibility.ts` |
| Run Directories, journal, effects | `orchestration/run-directory-handle.ts`, `orchestration/program-journal.ts`, `orchestration/effect-runner.ts` |
| Request authority, rosters, minting | `core/orchestration-contract/roster.ts`, `core/model-profiles.ts` |
| Context packets, section blobs | `core/context-packets.ts`, `scripts/read-context-packet.ts` |
| Review packets, generations | `core/review-packet.ts` |
| Reviewer protocol descriptors (v2/v3/v4) | `core/reviewer-contract.ts`, `core/standalone-lineage-contract.ts` |
| Findings, admission, aggregation | `core/review-output.ts`, `core/findings.ts` |
| Wave review roster/narrowing/carry | `core/wave-review-authority.ts`, `core/review-narrowing.ts`, `core/review-change.ts`, `core/wave-review-roles.ts`, `core/wave-review-carry.ts`, `core/wave-review-carry-plan.ts`, `core/review-subject.ts`, `core/retired-wave-review-runs.ts` |
| Wave Gate machine, readiness, status | `core/wave-gate-machine.ts`, `core/wave-gate-checks.ts`, `core/wave-completion-suite-readiness.ts`, `core/wave-gate-preparation.ts`, `core/wave-gate-registration.ts`, `core/loom-status.ts` |
| Panels (architecture + refutation) | `core/panel-kernel.ts`, `core/panel-contract.ts`, `core/panel-program.ts`, `core/review-panel.ts`, `core/persistent-panel.ts` |
| Standalone review & lineage | `core/standalone-review.ts`, `core/standalone-review-scope.ts`, `core/standalone-lineage-contract.ts`, `core/standalone-disposition-machine.ts` |
| Plan design review | `core/plan-design-review.ts`, `handlers/helpers/accept-plan-design-review.ts` |
| Remediation | `core/remediation-machine.ts` |
| Completion suite, owner verification | `core/completion-suite.ts`, `core/owner-verification/`, `orchestration/owner-verification-runner.ts`, `orchestration/owner-mutation-workspace.ts` |
| Acceptance contracts, skeletons | `core/acceptance-contract/*`, `core/skeleton/*` |
| Evidence ledger, machines | `machine/*` (pure core + shells), `core/machine-pins.ts` |
| Proof, red-then-green, test evidence | `core/proof-obligations.ts`, `core/red-then-green.ts`, `core/test-file-classification.ts`, `core/test-evidence-policy.ts`, `core/engine-test-run.ts` |
| Stop checks | `handlers/subagent-stop/stop-checks.ts`, `core/acceptance-contract/stop-check-planner.ts`, `core/affected-stop-check.ts`, `core/task-record.ts` |
| Mutation check, owner check (task-level) | `core/bash-code-mutation.ts`, `core/owner-verification/`, `orchestration/task-record-file.ts`, `orchestration/task-owner-check-runner.ts` |
| Emission | `core/emission-ingestion.ts`, `core/emission-observation.ts`, `core/emission-tool.ts`, `core/issued-emission-capability.ts`, `pi/emission-readiness.ts`, `pi/emission-tool.ts` |
| Capture & attestation | `core/harness-capture.ts`, `core/capture-attestation.ts`, `orchestration/capture-attestation-store.ts`, `handlers/subagent-stop/capture-orchestration-result.ts`, `pi/review-capture.ts` |
| Rules gate | `core/rules-gate.ts`, `handlers/pre-tool-use/claude-transcript-events.ts`, `pi/rules-gate.ts` |
| Linter | `engine/src/linter/*`, `lint-rules/` |
| Type diagnostics | `handlers/type-diagnostics-edit.ts`, `handlers/type-diagnostics-runner.ts` |
| Model calibration | `core/model-calibration.ts`, `calibration/corpus.json` |
| Distill pass | `core/distill-task.ts`, `core/distill-snapshot.ts`, `machines/distill-agent.machine.json` |
| Advisory dispositions | `core/advisory-disposition.ts`, `core/advisory-disposition-record.ts` |
| Reopening/plan edits | `core/task-revalidation.ts`, `core/task-reopening.ts`, `core/reopen-scope.ts`, `core/task-rescope.ts`, `core/task-addition.ts`, `core/task-dependency-edit.ts`, `core/coupled-file-sets.ts` |
