# Standalone review and the reviewer protocol

This guide covers what a reviewer returns and how the engine admits it, read coverage, standalone lineage (advisory disposition and successor review), the plan design review gate, and remediation. The parent runbooks are `/review-pr`, `/review-and-fix` and `/wave-gate`; they carry only what a parent acts on. The Run Directory commands (`start`, `resume`, `decide`, `inspect`) are in [Operations](operations.md#run-directory-operations).

## Reviewer Protocol v2

Fresh standalone and Wave Gate reviews issue Reviewer Protocol v2 ([ADR-0009](adr/ADR-0009-versioned-reviewer-protocol.md)). There is no protocol flag: the engine selects v2 for every independent registration, and only an explicit [successor review](#explicit-successor-review) input selects v3. An operator never writes a reviewer payload. This section says what the engine admits, so that a refusal can be read.

**What a reviewer returns.** Every reviewer reads its issued Context Packet first. The packet's independent registration and publication joins, and its exact `reviewer-payload-schema` and `reviewer-impact-rubric` bytes, select admission; the engine never sniffs the output. The reviewer emits exactly one JSON object with `findings`: no fences, narrative, Machine Summary, tallies, new IDs or second lifecycle object. A Wave reviewer also echoes the issued packetId and generation, and assesses each prior ID exactly once, in packet order. Empty `findings` is success only when every issued prior obligation is satisfied.

**What a finding carries.**

- A critical has six fields: the claim, basis evidence, `violatedContract`, `consequence`, `truthConfidence` and `severityRationale`. Evidence may be a reproduction or a concrete execution trace; executing a repro is not universally required.
- An advisory needs a concise reason. Its basis is optional, and must be complete when given.
- Blocking needs a concrete consequence to supported behavior, to safety or authority, to explicit acceptance or verification obligations, or to safe operator use. A factual error, confidence, style, shallowness or a missing test alone is insufficient.
- Reviewer execution claims are not engine receipts. Filled fields prove neither truth, impact, reachability, execution nor semantic test adequacy.

**When a response is refused.** Admission rejects the whole response on malformed JSON, duplicate keys, a missing basis, a foreign location, a wrong binding or an incomplete prior roster. It creates no synthetic Finding and no remediation obligation. A missing or ambiguous final output gets the one retry, and attempt 2 failing terminal-blocks the slot. A transcript locator or read failure is infrastructure: the result stays unavailable, with no semantic rejection tombstone. A missing or corrupt current registration never becomes a legacy one.

**Limits.** A response is at most 1,048,576 final UTF-8 bytes, 32 nested containers, 128 new findings and 4,096 priors. These are semantic admission bounds, not pre-capture transcript limits. Separately, the shared orchestration `submit` CLI refuses raw stdin above 16 MiB before handler invocation, chunk concatenation, byte-array expansion or durable capture. Accepted strings, order and duplicates remain exact; the engine attributes IDs and derives counts. Stored, refuted, resolved, panel and remediation records retain the full basis.

**Refutation.** The default three-lens panel, complete critical-ID coverage and a strict majority decide each critical. The panel assesses an assertion with its stated preconditions, contract and consequence. A true assertion is not refuted merely because repair seems unimportant, and a surviving critical stays blocking. There is no automatic severity downgrade and no standalone severity-dispute authority.

**The Wave operator override.** `helper store-review-findings` (including `--dismiss-all`) is the explicit Wave operator override. It is separately audited. It is never an automatic fallback for failed reviewer evidence, and an override does not prove an assertion false. The direct `complete-wave-gate` helper is compatibility-only: it refuses every graph carrying `verification_manifest`. Modern corrected findings are stored first and then the exact registered Wave Gate is resumed (or `/wave-gate` is started when no registration exists), so no direct helper can bypass suite execution or invent current-workspace/Run Directory authority.

**Capture.** On Claude Code the reviewer's stop captures the exact final bytes and returns; the registered `resume` owns Wave semantic settlement. Pi keeps its native tool-call/index/agent and session-run capture binding and its run-bound short-circuit. Neither routes current reviewers into legacy concatenation or `CRITICAL_COUNT` polling.

### What a refutation verifier is issued

A verifier's task carries `LOOM_CONTEXT_PATH`, and for a schema-3 successor panel `LOOM_CONTEXT_VIEW_PATH`. The packet's `outputContract` names the lens; its one authority section (`refutation-authority` for a standalone review, `wave-refutation-authority` for a Wave Gate) carries the lens name and the findings. The lens definition is not in the packet: the verifier agent carries every lens's section, stamped from `references/review-lenses.md` by `scripts/stamp-wire-contract.ts`, and applies the one it was issued. Nothing substitutes lens text into a task.

### Read coverage (Reviewer Protocol v4)

See [ADR-0022](adr/ADR-0022-engine-observed-standalone-read-coverage.md). Every
fresh standalone review registers `readCoverage: loom-standalone-read-coverage v1`
beside the unchanged v2 payload descriptor. A reviewer's result is admitted only
after the engine itself observed that the reviewer was shown every unit of the
scope's frozen diff. Issued v2 registrations without the policy, successor v3 and
Wave Gate keep their exact admission.

- **What must be read.** Each request's packet carries `standalone-frozen-diff`:
  one unified diff per scoped file, from the review baseline (the merge base, or
  HEAD) to the exact frozen bytes. Unchanged and binary files oblige nothing. The
  issued task lists every obligated file with its unit and page counts under
  `LOOM_READ_COVERAGE: every-frozen-diff-unit`.
- **How to read it.** Append `--diff EXACT_SOURCE_PATH` to the task's
  `LOOM_CONTEXT_READ_COMMAND`, then repeat with `--offset <nextOffset>` until
  `nextOffset` is null. Pages are up to 12,000 units; other selections keep 4,096.
  Run each reader call as its own command. A piped, filtered or truncated page
  earns no credit.
- **How it is verified.** At capture, the harness transcript's tool results are
  checked line by line. Only exact reader pages whose text equals the frozen diff
  at their range count. The verified ranges are written before the transcript to
  `artifacts/read-coverage/<requestId>.json`, and the first observation of an
  attempt is kept.
- **When it refuses.** Resume and checkpoint-independent replay refuse a result
  with any unread unit through the ordinary bounded retry, and the attempt-2 task
  names every unread file and range. A capture without observed tool outputs also
  refuses ("read coverage was not observed"). Attempt 2 failing terminal-blocks the
  slot as before. Unreadable coverage evidence is infrastructure failure and
  consumes no attempt.
- **Budget.** A scope whose frozen diff exceeds 240,000 units is refused at
  `start`, before anything is registered. Partition it into explicit `--files`
  runs of at most that size. As a rule of thumb, keep each slice's `git diff`
  under about 230 KB.
- **Non-capturing harnesses.** `submit` accepts `--tool-outputs PATH`, a JSON array
  of the delivered tool-output strings in order. It is verified exactly like a
  native capture, and is refused for a Run without the policy. Claude Code and Pi
  capture natively, so a parent on either harness never needs it.

### Reading a Context Packet

All seven reviewer tasks carry a concrete `LOOM_CONTEXT_READ_COMMAND`: a shell-quoted `bun` invocation of the admitted package's `scripts/read-context-packet.ts`, with the actual immutable `LOOM_CONTEXT_PATH` and the expected request, digest, role and Skill. The reviewer runs it with Claude `Bash` or Pi `bash`; no `readContextPacket` harness tool exists. Schema 1 and schema 2 both use this reader without changing their frozen context bytes.

- **Paging.** The command first returns a bounded section index. Append `--section LABEL` to browse decoded sections or `--file EXACT_SOURCE_PATH` for frozen source text, then `--offset N --limit 4096` to continue. Text offsets count UTF-16 units; index offsets count section entries, at most 32 per page.
- **What a section shows.** Section browsing omits source contents and binary/base64 fields, and keeps binary/absent path, digest and length metadata.
- **Wave packets.** Fresh Wave v2 Task-reviewer packets carry one `wave-frozen-source` section built from the same dirty/untracked/absent artifact snapshot as `workspaceHeadSha`. Each Task packet contains only that Task's declared/modified review scope. Spec-check packets receive no source, and already-issued Wave packets stay byte-immutable.
- **Binary files.** Wave and standalone v1/v2 binary-file selection, and any invalid UTF-8, fail. Standalone v3 frozen source uses a binary representation for byte fidelity, and an explicit `--file` selection returns it when fatal UTF-8 decoding succeeds.
- **Bounds.** The 128 MiB input limit is a legacy v1/v2-selection ceiling; successor Context Packets are bounded smaller by the protocol. The 48 KiB output limit is a helper resource bound, not a change to protocol admission.
- **Safety.** The reader uses no-follow regular-file reads, fatal UTF-8, the packet parser and expected-identity checks. Missing tools or paths, unsafe filesystem entries, invalid digests or identity, and invalid page bounds fail visibly. References remain data: no execution, network, frozen-file writes, Run/state/index mutation or authority minting. Supplied expected IDs are not independent publication proof; that proof belongs to engine delivery.

### Issued schema-1 runs

Completed and unfinished issued reviewer v1 runs keep their original protocol, normalization, synthetic-shortfall behavior, IDs, retries and result bytes. Packet-first bootstrap delivers the archived role and shared fragment from `references/reviewer-protocol-v1/` at all four prefixes: initial publication, outstanding attempt-1 reissue, newly issued attempt 2, and already-published attempt-2 recovery, for standalone and registered Wave runs. A missing archive or authority fails visibly. The archives preserve baseline implementation instructions. Old packets did not freeze a full rubric or persona, so the archives are not invented original Agent inputs, and nothing is appended to or rehashed into a frozen old packet.

Remediation differs deliberately (ADR-0008): an unfinished remediation v1 run remains refused. Remediation can consume an opaque published review result v1 or v2, and a v3 source that retains the full exact source JSON and complete lineage. It preserves original IDs, the full basis and the original canonical result digest. Its selected operator checks, report freshness, accounting and installation authority are unchanged.

## Standalone lineage

A completed standalone review can be followed by a published advisory disposition, and by an explicit successor review that carries every earlier Finding forward ([ADR-0010](adr/ADR-0010-standalone-finding-lineage.md)). Use these commands only when the loaded package's admitted Runtime Revision implements schema-v3 standalone lineage. Every mutating CLI must match that loaded revision: after installing or updating Loom, reload Pi or restart the host before mutating ([runtime version skew](operations.md#pi-reports-runtime-version-skew)). A revision mismatch fails closed. It is never permission to unset admission, to switch a live session to unrelated checkout bytes, or to retrofit an issued source review.

### Immediate advisory publication

A completed standalone review has no advisory `await-user` stage. The parent
triages autonomously under operator instructions and immediately publishes its
complete decisions, even if no fix, remediation or successor will follow.
This is a separate no-agent program; it does not adjudicate criticals or prove repairs.

First obtain exact source identity and the **complete ordered** advisory inventory:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration inspect \
  --runs-root "<review-root>" --run "<completed-review-id>" --lineage
```

This emits JSON `kind: "standalone-lineage-source"`, `source`, `inventory`,
`advisoryInventory`, `snapshot`, `reviewers`, `counts` and explicit `disposition`.
Copy `source` unchanged. Each `advisoryInventory` row supplies `origin` and
`findingId`; publication entries use the **origin digest**, not the local Finding ID.
Copy every advisory in that order, including previously resolved or policy-retired
advisories. Never derive origins or counts from prose, similarity or bare IDs.

Prepare ordinary input JSON, not a registration/receipt/artifact, then invoke:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration start standalone-disposition \
  --runs-root "<policy-root>" --run "<fresh-policy-id>" < /path/to/declared-policy.json
```

Exact initial input shape (replace placeholders from inspection; expand entries to
cover the entire inventory, or use `[]` only for an actually empty inventory):

<!-- wire-example: standalone-disposition-start -->
```json
{
  "source": {"locator":"/absolute/review-root/run.review","runId":"run.review","resultDigest":"<exact-result-sha256>"},
  "record": {
    "schemaVersion": 1,
    "source": {"locator":"/absolute/review-root/run.review","runId":"run.review","resultDigest":"<exact-result-sha256>"},
    "provenance": "DECLARED",
    "revision": {"kind":"initial"},
    "entries": [{"origin":"<inspection-origin-sha256>","decision":"accepted","reason":"Concrete evidence-based policy reason."}]
  },
  "previous": null
}
```

`decision` is `accepted`, `deferred` or `dismissed`, with a non-empty reason.
Source, full advisory coverage and selected revision authenticate before destination
Run creation. The program checkpoints registered state, publishes `artifacts/disposition.json`,
checkpoints artifact-published state, records its receipt, then writes the receipt-backed
done checkpoint. `done.outcome.kind` is `standalone-disposition-published`;
read `outcome.publication` (`locator`, `runId`, `dispositionDigest`), `record` and
`receipt`. Exact repeat/resume is idempotent; conflicting bytes refuse. If interrupted,
use ordinary `resume` on that Run: exact artifact/receipt facts reconstruct progress;
a checkpoint cannot invent it. No Agent submission or user-decision action is needed.

**Correcting a disposition.** Corrections use a **fresh policy Run**, the same source and complete entries:
`record.revision = {"kind":"correction","previousDigest":"<prior-disposition-sha256>"}`
and `previous = {"locator":"/absolute/policy-root/run.prior","runId":"run.prior","dispositionDigest":"<same-prior-sha256>"}`.
The prior record must already be published for that exact source. No in-place edit,
automatic latest revision or branch join; explicit forks remain distinct.

**Importing a historical decision.** A present-day historical attestation uses `previous: null` and
`record.revision = {"kind":"historical-import","proseReference":"<exact-retained-reference>","prose":"<exact retained prose text>"}`.
Keep the original prose bytes/reference and explicitly map the complete advisory
inventory; the engine does not infer IDs or decisions from prose. The resulting
record is **DECLARED now**, not evidence that a historical decision was recorded then.
Missing historical policy is `historical-decision-unavailable`, not a native empty
record. An expected current record that is missing/corrupt is an error, never that
historical-absence arm. Unselected inspection does not search for policy or prove
that no published revision exists.

Inspect one exact revision together with its source:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration inspect \
  --runs-root "<review-root>" --run "<completed-review-id>" --lineage \
  --disposition "/absolute/policy-root/run.policy" \
  --disposition-run "run.policy" --disposition-digest "<exact-disposition-sha256>"
```

All three policy flags are required together. The projection retains every selected
revision/reason and Finding decision reference; it is not new authority.

### Explicit successor review

No slash-command successor flag or automatic `previousRun` exists. When a fresh
successor review is explicitly wanted, supply the lower-level start input:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration start standalone-review \
  --runs-root "<successor-root>" --run "<fresh-successor-id>" < /path/to/successor.json
```

<!-- wire-example: standalone-review-start -->
```json
{
  "schemaVersion": 3,
  "kind": "all",
  "files": ["src/example.ts", "tests/example.test.ts"],
  "dryRun": false,
  "successor": {
    "source": {"locator":"/absolute/review-root/run.review","runId":"run.review","resultDigest":"<exact-result-sha256>"},
    "disposition": {
      "kind": "selected-record",
      "publication": {"locator":"/absolute/policy-root/run.policy","runId":"run.policy","dispositionDigest":"<exact-disposition-sha256>"}
    }
  }
}
```

**Input rules.** The only alternate policy arm is explicit `{"kind":"historical-decision-unavailable"}`
for genuinely unavailable historical policy—not fallback after selected-record failure.
`files` must be non-empty, canonical, explicit and ordered; `dryRun` must be false.
All predecessor paths and reviewer roles must remain; scope/roster may expand, never
silently narrow. Include relevant dependencies/configuration/contracts explicitly.
Role, model and request provenance remain separate; there is no live transitive
source lane. Preflight refuses unsupported bounds/scope/roles before issuance.

**What the engine freezes.** The engine observes exact source bytes, digest/length and normalized Git executable
mode (`100644`/`100755`), or anchored-safe observed absence, before freezing both
current attempts. Absence validates every extant parent without following symlinks.
HEAD-derived commands are pinned to their captured revision. Identical porcelain-v2
HEAD/index/worktree status witnesses bracket changed-path, additions, and reviewer
selection derivation and remain stable across the final whole-scope stat/absence pass;
any disagreement rejects before authority is encoded.
Historical v1/v2 modes remain unknown (`null`); genuinely missing old source facts
stay `historical-unknown`. Missing expected current source never becomes historical
absence. Same HEAD is not byte equality; different HEAD is not repair. Deleted or
renamed files keep the original Finding location and must not disappear from scope.

**What reviewers return.** Execute only returned requests, then `resume` as usual. Every current reviewer
assesses **all** inherited origins exactly once in issued order: active, refuted,
resolved and policy-retired. V3 final JSON contains `schemaVersion:3`,
`kind:"standalone-successor-review"`, issued `lineageDigest`/`snapshotDigest`,
`priorAssessments` and `findings` entries shaped as `{draft,relation}`. New drafts
retain the Reviewer Protocol v2 evidence fields; relations are `independent` or `distinct-related` with an
exact prior origin and distinction. Reviewers never mint IDs or rewrite old claims.

**Resolving an inherited Finding.** Resolution requires every expected reviewer to say `repaired`, give a reason and
identify a relevant scoped implementation change against the same frozen snapshot.
Known unchanged input cannot justify repair; unknown historical comparison is
retained as unknown, not an observed change. `still-present` or `not-assessable`
is valid evidence that prevents resolution; missing/duplicate/reordered/foreign or
malformed rows refuse the entire response. Semantic rejection gets only attempt 2;
infrastructure unavailability stays on the same attempt. No synthetic Finding.
Repair-Checked, passing tests, hashes and formally phrased assertions are not
semantic proof or automatic resolution.

**Retained and reopened decisions.** `retained` names an exact prior decision digest. `reopen` supplies the exact prior
decision/refutation/resolution reference plus full new evidence, changed conditions
or contradiction of the old reason, current applicability and evidence limits.
Only **new criticals and explicit critical reopening** reach a fresh full bound
Refutation Panel under the unchanged strict-majority rule. Already-upheld unchanged
criticals stay active without a second panel. Original IDs, per-role ordinal
high-water across retired history, assertion/severity/evidence, old votes/reasons
and all generations remain. Advisory reopening never promotes severity; changed
parent policy needs a later disposition publication. There is no parent critical
override, similarity merge, multi-predecessor reconciliation or review reuse.
Do not add another reviewer roster merely because remediation/rerun occurred.

### Native delivery, replay and remediation

**Capture.** Claude and Pi capture exact correlated final bytes and durable
`raw-transcript-captured` receipts at the native boundary. Missing/foreign receipts
refuse; replay cannot manufacture provenance from raw files. If the native raw write
succeeded but receipt recording failed, the current capture boundary can reconcile
only a newly delivered **same native final** at the same semantic attempt. It must
match the immutable write-ahead observation (request/context/correlator/payload origin)
and exact already-written bytes. Missing observation, changed identity/bytes, a
rejection or any existing/contradictory receipt refuses; ordinary already-receipted
duplicates remain refused. Resume/replay alone cannot synthesize this recovery, and
no additional Agent roster or semantic attempt is authorized. Retain the failure
evidence; never hand-write an observation or receipt. Missing expected Run metadata
is not recreated by native reads. Pi adds current-session process witnesses:
the first exact standalone spawn binding selects the current Run for the root before
capture, rejection never falls back, acceptance is idempotent and retires older
witnesses, and shutdown prunes the session.

**Reading the packet.** Issued `LOOM_CONTEXT_READ_COMMAND` selects v3 with `--purpose standalone-successor`.
Use bounded `--section`, `--file`, `--offset`/`--limit` pages, and explicit
`--archive LABEL --archive-purpose v1-v2|standalone-successor` for predecessor packets.
Fresh references retain exact original published packet bytes/path/length/digest;
original files remain mandatory. Earlier frozen gzip encoding remains readable
without recompression equality. Refutation verifiers have Read, not Bash, and receive
a packet-bound `LOOM_CONTEXT_VIEW_PATH`; views are rechecked at delivery/capture,
not result authority. See [native context instructions](standalone-successor-context.md).

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration inspect \
  --runs-root "<successor-root>" --run "<successor-id>" --replay
```

**Replay.** Read-only replay returns `{"kind":"standalone-evidence-replay","digest":"...","json":"..."}`
from exact registered CLI/native capture receipts, without trusting or rewriting
that Run's result/checkpoint. It is not publication: normal source authentication
also compares actual root `result.json` and its exact publication receipt.
Human `inspect` derives **new vs inherited**, current dispositions and critical
coverage from the canonical v3 result, never from parent arithmetic or panel counts.
`--json` keeps the general inspection shape; `--lineage` is the complete source/policy
projection. Neither results nor current origins contain their own result digest:
current origins bind issued Run/request/transcript/ordinal; enclosing publication
supplies result identity downstream. Contexts bind prepared lineage, not a future
registration digest or future policy record.

**Remediation after a successor review.** Remediation consumes actual active `surviving_critical_findings`, never just new/panel work.
Any limited current critical coverage blocks before checks/candidate/installable
authority, even with zero active criticals. Full-coverage zero-critical sources use
explicit `defectFamily:{"kind":"not-required"}`. V3 retains the entire byte-exact
source JSON/digest, origins and histories through schema-2 remediation; no fabricated
v2 source. Fixed operator checks, fresh reports, candidate bytes/modes, literal
staging and guarded exact-index installation are unchanged. Remediation does not rewrite
source resolution status.

### Resource and compatibility boundaries

| Boundary | Limit |
|---|---:|
| Source regular file / aggregate raw bytes / paths | 512 KiB / 2 MiB / 4096 |
| Prepared lineage + current source + predecessor-section payload | 4 MiB before packet byte arrays |
| Canonical serialized successor packet | 16 MiB exact pre-issuance ceiling |
| Retained predecessor-section payload | 2 MiB, at most 15 sections |
| Exact predecessor packet observations | 64 MiB, charged to carried traversal allowance |
| Individual retained context/registration/result/source read; start/submit stdin | 16 MiB |
| Predecessor traversal | 64 Runs, cycle refusal; 64 MiB carried primary/artifact observations |
| Origins / decisions per origin / retained review generations | 4096 / 64 / 64 |
| Disposition revision chain / retained import prose | 64 revisions / 65,536 UTF-8 bytes |
| Reviewer response / nesting / new drafts / prior rows | 1 MiB / 32 / 128 / 4096 |
| Issued schema budgets (v2 / v3) | 12 KiB / 16 KiB |
| Current reader packet / one archive expansion | 16 MiB / 16 MiB |
| Reader page / index / encoded output | 4096 UTF-16 units / 32 entries / 48 KiB |
| Current Claude transcript before decoding | 16 MiB |
| Current Pi decoded transcript before adapter copying | 16 MiB text/key bytes, 65,536 values, depth 32 |
| Current panel readable view | 16 MiB; 4096 UTF-16-unit display lines, never split inside a Unicode surrogate pair |

Request reads also cap at 16 KiB/128 entries; captured slots at 128 with bounded
per-slot enumeration. Native write-ahead observations cap at 16 KiB and are inert
evidence, not capture receipts or replay authority. CLI submit and retained raw
capture reads cap at 16 MiB; semantic admission still caps at 1 MiB. Disposition traversal has a separate 64 MiB read allowance.
These simultaneous limits do not promise that all maxima fit together. Refuse,
never truncate. They are **not** an all-reads cumulative, whole-Run or whole-process
heap bound; JSON, byte arrays, repeated authenticated reads and native input can
allocate more. Legacy reader ceiling remains 128 MiB; the remediation report and journal budgets
([Enrolling a critical-repair check](verification.md#enrolling-a-critical-repair-check)) are unchanged.

Independent standalone and Wave issuance remain v2. V1/v2 initial publication,
outstanding attempt 1, new attempt 2, already-published attempt-2 recovery and exact
packet/result/receipt history remain under their issued contracts.

## Decompose is blocked on the plan design review

A decompose spawn is refused with `plan-design-review (<plan> has no accepted design review: ...)` or `plan-design-review (<plan> changed after its design review was accepted: reviewed sha256 <a>, now <b>; ...)`. The State File's `plan_design_review` is `required`, or `accepted` for bytes the plan no longer has ([ADR-0070](adr/ADR-0070-the-plan-design-review-gates-decompose.md)).

**Open it.** From the repository root, run a Standalone Review of kind `plan-design` whose `files` is exactly the plan, drive it to `done`, publish a disposition if it has advisories ([above](#immediate-advisory-publication)), then:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper accept-plan-design-review \
  --runs-root "<review-root>" --run "<completed-review-id>" \
  [--disposition "<absolute disposition Run directory>" --disposition-run "<its Run id>" --disposition-digest "<its disposition sha256>"]
```

The full sequence is the [`/loom` Phase 3.6 runbook](../references/loom/plan-design-review-runbook.md). The helper reads the plan this State File names and everything else from the authenticated Run Directory; it takes no claim from the caller beyond which Run and which disposition to read.

**What a refusal means.** Every refusal starts `accept-plan-design-review:` and names one cause:

| Message says | Do |
| --- | --- |
| the review's kind is not exactly `["plan-design"]` | Start a `plan-design` review. A `types` or `architecture` review of the plan is not one. |
| the frozen scope is not exactly the plan | Start the review with `files` naming only the plan, from the repository root. |
| the review ran without a reviewer, or without the read obligation | Start a fresh `plan-design` review. |
| the plan changed after it was reviewed | Start a fresh review of the edited plan. |
| N critical finding(s) survived refutation | Edit the plan to resolve them, then start a fresh review. There is no override and no successor review. |
| N advisory finding(s) have no published disposition | Publish a `standalone-disposition` for this review and pass the three `--disposition*` flags. |
| the named disposition is not a published disposition of this review | Pass the disposition published against this exact review result. |

**Not doing the review.** `init-state --skip-plan-design-review` records `{"status":"not-required","reason":"skipped"}` when the orchestration starts. There is no flag that skips it later. A State File initialized before the gate existed has no `plan_design_review` field and is not gated; running the review and the helper on it records `accepted` and turns the digest binding on.

**Population asks it too.** `populate-task-graph` refuses first population (a graph still in `decompose`) with `populate-task-graph: TaskGraph population requires plan-design-review (...)`, the same requirement the decompose spawn names, so a payload written by hand is held to it as well. Open it the same way.

**The plan moved during acceptance.** `accept-plan-design-review` re-hashes the plan under the State File lock. If the plan was edited after the review was judged it refuses with `the plan changed while its review was being accepted`; if the graph was re-pointed at another plan it refuses with `the task graph names a different plan than the one judged`. Run the helper again; an edited plan needs a fresh review.

**Known limits.** Execute is not gated: neither an execute spawn nor re-population in execute asks the gate. The record is not re-proved against the Run Directory after acceptance.

## Remediation and Git safety

`/review-and-fix` must use the registered remediation program. Standalone remediation itself does **not** require a feature TaskGraph. Every new start is schema v2 and requires `defectFamily`, even when the source review has zero surviving criticals. Use the canonical Skill runbook for the complete input shape; do not hand-write a registration, checkpoint, event, or result.

Before creating or claiming the requested Run Directory, start preflight authenticates the completed source review and its published result, parses complete critical-Finding accounting, selects any required operator checks, and captures the candidate baseline. Invalid input returns an ordinary start error and creates **no run**. Once preflight succeeds, the engine creates and registers the run; any later process/report failure, candidate drift, path audit failure, or installation refusal returns a durable `blocked` action for that registered run. Do not describe these two cases as the same recovery state.

The program rejects:

- a missing, duplicate, foreign, advisory, or refuted Finding ID in critical accounting;
- unresolved or out-of-scope critical/sibling dispositions (valid declarations, but installation blockers);
- dirty paths absent from review scope and explicit support paths;
- Loom state, review, panel, and Run Directory evidence;
- unrelated pre-staged work;
- symlinks or non-canonical repository-relative paths at authority boundaries;
- staged sets that differ from the audited set;
- selected checks without a fresh required-file JUnit/Vitest report containing at least one executed and zero failed tests;
- candidate byte, mode, path-roster, HEAD, or index drift through execution and installation.

A failed check or changed candidate is immutable evidence for that run; start a fresh remediation run after correcting the cause. Removing unrelated dirty/staged state also changes the registered candidate, so it requires a fresh run rather than reuse of the old registration. A registered blocked run may be resumed idempotently for diagnosis or after a transient external condition only when source, registration, and candidate authority remain byte-identical. If remediation itself needs an omitted support path, the immutable registration cannot gain it: start a fresh run that names it and retain/abandon the older run as evidence.

The engine stages into a temporary index with literal path semantics, verifies that index, and installs it under the real index lock only after an opaque installable Defect-Family Assessment exists. In the external schema-v2 `done` action, `outcome.kind` is `remediation-installed`, `outcome.installation` is the actual receipt returned by the Git adapter, and `outcome.defectFamilyAssessment` is the authenticated assessment. Read that action; never construct it. For zero surviving criticals, the assessment status is `not-required`; for critical repairs it is `repair-checked`. Neither means proven defect-family closure or a `ResolvedFinding`. Commit only after this `done` action. Never hand-stage, and never force-push.

A Declared Repair Group does not replace or mint Finding IDs. Compatible sibling reuse across distinct groups is allowed; duplicate sibling paths inside one group or conflicting cross-group statuses are rejected. `repair-checked` means the repaired-state checks were engine-observed on unchanged candidate bytes. It does not prove the declared family, root cause, invariant, sibling completeness, or Historical RED, and it is not `ResolvedFinding` status. An operator-owned fixed command can still fabricate a syntactically valid new report; structured fresh engine observations are not semantic proof.

Completed schema-v1 remediation runs remain read-only and inspect as `done — historical P3 assessment unknown`; their external assessment is `historical-unknown`. Reading/resuming that history returns the existing receipt, never reinstalls the index or grants current installation authority. An unfinished schema-v1 run is blocked and must be replaced by a fresh schema-v2 run. Missing v2 fields never fall back to v1. The source Standalone Review Run retains its own schema and immutable publication; versioning remediation does not rewrite or invalidate that source history.

Completed-v2 replay parses both checkpoint audit-path arrays before assessing retained observations. Missing or malformed arrays produce `remediation checkpoint audit paths are missing or malformed`, not invented empty-path evidence. If installation succeeds but checkpoint recording fails, preserve the explicit installed-index diagnostic and actual receipt: that failure does not mean rollback or “nothing was installed.” Do not hand-repair the checkpoint or reinstall from its prose; use read-only inspection and retain the interrupted evidence.

**Runtime selection:** the [standalone lineage](#standalone-lineage) rule applies here too. Every mutating CLI must present the exact Runtime Revision admitted by the loaded extension; revision skew fails closed and must never be bypassed by unsetting admission variables. Use matching-runtime disposable fixtures for feature-checkout mutation experiments. Do not retrofit newly available records into an already-issued source review. Reviewer source version does not select remediation version: the remediation schema-2 command, report and install policy remains separate. Development checks are not registered installation receipts.

## Archived protocol material

History kept for audit. Nothing in this section is an operating instruction.

**Historical goldens.** The two completed historical goldens retain **90 exact logical files,
20,250,407 bytes**, in two lossless gzip packs totaling **3,395,759 bytes**.
Every decoded path/length/hash is independently checked against the unchanged
original inventory. No receipt is newly authored and original anchoring metadata
is untouched. Production pure parsers replay those bytes through in-memory
resolvers: semantic/result-byte compatibility, **not relocated native filesystem
admission**. Separate legitimate disposable fixtures exercise both native adapters,
publication/reload/witness replay and actual remediation repair-check/index installation.
Scripted basis is not a real product defect or semantic proof.

**Reviewer Protocol v2 implementation evidence.** The early inherited checkout-cwd CLI calls and mismatched fixture handshakes of that
implementation are not positive native evidence. Corrected tests use disposable cwd and explicit
matching child-only runtime identity with `PI_CODING_AGENT:true`; final native and remediation
checks use the actual source loader and guarded fixture installation. The bounded
scheduler-only yield in `machine-purity.test.ts` changes no audit assertion or
capability grant. The normal root verify process-environment policy is unchanged
and is not substituted for independently admitted native evidence.

**The schema-2 reviewer guidance archive.** The former references/reviewer-protocol-v2/ directory held exact copies of the seven reviewer agents, the verifier and the generated wire fragment as they were at commit `96153edc3dd755b4ac648ed48920b6670753c5a6`. Nothing in the engine, Pi extension, scripts or hooks read it, so it is not kept in the tree. A schema-2 request is governed by its own packet's frozen schema and rubric. To reproduce a file, run `git show 96153edc3dd755b4ac648ed48920b6670753c5a6:<path>` with a path from this list and compare its SHA-256:

```text
e3523e36f18751a9762b94409a63e4bb7a9b06aa8c6f89cd8f223f37a0d6f482  agents/architecture-tech-lead.md
9c20d01da79ee344d7801149f79c8a560366c7610d01b15fa5c375873f172850  agents/code-reviewer.md
5b5deeaaf2850aae24c9b29ee4df790c9e836a1a8e8ac294aee0c53f3003f821  agents/code-simplifier.md
cabf2206cbace0107ead4eba4d002fc1f2ca08d4d095fd4007eeb67057ff79a9  agents/comment-analyzer.md
4da60144489ff12f8c49a9788e13663e33d8c3b322d5af49e85415cb0194c834  agents/pr-test-analyzer.md
e4bfbece88d39c675cb99dede874c237d2a2480e8c8035448273ae53b7875a43  agents/silent-failure-hunter.md
7620a4596cd96175a93adbd38432e52ab6dd233dcd93e303329cf9cfea69a6ce  agents/type-design-analyzer.md
7fc7c28ea029ffaf9760423df98aff82eadb49235bc48320c6c2d3ff91bf75e6  agents/_shared/wire-contract.md
5e1e1f1383ece0f189186c8f232ebeebd15bb61b244394b1b206628488594ff0  agents/review-verifier-agent.md
```

The schema-1 archive, `references/reviewer-protocol-v1/`, stays: the engine names its files in every schema-1 reviewer task and refuses to issue one without them.
