# Roadmap: deterministic implementation and verification

This document holds proposals that have not shipped. Items from the same plan that did ship are listed once, in [Shipped](#shipped), with the document or ADR that now describes them. The item codes (T0.1, I6, Q1 and so on) are this plan's own labels; ADRs cite them, and other documents use feature names.

Loom 1.1 made orchestration authority deterministic: state transitions, gate arithmetic, retry accounting and evidence attribution are code. What remains model judgment is verification content. Reviewers produce prose Findings, spec-check emits a model's verdict for whatever the frozen acceptance tests do not cover, and much of what an implementer generates has no machine-checkable contract. Remediation is where that residual judgment is paid for, repeatedly.

The plan has two halves:

- **Part I, verification:** replace classes of model Findings with deterministic gates (static analysis, architecture conformance, mutation testing, contracts), and change the economics of the Findings that remain.
- **Part II, implementation:** make implementer agents produce correct code the first time, by shrinking the generation space before spawn and putting deterministic oracles inside the agent's own loop.

The organizing principle extends the shipped one ("models for judgment, code for authority"): every Finding class that can be mechanized (a) never becomes prose, (b) is caught at edit time or completion time with an exit code and an exact location, and (c) needs no refutation panel, because compilers do not hallucinate.

## 1. Where remediation cost comes from

Remediation cost has five drivers. Static analysis addresses some of them, not all.

1. **Total invalidation on any byte change.** A settled attempt that changes bytes bumps `review_generation`, drops the Review Run, clears the Wave's spec check and resets the test and review flags. A one-line advisory fix therefore costs a full reviewer-roster rerun for every Wave Task, plus spec-check, plus a fresh refutation panel if any critical remains. Nothing scopes re-review to what changed. This is the dominant structural cost.
2. **Prior-finding re-assessment grows monotonically.** Every reviewer must assess every prior Finding id exactly once per round. The design is correctly fail-closed, since a clean rerun cannot erase an old blocker by omission, but round *N* costs O(accumulated Findings), every round.
3. **Findings are prose, so wrongness is expensive.** A plausible but wrong critical costs a full remediation cycle. The refutation panel spends more model tokens to adjudicate model judgment; it exists because there is no cheaper oracle.
4. **Wire-format failures burn attempts.** The attempt-1/attempt-2 machinery and its retry diagnostic exist because models emit malformed JSON and repeat it on retry, exhausting a batch and forcing a restart into a fresh Run Directory.
5. **Acceptance is partly judged, not checked.** Where a Requirement has no frozen acceptance test, spec alignment is still a model emitting `FR-XXX: PASS`.

## 2. The three-distance model

A deterministic oracle can sit at three distances from the model, and the cost of a defect scales with the distance at which it is caught:

| Distance | Mechanism | Cost of a defect |
|---|---|---|
| In the edit loop | post-edit hooks: lint, type diagnostics | one tool call, hot context |
| At task completion | SubagentStop: stop checks, proof obligations | one same-agent resume, hot context |
| At the wave gate | reviewer roster, spec-check, refutation panel, remediation loop | a full remediation cycle |

The plan moves copies of the deterministic oracles into the first two rows and shrinks the generation space, so there is less for any oracle to catch. Code checks run globally because they are cheap; model re-review should scope to the diff because it is expensive.

## Shipped

Each row is described where the link points. Nothing below this table repeats it.

| Item | What shipped | Described in |
|---|---|---|
| T0.1 | Full-tier lint inside the registered Wave Gate | [Workflows](workflows.md#completion-suite-full-lint-and-completion) |
| T0.2 | Engine-executed project checks at Wave scope, from an operator-frozen manifest | [Workflows](workflows.md#verification-manifest), [operations](verification.md#enrolling-a-critical-repair-check) |
| T0.3 (part) | Emission tools on the qualified Pi route. The route accepts the schema but does not enforce it, so the retry path remains | [Model profiles](model-profiles-and-calibration.md#emission-routes-and-qualification), ADR-0012 to ADR-0021 |
| T1.2 (part) | `no-cross-boundary-imports` and `no-io-in-pure-modules` as programmatic lint rules | [Lint rules](../lint-rules/README.md), [ADR-0043](adr/ADR-0043-the-pure-core-is-enforced-by-the-purity-linter.md) |
| T2.2 | Requirements compiled to frozen acceptance tests (Acceptance Contracts), observed red and then green | [Executable models: enforcement](executable-models-enforcement.md#the-contract-lifecycle), [ADR-0044](adr/ADR-0044-the-acceptance-freeze-is-stamped-by-the-completion-commit.md) |
| T2.3 (part) | A deterministic mutation plan over changed owner lines at the Wave Gate; a Task mutation check before the stop | [ADR-0036](adr/ADR-0036-deterministic-mutation-plan-over-changed-owner-lines.md), Q4 below |
| Tier 3 floor | Defect-family accounting in remediation: every surviving critical accounted for, repairs checked by fresh engine-observed reports | [ADR-0008](adr/ADR-0008-versioned-defect-family-installation-authority.md), [operations](standalone-review.md#remediation-and-git-safety) |
| I1, I2 | Skeletons and contract stubs: frozen consumer-facing signatures and types, written before the implementer starts | ADR-0048 to ADR-0062, [operations](verification.md#skeletons-and-contract-stubs) |
| I5 (part) | Advisory type diagnostics after a TypeScript edit. It never blocks; typed ESLint and AST rules remain open (T1.1) | [operations](operations.md#advisory-type-diagnostics) |
| I6 | Red-then-green as a proof obligation over the evidence ledger | [ADR-0024](adr/ADR-0024-approach-1-facts-plus-two-pure-judges-behind-one-planner.md), [ADR-0025](adr/ADR-0025-the-i6-era-marker-is-the-frozen-test-file-classification.md), [ADR-0026](adr/ADR-0026-i6-enters-proof-as-one-obligation-one-failure-variant-and-one-evidence-variant.md), [ADR-0064](adr/ADR-0064-bun-reports-file-identity-and-console-collection-errors.md), [operations](operations.md#task-fails-i6-red-then-green); its limits: [Guarded Skill Machines](../machines/README.md#known-residual-limits) |
| I7 | The Affected-Test Stop Check | [ADR-0028](adr/ADR-0028-one-stop-shell-runs-both-checks-sequence-lock-budget-and-counters.md), [operations](verification.md#affected-test-stop-check) |
| I8 | An engine-owned completion oracle at Task and Wave scope, with one bounded retry and a terminal escalation | [Workflows](workflows.md#phase-5-execute), [operations](reference/recovery.md#implementation-escalation-semantic-attempt-2-exhausted) |
| Q1 | The distill pass as an engine-added Task per Wave | [ADR-0068](adr/ADR-0068-the-distill-pass-is-an-engine-added-task-per-wave.md), [operations](verification.md#the-distill-pass-distill-task) |
| Q2 | `no-duplicate-block`: a copied block is refused at the edit | [Lint rules](../lint-rules/README.md) |
| Q3 | The plan design review before decompose; the contract-surface reviewer for a Contract Task | [ADR-0070](adr/ADR-0070-the-plan-design-review-gates-decompose.md), [ADR-0069](adr/ADR-0069-the-contract-task-wave-review-judges-the-contract-surface.md) |
| Q4 | The Task mutation check, enforced within bounds on Claude Code and advisory on Pi | [ADR-0071](adr/ADR-0071-the-task-mutation-check-names-surviving-mutants-before-the-stop.md), [operations](verification.md#task-mutation-check) |
| Q5 | Every documented wire example parsed by its production parser | [ADR-0073](adr/ADR-0073-every-documented-wire-example-is-parsed-by-its-production-parser.md) |
| Q6 (edit-time half) | `no-wire-cast`: wire output typed without a parse is refused at the edit | [ADR-0072](adr/ADR-0072-wire-output-typed-without-a-parse-is-refused-at-the-edit.md) |

---

## Part I — Deterministic verification

A ladder from "close existing gaps" to "formal methods", in rough order of effort.

### Tier 0 — close existing gaps

**T0.3 — Strict structured outputs for every agent that returns JSON.** Constrained decoding against a JSON schema makes schema-invalid output impossible at the decoder. The decompose agent, architecture judges, review verifiers and reviewers are parse-then-retry today. On a harness path that enforces strict tool schemas, the whole wire-format attempt-exhaustion class, and the terminal-block and restart ceremony it drags in, disappears. What exists is the emission tool on the Pi route, where the provider accepts the schema without enforcing it; until a route enforces it, the retry diagnostic is the right mitigation. One caveat from the literature: grammar-forcing can slightly degrade reasoning on complex tasks, and the standard mitigation is "reason free-form, then emit structured".

### Tier 1 — mechanize reviewer dimensions

A large fraction of what the reviewer roster finds is mechanizable with production-ready tooling.

**T1.1 — Replace the regex lint tier with AST-level rules.** The shipped regex rules (`lint-rules/*.json`: `no-any-type`, `no-console-log`, `no-raw-exception-catch`, `no-field-injection`, …) false-positive on strings and comments and cannot express structure. **ast-grep** (Rust/tree-sitter, repo-scale scans in seconds, YAML rules with relational constraints `inside`/`has`/`not`, autofix, embeddable as a library) can slot into the post-edit lint hook so violations block at edit time. First-class TypeScript; workable Java. For taint and dataflow rules, **Opengrep** (the LGPL consortium fork of Semgrep CE) is the choice.

**T1.2 — Compile `rules/architecture.md` into architecture conformance checks.** This is the highest-value mechanization, because it is what `code-reviewer` currently judges as prose:

- **TypeScript:** **dependency-cruiser** — "functional core imports no IO" is literally a rule (`core/**` may not import `fs`, network or database clients). **eslint-plugin-boundaries** for the layer interaction matrix. **eslint-plugin-functional** strict preset on core directories for immutability and no-expression-statements.
- **Java:** **ArchUnit** (plus **jMolecules** to declare the DDD/hexagonal model as annotations and enforce it with the shipped rule sets). **NullAway + JSpecify** makes null-safety a compile failure. **Checker Framework** `@Pure`/`@SideEffectFree` is the only tool that machine-checks purity claims; at 2–4× compile cost, scope it to functional-core packages only.
- Loom's own two programmatic rules cover its engine. The open work is generating per-project rule files, for which the `lint-project` skill is the natural place.

**T1.3 — Effect (TS) as the opt-in maximum.** `Effect<A, E, R>` puts side effects and error channels in the type system, making the compiler the functional-core/imperative-shell reviewer. It is a framework commitment, so it belongs in the architecture-phase option set, not as a mandate; the dependency-cruiser rule delivers about 80% of the value for about 5% of the cost.

Net effect on the roster: `code-reviewer` shrinks to semantic judgment; `silent-failure-hunter`'s catch-swallowing patterns become Error Prone or ast-grep rules; `type-design-analyzer` is partly subsumed by typed lint plus the contract tier below.

### Tier 2 — machine-checkable task contracts

**T2.1 — Frozen interface artifacts per task.** At decompose time, a task that exposes an API also gets a declared surface: TypeScript → an API Extractor `.api.md` (or `.d.ts` plus expect-type assertions); Java → a japicmp baseline. New gate check: exported surface equals declared surface, as an exact exit-code diff. Skeletons already freeze the signatures a contract binds; this extends the check to every exported surface a Task declares.

**T2.3 — Mutation testing on the whole diff.** StrykerJS `--incremental` (TS), PIT with history files (Java) and cargo-mutants `--in-diff` (Rust) are production-ready and designed for PR-scoped gating. Gate: no surviving mutants on changed lines, or a threshold. What shipped mutates owner lines at the Wave Gate and a sample of a Task's changed lines before its stop; a gate over every changed line, in every supported language, is open. Diff-scoping keeps cost bounded; full runs belong in nightly CI, not the gate.

### Tier 3 — change the remediation economics

Some Findings stay semantic no matter what. The shipped accounting floor reduces unsupported closure claims; it adds no reviewer rerun after each repair, no dual-snapshot executor and no generalized task runner. The two items below remain proposals.

**T3.1 — Finding → detection-rule compilation.** When a reviewer emits a critical, require it to also emit a machine-checkable resolution predicate where one exists: an ast-grep pattern that matches the defect, or a failing test that reproduces it. `resolved_by_remediation` then becomes an engine check — run the rule or the test — instead of five reviewers each re-assessing the prior id every round. Findings that cannot carry a predicate fall back to today's roster re-assessment. The model judges once, at Finding creation; verification thereafter is code.

**T3.2 — Diff-scoped re-review.** Content-hash per file in the artifact baseline (baselines are already snapshotted); on remediation, invalidate only reviewer slots whose scope intersects changed files, and require prior-finding re-assessment only for Findings anchored in changed files. The soundness worry, cross-file effects, is what the deterministic tier covers: typecheck, architecture rules, API-surface diff and mutation-on-diff run globally because they are cheap, while expensive model re-review scopes to the diff.

### Tier 4 — formal methods where they pay

**T4.1 — Model-check the Loom engine itself with Quint.** The best formal-methods fit in the whole system. The Wave Gate machine, panel kernel and remediation machine are already pure typed reducers with explicit event algebras, nearly transliterable to **Quint** (Informal Systems' typed TLA+ successor: npm-installable, REPL, simulation, TLC/Apalache checking, and model-based test-case generation). The engine's bug history is the class model checking catches: the all-criticals-upheld infinite re-derivation spin (loom#20 F4), the stale-epoch attempt-2 terminal block (F5), the panel-resize threshold-lowering promotion, the reviewer-completion-order gate flip. Each is a temporal-property violation (`always(eventually(done or terminal))`; "threshold never decreases within a recorded panel"; "gate verdict is independent of arrival order") that a checker finds by exhaustion instead of by production incident. Write the spec once and generate trace tests; reducer purity makes conformance testing trivial.

**T4.2 — App-level proof languages: mostly no, two exceptions.** Dafny, Verus or Creusot for business code is not practical: proof effort is expert-level, and for TypeScript and Java the honest stand-in is properties-as-tests. Exceptions: (a) Rust cores — **Kani** is production-ready for bounded proofs (panic and overflow freedom, user assertions on real code) and could be a per-task obligation for Rust tasks; (b) verified reference implementations of hairy algorithms — **Dafny** is currently the most LLM-tractable proof target, an interesting future agent type, not a near-term gate. One research result worth keeping in mind: type-constrained decoding underperforms unconstrained generation plus the compiler as a post-hoc gate on functional correctness, which supports Loom's arrangement. Keep the oracle outside the model.

**T4.3 — Alloy 6 at spec time (optional).** Domain-model invariants (uniqueness, reachability, permission lattices) checked at design time in the specify and architecture phases, then exported as property tests. Real value, but only after the tiers above.

---

## Part II — Deterministic implementation

The verification tiers catch defects; this part reduces how many exist to catch.

### Before spawn — shrink the space the model can be wrong in

**I3 — Codegen for everything mechanical.** Boundary code should never be handwritten by a model: OpenAPI/Zod schema → generated clients and validators; Prisma/jOOQ for persistence; generated migrations. The more of a task that is generated and tamper-evident, the less surface the model can vary on. Same logic for formatting: run prettier or spotless as a post-edit auto-fix so style cannot become a Finding. Never ask a model to do what a formatter does deterministically.

**I4 — Exemplar anchoring in the brief.** Replace some of the plan context's prose with real code: the two or three closest existing modules that do it "the house way" (retrieved by path or similarity at decompose time), plus input→output examples per spec anchor, which double as test cases. Few-shot with actual repository code collapses idiom variance; prose rules get interpreted, pasted exemplars get imitated.

### During the loop — put the oracle inside the agent's iteration

**I5, remainder — typed lint and AST rules at the edit.** The advisory type diagnostics shipped. Typed ESLint on the touched file and the T1.1 ast-grep rules are open. A blocking type gate stays out of scope: it is the unbounded retry surface the loop-breaker exists for.

### At completion — make "done" unclaimable without proof

**Q4 on Pi.** The Task mutation check is advisory on Pi, because Pi settles after the child has ended. Enforcing it there would need an engine-added Task after each implementation Task, as the distill pass added one per Wave.

**I9 — Best-of-N for flagged tasks: spend generation tokens to save remediation tokens.** Once completion is machine-scored, exploit it: for tasks decompose flags as high-risk (novel module, security-touching, wide blast radius), spawn 2–3 isolated implementers and let the engine pick the candidate with the best deterministic score; a reviewer breaks ties. Sampling and selecting is the standard way to convert stochastic generation into near-deterministic output, and it is only rational because the selector is code. Existing completion checks and Git worktree primitives are useful substrate, but isolated Task worktrees, candidate selection and integration, and mutation-on-diff scoring are prerequisites, not shipped machinery. The economics usually favour it: twice the generation on one hard task is cheaper than one remediation cycle.

**I10 — Hermetic environment as the boring foundation.** Pinned toolchains, lockfile-enforced installs, seeded or fake clocks in tests, no network in test runs. Every flaky test or version drift appears to the agent as a mysterious failure it will "fix" by mutating something irrelevant. Add an engine preflight per run (lockfile clean, toolchain matches declared versions) before any implementer spawns.

---

## 3. Tooling reference

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
| Structured output | strict structured outputs | available on some harness paths | schema-invalid agent output impossible at decoder |

## 4. Adoption order of what remains

| # | Move | Attacks | Effort |
|---|---|---|---|
| 1 | T1.1 + T1.2 — AST rule tier; generated dependency-cruiser/ArchUnit/NullAway rules from `rules/` | mechanizes reviewer dimensions | medium |
| 2 | T2.3 — mutation testing over the whole diff | vacuous tests | medium |
| 3 | T3.1 + T3.2 — finding→rule compilation; diff-scoped re-review | cost drivers 1 and 2, the token bill | medium–large |
| 4 | T2.1 — API-surface contracts per task | parallel-task drift at the gate | medium |
| 5 | I9 — best-of-N on flagged tasks | hard-task variance | medium |
| 6 | T0.3 — strict structured outputs | wire-format attempt exhaustion | small, harness-gated |
| 7 | T4.1 — Quint model + trace tests for the engine machines | the engine's own bug class | medium, high-confidence payoff |

## 5. What this does to the remediation economy

With the ladder in place, a typical remediation round changes from:

> full reviewer roster × all wave tasks × all prior findings, plus spec-check, plus a refutation panel

to:

> the engine re-runs the deterministic suite globally (cheap, exit codes); model reviewers re-judge only the diff; resolution predicates auto-retire most prior findings; the panel adjudicates only the semantic residue.

## 6. Honest limits

- Semantic correctness beyond the frozen tests and properties still depends on model judgment; the roster shrinks but does not disappear.
- Diff-scoped re-review (T3.2) trades a small soundness risk on cross-file semantic effects for a large cost reduction; the mitigation is that all global checks in the deterministic tier remain whole-program.
- Mutation testing cost is real; it is bounded only as long as it stays diff-scoped at the gate.
- Best-of-N (I9) multiplies generation cost and is only rational for tasks decompose flags as high-risk.
- Constrained decoding does not replace post-hoc checking. Nothing in this plan moves the oracle inside the model.
