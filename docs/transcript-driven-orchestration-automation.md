# Transcript-driven orchestration automation: discovery to shipped system

**Status:** implemented; this document preserves the discovery evidence and maps it to the current architecture.

**Decision:** [ADR-0004](adr/ADR-0004-engine-owned-orchestration-automation.md)
**Current design:** [Architecture](architecture.md), [Workflows](workflows.md)

## Why this work happened

Loom’s original deterministic core validated state transitions, but Markdown runbooks still asked the parent model to perform deterministic glue:

- inspect protected state with repeated `jq` calls;
- derive scope and diff metadata;
- look up each model profile;
- create Review Packets and Run Directories;
- assemble prompts and transcript slots;
- construct and replay panel event arrays;
- embed raw verifier output in shell commands;
- decide which retries were needed;
- build Git pathspecs and verify staging.

The engine owned individual primitives while the model implemented the workflow connecting them. That was a shallow interface: expensive, inconsistent, difficult to resume, and vulnerable to quoting/path mistakes.

## Transcript evidence

The discovery sampled 13 recent Loom sessions:

| Observation | Count |
|---|---:|
| Bash calls | 824 |
| Generated Bash text | about 327k characters |
| Subagent calls | 115 |
| Read calls | 589 |
| Write/Edit calls | 414 |

Repeated deterministic operations included 153 model-profile resolutions, 86 raw state queries, 62 scope/diff assemblies, 61 panel-program construction/replay operations, 60 verdict validations, 40 remediation staging assemblies, and 39 fresh Run Directory creations.

Across 12 review-and-fix sessions, the parent made 98 writes beneath standalone review runs, including 72 raw transcript copies. Raw Agent bytes traveled through the parent model and were then manually written back even though immutability was a contract requirement.

The Wave Gate sample showed the same pattern at greater scale: packet loops, reviewer prompts, model resolution, retry discovery, panel setup, verifier JSON embedding, tally, and final state inspection were repeated for every Wave.

These observations established that the problem was interface leakage, not missing model intelligence.

## Ownership rule

The accepted boundary is:

### Loom code owns

- scope and repository metadata;
- exact rosters and request slots;
- model/Skill bindings;
- Run Directory and Review Packet authority;
- immutable Context Packets;
- transcript/result capture;
- semantic retry limits;
- event journals and checkpoints;
- deterministic aggregation and tally;
- canonical status/next action;
- remediation path audit, temporary staging, verification, and index install.

### Agents and users own

- implementation and remediation code;
- semantic review and refutation reasoning;
- architecture candidate content;
- approach selection;
- advisory disposition;
- explicit approval and policy choices.

The engine automates bookkeeping and authority. It does not pretend code can replace semantic judgment.

## What shipped

### One orchestration façade

`engine/src/handlers/helpers/orchestration.ts` exposes registered programs for:

- architecture panel dispatch;
- refutation panel dispatch;
- standalone review;
- Wave Gate;
- remediation;
- canonical status.

The parent receives only `spawn-batch`, `await-user`, `blocked`, or `done` at true external boundaries.

### Persistent typed programs

Closed reducers now model Wave Gate, standalone review, refutation/architecture panels, and remediation. Events are persisted through `orchestration/fugue-program-runtime.ts`; checkpoints are projections, not primary history. A semantic failure gets one retry, and attempt-2 rejection is a typed terminal state.

### Engine-issued request authority

Each request binds exact Run, slot, attempt, Agent, model profile, both harness bindings, required Skill, Context Packet digest, and output slot. Complete-roster values are parser-produced, so partial evidence cannot reach aggregation.

### Automatic exact-byte capture

Claude SubagentStop and Pi tool-result paths map native completion identities to engine request authority and publish the exact final bytes into reserved transcript slots. The parent no longer copies transcripts.

### Immutable Context Packets

Fixed and variable Agent context is encoded, hashed, published, and referenced by digest/path. Registered programs no longer repeat large policy/prompt bodies through parent reasoning.

### Canonical status

`helper orchestration status` derives one `LoomStatus` and renders human or JSON forms. Missing authority becomes explicit `unavailable` facts and a blocked action.

### Remediation boundary

The registered remediation program loads authoritative standalone review results, adds explicit support paths, audits dirty paths, rejects evidence/unrelated work, stages with literal semantics into a temporary index, proves exact equality, rechecks repository witnesses, and installs the verified index.

### Model bindings in spawn requests

Registered programs resolve model profiles before publication. The parent no longer performs a model lookup per Agent, while harness gates continue to validate exact policy.

## Architecture selected by the panel

Three architecture candidates were generated and judged. The deterministic ranking preferred the simplicity-first candidate, but the user chose type-driven FP for its stronger pure-core guarantees.

The final design grafted:

- one small parent-facing façade from simplicity-first;
- parser-produced complete-roster proof and typed reducers from type-driven FP;
- anchored fixed-layout authority and narrow capabilities from risk/security-first.

The result uses Fugue 0.4.0 directly through its public state-machine and DAG APIs. It deliberately does not create one plan-level `AuthoredDag` for Loom’s internal orchestration: several distinct operation DAGs and persistent domain reducers cannot be honestly represented by that one-sidecar shape.

See [ADR-0004](adr/ADR-0004-engine-owned-orchestration-automation.md) for the complete decision and consequences.

## Acceptance criteria status

| Discovery criterion | Shipped mechanism |
|---|---|
| No parent `jq` for Wave decisions | Canonical status + Wave Gate reducer |
| Batch-atomic review preparation | Initial publication intents/receipts and exact request authority |
| Exact retry requests | Attempt-aware reducer state and durable capture rejection |
| Automatic refutation routing | Standalone and Wave Gate drivers |
| No verifier shell embedding | Harness exact-byte capture |
| Advisory remains user-visible | `await-user` + `decide` |
| One-call standalone preparation | Registered standalone start |
| Exact frozen scope/roster | Standalone authority and Context Packets |
| No manual transcripts | Cross-harness capture runtime |
| No caller panel event arrays | Registered panel driver and internal deterministic operations |
| Slot/lens/criterion binding | Request authority + slot parsers |
| Resume survives interruption | Append-only events, checkpoints, idempotent receipts |
| Model included in request | Semantic profile + both harness bindings |
| Exact remediation staging | Registered remediation + temporary index install |
| Pi/Claude parity | Shared core plus adapter contract tests |

## Benchmark result

The accepted ADR records the initial status benchmark: eight parent `jq` calls (890 command characters) became one façade call (56 characters), an 87.5% call reduction and 93.7% command-text reduction.

The broader qualitative result is more important: the deleted logic did not move into a larger prompt. It moved behind typed, tested interfaces with auditable artifacts.

## Remaining migration boundary

Legacy helpers and historical run formats remain readable for audit compatibility. Their parsers are frozen in `engine/src/core/legacy-archive.ts`; new code must not extend those shapes. Canonical registered programs are the path for new standalone review, Wave Gate, and remediation work.

Architecture panel’s detailed `/loom` phase still has interactive/template integration around the registered dispatch core, and Pi’s headless interview relay remains unresolved. Those limitations are documented rather than hidden.
