# Deterministic implementation and verification

Status: design proposal with explicitly marked shipped-baseline sections. Verification Policy, the quiescent Wave completion suite, and Slice 3 Task-local Implementation Attempt authority are shipped. Slice 4 bounded retry/escalation is implemented and locally validated on `feat/deterministic-implementation-retry` (issue #39) but is not yet claimed shipped; later items remain proposals. Passages labeled **Shipped baseline**, **shipped**, or **implemented** describe current behavior. For the complete shipped guarantees this proposal builds on, see [Deterministic core](deterministic-core.md).

Loom 1.1 made orchestration *authority* deterministic: state transitions, gate arithmetic, retry accounting, and evidence attribution are code. What remains model judgment is verification *content* — reviewers produce prose findings, spec-check emits an LLM verdict, and implementers generate code with no machine-checkable contract beyond `file_list` byte changes. The remediation phase is where that residual judgment gets paid for, repeatedly and expensively.

This proposal covers both halves of the problem:

- **Part I — Verification:** replace classes of LLM findings with deterministic gates (static analysis, architecture conformance, mutation testing, contracts), and change the remediation economics for the findings that remain.
- **Part II — Implementation:** make the implementer agents produce correct code the first time, by shrinking the generation space before spawn and putting deterministic oracles inside the agent's own loop.

The organizing principle extends the shipped one ("models for judgment, code for authority"): **every finding class that can be mechanized (a) never becomes prose, (b) is caught at edit time or completion time with an exit code and an exact location, and (c) needs no refutation panel, because compilers do not hallucinate.**

## 1. Where remediation cost actually comes from

Empirically, from the engine and its documented bug history, remediation cost has five distinct drivers. Static analysis addresses some but not all of them; the proposal is honest about which.

1. **Total invalidation on any byte change.** For modern exact attempts, `applyImplementationCompletionTransition` applies Task-local byte authority, bumps `review_generation`, drops `review_run`, clears the wave's `spec_check`, and resets `tests_passed`/`reviews_complete`; `applyUntrustedStopResolution` performs the corresponding authority-free legacy compatibility invalidation. A one-line advisory fix therefore costs a full reviewer-roster re-run (`WAVE_REVIEW_AGENTS` × every wave task) plus spec-check, plus a fresh refutation panel if any critical remains. Nothing scopes re-review to what changed. This is the dominant structural cost driver.
2. **Prior-finding re-assessment grows monotonically.** Every reviewer must assess every prior finding id exactly once per round (`core/findings.ts`, packet-order lockstep). The design is correctly fail-closed — a clean rerun cannot silently erase an old blocker by omission — but it makes round *N* cost O(accumulated findings), every round.
3. **Findings are prose, so wrongness is expensive.** A plausible-but-wrong critical costs a full remediation cycle (`commands/loom.md`, `references/review-lenses.md`). The refutation panel is a mitigation that spends more LLM tokens to adjudicate LLM judgment; it exists because there is no cheaper oracle.
4. **Wire-format failures burn attempts.** The attempt-1/attempt-2 machinery and its retry diagnostic (`programs/wave-gate.ts`, `WAVE_RETRY_PREAMBLE`) exist because models emit malformed lifecycle JSON and repeat it on retry, exhausting a batch and forcing an exhausted-run restart into a fresh run directory.
5. **Acceptance is judged, not checked.** The machine-checkable per-task contract is thin: declared artifacts changed bytes, a trusted test ran, `LC-N` machine files exist. As `references/executable-models.md` states: *"Wave-gate artifact verification is existence, not semantics. An empty file at the declared path passes the gate and fails at test evidence."* Spec alignment is an LLM emitting `FR-XXX: PASS`.

**Shipped baseline:** the registered Wave Gate now invokes an engine-owned quiescent completion suite after every current-Wave Agent has stopped. The operator's optional `.loom/verification-manifest.json` is parsed and frozen during TaskGraph population; commands are executable/argv arrays run without a shell. The suite binds exact process facts and immutable result bytes to manifest, suite, result, and Git-visible workspace digests in protected readiness. Full-tier lint is the reserved engine check and the prior terminal lint shell remains as a migration canary. Programmatic boundary, purity, function-length, and generated-integrity violations therefore block advancement automatically; the old documented-only “Step 4c” gap is closed.

## 2. The three-distance model

Both parts of this proposal are one architecture. A deterministic oracle can sit at three distances from the model, and the cost of a defect scales with the distance at which it is caught:

| Distance | Mechanism | Cost of a defect |
|---|---|---|
| In the edit loop | `lint-file` PostToolUse hook: typecheck, AST rules, format-on-write | one tool call, hot context |
| At task completion | SubagentStop gate: engine-run tests/lint/arch checks, red-green obligation | one same-agent resume, hot context |
| At the wave gate | reviewer roster, spec-check, refutation panel, remediation loop | a full remediation cycle |

Loom today runs almost everything at the third distance. The proposal moves copies of the deterministic oracles into the first two rows, and shrinks the generation space so there is less for any oracle to catch. Complementarily, code checks run *globally* (they are cheap) while LLM re-review scopes to the *diff* (it is expensive) — the inverse of today's arrangement.

---

## Part I — Deterministic verification

Organized as a ladder from "close existing gaps" to "formal methods," in rough order of effort.

### Tier 0 — close existing gaps (no new tools)

**T0.1 — Full-tier lint in the registered wave-gate program (shipped).** The helper (`engine/src/handlers/helpers/lint-wave-gate.ts`) and registered façade share one fail-closed shell over the Wave's `files_modified`. The façade runs it after semantic readiness and before the protected completion commit, closing the former documented-but-unenforced lint drift.

**T0.2 — Engine-executed build/typecheck/test as a gate check (Wave scope shipped).** The proof-obligation system establishes *trusted* Claude Task test evidence via ledger attribution and preserves Pi structured evidence with its provenance, with documented forgery residuals. The engine-owned Task-local oracle runs only `loom:task-byte-scope`; agents still execute required Task tests as evidence. At Wave scope, the engine executes operator-frozen project commands after quiescence and records orthogonal exit/timeout/signal/report facts; evidence the engine produced needs no model trust. Required reports live under a protected report root and are freshness-checked. Whole-program build/typecheck/test commands remain Wave-quiescent because they are unsound while sibling Tasks write concurrently.

**T0.3 — Strict structured outputs for every "returns pure JSON" agent.** Anthropic structured outputs (beta Nov 2025, GA early 2026) perform constrained decoding against a JSON schema, making schema-invalid output impossible at the decoder. The decompose agent, arch judges, review verifiers, and the reviewer lifecycle blocks are all parse-then-retry today. Once the harness path Loom runs on exposes strict tool schemas, the entire wire-format attempt-exhaustion class — and the terminal-block → restart ceremony it drags in — disappears. Until then the retry diagnostic is the right mitigation; after, it is legacy. Note one caveat from the literature: grammar-forcing can slightly degrade reasoning on complex tasks; the standard mitigation is "reason free-form, then emit structured."

### Tier 1 — mechanize reviewer dimensions

A large fraction of what the frozen reviewer roster (`engine/src/config.ts`, `WAVE_REVIEW_AGENTS`) finds is mechanizable with production-ready 2026 tooling.

**T1.1 — Replace the regex lint tier with AST-level rules.** The shipped regex rules (`lint-rules/*.json`: `no-any-type`, `no-console-log`, `no-raw-exception-catch`, `no-field-injection`, …) false-positive on strings and comments and cannot express structure. **ast-grep** (Rust/tree-sitter, repo-scale scans in seconds, YAML rules with relational constraints `inside`/`has`/`not`, autofix, embeddable as a library) can slot directly into the `lint-file` PostToolUse hook so violations block at edit time. First-class TypeScript; workable Java. For taint/dataflow rules, **Opengrep** (the LGPL consortium fork of Semgrep CE, which narrowed its OSS scope in Dec 2024) is the choice.

**T1.2 — Compile `rules/architecture.md` into architecture conformance checks.** This is the highest-value mechanization because it is exactly what `code-reviewer` currently judges as prose:

- **TypeScript:** **dependency-cruiser** — "functional core imports no IO" is literally a rule (`core/**` may not import `fs`/net/db clients). **eslint-plugin-boundaries** for the layer interaction matrix. **eslint-plugin-functional** strict preset on core directories for immutability and no-expression-statements.
- **Java:** **ArchUnit** (+ **jMolecules** to declare the DDD/hexagonal model as annotations and enforce it with the shipped rule sets). **NullAway + JSpecify** makes null-safety a compile failure — Spring Boot 4 annotated its entire API with JSpecify in Nov 2025, so the ecosystem tailwind is real. **Checker Framework** `@Pure`/`@SideEffectFree` is the only tool that machine-checks purity claims; at 2–4× compile cost, scope it to functional-core packages only.
- The existing `no-cross-boundary-imports` programmatic rule already gestures at this, and `references/executable-models.md` names "auto-generated rules from state lists" as future work. This is that work. The `lint-project` setup skill is the natural place to generate the per-project rule files.

**T1.3 — Effect (TS) as the opt-in maximum.** `Effect<A, E, R>` puts side effects and error channels in the type system, making the compiler the functional-core/imperative-shell reviewer. It is a framework commitment, so it belongs in the architecture-phase option set, not as a mandate; the dependency-cruiser rule delivers ~80% of the value for ~5% of the cost.

Net effect on the roster: `code-reviewer` shrinks to genuinely semantic judgment; `silent-failure-hunter`'s catch-swallowing patterns become Error Prone/ast-grep rules; `type-design-analyzer` is partially subsumed by typed lint plus the contract tier below.

### Tier 2 — machine-checkable task contracts

**T2.1 — Frozen interface artifacts per task.** At decompose time, tasks that expose an API also get a declared surface: TypeScript → an API Extractor `.api.md` (or `.d.ts` plus expect-type assertions); Java → a japicmp baseline. New gate check: exported surface equals declared surface, as an exact exit-code diff. This does something nothing in Loom currently does: it keeps parallel implementers in one wave compatible with each other by contract rather than by shared prose plan context. Cross-task integration drift is precisely the class of bug that surfaces late as a critical.

**T2.2 — Requirement Completion Claims compiled to frozen executable acceptance.** At decompose time or wave start, the existing test-engineer agents translate the current Wave's `spec_anchors` Completion Claims into failing unit tests plus property-based tests (fast-check / jqwik); `spec_contributions` remain traceability only and are excluded. The engine records the acceptance-test hashes before any implementer spawns (the Fugue tamper-evidence machinery already implements exactly this hash-freeze pattern). Gate: those exact tests pass, hashes unchanged. Consequences:

- `checkTestEvidence` stops meaning "a test ran" and starts meaning "the acceptance tests pass."
- Spec-check's LLM judgment shrinks to the residue of criteria that genuinely cannot be expressed as tests; for covered FRs, `FR-XXX: PASS` is an exit code.
- The "empty file passes the gate" residual closes.
- Properties are the right formalism: FSE 2025 ("From Prompts to Properties") found property-based tests expose 30%+ partial-correctness failures in LLM-generated code that passing unit tests miss.

**T2.3 — Mutation testing on the diff as the vacuous-test detector.** StrykerJS `--incremental` (TS), PIT with history files (Java), and cargo-mutants `--in-diff` (Rust) are all production-ready and designed for PR-scoped gating. Gate: no surviving mutants on changed lines (or a threshold). This is the best deterministic proxy for "the tests actually test something" and substantially mechanizes `pr-test-analyzer`. Run as engine-executed evidence — no trust model needed. Diff-scoping keeps cost bounded; full runs belong in nightly CI, not the gate.

### Tier 3 — change the remediation economics

Some findings stay semantic no matter what. Two structural changes attack cost drivers 1 and 2 directly.

**T3.1 — Finding → detection-rule compilation.** When a reviewer emits a critical, require it to also emit a machine-checkable resolution predicate where one exists: an ast-grep pattern that matches the defect, or a failing test that reproduces it. `resolved_by_remediation` then becomes an engine check — run the rule/test — instead of five reviewers each re-assessing the prior id every round. Findings that genuinely cannot carry a predicate fall back to today's roster re-assessment. The model judges once, at finding creation; verification thereafter is code.

**T3.2 — Diff-scoped re-review.** Content-hash per file in the artifact baseline (baselines are already snapshotted); on remediation, invalidate only reviewer slots whose scope intersects changed files, and require prior-finding re-assessment only for findings anchored in changed files. The soundness worry — cross-file effects — is exactly what the deterministic tier covers: typecheck, architecture rules, API-surface diff, and mutation-on-diff run globally because they are cheap, while expensive LLM re-review scopes to the diff. This inverts today's arrangement, where a one-line fix re-runs every reviewer against every task.

### Tier 4 — formal methods where they pay

**T4.1 — Model-check the Loom engine itself with Quint.** The best formal-methods fit in the whole system. The wave-gate machine, panel kernel, and remediation machine are already pure typed reducers with explicit event algebras — nearly transliterable to **Quint** (Informal Systems' typed TLA+ successor: npm-installable, REPL, simulation, TLC/Apalache checking, and model-based test-case generation). The engine's bug history is precisely the class model checking catches: the all-criticals-upheld infinite re-derivation spin (loom#20 F4), the stale-epoch attempt-2 terminal block (F5), the panel-resize threshold-lowering promotion, the reviewer-completion-order gate flip. Each is a temporal-property violation (`always(eventually(done or terminal))`; "threshold never decreases within a recorded panel"; "gate verdict is independent of arrival order") that a checker finds by exhaustion instead of by production incident. Write the spec once, generate trace tests, run them in `artifacts/tests/`; reducer purity makes conformance testing trivial.

**T4.2 — App-level proof languages: mostly no, two exceptions.** Dafny/Verus/Creusot for business code is not practical in 2026 — proof effort is expert-level, and for TS/Java the honest stand-in is properties-as-tests. Exceptions: (a) Rust cores — **Kani** is production-ready for bounded proofs (panic/overflow-freedom, user assertions on real code; used in Firecracker/s2n) and could be a per-task obligation for Rust tasks; (b) verified reference implementations of genuinely hairy algorithms — **Dafny** is currently the most LLM-tractable proof target (82% off-the-shelf LLM success on the vericoding benchmark vs 44% Verus, 27% Lean), an interesting future agent type, not a near-term gate. One research result worth internalizing: type-constrained *decoding* underperforms unconstrained generation plus compiler-as-posthoc-gate on functional correctness — which validates Loom's architecture. Keep the oracle outside the model.

**T4.3 — Alloy 6 at spec time (optional).** Domain-model invariants (uniqueness, reachability, permission lattices) checked at design time in the specify/architecture phases, then exported as property tests. Real value, but only after the tiers above.

---

## Part II — Deterministic implementation

The verification tiers catch defects; this part reduces how many exist to catch. Levers are organized along the implementer's timeline.

### Before spawn — shrink the space the model can be wrong in

Today the implementer brief (`commands/templates/impl-agent-context.md`) provides prose description, `file_list`, spec anchors, plan excerpt, and inlined rules. The agent invents everything else: module structure, type shapes, signatures, error channels. Every invented thing is a variance source and a future finding.

**I1 — Deterministic scaffolding: the agent fills holes, it does not invent structure.** Decompose (or a wave-start engine step) generates the skeleton: files created at every `file_list` path with module structure, exported type/function signatures, and `throw new Error("unimplemented")` bodies (Java: interfaces plus `UnsupportedOperationException` stubs). The implementer's job collapses from "design and write a module" to "make these signatures work." This is the single biggest known generation-determinism lever — the winning setup in the constrained-generation literature is unconstrained generation against a rigid frame with the compiler as oracle; the skeleton is the rigid frame. It also gives the existing `declared-artifact-not-changed` proof obligation semantic teeth: bytes changed *within a frozen signature* is a much stronger claim than bytes changed.

**I2 — Types first, as a wave-0 artifact.** Push T2.1 upstream: do not just gate on a frozen surface — generate it before implementers exist. A dedicated types task (the architecture output is rich enough to source it) produces the shared `.d.ts` / Java interfaces / sealed ADTs that all wave tasks compile against. Parallel implementers currently stay compatible only via shared prose; importing one frozen types module that already compiles turns cross-task drift into a compile error inside each agent's own loop instead of an integration finding at the gate. The types *are* the task contract — illegal states unrepresentable, applied to the orchestration itself.

**I3 — Codegen for everything mechanical.** Boundary code should never be handwritten by an LLM: OpenAPI/Zod schema → generated clients and validators; Prisma/jOOQ for persistence; generated migrations. The Fugue generated-code integrity machinery already protects generated regions — the more of a task that is generated-and-tamper-evident, the less surface the model can vary on. Same logic for formatting: run prettier/spotless as a PostToolUse auto-fix so style *cannot* become a finding. Never ask a model to do what a formatter does deterministically.

**I4 — Exemplar anchoring in the brief.** Replace some of `{plan_context}`'s prose with real code: the two or three closest existing modules that do it "the house way" (retrieved by path/similarity at decompose time), plus input→output examples per spec anchor — which double as test cases under T2.2. Few-shot with actual repo code collapses idiom variance; prose rules get interpreted, pasted exemplars get imitated.

### During the loop — put the oracle inside the agent's iteration

A defect caught by the wave gate costs a remediation cycle; the same defect caught while the implementer is alive costs one tool-call round-trip with hot context. Everything deterministic that can be evaluated per-edit should fire there.

**I5 — Compiler-in-the-loop via the `lint-file` hook.** The attachment point already exists: the PostToolUse hook on Edit/Write that runs the immediate regex tier. Extend it with single-file `tsc --noEmit` (or LSP-based diagnostics), typed eslint on the touched file, and the T1.1 ast-grep rules. The hook already blocks on error; now the error message is compiler output with exact locations, fed straight back into the loop. An implementer that cannot make an edit that does not typecheck is a categorically more deterministic process than one reviewed for type errors later. Keep per-file scope for latency; the whole-program check belongs at completion (I8).

**I6 — Red-then-green as a machine-checked proof obligation.** The substrate already exists and is unused for this: the evidence ledger records ordered `TestRun` facts per agent epoch (`record-evidence`), and `core/proof-obligations.ts` already evaluates ledger-derived claims. Add an obligation: for Tasks whose `verification_policy.new_tests` arm is required, the ledger must show a *failing* TestRun on the task's tests before the first `FileWrite` to implementation files, then a passing one after. TDD enforced by arithmetic on facts already collected — no new trust model, no prose protocol the agent can skip. It forces the agent to establish its own oracle before generating against it. Under T2.2 the red state comes for free: the frozen acceptance tests pre-exist and fail by construction.

**I7 — Affected-test cadence as a requirement, not a suggestion.** The brief mandates, and the ledger verifies, that a test run occurred within the last N writes (Vitest and Gradle both have fast affected-only modes). An agent that runs tests every few edits self-corrects on a two-edit horizon; one that runs them once at the end self-corrects on a whole-task horizon — same model, wildly different variance.

### At completion — make "done" unclaimable without proof

**I8 — Add an engine-owned completion oracle at Task and Wave distance (Task + Wave scopes implemented; bounded retry implemented on feature branch).** The Wave half runs whole-program project checks and full-tier lint only after quiescence, persists/replays exact Run Directory results, exposes failures through canonical status, and binds accepted suite/workspace authority into the protected completion commit. Slice 3 adds exact engine-issued Implementation Attempt authority to both harnesses and one shared pure Oracle/application path. Its non-empty Task suite contains only `loom:task-byte-scope`: parser-proven transcript paths are checked against the registered `attempt_artifact_baseline`, while cumulative declared-artifact Proof still compares the first `artifact_baseline`. Foreign transcript paths are semantic failure regardless of ownership; baseline/path/read/Git uncertainty is infrastructure-blocked. The first unresolved repository baseline survives every non-positive settlement/reclamation. Under locked TaskGraph authority, other current-Wave Tasks' canonical declared/modified paths are inert sibling ownership; all other changed repository paths outside the current Task scope block, invalidate, and persist as unresolved even if absent from the transcript. Reversion removes resolved paths, and exact acceptance clears the retained authority. Task-local settlement executes **no project subprocesses**—build, test, typecheck, reports, package scripts, and full-tier lint remain Wave-quiescent. Exact receipts make duplicate/late results idempotent and release only matching authority. Slice 4 derives one exact attempt-2 Retry Context from the attempt-1 receipt, freezes prompt/context identity before fresh Pi/Claude dispatch, keeps infrastructure recovery on the same semantic attempt, and makes attempt-2 semantic failure terminal escalation. This Slice 4 behavior remains feature-branch evidence until review and merge.

**I9 — Best-of-N for flagged tasks: spend generation tokens to save remediation tokens.** Once completion is machine-scored, exploit it: for tasks decompose flags as high-risk (novel module, security-touching, wide blast radius), spawn 2–3 isolated implementers and let the engine pick the candidate with the best deterministic score; a reviewer breaks ties. Sampling-and-selecting is the standard way to convert stochastic generation into near-deterministic output, and it is only rational *because* the selector is code. Existing completion checks and Git/worktree primitives are useful substrate, but isolated Task worktrees, candidate selection/integration, and proposed mutation-on-diff scoring remain prerequisites rather than shipped machinery. The economics usually favor it: 2× generation on one hard task is cheaper than one remediation cycle (full roster × N tasks + panel + fix + re-review).

**I10 — Hermetic environment as the boring foundation.** Pinned toolchains, lockfile-enforced installs, seeded/fake clocks in tests, no network in test runs. Every flaky test or version drift appears to the agent as a mysterious failure it will "fix" by mutating something irrelevant — environment nondeterminism gets laundered into code churn. Add an engine preflight per run (lockfile clean, toolchain matches declared versions) before any implementer spawns.

---

## 3. Tooling reference (state of the field, mid-2026)

| Area | Tool | Maturity | Deterministic gate |
|---|---|---|---|
| AST policy | ast-grep | production | forbidden/required constructs, edit-time blocking, autofix |
| AST policy + taint | Opengrep (Semgrep CE fork) | production | dataflow rules, SARIF output |
| Arch conformance (Java) | ArchUnit 1.4.x + jMolecules | production (gold standard) | layers, cycles, dependency direction, DDD model |
| Arch conformance (TS) | dependency-cruiser, eslint-plugin-boundaries | production | module-graph rules, layer matrix |
| Nullness (Java) | NullAway + JSpecify (+ Error Prone) | production; Spring Boot 4 aligned | zero unproven nullable dereferences |
| Purity (Java) | Checker Framework `@Pure` | production, 2–4× compile cost | machine-checked purity on functional core |
| Purity/immutability (TS) | eslint-plugin-functional; Effect 3.x | production / Trial (Thoughtworks) | immutability presets; type-level effect tracking |
| Mutation testing | StrykerJS `--incremental`, PIT history mode, cargo-mutants `--in-diff` | production | no surviving mutants on changed lines |
| API surface (TS) | API Extractor, expect-type | production | exported surface equals frozen `.api.md`; type-level tests |
| API surface (Java) | japicmp, Revapi | production | binary/source API diff blocks breaking change |
| Property testing | fast-check, jqwik, proptest | production | frozen property suites as executable acceptance |
| Model checking (orchestration) | Quint + Apalache/TLC | promising→early-production | safety/liveness of state machines; model-based trace tests |
| Bounded proofs (Rust) | Kani | production | panic/overflow-freedom, user assertions |
| Deductive proofs | Verus, Dafny | promising / niche-production | verified reference implementations; Dafny most LLM-tractable |
| Structured output | Anthropic strict structured outputs | GA early 2026 | schema-invalid agent output impossible at decoder |

## 4. Adoption order

| # | Move | Attacks | Effort |
|---|---|---|---|
| 1 | T0.1 + T0.2 — wire full-tier lint and engine-executed compile/test into the wave-gate program | documented-but-unenforced gap; evidence-trust residuals | small |
| 2 | I5 — compiler-in-the-loop via the existing `lint-file` hook | defect distance: gate → edit loop | small–medium |
| 3 | I8 — Task/Wave completion oracle with fresh engine-issued attempts | defect distance: gate → completion without cross-harness continuation drift | medium |
| 4 | T1.1 + T1.2 — ast-grep tier + generated dependency-cruiser/ArchUnit/NullAway rules from `rules/` | mechanizes reviewer dimensions | medium |
| 5 | I1 + I2 — skeletons and frozen types at decompose | generation variance, cross-task drift | medium |
| 6 | T2.2 + T2.3 — frozen acceptance tests/properties; mutation-on-diff | prose acceptance, vacuous tests, spec-check surface | medium |
| 7 | I6 — red-then-green ledger obligation | untested-first generation | small (substrate exists) |
| 8 | T3.1 + T3.2 — finding→rule compilation; diff-scoped re-review | cost drivers 1 and 2 — the token bill | medium–large |
| 9 | T2.1 — API-surface contracts per task | parallel-task drift at the gate | medium |
| 10 | I9 — best-of-N on flagged tasks | hard-task variance | medium |
| 11 | T0.3 — strict structured outputs | wire-format attempt exhaustion | small, harness-gated |
| 12 | T4.1 — Quint model + trace tests for the engine machines | the engine's own bug class | medium, high-confidence payoff |

Items 1, 2, 3, and 7 are pure extensions of hooks and proof obligations that already ship — new checks on existing attachment points, no new subsystems.

## 5. What this does to the remediation economy

With the ladder in place, a typical remediation round changes from:

> full reviewer roster × all wave tasks × all prior findings, plus spec-check, plus a refutation panel

to:

> the engine re-runs the deterministic suite globally (cheap, exit codes); LLM reviewers re-judge only the diff; resolution predicates auto-retire most prior findings; the panel adjudicates only the semantic residue.

And fewer rounds happen at all, because the implementation phase catches its own mechanical defects at one-tool-call distance (I5), cannot claim completion without passing the suite (I8), and starts from frozen types and skeletons that leave less to get wrong (I1/I2).

## 6. Honest limits

- Semantic correctness beyond the frozen tests and properties still depends on model judgment; the roster shrinks but does not disappear.
- Diff-scoped re-review (T3.2) trades a small soundness risk on cross-file semantic effects for a large cost reduction; the mitigation is that all *global* checks in the deterministic tier remain whole-program.
- Mutation testing cost is real; it is bounded only as long as it stays diff-scoped at the gate.
- Best-of-N (I9) multiplies generation cost and is only rational for tasks flagged high-risk by decompose.
- Constrained decoding does not replace posthoc checking; the research is explicit that the compiler-as-oracle arrangement wins. Nothing in this proposal moves the oracle inside the model.
- Skeleton generation (I1) assumes decompose/architecture output is rich enough to fix signatures upfront; where it is not, the skeleton degrades to file stubs and the value shifts to I2's shared types module.
