# Standalone review remediation — round 7

- Branch: `fix/abandoned-gate-terminal-outcome`; reviewed HEAD: `8b8ba024`.
- Exact frozen review scope: the 171 ordered paths in the registered `review-fix-20260924T093041Z-8b8ba024/result.json` (`scope`, digest `38acf3a66cacbc4c306902a439db25eac5323ab27e284bf6d6c55c653c2d6032`). Do not infer a new scope from this plan.
- Published policy: `policy-20260924T095138Z-r7`, initial DECLARED revision, disposition digest `f79db4907857f82f757bca58fa7c7300c39f34814683ae1676609b7d5565ce98` (receipted `effect:standalone-disposition:f79db490…`).
- Review inspection: 7 slots issued and captured, 0 rejected; **0 emitted/admitted critical, 11 advisory**; **0 surviving critical, 0 refuted critical** after the engine's adjudication (no Refutation Panel was routed — the critical set was empty).

## Surviving criticals / repair groups

None. Zero surviving critical findings; no Refutation Panel evidence exists and none is fabricated. Zero-critical remediation carries `defectFamily: {"kind":"not-required"}`, no repair group, no selected operator check, and no Historical RED declaration.

## Refuted-finding audit

None — no refuted critical findings were produced.

## Complete advisory policy (DECLARED, published at `policy-20260924T095138Z-r7`)

| Finding | Decision | Reason / action |
| --- | --- | --- |
| `code-reviewer-1` | Accepted | `gitPaths` decodes NUL-delimited listings with lossy UTF-8 (`spawnText`), so a non-UTF-8 filename silently mangles into scope authority as an absent entry while `workspace-digest parseListedPaths` refuses the same listing with a typed failure. Fix: fatal per-chunk UTF-8 decode with a typed refusal, aligned with the sibling implementation. |
| `silent-failure-hunter-1` | Accepted | `resetRemediationReport` conflates clean not-ignored exit 1, Git fatal exits and spawn errors into one fixed refusal and drops stderr from both the check-ignore arm and the ls-files non-zero arm. Fix: distinguish the clean exit-1 not-ignored refusal from attributed spawn/fatal refusals; carry stderr in both probes' refusal messages. |
| `pr-test-analyzer-1` | Accepted | The candidate-reference probe lacks scripted refusal pins for a diagnostic exit 1 and a fatal non-zero status (the symmetric merge-base arms are pinned). Add two scripted cases mirroring the merge-base pins. |
| `pr-test-analyzer-2` | Accepted | The candidate-reference probe is the only Git probe family without a transient-discharge pin. Add one scripted empty-then-revision case. |
| `type-design-analyzer-1` | Accepted | `messageOf` returns plain `string` and two sites mint `NonEmptyString` by bare `as` casts while sibling sites prove the bound first. Fix: make `messageOf` the validating constructor (non-empty fallback literal, 4096 bound = `MAX_SPAWN_FAILURE_MESSAGE_LENGTH`) and delete both casts. |
| `type-design-analyzer-2` | Deferred | Branding `WaveSpecCheckSlotAuthority.slot_id` with the kernel `SlotId` requires threading the brand across the pi↔engine reservation boundary (writer `wave-gate.ts:843` consumes the Pi reservation chain whose types carry plain strings); a type-only change would move the unproven assertion to the writer. No runtime defect at head: `parseSlotId` re-proves the value at the load boundary and all consumers compare by equality. Deliberate follow-up with the reservation-boundary proof. |
| `comment-analyzer-1` | Accepted | `git.ts resolveRepositoryRoot`'s catch-block comment and stderr text still describe the removed silent-absence contract. Fix: correct the prose to the current typed-refusal contract. |
| `comment-analyzer-2` | Accepted | The causeless-block refusal's `--fix` pointer is false (`fixFull` never touches `wave_gates`). Fix: correct the operator pointer to the real remedy; no new repair semantics for a withholding invariant. |
| `comment-analyzer-3` | Accepted | The `gitSpawnProbe` rationale counts five wraps; the module instantiates six. Folded into the accepted shared-tail extraction (`code-simplifier-1`), which rewrites the rationale to name the actual sites. |
| `code-simplifier-1` | Accepted | Six near-identical post-observation resolution tails and four byte-identical confirmed-empty refusal sentences in `helpers.ts`. Fix: extract one shared observation-resolution helper (failed → throw with attribution; confirmed-empty → caller's explicit decision; value → passthrough), behavior-preserving, messages byte-identical to their pinned test regexes. |
| `code-simplifier-2` | Accepted | The `gitSpawnProbe` rationale's count and site name drifted after the `8b8ba024` split. Folded into the accepted shared-tail extraction. |

10 accepted, 1 deferred, 0 dismissed. Advisories are never inserted into `defectFamily`; with zero criticals the remediation carries `not-required`.

## Accepted advisory fixes (all inside the frozen 171-path review scope)

- `engine/src/handlers/helpers/programs/helpers.ts` — shared post-observation resolution helper (extraction), fatal UTF-8 path decode in `gitPaths`, rationale rewrite (six wraps, both candidate probes named).
- `engine/src/orchestration/completion-check-runner.ts` — `messageOf` mints `NonEmptyString`; check-ignore/ls-files refusal attribution with stderr.
- `engine/src/utils/git.ts` — stale comment and stderr prose corrected.
- `engine/src/state-file-wire.ts` — operator remedy pointer corrected.
- `engine/tests/handlers/helpers/programs/reviewer-scope-empty-retry.test.ts` — three new scripted pins (diagnostic exit-1, fatal status, transient discharge for the candidate reference).

The only remediation path outside the frozen review scope is this plan file, named in `supportPaths` at remediation start.

## Validation and install

Development validation (not P3 evidence): targeted focused suites (`reviewer-scope-empty-retry.test.ts`, `report-reset-empty-retry.test.ts`, completion-check suites), then `cd engine && npm run verify` (typecheck, fresh structured Vitest report, smoke checks). Start a fresh schema-v2 remediation with `defectFamily: {"kind":"not-required"}` and this plan as the sole out-of-scope support path; accept only a fresh engine-observed outcome and exact verified-index installation. Commit that installed index without restaging, then push without force.
