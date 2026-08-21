# PR Remediation — Round 3

## Authority

- Branch: `feat/architecture-panel-mode-plan`
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260820T193629Z-ac1981e726f2`
- Canonical result: `.claude/reviews/review-and-fix-runs/review-20260820T193629Z-ac1981e726f2/result.json`
- Result digest: `b0252c0b44b32bc0e2949bb748fc0de1ec1ec8e5a0385e1c0206a6ba39c1c2f7`
- Reviewed revision: `a58f141c502fbb7c8373916864b5fe07e0fb82a4`
- Exact scope: the 486 repository paths in the canonical `result.json.scope` array. That array is the frozen authority; it is not widened by a glob or reconstructed here.

## Surviving critical findings — mandatory

### `code-reviewer-1` — crash-orphaned generation claims strand locks

`engine/src/utils/lock.ts:128` writes `generation-claim`, but an `EEXIST` claim is always treated as live contention. A process crash after claim publication can therefore prevent both acquisition and owner release indefinitely.

Fix:

1. Include parser-readable claimant identity and claim time in every claim record.
2. On contention, distinguish a live claim from an orphaned/expired claim; remove an orphan only after re-reading the same bytes, then retry exclusive creation.
3. Preserve the existing token and generation re-check before retirement so a claimant whose claim was reaped cannot retire another generation.
4. Add a subprocess crash regression that exits immediately after obtaining a generation claim and proves another process can recover and acquire the lock.

### `comment-analyzer-1` — arbitrary pipe stages can fabricate Pi test evidence

`pi/transcript-adapter.ts:180` claims post-test pipes only transform runner output, while `relaxableComposition` currently accepts every command after `|`. A stage such as `printf` can ignore stdin and fabricate a green summary.

Fix:

1. Replace the operator-only test with a narrow parser for pipe stages whose stdout is structurally derived from stdin (`tail` with bounded stdin-only syntax and `tee` with inert path arguments).
2. Fail closed for every unsupported pipe command or argument shape.
3. Add red-run fabrication regressions for arbitrary downstream commands and retain positive regressions for the supported `tail`/`tee` forms.

## Advisory dispositions

### Accepted

- `silent-failure-hunter-2` — preserve the caught `SyntaxError` detail and Run Directory context for malformed standalone checkpoints. Sound, low-risk, and directly actionable.
- `silent-failure-hunter-3` — preserve the caught `SyntaxError` detail and Run Directory context for malformed remediation checkpoints. Sound and symmetric with Wave Gate diagnostics.
- `pr-test-analyzer-1` — add a façade-level restart regression where an already-recorded attempt-2 retry is reissued while the current pass has no new rejection. This pins the durable rejection diagnostic at the public façade seam.
- `architecture-tech-lead-1` — move `PHASES`/`Phase` from the broad legacy `types.ts` root into a leaf `core/phases.ts`, import it from both `types.ts` and `model-profiles.ts`, and add a type-import-aware top-level cycle regression. This restores shared-kernel locality without changing the published Phase contract.
- `code-simplifier-1` — flatten nested error-message selection in `core/orchestration-contract/completion.ts`.
- `code-simplifier-2` — flatten nullable line parsing in `core/panel-program.ts`.
- `code-simplifier-3` and `code-simplifier-4` — flatten the two resolution-error parsers in `core/remediation-machine.ts`.
- `code-simplifier-5` — flatten JSON-object parse outcomes in `core/review-packet.ts`.
- `code-simplifier-6` — flatten completed-panel-state precedence in `core/standalone-review-machine.ts`.
- `code-simplifier-7` and `code-simplifier-8` — flatten panel-action request selection and façade resume dispatch in `handlers/helpers/orchestration.ts`.
- `code-simplifier-9` — flatten optional Wave registration-key selection in `handlers/helpers/programs/helpers.ts`.
- `code-simplifier-10` — flatten tracked/present diff selection in `handlers/helpers/review-packet.ts`.
- `code-simplifier-11` — flatten evidence-record source precedence in `handlers/subagent-stop/update-task-status.ts`.
- `code-simplifier-12` — flatten filesystem-kind byte selection in `utils/artifact-baseline.ts`.

All simplifier advisories are accepted because they are behavior-preserving, in scope, and directly enforce the repository's existing no-nested-ternary rule. Each will use explicit guards or discriminant branches rather than new abstractions.

### Deferred

- `type-design-analyzer-1` — the reducer currently rejects undeclared state/event products at runtime, but encoding every legal pair in its caller-visible signature requires a coordinated typestate redesign across the Lifecycle Machine, façade, replay, and tests. That interface redesign is materially broader than this correctness remediation; runtime fail-closed behavior remains intact.
- `type-design-analyzer-2` — deep event immutability is not expressible by changing outer `Readonly<event: unknown>` alone. A complete fix requires a generic immutable event value, recursive parser/freeze policy, and coordinated `ProgramJournal`/Fugue adapter changes. Defer rather than apply a misleading type-only patch; current consumers cannot mutate `unknown` without first narrowing it.

### Dismissed

None.

## Refuted critical audit — never fix

### `silent-failure-hunter-1`

Claim: `review-panel.ts` treats unreadable `tally-closure.json` as absent.

The Refutation Panel rejected this unanimously:

- Reproduction: an existing closure enters the closure branch; read/JSON failure is caught and returned as a closed-run contract error with the read cause.
- Intent: the path is fail-closed, and the malformed-closure regression confirms tally remains blocked.
- Blast radius: the handler immediately returns the closed-run error; `outcomes.json` and pending outcomes independently prevent unsafe continuation.

No code change will be made for this refuted Finding.

## Validation

Baseline already green before edits:

- `cd engine && npm run typecheck`
- `cd engine && npm run test:unit -- tests/utils/lock.test.ts tests/pi-test-evidence.test.ts tests/handlers/helpers/orchestration.test.ts tests/core/orchestration-contract-acyclic.test.ts` — 148 tests

Remediation validation:

1. Run the focused tests after each coherent move.
2. `cd engine && npm run typecheck`
3. `cd engine && npm run test:unit`
4. `cd engine && npm test` (full unit and smoke suite)
5. Run the full-tier Loom linter over the changed scope if exposed by the project CLI.
6. Start registered remediation with this plan in `supportPaths`; let the engine audit, stage in a temporary index, verify `audited == staged`, and atomically install the verified index.
