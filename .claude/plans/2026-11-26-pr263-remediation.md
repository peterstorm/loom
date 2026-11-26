# Plan — PR #263 remediation (review run rf-pr263-slice1-1)

Branch: `fix/258-review-request-marker` (worktree `~/dev/claude-plugins/loom-258-review-request-marker`).
Scope: the PR's 8 files (three-dot vs `origin/main` @ `41d1fea2`).
Review Run Directory: `.claude/reviews/review-and-fix-runs/rf-pr263-slice1-1` (result digest `7797ca32626b484fe9c09ea455e9e1337e4a2b6c869e7ad6da9d9b98b685b015`).
Policy publication: run `rf-pr263-slice1-1-policy`, `standalone-disposition-published`, artifacts/disposition.json, 19 entries.
Counts (engine inspection): 1 surviving critical, 0 refuted, 19 advisories.

## Surviving critical — disposition

- **`pr-test-analyzer-1`** (spawn-task.ts:281): `observeTaskBinding` — the sole runtime producer of the Task/Wave binding line — has no test coverage: neither the subject mapping nor its two refusal throws. A mutation returning `{kind:'none'}` or swapping subjects leaves the suite green while emitted Wave tasks lose or corrupt the binding the capture matcher re-derives.
  - Disposition: **repaired**, via Declared Repair Group `group.repair-issued-request-binding`.
  - Panel (threshold 2): reproduction **upheld**, intent **upheld**, blast-radius **refuted** (binding is self-consistent between reservation and echo; capture binds by request identity). Survives per the engine's accounting.

## Declared Repair Group

- **`group.repair-issued-request-binding`** — findingIds: [`pr-test-analyzer-1`]
- Root cause (DECLARED): the consolidation tested the pure composer (`issued-request-task.test.ts`) and the composition location (source scan), but the runtime step that produces the binding from durable state — the packet read, the subject mapping and the two refusal throws — is exercised by no test, so the load-bearing property the change exists to protect is held by nothing at runtime.
- Invariant (DECLARED): rendering a wave-gate request through `renderIssuedRequestTask` against a run directory whose packet carries a Task subject emits text ending in that subject's binding line; a spec-check subject emits the Wave line; an unavailable packet and a non-usable Wave context each throw their bounded refusal. The suite fails if any of that is lost.
- Siblings (DECLARED): `none-declared` — `observeTaskBinding` is the only runtime producer; `taskBindingLine`/`withTaskBinding` (the pure writers) are already exhaustively tested in `issued-request-task.test.ts`; the two emission call sites are covered by the source-scan suite and gain the runtime pin through this repair.
- Selected check: `project:issued-request-binding-repair` (new; Historical RED below).

### Historical RED (DECLARED)

The new runtime test provably fails against the reviewed vulnerable behavior: with `observeTaskBinding` mutated to return `{kind:'none'}` (or to swap task/spec-check subjects), every current suite stays green — no test exercises the function — while the emitted Wave task loses its binding line. The repaired suite asserts the binding line and both refusals against a real run directory, so the mutation fails it.

## Advisory dispositions (policy run rf-pr263-slice1-1-policy)

**Accepted (10), implemented in this remediation:**
- `silent-failure-hunter-1` — both binding-observation refusals name the failed request (requestId + digest).
- `silent-failure-hunter-2` — the not-loaded arm interpolates the actual failure kind instead of the literal "no packet".
- `pr-test-analyzer-3` — delivered by the critical's runtime test: emitted binding asserted against the packet subject.
- `comment-analyzer-1` — issued-request-task.test.ts header corrected (only the two attempt-1 sites were migrated).
- `comment-analyzer-2` — spawn-task.ts renderIssuedRequestTask doc scoped to the sites that render through it.
- `comment-analyzer-3` — issued-request-task.ts header qualified (cannot-disagree holds for renders through this module).
- `comment-analyzer-4` — spawn-task.ts header no longer claims the Wave subject is gathered in the single observation step.
- `comment-analyzer-5` + `code-simplifier-2` — renderSpawnTask caller list corrected (legacy batches no longer call it).
- `architecture-tech-lead-4` — `renderIssuedRequestTask` takes `RegisteredReviewProgram | null` (null = archived route); the caller conversion dropped.

**Deferred (9), each with its concrete reason in the published record:**
- `pr-test-analyzer-2` — cross-site byte-identical assertion is integration-suite territory; the critical repair adds the per-render runtime pin; full byte pin lands with slice 1b.
- `type-design-analyzer-1` — branded binding fields; constructor boundary already validated by the packet parser; interface change → deepen follow-up.
- `type-design-analyzer-2`, `type-design-analyzer-3`, `architecture-tech-lead-1`, `architecture-tech-lead-2`, `architecture-tech-lead-3`, `code-simplifier-1` — the slice-1b consolidation (migrate the five remaining compose sites, ban the packet-instruction fingerprint in handlers, thread the loaded context through the render facts, stop exporting caller-supplied instructions).
- `code-simplifier-3` — withBatchSubjects reshape is an exported-contract change; own change.

## Refuted findings

None. (`pr-test-analyzer-1` survived 2–1 against the blast-radius lens; the refutation reasoning is retained in result.json and reported, never repaired as a refuted finding.)

## Changed files (planned)

- `engine/src/handlers/helpers/programs/spawn-task.ts` (in scope): refusal diagnostics, typing, doc corrections.
- `engine/src/core/issued-request-task.ts` (in scope): header qualification.
- `engine/tests/core/issued-request-task.test.ts` (in scope): header correction.
- `engine/tests/handlers/helpers/programs/issued-request-binding.test.ts` (NEW — supportPath): the critical's runtime test.
- `docs/feature-guard-map.md` (in scope): derived counts if they move.
- `.loom/verification-manifest.json` (supportPath): enroll `project:issued-request-binding-repair`.
- `.claude/plans/2026-11-26-pr263-remediation.md` (supportPath): this plan.

## Validation

- `cd engine && npx vitest run tests/core/issued-request-task.test.ts tests/core/issuance-text-composition.test.ts tests/handlers/helpers/programs/issued-request-binding.test.ts tests/docs/facts.test.ts`
- `bun scripts/typecheck.ts` (excluding the pre-existing java-parser env failures on main)
- `bun scripts/lint-project.ts`
- CI is the full-suite oracle (PR #263).
- The enrolled check re-runs the binding suite itself at remediation time with a required-file JUnit report.
