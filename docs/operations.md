# Operating and developing Loom

This guide covers status, persisted artifacts, recovery, validation, and contributor commands. For lifecycle semantics, read [Workflows](workflows.md); for module boundaries, read [Architecture](architecture.md).

## Prerequisites

- Linux or macOS 13+ for the existing runtime (`/proc/self/fd` descriptor-relative authority on Linux; `O_NOFOLLOW_ANY` on macOS, with older Darwin kernels refused at startup). **Strict critical-remediation report reset works on both**: Linux unlinks through the retained parent descriptor; macOS re-proves the parent path (`O_NOFOLLOW_ANY` + identity) immediately before the unlink, refusing a planted symlink with ELOOP. Darwin retains the documented proof-to-use gap shared by every anchored leaf mutation. This does not change zero-critical remediation or Wave behavior.
- Bun (engine runtime and tests)
- Git
- Claude Code or Pi
- GitHub CLI for `/loom`’s issue tracking and optional push/PR operations

Run commands from the repository being orchestrated unless a command explicitly changes into Loom’s `engine/` directory.

## Canonical status

Prefer the engine-derived status over hand-written `jq` readiness checks:

```bash
bun "$LOOM_PLUGIN_ROOT/engine/src/cli.ts" helper orchestration status \
  --runs-root ".claude/reviews/wave-gate-runs"
bun "$LOOM_PLUGIN_ROOT/engine/src/cli.ts" helper orchestration status --json \
  --runs-root ".claude/reviews/wave-gate-runs"
```

Under Claude Code, command source uses `${CLAUDE_PLUGIN_ROOT}`; under Pi, rendered resources replace that token and export `LOOM_PLUGIN_ROOT` for diagnostics.

Both renderers project one `LoomStatus` value. Status reports:

- active Phase and Wave;
- exhaustive Task counts;
- failed proof obligations;
- test readiness;
- Wave completion-suite outcome and independent `projectVerificationCoverage`;
- Review Run roster gaps and evidence failures;
- active/advisory/resolved/refuted Finding counts;
- whether a Refutation Panel is needed;
- Wave Gate completion eligibility;
- exactly one next action and all reasons.

Unreadable or malformed authority is represented as `unavailable` and leads to `blocked`; status never fabricates empty/ready values. Status probes the conventional Wave Gate runs root by default; pass `--runs-root` when the active run was started under a different root. A missing active directory is reported as orphaned, never as a healthy suspended run.

Modern completion-suite readiness (`required`, `accepted`, `rejected`, or `stale`) includes `projectVerificationCoverage`. `configured` carries non-empty sorted `checkIds`, not a pass. `not-configured` distinguishes `engine-default` (source absent at population), `empty-operator-manifest` (explicit zero project checks), and `historical-unknown` (archived reserved-only receipt without source provenance). Reserved-only suites remain eligible to advance when the existing gates pass; report “Reserved checks accepted; Project verification NOT CONFIGURED,” not “project verification passed.” Completed schema-v2 coverage comes from the archived receipt roster, never today's manifest. `legacy-unavailable` remains unavailable without invented coverage. These are read-model facts, not new persisted authority or waivers.

Raw state inspection remains useful for diagnosis, but it is not gate logic:

```bash
jq '.' .claude/state/active_task_graph.json
jq '.tasks[] | {id, wave, status, proof, review_status}' \
  .claude/state/active_task_graph.json
```

Use `.pi/state/active_task_graph.json` under Pi.

## Run Directory operations

Registered programs require a fresh directory that is a direct child of the supplied runs root. A nested path or unrelated basename is rejected.

Typical roots:

| Program | Conventional root |
|---|---|
| Wave Gate | `.claude/reviews/wave-gate-runs/` |
| Standalone review/remediation | `.claude/reviews/review-and-fix-runs/` |
| Architecture panel evidence | `.claude/specs/<slug>/panel-runs/` |

Create the exact root and a fresh `run.*` child. Never reuse a completed or blocked run.

### Registered program protocol

```bash
# Start with program-specific JSON on stdin
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration start <program> \
  --runs-root <root> --run <fresh-direct-child>

# After a returned spawn batch finishes
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration resume \
  --runs-root <root> --run <same-child>

# Supply a requested user decision
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration decide \
  --runs-root <root> --run <same-child> --request <decision-id>
```

`resume` is idempotent. Execute only the returned `spawn-batch`, `await-user`, `blocked`, or `done` action. Do not build request lists, Context Packets, verdict manifests, transcript files, model choices, or result artifacts by hand.

The façade also exposes `submit` and `correlate` for transport integration and compatibility. Normal Pi and Claude Code operation records native correlations and captures final bytes automatically. `complete` remains a compatibility adapter for historical panel callers; deterministic operations are executed internally in new façade runs.

### Inspecting one run

`status` answers “where is the graph”; `inspect` answers “what state is this run in, and is it recoverable or stale?”. It is a pure read — it advances nothing.

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration inspect \
  --runs-root <root> --run <run-directory> [--json]
```

It reports the registered program, the machine state read through that program’s own checkpoint shape, every issued slot with its attempt, capture status and the diagnostic that refused it, the event tail, and any abandonment marker. Facts it cannot read are reported as `unavailable` with the cause, never defaulted — so an unreadable checkpoint is distinguishable from a run that never wrote one. Prefer it over hand-reading `authority.json`, `program.json`, `checkpoint.json`, and `events/`. Like `status`, it stays available during a Pi runtime-revision skew, because it is exactly what diagnosing that skew needs.

For standalone review, `inspect` calls `inspectStandaloneFacade`, re-proving
independent registration, issued protocol, publication, checkpoint and actual
result/receipt bytes. Only an authenticated done result gets
`renderStandaloneReviewSummary`: emitted/admitted counts, after-refutation counts,
and escaped rows with IDs, reviewers, locations, claims and full current
basis/reason. The canonical result is `result.json` at the Run Directory root,
not `artifacts/result.json`. JSON inspection retains its existing shape; no
summary artifact or model-authored arithmetic becomes authority.

### Retiring a superseded run

Run directories are never deleted — they hold the evidence. When a newer run replaces one, record it so the directory listing stays honest:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration abandon \
  --runs-root <root> --run <retired-run> \
  --superseded-by <replacement-run> \
  --reason "<why this run was retired>"
```

The marker removes nothing. It is written once and is immutable: an identical repeat succeeds, a different one is refused, a run may not supersede itself, and the replacement must already exist as a direct child of the same runs root. Afterwards `inspect` still reads the run’s evidence, but every operation that would advance it — `resume`, `submit`, `correlate`, `decide`, `restart`, `complete` — refuses, and no recovery can adopt it as a pristine replacement. `--superseded-by` is optional; omit it when a run is retired without a successor.

### Pi batch limit

Pi’s native subagent transport accepts at most eight requests per call. Partition a larger engine-issued batch into ordered chunks of at most eight without changing any request. Resume only after all chunks finish.

## Reviewer Protocol v2

**P4 status:** merged as `96153ed` on 2026-09-10; publication and loaded-runtime
reload were verified. See [ADR-0009](adr/ADR-0009-versioned-reviewer-protocol.md).
P5 successor contracts are merged (PR #51) with review and remediation
complete; publication and the /reload cutover happen after merge; see
[Standalone lineage](#standalone-lineage-p5).

Fresh independent standalone/Wave registrations select v2 internally. There is no
independent-review protocol flag; only the explicit P5 successor input selects v3. Every reviewer reads the issued Context Packet first: its independent
registration/publication joins, exact `reviewer-payload-schema` and
`reviewer-impact-rubric` bytes select admission, never output sniffing. Emit exactly
one JSON object with `findings`, no fences, narrative, Machine Summary, tallies,
new IDs, or second lifecycle object. Wave additionally echoes issued packetId and
generation and assesses each prior ID exactly once in packet order. Empty findings
is explicit success only with all issued prior obligations satisfied.

A critical's six fields are claim plus basis evidence, violatedContract,
consequence, truthConfidence, and severityRationale. Evidence may be reproduction
or concrete execution trace; executing a repro is not universally required.
Advisories require a concise reason; optional basis must be complete. Reviewer
execution claims are not engine receipts. Blocking requires a concrete consequence
to supported behavior, safety/authority, explicit acceptance/verification
obligations, or safe operator use. Factual error, confidence, style, shallowness,
or a missing test alone is insufficient. Filled fields prove neither truth,
impact, reachability, execution, nor semantic test adequacy.

Current admission rejects the whole response on malformed JSON, duplicate keys,
missing basis, foreign location, wrong binding or incomplete prior roster. It
creates no synthetic Finding or P3 obligation. Limits include 1,048,576 final UTF-8
bytes, 32 containers, 128 new findings and 4,096 priors; these are semantic
admission bounds, not pre-capture transcript limits. The shared orchestration
`submit` CLI separately refuses raw stdin above 16 MiB before handler invocation,
chunk concatenation, byte-array expansion, or durable capture. Accepted
strings/order/duplicates remain exact; the engine attributes IDs and
derives counts. Stored/refuted/resolved/panel/P3 records retain full basis.

The existing default three-lens panel, complete critical-ID coverage and strict
majority are unchanged. It assesses assertions including their stated preconditions,
contract and consequence. A true assertion is not refuted merely because repair
seems unimportant. A surviving critical stays blocking. There is no automatic
severity downgrade or new standalone severity-dispute authority. The old explicit
Wave `helper store-review-findings` operator override (including `--dismiss-all`)
is unchanged, separately audited, and **never automatic fallback** for failed
reviewer evidence; an operator override does not prove an assertion false.

Claude current reviewer stop captures exact final bytes then returns; registered
resume owns Wave semantic settlement. Pi retains its native tool-call/index/agent
and session-run capture binding and run-bound short-circuit. Neither routes current
reviewers into legacy concatenation or CRITICAL_COUNT polling. Missing/ambiguous
final output gets only the existing retry and terminal-blocks attempt 2; current
transcript locator/read infrastructure failure stays unavailable without a semantic
rejection tombstone. Missing/corrupt current registration cannot become legacy.

### Historical reviewer evidence

Completed **and unfinished issued reviewer v1** runs keep their original protocol,
normalization, synthetic-shortfall behavior, IDs, retries and result bytes.
All seven reviewer tasks carry a concrete `LOOM_CONTEXT_READ_COMMAND`: a shell-quoted
`bun` invocation of the admitted package's `scripts/read-context-packet.ts`, with
the actual immutable `LOOM_CONTEXT_PATH` and expected request/digest/role/Skill.
Run it with Claude `Bash` or Pi `bash`; no `readContextPacket` harness tool exists.
The command first returns a bounded section index. Append `--section LABEL` to
browse decoded sections or `--file EXACT_SOURCE_PATH` for frozen standalone source
text, then `--offset N --limit 4096` to continue. Text offsets count UTF-16 units;
index offsets count section entries (at most 32 per page). Section browsing omits
source contents and binary/base64 fields. V1/v2 binary-file selection and any
invalid UTF-8 fail; v3 frozen source uses a binary representation for byte fidelity,
but explicit `--file` selection returns it when fatal UTF-8 decoding succeeds.
The helper uses existing no-follow regular-file reads, fatal UTF-8, the packet
parser and expected identity checks. Its 128 MiB input limit is a legacy
v1/v2-selection ceiling (successor Context Packets are already bounded smaller
by the protocol) and the 48 KiB output limit is a helper resource bound, not a
change to protocol admission. Missing tools/paths,
unsafe filesystem entries, invalid digests/identity or page bounds fail visibly.
References remain data: no execution, network, frozen-file writes, Run/state/index
mutation, or authority minting. Supplied expected IDs are not independent
publication proof; that proof belongs to engine delivery. Both v1 and v2 use
this helper without changing their frozen context bytes.

Packet-first bootstrap delivers archived role plus shared fragment from
`references/reviewer-protocol-v1/` at all four prefixes: initial publication,
outstanding attempt-1 reissue, newly issued attempt 2, and already-published
attempt-2 recovery, for standalone and registered Wave. Missing archive/authority
fails visibly. Archives preserve baseline implementation instructions; old packets
did not freeze a full rubric/persona, so these are not invented original Agent
inputs. Nothing is appended to or rehashed into frozen old packets.

This differs deliberately from ADR-0008: unfinished **remediation v1** remains
refused. P3 can consume an opaque published review result v1 or v2, and P5 adds a deliberate
v3 source arm retaining the full exact source JSON and complete lineage. It preserves
original IDs, full basis and the original canonical result digest. Its selected
operator checks, report freshness, accounting and installation authority are unchanged.

The two completed historical goldens retain **90 exact logical files,
20,250,407 bytes**, in two lossless gzip packs totaling **3,395,759 bytes**.
Every decoded path/length/hash is independently checked against the unchanged
original inventory. No receipt is newly authored and original anchoring metadata
is untouched. Production pure parsers replay those bytes through in-memory
resolvers: semantic/result-byte compatibility, **not relocated native filesystem
admission**. Separate legitimate disposable fixtures exercise both native adapters,
publication/reload/witness replay and actual P3 repair-check/index installation.
Scripted basis is not a real product defect or semantic proof.

### P4 implementation evidence limitations

P4 B5's early inherited checkout-cwd CLI calls and mismatched fixture handshakes are
not positive native evidence. Corrected tests use disposable cwd and explicit
matching child-only runtime identity with `PI_CODING_AGENT:true`; final native/P3
checks use the actual source loader and guarded fixture installation. The bounded
scheduler-only yield in `machine-purity.test.ts` changes no audit assertion or
capability grant. The normal root verify process-environment policy is unchanged
and is not substituted for independently admitted native evidence.

## Standalone lineage (P5)

**Availability and bootstrap:** use these commands only when the loaded package's
admitted Runtime Revision implements schema-v3 standalone lineage. Every mutating
CLI must match that loaded revision; after installing or updating Loom, reload Pi
(or restart the host) before mutation. A revision mismatch fails closed and is never
permission to unset admission, switch a live session to unrelated checkout bytes,
or retrofit an issued source review. Dated rollout evidence belongs in ADR-0010 and
the remediation plans, not this operating contract.

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

Corrections use a **fresh policy Run**, the same source and complete entries:
`record.revision = {"kind":"correction","previousDigest":"<prior-disposition-sha256>"}`
and `previous = {"locator":"/absolute/policy-root/run.prior","runId":"run.prior","dispositionDigest":"<same-prior-sha256>"}`.
The prior record must already be published for that exact source. No in-place edit,
automatic latest revision or branch join; explicit forks remain distinct.

A present-day historical attestation uses `previous: null` and
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

The only alternate policy arm is explicit `{"kind":"historical-decision-unavailable"}`
for genuinely unavailable historical policy—not fallback after selected-record failure.
`files` must be non-empty, canonical, explicit and ordered; `dryRun` must be false.
All predecessor paths and reviewer roles must remain; scope/roster may expand, never
silently narrow. Include relevant dependencies/configuration/contracts explicitly.
Role, model and request provenance remain separate; there is no live transitive
source lane. Preflight refuses unsupported bounds/scope/roles before issuance.

The engine observes exact source bytes, digest/length and normalized Git executable
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

Execute only returned requests, then `resume` as usual. Every current reviewer
assesses **all** inherited origins exactly once in issued order: active, refuted,
resolved and policy-retired. V3 final JSON contains `schemaVersion:3`,
`kind:"standalone-successor-review"`, issued `lineageDigest`/`snapshotDigest`,
`priorAssessments` and `findings` entries shaped as `{draft,relation}`. New drafts
retain P4 v2 evidence; relations are `independent` or `distinct-related` with an
exact prior origin and distinction. Reviewers never mint IDs or rewrite old claims.

Resolution requires every expected reviewer to say `repaired`, give a reason and
identify a relevant scoped implementation change against the same frozen snapshot.
Known unchanged input cannot justify repair; unknown historical comparison is
retained as unknown, not an observed change. `still-present` or `not-assessable`
is valid evidence that prevents resolution; missing/duplicate/reordered/foreign or
malformed rows refuse the entire response. Semantic rejection gets only attempt 2;
infrastructure unavailability stays on the same attempt. No synthetic Finding.
Repair-Checked, passing tests, hashes and formally phrased assertions are not
semantic proof or automatic resolution.

`retained` names an exact prior decision digest. `reopen` supplies the exact prior
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

### Native delivery, replay and P3

Claude and Pi capture exact correlated final bytes and durable
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

Issued `LOOM_CONTEXT_READ_COMMAND` selects v3 with `--purpose standalone-successor`.
Use bounded `--section`, `--file`, `--offset`/`--limit` pages, and explicit
`--archive LABEL --archive-purpose v1-v2|standalone-successor` for predecessor packets.
Fresh references retain exact original published packet bytes/path/length/digest;
original files remain mandatory. Earlier frozen gzip encoding remains readable
without recompression equality. Refutation verifiers have Read, not Bash, and receive
a packet-bound `LOOM_CONTEXT_VIEW_PATH`; views are rechecked at delivery/capture,
not result authority. See [native context instructions](../references/standalone-successor-context.md).

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration inspect \
  --runs-root "<successor-root>" --run "<successor-id>" --replay
```

Read-only replay returns `{"kind":"standalone-evidence-replay","digest":"...","json":"..."}`
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

P3 consumes actual active `surviving_critical_findings`, never just new/panel work.
Any limited current critical coverage blocks before checks/candidate/installable
authority, even with zero active criticals. Full-coverage zero-critical sources use
explicit `defectFamily:{"kind":"not-required"}`. V3 retains the entire byte-exact
source JSON/digest, origins and histories through schema-2 remediation; no fabricated
v2 source. Fixed operator checks, fresh reports, candidate bytes/modes, literal
staging and guarded exact-index installation are unchanged. P3 does not rewrite
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
allocate more. Legacy reader ceiling remains 128 MiB; P3 report/journal budgets
above remain unchanged.

The representative owned seven-role Claude workload uses an explicit production
path roster in `engine/tests/fixtures/standalone-native-workload.ts`, independent of
Git dirty/index state. The test copies exact bytes and proves the same workload in
staged and clean committed fixture states before actual native publication. The
observed B5 focused run used 1,517,532 production bytes, 46 scope paths including
three fixture paths, a 6,907,243-byte packet and 6,828,446-byte registration. This
replaces the B4 dirty-tree-selected workload (1,506,719 bytes / 54 scope paths), not
its historical evidence. These scripted measurements demonstrate representative
capacity, not a live semantic review, every possible scope, a whole-heap bound or
a final full-root timing guarantee. Final concurrent-code validation remains pending.

Independent standalone and Wave issuance remain v2. V1/v2 initial publication,
outstanding attempt 1, new attempt 2, already-published attempt-2 recovery and exact
packet/result/receipt history remain under their issued contracts. P5's pre-B4
**development-only v3 panel transport** changed before any live v3 publication;
that is not a historical v1/v2 migration or permission to rewrite old packets.
P5 adds no formal planning tooling, dual-snapshot execution or future-priority scope.

## Protected state rules

Do not write `active_task_graph.json`, machine bindings, or evidence ledgers directly.

Protection is layered:

1. TaskGraph mode is `0444` at rest.
2. `guard-state-file` denies Bash segments that may write guarded paths.
3. Under Pi, a content-addressed Runtime Revision handshake rejects stale-extension/fresh-CLI mutations before dynamic import; `StateManager` repeats the check before chmod or lock creation.
4. `StateManager` serializes writes with a lock and atomic rename.
5. Only hooks and narrowly allowlisted helpers receive write authority.
6. Run-scoped programs publish immutable evidence outside the protected graph and commit protected state only through typed effects.

If a helper says a direct write is blocked, use the named canonical operation; do not use `chmod`, output redirection, an interpreter, or path obfuscation to bypass it.

## Common operating states

### Task remains `pending`

- If its Agent is still in `executing_tasks`, wait or diagnose a hang.
- If the Agent crashed, SubagentStop/cleanup clears execution attribution; respawn the exact Task.
- If proof is unsatisfied, inspect `proof.obligations` rather than trusting completion prose.

### Test evidence is missing or degraded

The implementation Agent must run recognizable tests. For trusted Claude evidence, prefer a supported machine-readable report. A nonzero exit is trusted failure; a zero exit without an acceptable report may remain untrusted. Pi structured tool results retain their distinct provenance.

Do not use `mark-tests-passed` to fabricate evidence. It is an evidence/status operation, not an escape hatch.

### Reviewer evidence is missing

Registered programs derive the exact missing slots and issue retry requests. Resume the program; do not re-run the whole roster or manually write a transcript.

A malformed semantic output gets one retry. Attempt-2 rejection is terminal for that run. Wave reviewer exhaustion has an explicit `orchestration restart` path; standalone runs should remain blocked audit evidence rather than be edited.

### Implementation escalation (semantic attempt 2 exhausted)

A modern implementation Task gets exactly two semantic attempts. When attempt 2's settlement also fails its proof, the lineage records an `escalation-required` receipt and further implementation dispatch is refused — the engine will not spin a third unreviewed attempt. Attestation byte drift is terminal on attempt 1 because refreshing its baseline would certify child-authored bytes. The direct exit from either terminal state is `remediate`; it is deliberate, reason-echoed, and never rewrites history:

```bash
# Consume the escalation: append one escalation-remediated receipt and return
# the Task to a fresh attempt 1 (operator repaired the environment, re-scoped
# the Task, or otherwise sanctioned a new proving round).
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration remediate \
  --task <task-id> \
  --receipt <exact-terminal-escalation-receipt-id> \
  --reason "<why a fresh attempt is now sanctioned>"

# Separately, arm re-attestation only on an eligible pending, nonterminal Task
# when the declared artifacts ALREADY carry the completed work
# (populate-task-graph --force reset, reopened Wave, anchor-only repair).
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration attest \
  --task <task-id> \
  --reason "<why the work is known to be already present>"
```

`remediate` requires the EXACT receipt id of the Task's terminal escalation and refuses a repeat (`no longer escalated`), a live attempt, or a wrong receipt — all without touching state. The receipt is appended only; history start and the seed predecessor are untouched, and the walk past the remediation receipt lands on a fresh attempt 1 with a full two-attempt budget. The reason is echoed to stdout only; it is never persisted into the graph.

`attest` refuses a live attempt, an escalated lineage (remediate first), a satisfied proof, a repeat (`already in attestation mode`), and an unknown Task — all without touching state. It rewrites exactly the proof surface under the TaskGraph lock: one scope-wide attestation obligation plus one attested obligation per declared artifact, a regression-required/new-tests-waived stored policy (the legacy `new_tests_required` boolean is CLEARED, not flipped — a `false` there would contradict the required regression at the load boundary), and the `implementation_attestation: true` flag. Lineage, baselines, and history are untouched. The dispatch binding requires the engine-derived `LOOM_IMPLEMENTATION_ATTESTATION_CONTEXT` line on every dispatch and refuses it on non-attestation Tasks. The attested child must change NOTHING inside the attempt scope: any byte move fails the scope obligation and terminalizes that attestation lineage, so it can never become a refreshed attempt-2 baseline. Restore the intended bytes, then use the exact terminal receipt with `remediate` before another proving round. The classified regression still runs. Reconcile measures drift against the attempt baseline (never the population baseline), so pre-existing population-relative changes are the attested work, not writes.

### Completed Wave has post-review workspace-integrity loss

A completed Wave may be reopened only through Loom's independent immutable Review Packet authority. This is the recovery for a missed remediation invalidation; do not edit the graph or decrement a Review Generation.

```bash
cat > /tmp/reopen-wave-3.json <<'JSON'
{"runId":"<completed-run-id>","wave":3,"authorityDigest":"<completed-authority-digest>","taskIds":["T19","T22"]}
JSON
bun "$LOOM_DIR/engine/src/cli.ts" helper reopen-completed-wave \
  --runs-root ".claude/reviews/wave-gate-runs" < /tmp/reopen-wave-3.json
```

For modern packets, `workspaceHeadSha` lets the helper derive exactly the completed Tasks whose declared bytes drifted. For historical packets without it, `headSha` is only a batch epoch and is never compared with current bytes: the helper records `legacy-workspace-authority-unverifiable` and requires every completed Task in that Wave. The payload Task list must equal that mode's engine-derived list in protected order. The helper requires execute phase, `current_wave === wave + 1`, no active Wave Gate, and no later-Wave Task progress evidence. It re-proves authority under the StateManager lock, removes only that completed Wave's terminal entry, restores `current_wave`, increments and invalidates reopened Tasks' review generation, and preserves all historical proof, test, artifact, and Finding bytes. Each reopened Task is instead returned to protected `pending` revalidation state; the Wave Gate resets `impl_complete: false`, `tests_passed: null`, and `reviews_complete: false`. Re-spawn **every reopened Task** before starting a new Wave Gate. The implementation Agent may make no production change when current code is correct, but it must run tests and stop with fresh task-linked test evidence; only that stop clears revalidation. An exact replay after success is idempotent; a changed payload is refused. Start a normal fresh Wave Gate only after every reopened Task revalidates.

### Active Wave Gate Run Directory is missing

Do not recreate the old directory or edit `active_wave_gate`. Create a pristine
replacement direct child, copy the exact run ID/wave/digest from protected state,
and use the atomic recovery operation:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration recover-orphan \
  --runs-root ".claude/reviews/wave-gate-runs" \
  --run-id "<active-run-id>" --wave "<active-wave>" \
  --digest "<active-authority-digest>" \
  --new-run "<fresh-replacement-run-directory>"
```

It refuses if the old entry exists or any subagent is active, preserves review
history and generations, records the retirement, installs replacement authority
atomically, and returns the exact new spawn batch. `cleanup-state` remains a
history-discarding last resort, not normal recovery.

### Wave Gate reports critical Findings

Fix surviving criticals through implementation Agents, which increments Review Generation, then open a new Wave Gate run. Do not remove Findings from the graph. The next Review Run verifies every prior id against a new Review Packet.

### Wave Gate awaits advisory disposition

Present the engine’s request and return exactly one disposition/reason object through `decide`. Do not classify advisories silently in parent reasoning.

### Pi reports runtime version skew

Do not repair state. The mutating CLI route compared the Runtime Revision published by Pi's loaded extension with the current checkout and refused before writing. Run `/reload` (or fully restart Pi while preserving the session), then retry the same idempotent operation. Canonical `orchestration status` remains available during skew.

A missing handshake means the Pi session predates this protocol or did not load Loom; it is also resolved by reload/restart, not by deleting fields from the TaskGraph.

### Active graph uses the legacy Requirement trace contract

Legacy graphs without `spec_trace_version` remain readable and auditable. To upgrade exactly one active legacy graph, prepare JSON covering the exact existing Task roster in protected order; provide both arrays for every Task:

```json
{
  "spec_trace_version": 2,
  "tasks": [
    {"id":"T1","spec_anchors":[],"spec_contributions":["FR-001"]},
    {"id":"T2","spec_anchors":["FR-001"],"spec_contributions":[]}
  ]
}
```

Then run the sanctioned atomic helper (use `.pi/state/...` through Loom's normal `LOOM_STATE_PATH` under Pi):

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper upgrade-spec-trace \
  < /path/to/exact-trace-ownership.json
```

The helper uses StateManager's lock, validates the resulting v2 graph through the same pure trace parser used by normal loading and `validate-task-graph`, and changes only `spec_trace_version`, `spec_anchors`, and `spec_contributions`. It rejects duplicate, missing, reordered, or foreign roster entries; stale conflicting replays; active subagents; and invalid ownership. An exact replay is idempotent.

By default the helper refuses while protected `active_wave_gate` authority exists. Normally, resume and finish that registered Wave Gate until the engine archives it and clears active authority. If the run is blocked specifically because its legacy Requirement scope is wrong, finishing it is impossible. Use this explicit retirement sequence instead, substituting the exact `runsRoot` and `runId` stored in `active_wave_gate`:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration abandon \
  --runs-root "<exact-protected-runsRoot>" \
  --run "<exact-protected-active-runId>" \
  --reason "legacy Requirement scope prevents this Wave Gate from completing"

bun "$LOOM_DIR/engine/src/cli.ts" helper upgrade-spec-trace \
  --retire-abandoned-run \
  < /path/to/exact-trace-ownership.json
```

Usually omit `--superseded-by` and start the replacement only after migration. If an already-created successor Run Directory was deliberately named during abandonment, the upgrade re-proves that exact direct child and preserves the pointer as audit data; it does not install the successor as protected authority. The upgrade opens the exact protected Run Directory, proves its engine-owned Wave Gate program (Wave, Task roster, and authority digest), reads the immutable abandonment marker, then repeats those proofs under StateManager's lock. Missing/unreadable/foreign markers, authority drift, missing or foreign supersession targets, and non-abandoned runs cause no TaskGraph mutation.

On success, one immutable `SpecTraceWaveGateRetirement` audit preserves the old run id, Wave, authority digest, revision, runs root, and exact abandonment reason/supersession. The same locked commit installs trace v2 and clears only stale `active_wave_gate`, `wave_review_epoch`, and `spec_check` scope. Tasks, proofs, Review Runs, Findings, Refutations, Resolutions, issued packets, completed/orphan retirement history, and implementation evidence remain intact. An exact replay does not append another audit; a different mapping remains refused.

### State is malformed

Use only when the load boundary explicitly directs recovery:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper repair-task-graph
```

The repair path parses rejected bytes, applies conservative repair, refuses loss of Findings/audit data, validates both full and typed forms, installs atomically, and restores mode `0444`.

### Abandoning an orchestration

`/loom --complete` and `--abort` are not implemented lifecycle flags. The canonical emergency teardown is the guarded helper:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper cleanup-state
```

Use it only with explicit operator intent. Preserve specs, plans, review runs, and the GitHub Issue as audit/recovery material.

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

Completed schema-v1 remediation runs remain read-only and inspect as `done — historical P3 assessment unknown`; their external assessment is `historical-unknown`. Reading/resuming that history returns the existing receipt, never reinstalls the index or grants current installation authority. An unfinished schema-v1 run is blocked and must be replaced by a fresh schema-v2 run. Missing v2 fields never fall back to v1. The source Standalone Review Run retains its own schema and immutable publication; versioning remediation does not rewrite or invalidate that source history.

Completed-v2 replay parses both checkpoint audit-path arrays before assessing retained observations. Missing or malformed arrays produce `remediation checkpoint audit paths are missing or malformed`, not invented empty-path evidence. If installation succeeds but checkpoint recording fails, preserve the explicit installed-index diagnostic and actual receipt: that failure does not mean rollback or “nothing was installed.” Do not hand-repair the checkpoint or reinstall from its prose; use read-only inspection and retain the interrupted evidence.

**Runtime selection:** every mutating CLI must present the exact Runtime Revision admitted by the loaded extension. After a package update, reload Pi or restart the host before retrying; revision skew fails closed and must never be bypassed by unsetting admission variables. Use matching-runtime disposable fixtures for feature-checkout mutation experiments. Do not retrofit newly available records into an already-issued source review. Reviewer source version does not select remediation version: P3 schema-2 command/report/install policy remains separate. Dated publication and bootstrap evidence lives in the relevant ADR and remediation plans; development checks are not registered installation receipts.

### Enrolling a critical-repair check

Critical remediation selects check IDs from the operator-owned `.loom/verification-manifest.json`. The selected fixed executable/argv must itself create a **new** report at the **exact** configured path on every run. The file must be a fresh parseable JUnit XML or Vitest/Jest JSON report beneath `.loom/completion-reports/`, remain untracked, and be Git-ignored. A normal process exit is insufficient: the parsed report must show more than zero executed tests, zero failures, and not an all-skipped run.

Before each selected critical check launches, the engine proves that exact literal report path is Git-ignored and untracked, then removes any old regular file through the anchored parent capability using no-follow: Linux unlinks through the retained parent descriptor; macOS re-proves the parent's whole path immediately before the unlink and refuses a planted-symlink parent with ELOOP (both reports survive a redirect attempt). Only ENOENT counts as absence; directories, symlinks, and permission failures fail before launch with `required report reset failed before launch`. Merely touching seeded green bytes cannot pass. A newly written report may have identical bytes to the previous report. Zero-critical remediation launches no check, and Wave report freshness behavior is unchanged.

Strict reports are capped at **8 MiB (8,388,608 bytes)** and actual XML element depth **128** (root depth 1, including diagnostic elements). Structural XML parsing rejects malformed documents and DTDs; comments/CDATA do not create tests. Capture, persistence, and base64 replay enforce the report byte bound before oversized allocation/decoding. V2 remediation additionally caps each encoded event file at **12 MiB**, the aggregate encoded journal at **64 MiB**, and the journal at **1024 records**. These limits apply to retained-event reads, append reconciliation/new appends, and CLI inspection's event-tail read, before oversized file decoding/JSON parsing; enumeration is bounded too. They are not blanket limits on every Run artifact/checkpoint, or a claim that decoded heap usage equals encoded bytes. Legacy/default journal consumers retain their existing policy.

These are fresh structured engine observations, **not semantic proof**: an operator-owned fixed command can still fabricate a syntactically valid new report. Neither process success nor a report digest proves that tests exercised the declared invariant, root cause, sibling completeness, or Historical RED.

The `helper write-verification-manifest` operation is **create-only**. It requires an existing loadable TaskGraph whose Task roster is empty, accepts an identical replay, refuses a different existing manifest, and refuses after Task population. It does not update this repository's existing manifest. Standalone remediation has no TaskGraph requirement; this enrollment helper's idle-TaskGraph requirement is a separate configuration-installation constraint.

**Current repository enrollment (2026-09-09):** with explicit user approval, the parent replaced only `project:verify`'s report policy at a verified idle boundary with no TaskGraph: `{ "kind": "required-file", "path": ".loom/completion-reports/verify.junit.xml" }`. The fixed executable `npm`, argv `["run", "verify"]`, root cwd, Wave scope, and 30-minute timeout are unchanged. This was operator configuration replacement, not use or modification of the create-only helper and not a live graph mutation. The existing `test:unit` script emits JUnit using installed Vitest; no runner or report writer was added. Only `.loom/completion-reports/` is newly Git-ignored. Existing populated TaskGraphs retain their already-frozen commands. Enrollment makes the check selectable for critical P3; it does not establish a passing check or completed live schema-v2 remediation. Do not bypass protected paths or edit a live graph. See [Verification manifest](workflows.md#verification-manifest) and the [dated enrollment follow-up](../.claude/plans/2026-09-09-junit-verification-enrollment.md).

## Linter operations

### Scan a path

```bash
bun scripts/lint-project.ts engine/src
```

### Validate rule files

```bash
bun engine/src/cli.ts helper validate-lint-rules .claude/linter/rules
# Pi project:
bun engine/src/cli.ts helper validate-lint-rules .pi/linter/rules
```

A nonexistent directory is an error for explicit validation. Runtime loading, by contrast, treats an absent project rules directory as “no project overrides.”

See [Lint Rules](../lint-rules/README.md) for configuration and tiers.

## Model policy operations

```bash
# Inspect one Agent’s semantic profile and both bindings
bun engine/src/cli.ts helper model-profiles agent --agent code-reviewer

# Validate all source definitions
bun engine/src/cli.ts helper model-profiles validate

# Regenerate Pi Agent definitions
bash scripts/sync-pi-agents.sh
```

Generated Pi Agents live under `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/agents`. Regenerate after Agent, Skill, model-profile, or package-root changes, then `/reload` Pi.

## Model calibration

Calibration is live-model work and is opt-in:

```bash
cd /path/to/loom
LOOM_RUN_MODEL_CALIBRATION=1 bun scripts/run-model-calibration.ts \
  --profile focused-review \
  --corpus calibration/corpus.json \
  --output calibration/results/focused-review.json
```

Without `LOOM_RUN_MODEL_CALIBRATION=1`, the script exits without running models. Score predictions separately with the `helper model-calibration` operations. Read [Model profiles and calibration](model-profiles-and-calibration.md) before changing policy.

## Development validation

### Locked bootstrap and mandatory full gate

The development/CI baseline is a full-history Git checkout on a non-root account with Node **22.23.2**, Bun **1.3.13**, npm, Git, and jq. Linux additionally requires Bash **4+** and GNU `timeout` on PATH. The macOS 13+ CI job uses Apple's Bash 3.2 and does not require GNU coreutils; its runtime support includes anchored report reset through a re-proven parent path. Full history is required because deterministic tests resolve the committed model-calibration corpus against historical revisions available through remote refs. A normal full clone checked out on `main` contains those objects; for an existing single-branch shallow clone, fetch every remote head before verification:

```bash
git fetch --unshallow origin '+refs/heads/*:refs/remotes/origin/*' --tags
```

From the Loom repository root:

```bash
bun install --frozen-lockfile
(cd engine && bun install --frozen-lockfile)
npm run verify
```

Both locks are required: root dependencies supply Pi/runtime resources; engine dependencies supply the compiler and Vitest. `preverify` checks required tools, executable local Vitest/Pi, and that Pi resolves to the root-local locked CLI through npm's PATH. No global/latest Pi or network-fetching compiler fallback is accepted. Local preflight checks availability, not exact runtime versions; CI explicitly checks the pinned Node/Bun versions.

The same **root `npm run verify`** runs locally, in `.github/workflows/ci.yml` for PRs/branch pushes/tags, and through this repository's runtime Verification Manifest. CI checks out full history with `fetch-depth: 0`, installs both frozen graphs, preserves failures through `pipefail`, and attempts log artifact upload even after failure. It has a 60-minute job budget; the manifest separately bounds its command to 30 minutes. Neither is proof of a successful hosted CI run.

Root `verify` delegates to engine `verify`: prerequisites → typecheck → existing `test`. That test script runs the entire existing Vitest suite (including property/integration tests) followed by all six unchanged smoke commands, once each on success:

1. `scripts/smoke-panel-mode.sh`
2. `scripts/smoke-review-panel.sh`
3. `scripts/smoke-standalone-review.sh`
4. `scripts/smoke-orchestration-facades.ts`
5. `scripts/smoke-pi-resources.sh`
6. `artifacts/tests/test-validate-task-graph.sh`

The review-panel and standalone helper smokes explicitly retain historical/manual
coverage. The façade smoke covers current issued payloads, bounded scope retries,
refutation, advisory decisions, durable replay and actual disposable index
installation; it supplies a matching runtime identity only to its CLI children.
These scripted smokes do not spawn live Agents.

The one Vitest invocation retains the default console reporter and also writes `.loom/completion-reports/verify.junit.xml` at the repository root. Its script uses `--reporter=default --reporter=junit --outputFile=../.loom/completion-reports/verify.junit.xml` because npm runs it from `engine/`. JUnit contains only Vitest test facts, including skipped/failed cases; it does not contain compiler or smoke testcases. Normal zero exit of the entire fixed command proves those other tiers passed too. A later smoke failure leaves the green unit report but the root command remains nonzero. Focused `test:unit` invocations overwrite the same file with focused facts: report existence alone is never full-gate or registered remediation evidence.

Failure stops later stages. The existing test scripts normalize `PI_CODING_AGENT` for their subprocesses; do not replace them with Bun's built-in test runner. The mandatory full gate has **no file/test selectors or omitted smoke tier**. Existing platform-dependent skips must be reported (for example the Darwin-only filesystem case on Linux), not hidden behind a universal zero-skips claim. Live-model calibration remains opt-in and outside this gate.

### Compiler boundary

`engine/scripts/typecheck.ts` uses the explicitly installed TypeScript API with `noEmit`, `noUnusedLocals`, and `noUnusedParameters`. `engine/tsconfig.json` owns all `src`, `tests`, `../pi`, and `scripts/typecheck.ts` roots. Standalone repository-root scripts are not all explicit compiler roots; imported portions may be checked transitively.

Only TS6133/TS6192/TS6196 unused diagnostics on compiler-proven external raw TypeScript, excluding declaration files and explicit roots, are non-fatal. Each original file/position/code/message remains visible. Owned diagnostics, ordinary external dependency errors, config/input failures, and compiler infrastructure failures remain fatal. This intentionally replaces the old fail-open path grep; `skipLibCheck` cannot suppress raw-source unused diagnostics. `typecheck:unused` is an alias of the same complete gate, not a weaker path.

### Focused iteration (not full-gate evidence)

```bash
npm --prefix engine run typecheck
npm --prefix engine run test:unit -- tests/runbook-contract.test.ts tests/panel-config.test.ts
npm --prefix engine run test:unit -- tests/handlers/helpers/orchestration.test.ts
npm --prefix engine run test:unit -- tests/pi-extension-review-events.test.ts
npm --prefix engine run test:smoke
# entire test script without the compiler gate:
npm --prefix engine run test
# equivalent package-script invocation from engine/:
# bun run test
```

**Bare `bun test` is Bun's built-in runner, not `npm run test` / `bun run test`.** Report the exact command, exit status, test counts/skips, smoke completion or not-run stages, and environment. Focused green checks or separately green tiers are not a green canonical run. Do not claim full validation when concurrent work prevents a complete run on the final tree.

## Repository map for operators

```text
.claude-plugin/plugin.json     Claude plugin metadata
package.json                   Pi package registration and runtime dependencies
commands/                      executable user runbooks
skills/                        reusable Skill runbooks and knowledge
agents/                        source Agent definitions
hooks/                         Claude Code hook registration and shims
pi/                            Pi adapter, renderer, transcript adapter, grants
engine/src/core/               parsers, policy, reducers, domain values
engine/src/orchestration/      anchored persistence, effects, Fugue runtime/DAGs
engine/src/handlers/           harness/CLI shell
engine/tests/                  unit, property, integration, contract tests
scripts/                       sync, lint, calibration, smoke scripts
calibration/                   committed corpus; generated results are ignored
```
