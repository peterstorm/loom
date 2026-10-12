# Issue #11: what is left, and how to finish it

- **Issue:** #11, "Make /spec-check structural"
- **Status:** decided and implemented (B, A); C and D closed
- **Date:** 2026-10-12

## Where #11 stands

Most of #11 shipped through #41/#43 and later trace work. Checked against main on 2026-10-12:

| Acceptance criterion | State |
|---|---|
| Spec parser returning FRs, scenarios, OOS and glossary with hashes | **Done.** Spec Index, `core/parse-spec.ts` |
| `AS-NNN:` / `OOS-NNN:` ids in the spec template | **Done** |
| Structural Phase A before the agent's own reading | **Done.** The Requirement Coverage Projection settles rows (`Decided by: engine`) and leaves the rest to the agent |
| Scope creep: a Task claiming an `OOS-NNN` is CRITICAL | **Done** (settled in the projection) |
| `Task.spec_anchor_hashes`, and drift since claim | **Done** for current-Wave claims. Population and amendment stamp it, and the projection grades a drifted claim MEDIUM |
| Step 5 checks scenario coverage by `AS-NNN` grep | **Done in the skill.** `spec-check.md` greps for `it('AS-NNN: …')`. The grep is the agent's, not the engine's |
| Implementer and test prompts require `it('AS-NNN: …')` | **Missing.** Neither the implementation brief nor any implementer or test skill mentions it, so Step 5 depends on a convention nobody is told about |
| `SpecCheck.fr_hashes_at_last_pass`: drift since a Requirement last passed | **Missing**, and a real gap (A below) |
| Wave Gate check for changed files no Task owns | **Missing.** Partly covered elsewhere (C below) |
| `/review-pr` reports orphan files | **Missing** (D below) |

## A. Drift on Requirements that earlier Waves completed

**The gap.** `projectRequirementCoverage` builds rows only for current-Wave claims (`if (!task.inCurrentWave) continue;`). After Wave 1 completes FR-003, nothing compares FR-003's text again. If someone rewrites FR-003 during Wave 4, every later spec-check is silent about it, and the final result claims FR-003 is done against text it never saw.

A second, smaller problem: a claim's recorded hash is the text **at claim time**. If the text changed during the Wave and the agent re-assessed the drifted row and passed it, the recorded hash still names the old text. So "recorded hash ≠ current text" would keep firing on a Requirement that was in fact verified against its current wording.

**Design.**

1. **Record what the passing Wave saw.** The packet's coverage rows already carry each claim's Spec Index entry with its current `contentHash`. Record that claim-to-hash map on the Wave Review Epoch beside `settledSpecCheckFloor`, with the same rationale as the floor: the value rendered to the agent is the value enforced. Call it `verifiedClaimHashes`. A historical epoch without it is stated, never defaulted.
2. **Re-anchor on completion.** When the Wave Gate completes, set each Wave Task's `spec_anchor_hashes` to the epoch's `verifiedClaimHashes`. The Requirement Content Hash then means "the text this claim was last verified against": set when the edge is created, then refreshed by each passing Wave Gate. This changes the CONTEXT.md definition, deliberately.
3. **Surface it in the projection.** Add a section, "Requirements completed in earlier Waves whose text changed since they passed", listing out-of-Wave claims whose recorded hash differs from the current text. Severity **MEDIUM, advisory**: it never blocks the current Wave, which did not do that work. Each item is rendered as a settled advisory line, and `orchestration status` repeats it as a reason.

**What it does not do.** There is no sanctioned way to re-verify a completed Wave against changed text:
- `reopen-completed-wave` requires proven workspace drift;
- a later Wave cannot claim or contribute to a Requirement an earlier Wave completed, because the v2 ownership rules refuse both.

So this item makes the drift visible and stops there. A "reopen for Requirement drift" route would be a separate decision (question 2).

**Tests.**
- The epoch records exactly the rendered hashes.
- Completion re-anchors only that Wave's claims.
- The projection lists exactly the drifted out-of-Wave claims.
- A Requirement verified after mid-Wave drift is not reported again.
- An epoch without `verifiedClaimHashes` is stated, never defaulted.

## B. Tell implementers to name tests `AS-NNN: …`

**The gap.** `/spec-check` Step 5 decides scenario coverage by grepping for `AS-NNN`, but the implementation brief (`commands/templates/impl-agent-context.md`) and the implementer and test skills never ask for that naming. Coverage is therefore accidental.

**Design.**
- The brief's Completion Claims section lists the claimed `AS-NNN` ids, with one instruction: each claimed scenario gets at least one test whose name starts with `AS-NNN:` (for example `it('AS-004: rejects a stale cursor', …)` or `@DisplayName("AS-004: …")`).
- The same convention goes into the `ts-test-engineer`, `java-test-engineer` and `code-implementer` skills.
- No hook enforcement. An operator-edited test that drops the prefix shows up as NOT COVERED in Step 5, which is the right outcome. This answers #11's open call 3.

**Follow-up worth doing later:** compute Step 5 in the engine. The reviewed-workspace snapshot already holds the exact bytes of each Task's scope, so `AS-NNN` coverage over the frozen test files could be a settled projection fact instead of an agent grep. That makes Step 5 deterministic in the same way Step 4 already is.

## C. Changed files no Task owns

**What already covers it.** Implementation settlement refuses writes outside the Task's scope, allowing for sibling Tasks' scopes (`out-of-scope-writes` in `implementation-application.ts`). An implementer Agent therefore cannot leave an orphan file behind.

**What is left.** Edits made outside any implementation attempt: the parent session or the operator changing code mid-Wave. Wave Gate reviewers see only the frozen Task scopes (spec-check Step 3 uses `declaredFiles`), so such an edit is never reviewed.

**Design.**
- Record a Wave-start repository revision when a Wave becomes current: at population for Wave 1, and at completion when `current_wave` advances. Call it `wave_start_revision`.
- At Wave Gate start, take the changed paths since that revision, plus the dirty set. Subtract the union of the Wave's Task scopes and the engine-owned paths (`.claude/**`, `.loom/**`, plan and spec files).
- Render what remains as an advisory packet section for spec-check Step 7 and as a status reason. **Advisory, not blocking**, because operator edits to docs or plans between Waves are legitimate.

**Cost.** One new protected field, Git observation in the start shell, and an exclusion list that will need tuning. This is the least valuable of A–C given the settlement guard.

## D. `/review-pr` orphan files

**Recommendation: drop it.** Standalone review is not tied to a TaskGraph: most PRs, including every Loom PR this cycle, have no active graph to compare against, and in graph-driven work C covers the case at the Wave Gate. Close this part of #11 as superseded.

## Proposed delivery

1. **PR 1, B** (small): brief, skills and docs, about half a day.
2. **PR 2, A** (medium): the epoch field, completion re-anchoring, the projection section, a status reason and the CONTEXT.md definition change. About 1–1.5 days.
3. **PR 3, C** (medium, optional): `wave_start_revision` and the advisory orphan section.
4. Then close #11, with D marked superseded.

## Decisions (delegated to Claude, 2026-10-12)

1. **A is advisory MEDIUM.** It never enters the settled floor and never blocks the current Wave.
2. **No reopen-for-drift route.** Reopening means re-planning a completed Wave, and that is the operator's call; A only makes the drift visible. Revisit only if visible drift turns out to be routinely ignored.
3. **Re-anchoring adopted.** CONTEXT.md now defines the Requirement Content Hash as "the text last verified".
4. **C skipped.** Settlement's `out-of-scope-writes` refusal already covers implementer writes. A baseline-plus-exclusion-list check for operator edits would add a protected field and false positives for little gain.
5. **D dropped.** Superseded, as recommended.

## As implemented (differs from the design above)

- **No `verifiedClaimHashes` epoch field.** The registered Wave Gate's completion commit already refuses unless the current spec bytes equal the epoch's `specCheckDocuments`, which are the bytes spec-check reviewed. Re-anchoring from the spec observed at completion therefore records exactly the reviewed text. `reanchorVerifiedClaims` (`core/verified-claim-hashes.ts`) still proves that the index digest and path match the epoch before using it.
- **Only the registered Wave Gate re-anchors.** The legacy `helper complete-wave-gate` path proves no spec bytes against an epoch, so it keeps claim-time hashes.
- **No status reason.** Status never observes the spec. The drift is reported where #11 asked for it: the spec-check packet, which every later Wave Gate renders.
- **The packet section renders only when non-empty**, so packets without drift keep their bytes.
- **Graphs completed before this change** carry claim-time hashes. A Requirement that drifted mid-Wave and was re-verified can therefore show once as drifted in a later Wave. Its text really does differ from the recorded hash, so the finding is true, though its wording overstates it.
- **B** renders an "Acceptance Scenario Test Names" section in the brief from the claimed `AS-NNN` ids, plus guidance in the skills and in spec-check Step 5.
