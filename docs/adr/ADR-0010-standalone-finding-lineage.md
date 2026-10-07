# ADR-0010: Explicit standalone Finding and disposition lineage

## Status

Selected design implemented, **registered review and remediation complete**;
merge, publication, and loaded-runtime cutover pending. The registered review
(run.p5-source-review-13) closed with zero surviving critical findings and 15
advisories — two accepted and fixed (cli.ts stdin bounding, safeIoCause
standard-error classification), thirteen deferred with recorded reasons; a
distill pass tightened the three highest-leverage deferrals (dense-array
unification, attempt-one admission, the v2-vs-v3 admission seam) and skipped
the WeakMap caches extraction as a hypothetical seam. The full gate (engine
typecheck, exact-baseline unit suite, root verify 23/23 including all six
smokes) held after every change. The branch merged main's PR #52
reviewer-protocol-v2 changes, resolving the one conflict in
`engine/src/core/reviewer-protocol.ts` in favor of the shared strict byte
grammar factored for both v2 and v3.

P4 merged as `96153edc3dd755b4ac648ed48920b6670753c5a6`, with publication and
loaded-runtime reload verified. P5's review/remediation used admitted main
runtime `sha256:086c472e4e913376c07d69f5116c9ad9655546e22c91e40d28cba9fdd795bc79`
and the frozen Skill 5.0.0 contract, including ordinary Plan advisory triage.
Feature mutations were confined to owned matching-runtime fixtures; admission
was never unset and P5 policy was never retrofitted into the source review. New
triage can publish new records honestly after merge/publication/reload.

## Context

Independent standalone reviews reuse local per-role Finding ordinals. They cannot
honestly share identity by bare ID, text similarity, branch name or nearby Run name.
Parent advisory choices previously lived in Plans; later readers could not
reliably distinguish an old decision from an inferred one. A repaired-state test
receipt also cannot establish semantic resolution of the original Finding.

A successor needs authenticated history without treating prior review as current
completion. It must retain earlier refutations, resolutions and declared policy,
require current assessment of every inherited origin, and preserve blocking
coverage limitations through P3. This addresses standalone review/remediation
continuity, not formal planning or automatic prevention of all remediation.

## Alternatives

1. Infer the previous review or match similar Findings. Small input, but ambiguous
   forks and local IDs would silently manufacture lineage. Rejected.
2. Keep an editable policy ledger or publish policy only during remediation.
   Simpler storage, but loses advisory-only decisions and permits rewritten history.
   Rejected.
3. Explicit predecessor plus independently published immutable policy revisions,
   with a standalone-only versioned successor envelope. Selected: more explicit
   authority joins, but honest history and bounded current review obligations.

## Decision

### Independent advisory custody

`start standalone-disposition` is a tiny no-agent per-program publisher. Input
contains exactly `source`, `record` and `previous`; source and full ordered advisory
inventory come from authenticated `inspect --lineage`. Entries name origin digests,
not bare Finding IDs. Every advisory—including retired history—is dispositioned
`accepted`, `deferred` or `dismissed` with a reason. No critical is a policy entry.

Publish immediately after autonomous parent triage under operator instructions,
even when no remediation or successor follows. The schema-1 record has `DECLARED`
provenance. Publication goes to `artifacts/disposition.json` plus an exact receipt;
registration → registered checkpoint → artifact → artifact checkpoint → receipt →
done checkpoint is an executable idempotent lifecycle.
Missing/lagging checkpoints reconcile only to observed effects; conflicts refuse.
There is no new await-user stage or Agent work.

A correction is a fresh record for the same source, naming both `previousDigest`
and the exact earlier published locator/Run/digest. Explicit forks are permitted;
no implicit latest revision. Present-day `historical-import` retains exact prose
text/reference and explicit advisory mapping but remains DECLARED now, never
backdated historical evidence. `historical-decision-unavailable` is an explicit
selection, not an empty native record or recovery from corrupt current publication.
An unselected inspection does not establish that no policy exists.

### Explicit successor authority

Only `start standalone-review` with explicit `schemaVersion:3`, non-empty ordered
canonical `files`, `dryRun:false`, and exact `successor.source`/`successor.disposition`
selects v3. Independent standalone and Wave issuance remain v2. Source locators
are canonical absolute original Run directories with exact Run/result identities.
Preflight authenticates source and selected policy, observes current bytes/modes,
retains predecessor scope and reviewer roles, and refuses narrowing or resource
overflow before Run creation/issuance. Scope/roster expansion is explicit.

Relevant dependencies/configuration/contracts belong in the selected frozen scope;
there is no mutable-live or implicit transitive context lane. Current source records
bind byte digest, byte length and normalized Git mode `100644`/`100755`, or actual
anchored-safe observed absence. Every extant parent component is checked without
following symlinks. HEAD, changed-path facts, additions, and reviewer-selection
metadata are derived inside the same observation window, then a final whole-scope
stability pass rejects drift before authority is encoded. Legacy known bytes retain unknown mode; genuinely unavailable old
observations stay historical-unknown. Never substitute current source for missing
history, or missing expected current source for historical absence. HEAD/ancestry
is provenance, not source equality, repair or applicability.

Each Finding Origin retains original Run/request/transcript/ordinal, original
publication, assertion, severity, location and evidence. New engine-attributed
ordinals continue per-role high-water across **all** inherited histories. Independent
forks may share a local ordinal but never an origin. Current origins and decisions
refer to enclosing publication; downstream consumption attaches its exact result
identity. A result does not contain its own digest or future policy references.
Contexts bind prepared lineage/snapshot, not a future registration digest.

### Current semantic assessment

The strict v3 envelope carries issued lineage/snapshot digests, complete ordered
`priorAssessments`, and `findings: [{draft, relation}]`. Draft evidence remains P4
v2; inherited v1/v2 evidence stays honest without synthesized basis. Relations are
independent or explicitly distinct-related—not replacement assertions.

Every current expected reviewer assesses every inherited origin exactly once,
including active, refuted, resolved and policy-retired rows. Whole-roster `repaired`
with reasons and relevant scoped implementation changes resolves against one frozen
snapshot. Known unchanged input cannot justify repair; unknown historical comparison
is recorded as unknown. Disagreement or `not-assessable` prevents resolution but is
valid evidence. Missing/malformed/foreign/duplicate/reordered coverage refuses the
whole response under existing attempt-1/2 policy, without synthetic product Findings.
Infrastructure unavailability retains the semantic attempt.

Retention names an exact prior decision. Reopening requires the exact prior
origin/decision/refutation/resolution reference, new evidence, changed conditions
or contradiction of the old reason, current applicability and evidence limits.
Only new criticals and explicit critical reopening proposals reach a fresh full
Refutation Panel, with unchanged lenses and strict-majority policy. Already-upheld
unchanged criticals stay active without a new panel. Preserve every old vote/reason;
parent prose cannot reopen/refute criticals. Advisory reopening cannot promote
severity; policy reconsideration needs a later disposition publication.

Unanimity is reviewer judgment, not engine proof. Structured evidence, formally
phrased statements and digests prove neither truth nor semantic test adequacy.
Repair-Checked never creates a resolution. Do not add an extra reviewer roster on
remediation/rerun, and do not equate no fresh panel work with no active blockers.

### Production and compatibility seams

The standalone review aggregate, its LC-2 reducer and lineage preparation are one
cohesive implementation owned by `engine/src/core/standalone-review.ts`: prepared-source
membership feeds issued reviewer evidence, which feeds LC-2 finalization/publication,
which alone can admit the next source. Callers import the LC-2 reducer, publication
reader and lineage preparation from that owner directly: the former
`standalone-review-machine.ts` and `standalone-lineage.ts` re-export facades were
deleted (2026-10, PR #66 deepen pass) because they moved no complexity and gave
callers two valid paths for one concept. `standalone-successor-reviewer.ts` remains a
consumed named entry surface pointing only inward; the implementation never imports it.
Only the membership proof chain shares that owner. Concerns outside it are separate
pure modules on an acyclic graph: below the core, `standalone-review-scope.ts` (scope,
changed-path/metadata parsing, reviewer selection), `standalone-review-model.ts`
(types and nominal brands, minted only by the core), `standalone-finding-origin.ts`,
`standalone-reviewer-capture.ts`, `standalone-transcript-admission.ts`,
`standalone-review-records.ts` (wire forms, result artifact, summary),
`standalone-refutation-panel.ts` and `standalone-refutation-completion.ts`; above it,
`standalone-review-preparation.ts` (which admits a successor only through the core's
read-only `isPreparedStandaloneSuccessor` predicate) and `standalone-review-checkpoint.ts`.
No module exports a membership registrar. Moved symbols are imported from their owners,
never re-exported through a facade.
The disposition reducer owns only its no-agent publication. Shell shared computation
is extracted **downward** into three named lower owners — `program-result.ts`
(dependency-free ProgramParse/FacadeDriveResult vocabulary), `standalone-evidence.ts`
(checkpoint-independent evidence, source observation and refutation replay) and
`standalone-disposition-source.ts` (bounded published advisory revision authentication)
— reused by successor, policy and P3 consumers. The per-program drivers in
`standalone.ts` and source authentication in `standalone-source.ts` are preserved and
consume those volumes instead of importing each other upward; no generic driver
(ADR-0005). Published interfaces remain curated around real consumers (ADR-0007).

CLI and native Claude/Pi capture preserve exact request/slot/attempt correlation.
Native capture records the shared durable `raw-transcript-captured` receipt at the
actual boundary; replay cannot fill a missing receipt from raw bytes. After a raw
write succeeds but receipt recording fails, only the actual native boundary may
reconcile a fresh delivery of the same native final/attempt. It must match a bounded
16 KiB immutable write-ahead observation and exact captured bytes, including original
request/context/correlator/payload origin. That observation is inert evidence, not a
receipt. Missing/changed evidence or any existing contradictory receipt refuses;
already-receipted duplicates remain refused. No new semantic attempt or reviewer
roster is granted. Current resume/inspection/source replay still require real receipts
and original publication.
Pi additionally requires its current-session witnesses, records the current Run when
its first exact standalone spawn is bound (before child dispatch or capture), rechecks
after asynchronous authentication, never falls back to an older Run, retires older
accepted witnesses and prunes on shutdown. Native reads do not recreate missing Run metadata.

Both current attempts are frozen/recoverable from authenticated registration and
source. If a v3 start stops after registration but before initial-batch publication,
resume idempotently publishes the frozen attempt-1 packets and reconstructs the
awaiting-results checkpoint; corrupt or conflicting evidence still refuses. Reader
projection explicitly selects v3 and pages sections/source/one predecessor archive. Fresh predecessor references name exact original packet files,
lengths/digests and decode purpose; originals remain mandatory. Earlier issued gzip
encodings remain bounded-readable without cross-compressor equality. Refutation
verifiers keep Read/Glob/Grep, not Bash: packet-bound readable views are checked at
delivery/capture and grant no independent authority.

Checkpoint-independent replay derives exact canonical v3 JSON from registered
capture evidence through LC-2 and the full current panel. Source admission additionally
compares root `result.json` and its exact publication receipt. Human counts distinguish
new/inherited/current states; `inspect --lineage` supplies full origins, decision
references and advisory inventory. No model-authored arithmetic is authority.

Completed and unfinished issued v1/v2 contracts preserve initial/resume/new-retry/
already-published-retry behavior and exact packet/result/receipt bytes. P4 schema
and generated regions are unchanged; explicit archives retain old guidance. The
pre-B4 **development-only v3 panel transport** changed before live v3 issuance;
this is not a historical v1/v2 migration or a promise to reuse those experimental
panel packets. Original Runs and archive source bytes are not rewritten.

### P3 conservation

P3 has a deliberate v3 source-reader arm, not a fabricated v2 projection. It retains
the **full exact canonical source JSON/digest**, every origin/history and original
Finding ID. Accounting uses actual still-active `surviving_critical_findings` only;
advisory/refuted/resolved rows never enter critical groups. Limited current critical
coverage refuses before checks/candidate/installable authority, even with zero
active criticals. Full-coverage zero-critical input explicitly declares not-required.

Remediation registration and installation remain **schema 2**. Operator-owned fixed
checks, fresh required structured reports, normal exit, report/journal bounds,
unchanged candidate bytes/modes, literal path staging and guarded exact-index
installation remain ADR-0008's policy. Completed remediation v1 remains read-only
historical-unknown; unfinished v1 refuses. Missing current fields never downgrade.
Actual Repair-Checked does not mutate the source's active Finding or history.

## Bounds and evidence

[Operations](../operations.md#resource-and-compatibility-boundaries) pins the actual
simultaneous limits: 512 KiB/file, 2 MiB raw source, 4096 paths/origins, 4 MiB packet
payload before byte arrays plus an exact 16 MiB canonical serialized-packet ceiling,
2 MiB/15 predecessor sections, 16 MiB retained reads and
start/submit input, 64-Run/cycle/64 MiB carried traversal controls, and 64 historical decisions
per origin/review generations/policy revisions. Response limits remain 1 MiB/depth
32/128 new drafts/4096 priors. Disposition prose is capped at 65,536 UTF-8 bytes.
Reader/native/view limits are separate; none is a whole-Run, all-reads cumulative
or whole-process decoded-heap guarantee. Simultaneous maxima may not fit together;
refuse rather than truncate or silently relax authority checks.

Unchanged schema identities:

- v2: 10,257 bytes, 12 KiB budget;
  `3ac3395301c1d38f41cd93accb19b942e832d7ebced990976335208259f40c37`.
- v3: 14,999 bytes, 16 KiB budget;
  `515ed14d0435d47da4f8299ed4f7ba9908f33c9f567051db93de84ec0017b4a2`.
- Shared rubric: 2,206 bytes;
  `4f36c09cc1e7c27e2d8ff36c86ad22c7723c1a4715bd9c198bbed40e2c2f3a6b`.

The original B4 seven-role Claude workload observed 1,506,719 production bytes,
54 scope paths, a 6,867,977-byte packet and 6,790,040-byte registration. B5 replaces
its dynamic dirty-tree selection with `standalone-native-workload.ts`'s explicit
production path roster and staged/clean committed fixture byte-conservation checks.
A focused B5 run observed 1,517,532 production bytes, 46 paths including three fixture
paths, a 6,907,243-byte packet and 6,828,446-byte registration. These are dated scripted
observations, not live review, universal capacity or a final full-suite timing
guarantee. The subsequent B5 final co-scheduled check passed 673 tests, including
both native receipt-failure recoveries and the staged/clean-workload control. That
run measured 1,518,151 production bytes, a 6,909,979-byte packet and 6,831,141-byte
registration; the workload took 10.835s. Full-root validation remains separate and
pending; these observations are development evidence, not publication authority.

Parent independent focused checks before this documentation pass: B3 core compiler
+189 tests; B3 shell compiler +17; B4 P3 compiler +27; B4 native compiler +43. The
native worker reported 1,252 co-scheduled passing tests. Counts overlap and do not
substitute for root verification. Final root verification (23/23 including all six smokes) and the single admitted
registered review/remediation are complete on the resolved merge head. The
full-project lint comparison remains consciously deferred — the round-8
deferral reason stands: the max-function-lines multi-line-signature regex blind
spot would flag currently-escaping shell functions project-wide and alter the
lint baseline. Commit/merge of this PR, publication, and the /reload cutover
are pending.

## Consequences

- Advisory-only decisions acquire immediate immutable custody without a new Agent
  or approval stage; parent policy remains DECLARED.
- Honest history requires exact predecessor/policy selection and retained original
  files. Corrupt expected publication blocks rather than guessing.
- Successor review costs a complete current roster and full prior inventory;
  it is not cached review reuse or an extra automatic review after every repair.
- No automatic previousRun, branch reconciliation, similarity matching, severity
  override, dual-snapshot execution, Wave policy change, formal planning feature,
  or other future-priority implementation is included.

## References

- [Selected P5 Plan](../../.claude/plans/2026-09-10-standalone-lineage.md)
- [Domain language](../../CONTEXT.md)
- [Operations and exact input](../operations.md#standalone-lineage-p5)
- [Review-and-fix Skill](../../skills/review-and-fix/SKILL.md)
- [ADR-0005](ADR-0005-per-program-facade-drivers.md), [ADR-0007](ADR-0007-curated-public-surface.md),
  [ADR-0008](ADR-0008-versioned-defect-family-installation-authority.md),
  [ADR-0009](ADR-0009-versioned-reviewer-protocol.md)
