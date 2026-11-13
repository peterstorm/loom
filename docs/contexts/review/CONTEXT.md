# Review

How Loom reviews code and plans. Core terms (Finding, Refutation Panel, Review Run, Review Packet, Wire Contract, Standalone Review Run, …) are in the root [CONTEXT.md](../../../CONTEXT.md).

## Language

### Reviewer protocol

**Issued Reviewer Protocol**:
The nominal authority joining independent registration, published request and Context Packet to reviewer admission. Current packets freeze exact reviewer schema and impact rubric bytes; genuine v1 issuance retains its original contract without inventing a retrospectively frozen rubric. Output shape and caller version hints never select the decoder.
_Avoid_: Payload version authority, decoder fallback, current prompt

**Finding Basis**:
A reviewer's structured evidence or execution trace, violated contract, consequence and evidence limits, truth confidence, and severity rationale accompanying one claim. Required for a v2 critical; optional but complete for an advisory, which requires a concise reason. These six critical fields (claim plus five basis fields) are semantic assertions, not engine-proven truth, impact, reachability, execution, or test adequacy.
_Avoid_: Proof of defect, impact score, execution receipt

**Reviewer Protocol Failure**:
Unusable reviewer evidence under its Issued Reviewer Protocol, consuming only existing bounded evidence-retry authority and creating no v2 product Finding or Defect-Family repair obligation. Infrastructure observation failure instead remains unavailable at the same semantic attempt.
_Avoid_: Synthetic critical, advisory downgrade, clean review

**Documented Wire Example**:
A fenced example of an input Loom parses, shown in a prompt or operations doc under a marker line naming its shape, and run by the test suite through that shape's production parser. The stamped **Wire Contract** regions are generated, not Documented Wire Examples.
_Avoid_: Sample payload, snippet, schema example (a hint written as a literal value is a defect: a value the reader replaces is a `<…>` placeholder)

### Wave review

**Wave Review Roster**:
The ordered reviewers one Wave **Task** is issued, derived per Task from protected state: the base five (code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer), plus architecture-tech-lead appended last when the Task's packets carry the Owner Map or the Task writes a Contract Surface. Order is slot authority. A **Distill Task** has no roster: it is explicitly exempt, never given an empty one.
_Avoid_: Reviewer list, "the five reviewers" (a Task under the architecture lens has six), owner-mapped roster (the owner map is one of two reasons), empty roster (for the Distill Task's exemption)

**Git-Visible Leaf**:
A file or symlink Git can see at or below a repository path: a tracked entry (even one deleted from the worktree) or an untracked file the repository's own ignore rules do not ignore. Every engine observer of repository content enumerates leaves the same way, ignoring the operator's ambient and global Git configuration.
_Avoid_: Directory listing, file walk, pathspec match

**Reviewed Workspace Observation**:
The exact bytes one Task's review scope held when a Wave review was prepared, with their content digest. Only the reviewed-workspace core mints one; a value rebuilt around its constructor is refused rather than re-hashed.
_Avoid_: Workspace snapshot (alias), file dump, worktree state

### Panels and programs

**Candidate**:
One architectural design produced by one designer through one **Lens** during `/loom --panel`. Judges rank Candidates against derived criteria; the user selects a Candidate as the base for the **Plan**, and may reject the ranking recommendation.
_Avoid_: Option, proposal, variant

**Verdict**:
One agent's complete judgment on one criterion or lens, covering every item exactly once. The unit both panels validate at the boundary; a verdict that skips or invents an item is rejected outright rather than counted as a weaker vote.
_Avoid_: Score, vote (alone), opinion

**Panel Program**:
The executable event-sourced dispatch policy for an architecture panel or Refutation Panel. Emits exact spawn batches, LLM Profiles, retry actions, engine operations, and terminal outcomes; Markdown explains execution but does not own ordering.
_Avoid_: Runbook sequence, workflow DSL, panel prompt

**Orchestration Façade**:
The single parent-facing engine interface for status and for every registered program (architecture panel, Refutation Panel, Standalone Review Run, Wave Gate, remediation). At its boundary it returns only a spawn batch, await-user, blocked or done.
_Avoid_: Helper collection, workflow script, shell runbook

**Effect Receipt**:
A typed durable record that an authorized orchestration side effect completed. Resume reconciles a matching receipt instead of executing the effect again.
_Avoid_: Log line, success flag, checkpoint

### Standalone lineage

**Finding Origin**:
The immutable identity of one originally attributed Finding: its originating Standalone Review Run, issued request, accepted transcript and original result publication. A bare Finding id is only local identity; a successor review preserves the original assertion, severity, location and evidence rather than reminting it.
_Avoid_: Similar claim, deduplicated Finding, global ordinal

**Standalone Disposition Record**:
An immutable, independently published record of the parent's policy decisions (accepted, deferred or dismissed, each with a reason) on every advisory of one completed Standalone Review result. The decisions are declared, not proven; a correction names the earlier revision instead of editing it. It is neither Refutation Panel authority nor repair evidence.
_Avoid_: Resolved Finding, policy proof, mutable triage ledger

**Standalone Successor Binding**:
What makes one Standalone Review Run the explicit successor of another: the authenticated predecessor result, its published disposition revision (or its honest historical absence), the conserved inventory of Finding Origins, and the successor's own frozen source and reviewer roster. Every current reviewer assesses every inherited origin once. An independent review or a same-Run recovery is not a successor.
_Avoid_: Latest review, same-name Run, review reuse, recoverable predecessor state

**Standalone Resolution Assessment**:
A source-bound semantic assessment resolving one prior Finding only when every current expected review Agent explicitly verifies its repair and identifies a relevant implementation change. Any disagreement, not-assessable or absent assessment prevents resolution. It is reviewer judgment, never engine proof, a Task Review Generation, or an automatic consequence of Repair-Checked.
_Avoid_: Refutation, declared repair, passing-check proof

**Standalone Reopening Proposal**:
A successor reviewer's explicit challenge to one prior disposition, refutation or resolution, naming its Finding Origin and the changed conditions or new evidence. A critical proposal goes to a fresh Refutation Panel. It never rewrites the origin, promotes an advisory's severity or erases historical votes.
_Avoid_: Parent override, duplicate Finding, severity promotion

**Current Critical Coverage**:
A successor's engine-derived statement of whether every inherited critical origin, refuted and resolved history included, was assessed: complete or limited. Limited coverage refuses remediation even when no critical is currently active.
_Avoid_: Zero-critical pass, new-finding count, test coverage

**Attempt-One Admission**:
The pure decision that classifies every expected first-attempt slot of a resumed standalone review as captured, to be reissued, or tombstoned. A tombstoned slot (its transcript was refused, or its capture terminally rejected) is advanced to its second attempt instead of deadlocking the roster.
_Avoid_: Admission sweep, Phase A (a reviewer's phase label, not the decision), retry decision

### Remediation

**Defect-Family Accounting**:
Exact accounting of one Standalone Review Run's surviving critical Finding IDs into Declared Repair Groups or explicit blocking dispositions. Grouping, root cause, invariant, sibling-path completeness, and Historical RED remain semantic declarations; accounting never changes the source Findings or creates a Resolved Finding.
_Avoid_: Proven closure, automatic root-cause discovery, cross-run finding lineage

**Declared Repair Group**:
A separately identified grouping that retains every original Finding ID and declares one root cause, invariant, sibling-path accounting, and selected operator-owned regression checks. Grouping is declared, not confirmed by a digest or inferred from similar text.
_Avoid_: Merged Finding, confirmed defect, replacement Finding ID

**Historical RED Declaration**:
An explicitly `DECLARED` statement about a regression against vulnerable behavior. It may cite historical evidence, but is never represented as engine-observed execution of the vulnerable snapshot.
_Avoid_: Observed counterfactual, verified historical failure, execution receipt

**Repair-Checked**:
The bounded remediation outcome: every surviving critical and declared sibling is accounted for without blocking dispositions, and the selected operator-owned checks produced fresh passing structured test reports under engine observation on unchanged candidate bytes. It proves neither the declared root cause nor historical RED. A run with no surviving critical needs no remediation at all.
_Avoid_: Proven closed, Resolved Finding, semantic proof

## Relationships

- An **Issued Reviewer Protocol** binds one parser and rubric from capture through publication
- A **Finding** has at most one **Finding Basis**; a critical always has one
- A **Reviewer Protocol Failure** never creates a **Finding**
- A Wave **Task** has exactly one **Wave Review Roster** or is exempt; a **Review Run** keeps the roster it was installed with
- A **Review Packet** reviews the **Git-Visible Leaves** of its scope and has one **Reviewed Workspace Observation**
- A panel has exactly one **Panel Program**; the **Orchestration Façade** issues each of its requests with one Context Packet
- An **Effect Receipt** belongs to exactly one authorized side effect
- A **Finding** has exactly one **Finding Origin** across every successor review
- A successor Standalone Review Run has exactly one **Standalone Successor Binding**
- A **Standalone Resolution Assessment** needs the full current roster; **Repair-Checked** alone creates none
- A critical **Standalone Reopening Proposal** gets one fresh Refutation Panel; unchanged upheld criticals get none
- **Defect-Family Accounting** places every surviving critical in exactly one **Declared Repair Group** or blocking disposition
