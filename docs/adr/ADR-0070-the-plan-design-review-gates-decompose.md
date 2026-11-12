# ADR-0070: The plan design review gates decompose

## Status
Accepted (2026-11-12). Implemented in PR #160. Implements Q3 (plan side) of the deterministic-implementation plan's Q-track.

## Context
Type-design and architecture findings are raised at the Wave Gate, after the code exists, and each one costs
a fix run. Most of them are decisions the architecture plan already made: a state a type can represent but
the plan calls impossible, a rule with two owners, a rule inside a shell.

Nothing reviews those decisions before Tasks are cut from the plan. The plan-alignment gate checks that
`plan-alignment.md` exists, and plan alignment maps the plan to the Requirements, not to design rules.
`--panel` judges candidates, not the plan the finalizer writes. A Standalone Review of the plan file selects
neither lens: the type lens needs a changed type file and the architecture lens needs size or new
structure, and a Markdown plan has neither.

## Options Considered

1. **A new registered program.**
   - Cons: the program union, registration, packets, slots, refutation, publication and inspection would
     all be written twice. Everything a plan review needs from a program, `standalone-review` has.

2. **A new phase between plan-alignment and decompose.**
   - Cons: phases are entered by one agent and advanced by its stop. A review is a roster, a Refutation
     Panel and a publication. The phase list, the transition table and every `skipped_phases` reader would
     change for something that is a gate on decompose, not a step with its own agent.

3. **The decompose gate opens the review's Run Directory.**
   - Cons: a PreToolUse gate that authenticates a Run Directory on every decompose spawn couples the phase
     gate to the review store in both directions, and makes the gate as slow and as fallible as that read.

4. **A free-text or boolean record (`plan_design_reviewed: true`).**
   - Cons: it says nothing about which bytes were reviewed. An edit after the review keeps the flag.

5. **A `plan-design` Standalone Review kind and a digest-bound acceptance (chosen).**
   - Pros: the review is an ordinary Standalone Review Run. The State File holds one record that names the
     reviewed bytes. The gate compares one digest.
   - Cons: accepting is a separate helper call, and the record trusts the helper's one authentication.

## Decision

### 1. The review is a Standalone Review of kind `plan-design`
`plan-design` is a Standalone Review kind. Its rules are owned by `core/plan-design-review.ts` and reach
the Standalone Review through one per-kind review profile (`standaloneReviewProfile`,
`core/standalone-review-scope.ts`), which registration, successor ingress, reviewer selection, the read
obligation and the packet lens all consult:

- **Roster.** Fixed at `code-reviewer`, `type-design-analyzer`, `architecture-tech-lead`, whatever the scope
  facts say. `selectStandaloneReviewers` answers it before it reads any scope fact.
- **Scope.** `files` must name exactly one file, the plan. A start with `files: null` or more than one file
  is refused at registration.
- **Read obligation.** The whole document. Every other kind obliges its frozen diff against the baseline
  revision; a plan committed unchanged at the baseline has an empty diff and would oblige no reading. A
  `plan-design` review gives the file no base, so every unit of the plan is obliged (ADR-0022 applies
  unchanged otherwise). The frozen diff records the base revision `none:whole-document`.
- **Lens.** Each reviewer's Context Packet carries one more byte section, `plan-design-lens`: the questions
  of that reviewer's lens, what makes a plan finding critical, and that findings are located in the plan
  file. The frozen `references/reviewer-protocol-v2` files are not edited.
- **No successor.** A `plan-design` successor start is refused. An edited plan gets a fresh review.

### 2. The record
The State File gains an optional `plan_design_review`, one of three exact shapes:

| Shape | Meaning |
| --- | --- |
| `{"status":"required"}` | A review is owed. Written by `init-state`. |
| `{"status":"not-required","reason":"skipped"}` | Written by `init-state --skip-plan-design-review`. |
| `{"status":"accepted","planSha256","runId","resultDigest"}` | A review was accepted for those plan bytes. |

It is parsed at the wire: extra keys, an unknown status, a malformed digest or Run id make the State File
refuse to load. An absent field stays absent on a round trip. The gate reads an absent field as
`not-required` for the reason `unrecorded`, which is never written. The skip is recorded here, not in
`skipped_phases`: the review is not a phase.

### 3. The gate
A decompose spawn needs the plan-alignment gate and then the plan design gate (`checkPlanDesignGate`, in
`core/validate-phase-order.ts`):

- `not-required`: open.
- `required`: closed.
- `accepted`: open exactly when the SHA-256 of the plan's bytes now equals `planSha256`.

The gate reads the State File and the plan's digest through `ArtifactProbe.sha256`. It never opens a Run
Directory. A closed gate names the plan, both digests when they differ, and the commands that open it. Both
harnesses call the same function. Execute is not gated: the gate binds the plan Tasks are cut from.

`populate-task-graph` asks the same gate (`populationPlanDesignRequirement`) on first population, the
decompose → execute transition that actually cuts the Tasks, so a payload populated without spawning
`decompose-agent` is held to it too. It digests the plan bytes it already read once for the
executable-model binding check, and asks the gate of the graph before the lock and again of the graph read
under it. `--skip-plan-design-review` (the State File's `not-required`) and an absent record leave it open.
Re-population in execute is not gated, like an execute spawn.

### 4. Acceptance
`helper accept-plan-design-review --runs-root <dir> --run <run>` is the only writer of `accepted`. The shell
reads the Run in one authenticated walk (`readAuthenticatedStandaloneRun`), which returns the published
result, the lineage source (frozen scope and roster) and the registration together; whether the
registration carries the read obligation is read from that registration. It then authenticates a named
disposition against this review, and parses every value into the type the judgement takes (digests as
`ArtifactDigest`, paths as `ReviewPath`, kinds and roles as their closed unions). The plan path is
canonicalised through the same parsers the review's scope passes (`parseRepositoryPath`, `parseReviewPath`).
One pure function (`judgePlanDesignEvidence`) then accepts, or refuses with one reason:

| Refusal | When |
| --- | --- |
| `wrong-kind` | The requested kinds are not exactly `["plan-design"]`. |
| `scope-mismatch` | The frozen scope is not exactly the plan this graph names. |
| `roster-incomplete` | A plan design reviewer is missing. |
| `read-not-obligated` | The Run was registered without the read obligation. |
| `plan-unobserved` | The review froze no bytes for the plan. |
| `plan-changed-since-review` | The frozen bytes are not the plan's bytes now. |
| `surviving-criticals` | A critical survived the Refutation Panel. |
| `advisories-undisposed` | There are advisories and no published disposition was named. |

On acceptance one locked write stores the record, after re-reading under the lock that the graph still
names the plan that was judged and re-hashing that plan: bytes that changed after they were judged are
refused, so the stored `planSha256` is the plan's digest at the moment it is written.

### 5. Criticals and advisories
A critical the Refutation Panel refuted does not block. A critical that survived is resolved by editing the
plan and reviewing it afresh: the edit changes the digest, so the old result can never be accepted for the
new bytes. Advisories never block; they need a published Advisory Disposition of this review, named by
`--disposition`, `--disposition-run` and `--disposition-digest`. Any decision is enough. A review with no
advisories needs no disposition.

### 6. Graphs that predate the record
A State File written before this ADR has no `plan_design_review` and is never stranded: its decompose gate
is as it was. Its operator may still run the review and the helper, after which the record is `accepted`
and the digest binding applies.

## Consequences
- Every new orchestration runs three reviewers and a Refutation Panel before decompose, and again after
  every plan edit made once a review was accepted. `--skip-plan-design-review` removes it for one
  orchestration, visibly, in the State File.
- A plan-alignment loop-back that rewrites the plan invalidates an acceptance. The review belongs after
  plan alignment has settled.
- **The record trusts one authentication.** The gate does not re-prove the Run Directory. A Run Directory
  deleted or retired after acceptance leaves the record standing, and `runId` and `resultDigest` are then
  references nothing can follow.
- **The helper authenticates the Run once.** One walk returns the published result, the lineage source and
  the registration. For a schema-1 or schema-2 Run that walk re-reads the registration once more, to prove it
  did not change between authenticating the result and reading the frozen scope. A named disposition is a
  separate Run, read and authenticated against this review's lineage.
- **The plan path is compared relative to the working directory.** The helper and the review must run from
  the repository root, as every helper documented in `/loom` does. From another directory the helper
  refuses with `scope-mismatch`; it never accepts a different file.
- **The record is not cleared by a phase loop-back.** `set-phase --phase architecture` keeps an `accepted`
  record. A rewritten plan closes the gate through its digest; a plan restored to the reviewed bytes opens
  it again, which is correct.
- **Execute is not gated.** A plan edited after population is not reviewed again by this gate, and
  re-population in execute does not ask it.
- **The lens is prose.** Nothing checks that a reviewer answered its questions, beyond the read obligation
  and the result grammar every reviewer already meets.
- **The gate is asked at both decompose seams.** The decompose spawn asks it, and `populate-task-graph` asks
  it again on first population, so a hand-written payload populated without spawning `decompose-agent` is
  refused while the plan has no accepted review for its current bytes.
- The Wave Review Roster is unchanged. Whether a Wave's type and architecture reviewers may be reduced for
  a Task cut from a design-reviewed plan is not decided here.
