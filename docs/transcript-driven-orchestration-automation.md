# Transcript-Driven Orchestration Automation

> **Status:** Discovery brief for a future `/loom` run  
> **Date:** 2026-08-09  
> **Purpose:** Turn repeated LLM-authored orchestration glue into engine-owned Loom programs, helpers, and harness adapters.

## Executive summary

Recent Pi transcripts show that Loom's deterministic core is strong, but its operational interface is still shallow. The engine owns validation and state transitions while the parent LLM repeatedly writes shell scripts to connect those operations: inspect state, create Run Directories, resolve model profiles, create and verify Review Packets, build Panel Program documents, append events, validate verdicts, copy raw transcripts, and audit staged paths.

The result is avoidable token use, duplicated orchestration logic, quoting and path-handling risk, and inconsistent recovery behavior. The LLM is acting as Loom's shell-script interpreter.

The desired end state is that Loom owns every deterministic orchestration decision. Programs should emit exact external actions—primarily Agent spawn batches and genuine user decisions—while the engine performs bookkeeping, validation, persistence, retries, and state derivation itself. The parent LLM should not need to synthesize `jq`, JSON event logs, shell loops, or raw-output publication commands.

This brief records the transcript evidence, desired outcomes, candidate capabilities, invariants, and acceptance criteria. It intentionally does not commit to final module or CLI shapes; the subsequent Loom architecture phase should design those.

## Evidence base

The analysis sampled:

- the active Loom Pi session `019fe849-08cb-75c6-8fc7-c7bc7b58e545`;
- the active `/home/peterstorm/dev/web/chatbot` Pi session `019fe5f7-960a-7aec-b048-c0ee6e7acef0`;
- eleven additional recent Loom `review-and-fix` sessions.

The sessions were parsed as JSONL and their assistant tool calls classified. Counts are point-in-time observations from active transcripts, not stable product telemetry.

### Aggregate sample

| Observation | Count |
|---|---:|
| Sessions sampled | 13 |
| Bash tool calls | 824 |
| Generated Bash command text | ~327k characters |
| Subagent tool calls | 115 |
| Read tool calls | 589 |
| Write/Edit tool calls | 414 |
| Recorded assistant output tokens | ~647k |

The token total includes implementation and analysis, so it is not itself a savings estimate. The command and helper repetition identifies the automatable share.

### Repeated deterministic operations

| Operation pattern | Observed repetitions |
|---|---:|
| Model-profile resolution | 153 |
| State-file `jq` observability | 86 |
| Review scope and diff-metadata assembly | 62 |
| Panel Program construction/replay | 61 |
| Review verdict validation | 60 |
| Remediation audit/staging assembly | 40 |
| Fresh Run Directory creation | 39 |
| Raw verdict shell embedding | 36 |
| Refutation bootstrap (`brief`, `manifest`, `lenses`) | 19 sequences |
| Review Packet create/verify operations | 46 total |

### Standalone review evidence

Across twelve recent `review-and-fix` sessions, the parent LLM made 98 Write calls under standalone Run Directories, including:

- 72 raw reviewer transcript writes;
- 9 `review-input.json` writes;
- Panel Program documents and raw verifier-output files.

Those Write arguments contained roughly 311k serialized characters. Raw Agent output was returned by the harness, passed through the parent model, and manually copied back to disk even though the run contract requires that output to remain unchanged.

In the active review session alone, the parent generated approximately 25k characters of Bash. It hand-built scope metadata with an inline Bun program, manually wrote six reviewer transcripts, assembled Panel Program events, embedded three verifier outputs in a large shell command, and created custom remediation audit/staging scripts. The first attempt to stage the frozen scope failed because the scope contained a path absent from `HEAD`; the parent then improvised a second staging workflow.

### Wave Gate evidence

The chatbot session is the clearest example. The user largely responded with `go`, while the parent Agent generated more than 240 Bash calls. Repeated Wave Gate cycles required the parent to:

1. inspect current Wave and Task state with `jq`;
2. run test-evidence preflight;
3. resolve the same reviewer model profiles;
4. create and verify one Review Packet per Task;
5. construct reviewer prompts and spawn batches;
6. inspect Review Run roster gaps;
7. resolve profiles again and respawn missing Agents;
8. inspect critical Finding counts;
9. create a Refutation Panel Run;
10. invoke `brief`, `manifest`, and `lenses`;
11. hand-build and replay Panel Program JSON;
12. shell-embed raw verifier JSON into verdict commands;
13. tally;
14. inspect state again to determine the next action.

The session invoked model-profile resolution about 89 times, created 23 Review Packets, verified 23 Review Packets, made about 84 State File queries, and ran eight Refutation Panels. Twice, the parent searched Loom source code to rediscover how Panel Program events had to be appended. This is interface leakage, not domain reasoning.

Implementation/fix Agent spawn arguments contained roughly 136k characters. Wave-review spawn arguments added roughly 147k characters. Much of this was repeated rules, plan context, packet protocol, and output-contract text.

## Problem statement

Loom currently exposes deterministic primitives while its Markdown commands require the parent LLM to implement the workflow connecting them. The interface is nearly as complex as the implementation it hides.

This causes five forms of friction:

1. **Token waste:** repeated shell, JSON, prompt contracts, model lookup output, and state snapshots consume parent context.
2. **Correctness risk:** the parent can omit an event, swap a verdict slot, mishandle a deleted path, quote raw JSON incorrectly, or improvise a non-canonical recovery.
3. **Security risk:** large shell commands repeatedly embed untrusted Agent prose and manipulate authority artifacts by path.
4. **Harness drift:** Pi and Claude Code must independently reproduce workflow glue instead of sharing engine-owned behavior.
5. **Poor locality:** retry policy, next-action derivation, transcript capture, and artifact publication are spread across Markdown, parent reasoning, hooks, helpers, and harness adapters.

The deletion test is the target: deleting most procedural Bash from `commands/wave-gate.md` and `skills/review-and-fix/SKILL.md` should not move that complexity into another prompt. It should disappear behind a deeper engine interface.

## Ownership principle

### Loom must own

- state inspection and derived readiness;
- exact reviewer rosters;
- exact model bindings;
- Run Directory creation and authority files;
- scope and diff metadata;
- Review Packet creation and verification;
- prompt/context materialization;
- retry and missing-evidence policy;
- Panel Program event journals;
- verdict slot/lens/criterion binding;
- transcript and raw-output capture;
- deterministic engine operations such as aggregation and tally;
- remediation path auditing and staged-set verification;
- typed next-action derivation.

### Agents and users must continue to own

- implementation and code changes;
- semantic code review;
- refutation reasoning through assigned lenses;
- advisory relevance decisions;
- remediation design where multiple valid fixes exist;
- interactive architecture choices;
- explicit user approval and genuine policy decisions.

The engine should automate bookkeeping, not pretend deterministic code can replace semantic judgment.

## Candidate capabilities

### 1. Executable Wave Gate Program

Create an engine-owned Wave Gate Program, following Loom's existing executable-model direction. It should own the sequence from implementation readiness through review and final gate completion.

It should derive and perform:

- current-Wave validation;
- Proof Obligation and test-evidence preflight;
- batch-atomic Review Packet preparation;
- reviewer roster and model bindings;
- exact review spawn requests;
- missing-evidence and retry actions;
- critical-Finding detection;
- Refutation Panel preparation and integration;
- final completion readiness.

The program should expose a small action vocabulary such as:

- `spawn-batch`;
- `ask-advisory-triage`;
- `blocked` with typed diagnostics;
- `done`.

The parent executes external Agent spawns and supplies user decisions. It does not query State File internals or hand-advance the program.

### 2. Persistent Panel Program runner

Deepen the existing Panel Program so callers no longer build and replay its event document manually.

A run-scoped runner should:

- derive finding/candidate IDs and ordered lenses/criteria from the authoritative manifest;
- persist the program state and event journal;
- emit exact pending spawn requests;
- accept one raw result against one request id;
- infer the expected lens or criterion from the canonical slot;
- validate and publish the verdict;
- apply the one-retry policy;
- execute deterministic operations such as tally or aggregate;
- return the next external action.

Architecture, Refutation, and Wave Gate programs should remain separate typed reducers. Do not introduce a generic workflow DSL. Shared infrastructure may persist journals and execute actions, but each domain program retains its own algebraic state and events.

### 3. Standalone Review Program

Add one engine operation that starts a complete Standalone Review Run from user arguments. It should own:

- changed-path union or explicit file scope;
- diff stats and language classification;
- deterministic reviewer selection;
- fresh Run Directory creation;
- `review-plan.json` and immutable session initialization;
- model bindings;
- exact reviewer spawn requests and transcript slots.

A caller should not need an inline Bun script, six model-profile calls, or hand-authored plan/input JSON.

### 4. Automatic raw transcript capture

The harness adapters should bind completed standalone reviewer/verifier output directly to engine-declared slots.

Pi already has reservation identity, Agent identity, result ordering, task prompts, and raw result messages. Claude Code has SubagentStop identity and transcript paths. The engine should issue a run/slot binding that adapters recognize, then write the exact output through anchored publication.

Required properties:

- the parent LLM never copies raw Agent output;
- each expected slot is distinct and immutable;
- duplicate, missing, mismatched, or surplus results fail closed;
- capture never mutates an unrelated State File;
- aggregation begins only from the complete frozen roster;
- Pi and Claude Code produce the same canonical run artifacts.

### 5. Immutable Agent Context Packets

Replace repeatedly inlined Agent context with engine-authored, content-addressed packets.

A context packet may contain:

- Task identity and dependencies;
- exact plan/spec context;
- binding architecture and language rules;
- required Skill identity;
- Review Packet reference;
- output contract;
- model profile/request identity.

The parent prompt should carry only a compact, integrity-bound packet reference. Harness adapters or Agent startup logic should load the packet into child context without routing its full contents through the parent model repeatedly.

Review lifecycle protocol belongs in reviewer Agent definitions and Skills where possible. Per-spawn prompts should contain only variable data.

### 6. Canonical Loom status and next action

Implement the currently planned `/loom --status` as a real engine query with human and machine output.

It should report:

- active Phase and Wave;
- pending/running/completed Tasks;
- failed Proof Obligations;
- test readiness;
- Review Run roster gaps and evidence failures;
- active, advisory, resolved, and refuted Findings;
- whether a Refutation Panel is required;
- whether the Wave Gate can complete;
- one typed `next_action` with reasons.

This pure status derivation should also be consumed internally by the Wave Gate Program. It must not become a second validator with different rules.

### 7. Remediation audit and staging

Add an engine-owned remediation boundary for `review-and-fix`.

It should:

- load authoritative `result.json.scope`;
- register the remediation plan and any allowed new regression/support paths;
- derive dirty paths safely, including deletions and paths no longer present in `HEAD`;
- reject changed paths outside the audit authority;
- stage exactly the audited dirty set;
- verify the staged set and print canonical evidence;
- never stage Run Directory evidence;
- preserve pre-existing user changes according to an explicit, tested policy.

This must replace ad hoc `git add` argument assembly and comparison scripts.

### 8. Model bindings as spawn-request data

Model resolution is deterministic and should not be a separate parent-LLM step for every Agent.

Every engine-authored spawn request should already contain the semantic LLM Profile and exact harness binding required by the target Agent. Hooks still validate the binding fail-closed, but the parent should not call `model-profiles agent` repeatedly—especially in Pi, where generated Agent definitions already carry exact bindings.

A shallow `model-profiles batch` helper may be a temporary migration aid, but it is not the desired final interface.

## Non-goals

- Do not let helpers spawn semantic Agents invisibly without an auditable external action.
- Do not build a general-purpose workflow language.
- Do not weaken immutable Review Packet, Review Run, Finding identity, or Refutation Panel invariants.
- Do not merge architecture and refutation lens vocabularies.
- Do not hide user-facing advisory decisions.
- Do not move deterministic orchestration into larger prompt templates.
- Do not use shell scripts as the source of truth; scripts may be thin entrypoints over TypeScript core/helpers only.
- Do not add a second State File writer outside existing `StateManager`/hook authority.

## Architectural constraints

The future design must follow the project rules:

- functional core / imperative shell;
- typed reducers and algebraic states for executable programs;
- immutable, idempotent run artifacts;
- parse, do not validate-and-cast;
- fail closed on missing evidence, malformed results, drift, or partial publication;
- descriptor-anchored/no-follow filesystem operations for authority artifacts;
- exact rosters and exact ordered slots;
- no hand-authored finding sets;
- no parent-model reconstruction of raw evidence;
- harness parity tests for Pi and Claude Code;
- model policy resolved before spawn and validated at the harness seam;
- retries represented as program state, not improvised prose.

## Acceptance criteria

A successful implementation should satisfy all of the following.

### Wave Gate

1. A normal Wave review requires no parent-authored `jq`, packet loops, model-profile loops, or prompt-contract assembly.
2. The engine prepares every Task's packet and review request as one validated operation or publishes none of them.
3. Missing reviewer evidence produces exact retry spawn requests without parent analysis of State File internals.
4. A critical-bearing Wave transitions into the Refutation Panel through the same executable program, without hand-built Panel Program JSON.
5. The parent never shell-embeds verifier output.
6. The engine reports when advisory triage is the remaining user action.

### Standalone review

7. Starting a review requires one preparation operation plus the returned reviewer spawn batch.
8. Scope, stats, selected reviewers, model bindings, plan authority, and transcript slots are engine-authored.
9. Reviewer transcripts are captured unchanged by harness adapters; the parent performs zero transcript Write calls.
10. Aggregation and zero-critical finalization or critical-bearing panel preparation happen only after the exact expected roster is complete.

### Panels

11. Callers never manually create or append Panel Program event arrays.
12. Verdict slot identity is inferred from the request id/run authority, not repeated by the caller.
13. Tally/aggregate cannot run until every canonical slot succeeds.
14. Retry and terminal blocked states survive process/session interruption.

### Context and models

15. Engine-authored spawn requests include exact model bindings.
16. Variable Agent prompts are compact references to immutable context rather than repeated full rules/contracts.
17. Existing model and Skill spawn gates continue to fail closed.

### Status and remediation

18. `/loom --status` replaces documented ad hoc State File `jq` recipes and exposes one typed next action.
19. Remediation staging handles deleted/absent scoped paths and fails on any unaudited dirty/staged path.
20. Run evidence is never included in commits.

### Quality

21. Pi and Claude Code integration tests prove equivalent program transitions and artifacts.
22. Property tests cover event replay idempotency, exact roster/slot conservation, interruption/resume, and terminal-state monotonicity.
23. Fault-injection tests cover partial filesystem publication, malformed/surplus results, stale requests, and helper crashes.
24. Documentation becomes shorter because procedural mechanics are deleted, not copied elsewhere.

## Suggested delivery order

The architecture phase should evaluate sequencing, but the current dependency order is:

1. persistent program-session infrastructure for typed reducers;
2. persistent Panel Program runner;
3. Standalone Review start and automatic transcript capture;
4. executable Wave Gate Program;
5. immutable Agent Context Packets;
6. canonical status/next-action output;
7. remediation audit/staging;
8. deletion and simplification of obsolete runbook mechanics.

The implementation should be delivered in independently testable slices. Compatibility adapters may temporarily preserve existing CLI operations, but new runbooks should use only the deep interface once parity is proven.

## Risks and design questions for the Loom run

The subsequent brainstorm/spec/architecture phases should explicitly resolve:

1. How are external Agent results delivered to a persistent program without routing raw output through the parent model?
2. How does Claude Code transcript capture achieve parity with Pi reservation-bound capture?
3. Is program state stored inside existing Run Directories, in a separate program-run root, or both?
4. Which deterministic engine operations may the runner execute automatically, and which require an externally visible action receipt?
5. How are user advisory decisions represented as typed events?
6. How are interrupted programs resumed without replaying already-published side effects?
7. How do context packets reach child Agents without duplicating their bytes in parent context?
8. What compatibility period is required for existing `panel-program`, `review-panel`, and `standalone-review` operations?
9. How should remediation staging treat pre-existing unstaged user changes present at review start?
10. What quantitative transcript benchmark will prove the new interface reduced orchestration calls and context?

## Proposed benchmark

Retain a sanitized replay fixture representing:

- one two-Task Wave with no critical Findings;
- one Wave with missing reviewer evidence and a retry;
- one Wave with surviving and refuted critical Findings;
- one standalone review with six reviewers and three refutation lenses;
- one remediation that adds a regression test and deletes a scoped file.

Run both the legacy and new interfaces against the fixture. The new interface should demonstrate:

- zero parent-authored `jq`;
- zero parent-authored JSON event journals;
- zero raw-output shell embedding;
- zero manual transcript publication;
- zero explicit per-Agent model-profile lookup in Pi;
- materially fewer parent tool calls and prompt bytes;
- identical or stronger canonical artifacts and gate decisions.

## Suggested Loom invocation

Use this document as the approved discovery input:

```text
/loom --skip-brainstorm "Deepen Loom's orchestration interface using docs/transcript-driven-orchestration-automation.md as the authoritative discovery brief. Move deterministic Wave Gate, standalone review, panel-session, transcript-capture, status, context-packet, and remediation-staging mechanics behind engine-owned executable programs while preserving fail-closed harness parity."
```
