# What the Deterministic Core Delivers

This document explains the value of two coordinated branches:

- **loom** `feat/deterministic-core-phase-c`
- **fugue** `feat/deterministic-core-phase-b`

They ship together because they form one contract: loom orchestrates and
*enforces*, fugue generates typed workflow code and *stamps* it so loom can
verify it. The short version: **the workflow stops being a set of polite prose
instructions to an agent and becomes running code the agent cannot deviate
from.**

---

## 1. The problem this solves

A prompt-driven agent workflow degrades in predictable ways:

- **State drifts from description.** A plan says "the order state machine lives
  in `order-machine.ts`," but nothing stops a second file from re-implementing
  the transitions with a slightly different mental model.
- **Evidence is just text.** "All 10 tests passed" echoed into the transcript
  looks identical whether the test runner exited 0 or 1. An agent can declare
  success it did not earn.
- **Invariants are wishes.** "Refresh tokens only in `auth.ts`" is enforced by
  reviewer attention, which is finite and fatigues.
- **Retries and budgets are hand-maintained.** A new error kind silently
  inherits "retriable," so deterministic failures (a 401, an exhausted budget)
  get retried anyway, burning tokens.

Every one of these is a place where the system *says* one thing and *does*
another. The deterministic core closes that gap by moving the guarantees into
types, hooks, hashes, and a fail-closed guard — mechanisms that cannot be
talked out of enforcing themselves.

---

## 2. What loom's phase-c adds

Loom is a Claude Code plugin that runs a feature through a structured pipeline —
**brainstorm → specify → clarify → architect → plan-alignment → decompose →
execute (parallel waves) → wave-gate**. Phase-c turns the load-bearing parts of
that pipeline from *documentation* into *executable models* enforced by hooks.

### 2.1 Executable lifecycles (not prose state diagrams)

A plan declares `### LC-N` blocks binding a lifecycle to a machine file (e.g.
`src/domain/order/order-machine.ts`). The implementation imports and runs that
one typed reducer instead of re-deriving transitions elsewhere.

- **Enforced by:** `validate-task-graph` fails closed if a declared lifecycle
  has no machine file in any task's `file_list`; `decompose` emits a dedicated
  wave-1 task to build the machine and makes dependents depend on it.
- **Prevents:** two divergent copies of the same state machine.

### 2.2 Executable pipelines (generated structure, never hand-wired)

The architecture phase authors a fugue `AuthoredDag` sidecar and declares it in
a `## Pipeline` section. Agents fill only node *bodies*; the graph *structure*
is generated deterministically by `fugue new --from` and integrity-hashed.

- **Enforced by:** the `fugue-generated-integrity` programmatic lint rule
  (`engine/src/linter/programmatic/fugue-generated-integrity.ts`) recomputes the
  structural hash at the wave gate and blocks on mismatch.
- **Prevents:** silent hand-edits to node wiring, ordering, or IDs.

### 2.3 Checkable invariants (not advisory hopes)

A plan declares `### INV-N` blocks with `Tier: checkable`. The architecture
phase itself writes the JSON regex rule into the linter's rules directory
*before* implementation starts; it is then enforced on every edit.

- **Enforced by:** `validate-lint-rules` proves each rule loads through the
  fail-closed loader (malformed JSON, ReDoS-unsafe patterns, and missing fields
  all fail); `PostToolUse lint-file` runs it on every edit thereafter.
- **Prevents:** the "no rule, so no enforcement" review gap. Checkable
  invariants outlive the feature.

### 2.4 The evidence ledger (ground truth, not transcript text)

The guarded skill machine (`engine/src/machine/`) records facts-only events to a
per-session `*.evidence.jsonl` ledger: `FileRead`, `FileWrite`, `TestRun`. A
`TestRun` is trusted only when the process exit code **and** a machine-readable
report artifact (vitest JSON, JUnit XML) cross-check. Transcript text is never
evidence.

- **Enforced by:** `record-evidence` (PostToolUse) appends epoch-stamped events;
  `update-task-status` (SubagentStop) folds the ledger into a verdict. A trusted
  run yields `trusted-pass`; a transcript-regex-only signal is labeled
  `untrusted` / low-trust so a degraded pass cannot masquerade as a real one.
  Report artifacts must postdate the *start* of the Bash call that produced them
  (call-scoped freshness), so a stale artifact cannot re-vouch for a later
  command.
- **Prevents:** an agent fabricating a passing test result.

### 2.5 The phase machine (tool gates, not skill prose)

An agent type can bind a `.machine.json` statechart (the shipped
code-implementer machine enforces `read-context → implement → verify → done`).

- **Enforced by:** `enforce-phase-tools` (PreToolUse) denies tools the current
  phase does not list — deny-by-default within the machine's jurisdiction; the
  pure reducer `advance.ts` folds evidence to decide when a phase advances.
- **Prevents:** write-before-read and other out-of-phase actions. (Documented
  limitation: the gate stands down under parallel waves where evidence
  attribution to a single subagent is ambiguous.)

### 2.6 The programmatic linter (executed, not aspirational)

Rules under `engine/src/linter/programmatic/` run at the wave-gate tier and all
fail closed (a crash or parse error blocks the gate):

- `max-function-lines` — complexity ceiling
- `no-cross-boundary-imports` — DDD bounded-context arrows point inward
- `no-io-in-pure-modules` — no `process.env` / `fetch` / `Math.random` /
  `Date.now` / I/O imports in modules declared functional-core
- `fugue-generated-integrity` — structural tamper detection for generated DAGs

---

## 3. The fail-closed state-file guard

The evidence ledger and the orchestration state file are the crown jewels: if an
agent can write them directly, it can forge test verdicts and phase completion,
and every downstream gate then decides on false data. `guard-state-file`
(`engine/src/core/guard-state-file.ts`) is a **deny-by-default** Bash gate: a
command that references a guarded path is allowed only if every segment is a
read-only command (no output redirect) or a whitelisted helper. Everything else
blocks — including writers nobody enumerated.

The hard part is that bash can *spell the same path many ways*. The guard has
been hardened across ~26 review rounds against a single recurring class:
**word-normalization bypasses**, where a guarded literal is fragmented or
reassembled through shell syntax so a naive matcher misses it. Representative
vectors closed:

- Quote splitting: `.cl'aude'/state/...`
- ANSI-C and locale forms: `$'...'`, `$"..."`, line-continuations, NUL truncation
- Parameter expansion default/alternate/indirect forms: `${x-w}`, `${x:+w}`,
  `${!x:-w}` and their set-but-empty and always-set variants
- Brace and glob fragmentation: `active_task_{graph,x}.json`, `.claude/state/*`
- Command/process substitution — empty output rejoining a fragment
  (`.claude/stat$(:)e` → `.claude/state`) **and** nonempty output *completing*
  one (`.claude/stat$(printf e)` → `.claude/state`, the round-26 fix)

The defense is **reveal-monotonic**: the guard tests several collapsed views of a
command (quotes stripped, substitutions modeled as empty/literal/wildcard,
braces expanded), and each transform only ever *joins or exposes* literal
fragments — never hides one — so a guarded path that could reassemble under any
bash variable state appears contiguously in at least one view. An unparseable or
unbounded line fails closed. This is real hardening against real reassembly
attacks, verified end-to-end against a live bash, not hygiene theater.

---

## 4. What fugue's phase-b adds

Fugue is a typed, DAG-shaped durable runtime for LLM-bearing workflows:
crash-resume execution, typed nodes, human-in-the-loop suspension, and per-run
token budgeting. Phase-b makes its failure model and its generated code
*provably* correct rather than conventionally correct.

### 4.1 An exhaustive, type-encoded error model

`FrameworkError` (`packages/framework/src/types/errors.ts`) is a discriminated
union of 27 kinds. The defining behavioral axis — retriability — is single-
sourced in `retriabilityOf(e): Retriability`, an exhaustive `match(...)
.exhaustive()` with no `.otherwise()` fallback. `retry-policy.ts`'s
`handleNodeFailed` forks solely on that function.

- **Compile-time guarantee:** adding a 28th error kind without classifying its
  retriability is a TypeScript error. The unsafe direction — a new kind silently
  defaulting to "retriable" and burning retry budget on a deterministic failure —
  is now impossible. Three sibling functions (`usageOfError`, `messageOf`,
  `formatFrameworkError`) are exhaustive the same way, so token accounting and
  error formatting cannot silently regress either.

### 4.2 LLM error taxonomy + 100% token attribution

A single `classifyHttpStatus` (`llm/llm-errors.ts`) is the one policy for
transient (429/408/409) vs. non-retriable (other 4xx) vs. retriable (5xx), used
by both the raw-HTTP and SDK duck-typed paths so they cannot diverge. Errors
that consumed tokens (`node-crash`, `transient`, `aborted`) carry a
`PartialTokenUsage`; `usageOfError` extracts it exhaustively.

- **Guarantees (FR-W0-001):** every token a node burns is attributed to that
  node's budget — even when a tool-use loop crashes mid-turn or a model returns
  malformed JSON. A failed OpenAI Responses call threads usage on every terminal
  arm. No blind retry of a 401; no silently dropped tokens.

### 4.3 `@fugue-integrity` structural stamping

`fugue new --from` / `fugue compose` generate `dag.ts` deterministically from an
`AuthoredDag` and stamp it (`cli/authored-codegen.ts`):

```
// @generated ... implement only the @fugue-body regions (structure is integrity-hashed)
// @fugue-integrity sha256:<64-hex>
```

The hash covers `structuralProjection(body)`, which collapses every
`@fugue-body-start/-end` region to a canonical marker. Region *contents* (the
bodies you implement) are erased before hashing; imports, schemas, node IDs, and
wiring are not inside markers, so they *are* hashed.

- **Guarantees:** regenerating from the same `AuthoredDag` is byte-identical;
  implementing a body does **not** change the hash; rewiring the structure
  **does**. Defense-in-depth: the schema and the codegen both reject a
  `@fugue-body` marker appearing inside any LLM-authored free-text field
  (purpose, description, enum values), so the marker cannot be injected to poison
  the projection.

### 4.4 CLI authoring / lint / visualize surface

`fugue new`, `new --from`, `lint`, `describe`, `visualize`, and `compose` let a
DAG be authored and *validated without running it*: `defineDag` proves no cycles
and real edges, `analyzeDag` checks fan-in key matches, `visualize` renders
Mermaid (safe even when lint fails, which helps reveal topology mistakes). In
`compose`, the LLM only ever emits closed-schema `AuthoredDag` JSON — DAG code is
always generated deterministically, never hand-synthesized by the model.

---

## 5. The cross-repo contract

Fugue **stamps**; loom **verifies**. Neither imports the other — the coupling is
a four-part convention:

1. banner format `// @fugue-integrity sha256:<lowercase-hex>`
2. a comment-only prelude above the banner
3. the two marker strings `@fugue-body-start` / `-end`
4. the collapse rule (sha256 of `structuralProjection` output, UTF-8, hex)

Fugue does **not** self-verify — it would only be marking its own homework. Loom
recomputes the hash at the wave gate (`fugue-generated-integrity.ts`) and blocks
on mismatch. `.gitattributes` pins generated `dag.ts` to LF so a CRLF checkout
cannot cause a spurious mismatch. The coupling is intentionally tight: drift in
any of the four items should *break* verification loudly rather than pass
silently.

---

## 6. Before → after

| Concern | Before (prose workflow) | After (deterministic core) |
|---|---|---|
| State machine | Re-implemented in a second file, drifts | One bound machine file; `validate-task-graph` fails closed without it |
| Graph structure | Hand-editable, undetectable | Integrity-hashed; wave gate blocks structural edits |
| Invariants | Prose, caught by reviewer attention | Executable regex rules enforced on every edit, forever |
| Test results | "PASS" text trusted as-is | Exit code + report artifact cross-checked; `trusted-pass` vs `untrusted` |
| Phase order | Suggested by skill text | `enforce-phase-tools` denies out-of-phase tools |
| State/ledger writes | Reachable via Bash | Fail-closed guard, hardened over 26 rounds against bash reassembly |
| Retry / budget | Hand-maintained; new kinds default retriable | `retriabilityOf` exhaustive; a new kind is a compile error until classified |
| Token accounting | Scattered `usage?`, lossy | 100% attribution, exhaustively extracted |

The through-line: **the system now enforces what it claims.** State cannot
diverge from its declaration, an agent cannot forge its own evidence or skip a
phase, an invariant is checked rather than hoped for, generated structure is
tamper-evident, and the failure model is proven exhaustive at compile time.

*Verification for phase-c: `engine` typechecks clean and the full suite is 1592
passing / 0 failing as of the round-26 fix.*
