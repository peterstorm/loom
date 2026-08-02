# Adversarial Review Panel — Kernel Extraction Plan

**Date:** 2026-08-02
**Branch:** to be cut from `main` after PR #17 merges
**Status:** Proposed — not started
**Depends on:** PR #17 (`feat/architecture-panel-mode-plan`) merged

## Why

Loom's wave gate spawns five reviewers per task. Each produces findings; nothing
adjudicates them. A plausible-but-wrong finding costs a real remediation cycle,
and we have been working around this with prompt patches rather than structure —
the delta-review strategy for multi-pass PRs, and the architectural-intent
briefing that tells agents Fugue's never-throw / fail-closed / ADT patterns are
deliberate. Both are bandages over a missing verification stage.

`/loom --panel` already implements the fix for a different problem: fan out
across diverse lenses, have adversarial judges score against validated criteria,
aggregate deterministically. This plan reuses that machinery for review.

## The design decision this plan makes

The original seam analysis listed nine hardcoded things in `panel-contract.ts`
and implied a parameterized `PanelKind<Context, Item, Payload, Decision>`
descriptor that both panels instantiate.

**Rejecting that.** Extract shared *primitives*, not a framework. Three places
where the two panels genuinely differ, not just cosmetically:

| | Architecture panel | Review panel |
|---|---|---|
| Item identity | closed lens enum, one per designer, **order-significant** | open set of finding ids, N unbounded, order irrelevant |
| Criteria | 3 fixed, derived from the interview digest | one per review lens, count set by policy |
| Aggregate output | a **total order** over candidates (ranking) | a **per-item verdict** (survives / killed) |

A descriptor generic enough to cover both would constrain almost nothing — it
would buy indirection, not type safety. The genuinely reusable surface is about
four functions.

**The load-bearing choice that makes even those four reusable:** the review
panel spawns **N verifiers, each covering ALL findings**, each with a distinct
lens — not N verifiers per finding. That makes a review verdict structurally
identical to an architecture verdict (one verdict per criterion, covering every
item exactly once), so the envelope validator is shared verbatim. It also uses
N agents instead of N×findings, and gives each verifier enough context to spot
duplicate or contradictory findings across the set.

If we had gone the other way (verifiers spawned per finding), the envelope would
be trivial per call and there would be nothing worth extracting.

---

## Phase A — Findings identity (the prerequisite)

**Nothing else in this plan is possible first.** A k-of-n vote needs items two
verifiers can agree they are discussing. Today findings are regex-scraped
free text:

- `store-reviewer-findings.ts` matches `/^[\s\-*]*\*{0,2}CRITICAL(?!_COUNT):?\*{0,2}\s*(.*)/`
- into `critical_findings?: string[]` / `advisory_findings?: string[]` (`types.ts:133-134`)

No id, no file, no line, no stable identity across reviewers or re-runs.

### A1. Structured finding record

```ts
export const FINDING_SEVERITIES = ["critical", "advisory"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export interface Finding {
  /** Derived, never agent-chosen: `${agentType}-${ordinal}` scoped to the task. */
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly agent: string;
  readonly file: string | null;
  readonly line: number | null;
  /** The single assertion a verifier will try to refute. */
  readonly claim: string;
}
```

Ids are **derived from (agent, task, emission order)**, not chosen by the agent.
Agents renumber, collide, and reuse ids across runs; a derived id is stable and
needs no trust.

### A2. Extend the Machine Summary contract

Keep the existing `CRITICAL_COUNT` / `CRITICAL:` / `ADVISORY:` lines working —
they are the fallback. Add an optional fenced `findings` JSON block that
reviewers emit when they can:

```json
[{ "severity": "critical", "file": "src/x.ts", "line": 42, "claim": "..." }]
```

Parse the block first, fall back to the current line scraper, and synthesize
`Finding` records either way (a scraped line becomes `{severity, claim, file:
null, line: null}`). Verification quality degrades without file/line but does
not break.

Update: `commands/review-pr.md` (the format spec), `commands/wave-gate.md` (the
per-reviewer prompt), and the five reviewer agent definitions.

### A3. Store findings without breaking ten consumers

`grep` shows ~10 sites reading `critical_findings` / `advisory_findings`
(`complete-wave-gate.ts`, `validate-task-execution.ts`, `validate-task-graph.ts`,
`populate-task-graph.ts`, `store-review-findings.ts`, …).

Add `findings?: readonly Finding[]` as the authoritative field, and **keep the
two string arrays as derived views** written alongside it:

```ts
critical_findings: findings.filter(f => f.severity === "critical").map(f => f.claim)
```

No consumer changes in Phase A. They can migrate opportunistically later.

**Deliverable:** findings have identity; everything downstream still works.
Independently valuable — it is also what the delta-review strategy and the
intent briefing are hand-rolling around.

---

## Phase B — Kernel extraction (this is the §2 item)

Behavior-preserving refactor. Architecture panel is consumer 1 and must produce
byte-identical output; the golden test is that `panel-contract.test.ts` and
`smoke-panel-mode.sh` pass untouched.

### B1. `core/panel-kernel.ts` — the shared primitives

Move out of `panel-contract.ts`, unchanged in behavior:

```ts
export type ParseResult<T> = …          // already generic
export const sanitizeProse: (s: string) => string
```

Generalize the envelope — the single highest-value extraction:

```ts
export interface VerdictEnvelope<Payload> {
  readonly criterion: string;
  readonly entries: readonly Payload[];
}

export function parseVerdictEnvelope<Payload>(
  rawJson: string,
  expectedCriterion: string,
  expectedItemIds: readonly string[],
  parseEntry: (raw: Record<string, unknown>, index: number) => ParseResult<Payload>,
  itemIdOf: (payload: Payload) => string,
  crossCheck?: (entries: readonly Payload[]) => readonly string[],
): ParseResult<VerdictEnvelope<Payload>>
```

It keeps every invariant `parseJudgeVerdict` enforces today: criterion identity,
exact item coverage (each expected id once, no foreign, no duplicates, explicit
"missing" errors), and — via `crossCheck` — cross-entry rules. Architecture
passes its non-increasing-score check as `crossCheck`; review passes none.

Also generic, and used by both:

```ts
export function parseCriteriaSet(
  verdictCriteria: readonly string[],
  expected: readonly string[],
): ParseResult<void>   // distinct, complete, no unexpected — extracted from aggregateVerdicts
```

### B2. `handlers/helpers/panel-run.ts` — the shared shell

Extract from `handlers/helpers/panel-contract.ts`, parameterized by path names:

```ts
export interface RunLayout {
  readonly contextMd: string;    // "interview.md" | "brief.md"
  readonly contextJson: string;  // "interview.json" | "brief.json"
  readonly itemDir: string;      // "candidates" | "findings"
  readonly verdictDir: string;   // "verdicts"
}

export function parseRunBoundary(runsRoot, manifestPath): ParseResult<RunBoundary>
export function artifactError(path, expectedParent): string | null
export function verdictPath(runDir, layout, index): string
export function writeCanonicalOutput(output): HookResult
```

`parseRunBoundary` and `artifactError` move as-is — they are already
domain-agnostic (runs-root inside cwd, symlink rejection at every path hop,
non-empty regular file resolving inside its run-scoped directory).

### B3. Rewrite `panel-contract.ts` on the kernel

`parseInterviewDigest`, `selectPanelLenses`, `parsePanelManifest`,
`deriveJudgeCriteria`, `aggregateVerdicts`, `serializeRankings` all stay —
architecture-specific, as they should be. Only `parseJudgeVerdict` changes:
it becomes a thin call into `parseVerdictEnvelope` with the score/`fatal_flaw`/
`strongest_idea` payload parser and the ordering `crossCheck`.

**Exit criterion: zero test changes in Phase B.** If a test needs editing, the
refactor changed behavior and is wrong.

---

## Phase C — The review panel (the payoff)

### C1. `core/review-panel.ts`

```ts
export const REVIEW_LENSES = [
  "reproduction",        // can the failure actually be triggered?
  "intent",              // is this deliberate architecture? (never-throw, fail-closed, ADTs)
  "security",
  "test-coverage",
  "blast-radius",        // does the claimed consequence follow?
] as const;
```

`intent` exists specifically to kill the false positives the architectural-intent
briefing currently hand-patches — as a lens with a vote, not a prompt preamble.

Lens selection mirrors `selectPanelLenses`' signal-driven policy: `reproduction`
and `intent` are baseline; a finding set touching auth/crypto paths pulls in
`security`; findings on test files pull in `test-coverage`.

```ts
export interface RefutationVerdict {
  readonly findingId: string;
  readonly verdict: "refuted" | "upheld" | "uncertain";
  readonly reasoning: string;   // sanitized
}

export function tallyRefutations(
  verdicts: readonly VerdictEnvelope<RefutationVerdict>[],
  lenses: readonly string[],
  findingIds: readonly string[],
  threshold: number,
): ParseResult<readonly FindingOutcome[]>
```

Sibling to `aggregateVerdicts`, not a generalization of it: same input shape,
different decision. `uncertain` counts toward neither side; a finding survives
unless refuted by ≥ threshold verifiers. **Ties favor keeping the finding** — a
false positive costs a cycle, a false negative ships a bug.

### C2. Finding manifest + CLI

`helper review-panel <brief|manifest|lenses|verdict|tally>`, mirroring
`panel-contract`'s operation set on the shared shell. The manifest fixes the
finding set before verifiers spawn, so a verifier can neither invent a finding
nor skip one.

### C3. Wire into the wave gate

`commands/wave-gate.md` gains a step between Step 3 (reviews) and Step 4 (GH
comment): build the finding manifest from the wave's `Finding[]`, spawn N
verifiers in one message, tally, and write outcomes back. Refuted findings move
to a `refuted_findings` list with their reasoning — **recorded, not deleted**, so
a wrong refutation is auditable.

Only then does `complete-wave-gate` count criticals.

---

## Risks and non-goals

- **Token cost.** N extra agents per wave. Mitigate by verifying **critical
  findings only** by default; advisories skip the panel. Revisit once the
  false-positive rate is measured.
- **The verifier is itself an LLM.** k-of-n with diverse lenses reduces
  correlated error; it does not eliminate it. Refuted findings stay recorded.
- **Non-goal: verifying spec-check findings.** Different shape, different
  evidence. Later, if ever.
- **Non-goal: changing loom's phase spine.** This adds a stage inside the wave
  gate. Nothing about phase ordering changes.

## Test strategy

- Phase A: parser tests for the JSON block + fallback scraper; id-derivation
  determinism; a migration test asserting derived string arrays match `findings`.
- Phase B: **no new tests, no test edits** — the existing suite is the contract.
- Phase C: `tallyRefutations` table (unanimous refute, unanimous uphold, exactly
  at threshold, one below, all-uncertain, tie-favors-keeping); envelope rejection
  cases inherited from B1; a CLI test mirroring the panel-contract handler tests.

## Sequencing

| Phase | Blocked by | Independently useful? |
|---|---|---|
| A — findings identity | nothing | **Yes** — fixes delta-review and intent-briefing workarounds |
| B — kernel extraction | PR #17 merged | No — pure refactor |
| C — review panel | A and B | Yes — the actual goal |

A and B are parallelizable; they touch disjoint files. Do **A first if only one
gets done** — it carries value alone, whereas B alone is churn.
