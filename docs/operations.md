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
- owner verification per owned Invariant, when the latest completion result ran it (coverage, mutant counts or the exemption, the time bound; see [Owner verification](#owner-verification-blocks-a-wave-gate-g5b));
- Review Run roster gaps and evidence failures;
- active/advisory/resolved/refuted Finding counts;
- whether a Refutation Panel is needed;
- Wave Gate completion eligibility;
- exactly one next action and all reasons.

Unreadable or malformed authority is represented as `unavailable` and leads to `blocked`; status never fabricates empty/ready values. Status probes the conventional Wave Gate runs root by default; pass `--runs-root` when the active run was started under a different root. A missing active directory is reported as orphaned, never as a healthy suspended run.

Status re-proves accepted Review Packet authority the way the Wave Gate does: it reads each reviewed Task's declared bytes in the TaskGraph's own project and compares them with the reviewed snapshot. While a gate waits on an advisory decision, unchanged bytes therefore read as intact, and only real drift or a Git observation failure fails the `Review Packet workspace integrity` prerequisite.

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

The façade also exposes `submit` and `correlate` for transport integration and compatibility. Normal Pi and Claude Code operation records native correlations and captures final bytes automatically, through the same mechanism on both harnesses: every `spawn-batch` (and every `done` with a `result.json`) the façade returns is first published as a **session run binding** — a registry file `<session-id>.orchestration-runs.json` under `LOOM_SUBAGENT_DIR` (default `/tmp/claude-subagents`) naming the run and the request ids it issued, stamped with the harness that owns the session. On Pi the session is `PI_SESSION_ID` (with `PI_CODING_AGENT=true`); on Claude Code it is `CLAUDE_CODE_SESSION_ID` (with `CLAUDECODE=1`), which Claude Code exposes to the main agent's Bash commands. A missing session id under either harness withholds the spawn batch with an error rather than issuing requests nobody could capture.

The harness side reads the binding back by its own session id, and a registry stamped with the other harness is refused. Pi's extension resolves the run from the request markers in its spawn batch. On Claude Code, hook payloads carry the PARENT session's `session_id` for subagents too: PostToolUse on `Agent` records the native `agent_id` against the one binding that issued the prompt's `LOOM_REQUEST_ID`, and SubagentStop captures into the bound run whose correlator records that `agent_id`. Because a foreground Agent call finishes before it returns, its SubagentStop can precede that PostToolUse; the stop then records the same correlator from the agent's own spawn prompt (the transcript's opening message) before capturing. Claude Code subagents that finish with `SubagentHandback` are captured from that call's `message`. An agent no binding claims is left alone; a marker no binding (or several) issued, an unreadable registry, or a correlator in several runs is a hook error, never silent passthrough. `LOOM_ORCHESTRATION_RUNS_ROOT` and `LOOM_ORCHESTRATION_RUN_DIR`, when set, take precedence and pin the hooks to that one run (both or neither). `complete` remains a compatibility adapter for historical panel callers; deterministic operations are executed internally in new façade runs.

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

When the abandoned Run owns the matching protected Wave Gate, the same command also stamps that registration `terminal-abandoned` under the TaskGraph lock and clears its `active_wave_completion_suite`. This protected-state mutation authorizes a later successor start without deleting the tombstone audit. The immutable Run marker is published first; if the subsequent protected-state stamp fails, the command reports the marker-only partial outcome. Repeat the **identical** `abandon` command: marker publication reconciles idempotently and the helper retries the state stamp. Do not choose a new reason or successor, delete the marker, or edit protected state by hand.

`orchestration status` reports both leftover shapes (issue #50):

- **A marker without a stamp.** The run was abandoned before the stamp existed, or its stamp failed. Status reads the marker, refuses to call the run resumable, and prints the exact `abandon` to repeat, with the recorded reason and successor.
- **A tombstone that names a successor.** Status keeps the Wave in the implementation window and, once the Wave can start, returns the `start-successor-wave-gate` recovery carrying that successor's run id. Registration admits only that run, so start `/wave-gate` with exactly that id.

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

### Historical reviewer evidence

Completed **and unfinished issued reviewer v1** runs keep their original protocol,
normalization, synthetic-shortfall behavior, IDs, retries and result bytes.
All seven reviewer tasks carry a concrete `LOOM_CONTEXT_READ_COMMAND`: a shell-quoted
`bun` invocation of the admitted package's `scripts/read-context-packet.ts`, with
the actual immutable `LOOM_CONTEXT_PATH` and expected request/digest/role/Skill.
Run it with Claude `Bash` or Pi `bash`; no `readContextPacket` harness tool exists.
The command first returns a bounded section index. Append `--section LABEL` to
browse decoded sections or `--file EXACT_SOURCE_PATH` for frozen source text,
then `--offset N --limit 4096` to continue. Fresh Wave v2 Task-reviewer packets
carry one `wave-frozen-source` section built from the same dirty/untracked/absent
artifact snapshot as `workspaceHeadSha`; spec-check packets do not receive source,
and already-issued historical Wave packets remain byte-immutable. Each Task packet
contains only that Task's declared/modified review scope. Text offsets count UTF-16
units; index offsets count section entries (at most 32 per page). Section browsing
omits source contents and binary/base64 fields while retaining binary/absent path,
digest, and length metadata. Wave and standalone v1/v2 binary-file selection and
any invalid UTF-8 fail; standalone v3 frozen source uses a binary representation
for byte fidelity, but explicit `--file` selection returns it when fatal UTF-8
decoding succeeds.
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
- The settlement line (`Task T1 settlement: …` on Claude Code, `loom(pi): T1 settlement: …` on Pi) and the Task's `failure_reason` both say why a failed attempt was not implemented. A `task-byte-scope-violation` names the paths written outside the Task's declared files: the first 10, then `and N more`. Remove stray files that are not the Task's work, such as a killed test run's leftovers, before the retry, or that retry fails the same way.

### Test evidence is missing or degraded

The implementation Agent must run recognizable tests. For trusted Claude evidence, prefer a supported machine-readable report. A nonzero exit is trusted failure; a zero exit without an acceptable report may remain untrusted. Pi structured tool results retain their distinct provenance.

Do not use `mark-tests-passed` to fabricate evidence. It is an evidence/status operation, not an escape hatch.

### Task fails I6 (red-then-green)

A Task owes I6 when it requires new tests, is neither an Acceptance Contract claimant nor a contract Task, and its TaskGraph was populated after I6 existed, which means its frozen manifest carries `testFiles`. A contract Task is exempt because it cannot satisfy I6: its contract Wave Gate requires every acceptance testcase it writes to be collected and failing, so those tests never go green in its attempt, and a test-only contract has no implementation file to write. The gate's observed red window is the contract Task's red evidence. Its Proof still owes `new-tests`, and its brief carries no I6 section. A Task that owes I6 settles `implemented` only when its attempt epoch's ledger shows three things in order:
1. a qualifying red on one of its test files;
2. then its first write to an implementation file;
3. then a qualifying green covering every one of its test files.

A qualifying run is a ledger `TestRun` with an exit code and a parsed structured report that records per-file results. The obligation, the gaps and the soundness limit are defined in [Deterministic implementation, I6](deterministic-implementation.md#during-the-loop--put-the-oracle-inside-the-agents-iteration).

A failure reads `proof:red-then-green-unproven:<gap>` in the settlement line and in the retry receipt. Each gap points to a likely cause:

- `no-test-files`: the `file_list` matches no frozen test suffix. Re-scope the Task, or declare `testFileSuffixes` in the manifest before the next population.
- `implementation-write-missing`: the ledger holds no write to a non-test `file_list` entry. Either the agent wrote only through an unlogged path, such as an interpreter or a generator, or it wrote nothing.
- `red-missing` or `green-missing` with `untrustedOnly: true`: tests ran, but no run was qualifying. Usual causes are a chained, piped or redirected command, a missing report option, or Pi-structured evidence with no ledger run. On Claude Code a failing run reaches the ledger only through the `PostToolUseFailure` hook; a runtime whose `hooks/hooks.json` predates that wiring records no red at all.
- `red-missing` with `untrustedOnly: false`: qualifying runs exist, but none shows red on a Task test file. Either the tests never failed, or they only failed to collect in a Task that creates no implementation file. A collection or import error is red only when the Task creates an implementation file, meaning one whose Task-level `artifact_baseline` entry is `missing` (FR-007a). The brief names those files.
- `red-after-first-implementation-write`: the code came before the failing test.

The retry brief tells the agent to return its implementation files to the attempt baseline with one Bash call, observe red, and then implement. The call runs from the repository root and first checks that the baseline is a commit. The baseline is the Task's `start_sha`, or `HEAD` when none was recorded; the brief then says that the uncommitted changes are discarded. The call restores each file the baseline has (`git restore`) and deletes each file the Task created (`rm -f`). If the baseline is not a commit, it fails before changing anything. A `ledger-unavailable` gap, or an unreadable ledger at settlement, is infrastructure. It does not use up the semantic attempt.

To see the facts settlement judged, numbered the way the gap and the stored evidence cite them, read the attempt's epoch (see [Reading an attempt's ledger epoch](#reading-an-attempts-ledger-epoch)). For the I6 judgment itself, use [`helper red-then-green-status`](#where-does-a-task-stand-on-i6).

### Reading an attempt's ledger epoch

Use this when an I6 result, or a `red #3` / `green #5` reference, needs checking against what the agent actually ran and wrote. The script prints one epoch of a session's evidence ledger, or lists the session's epochs. It runs in place from the repository:

```bash
# List the session's epochs, with each epoch's fact count.
bun scripts/ledger-epoch.ts --session <session-id>

# Print one attempt's facts, numbered as I6 settlement numbers them.
bun scripts/ledger-epoch.ts --session <session-id> --agent <agent-id> --type <agent-type>
```

`--agent` and `--type` are given together or not at all. The session id is the Claude Code session that dispatched the Task (`CLAUDE_CODE_SESSION_ID` in the orchestrator's Bash commands).

**Which epoch is the attempt's.** An epoch is `<agentId>:<agentType>`, the same identity settlement builds with `epochOf` when it judges the attempt. The agent id is the `agentId` of the Task's implementation-attempt sidecar (`<session>.<hex agent id>.implementation-attempt.json` in the subagent directory). The agent type is the subagent type the Task was dispatched with, without its plugin namespace: `loom:code-implementer-agent` is `code-implementer-agent`. The settlement line names the Task, not the agent, and cleanup removes the sidecar once the attempt settles. When neither is at hand, run the index form first: it prints each epoch in the order it first appears in the ledger, as `<agentId>:<agentType> — <n> fact(s)`, below a `<n> epoch(s)` header.

**Positions.** The epoch view opens with `epoch <agentId>:<agentType> — <n> fact(s)` and prints one line per fact, `#<N> <Kind> …`. `N` is the fact's 0-based position in the epoch's ordered events, the same array settlement hands the I6 judge, so it is the number I6 evidence cites. If the evidence reads red `#3`, first write `#4`, green `#5`, those are lines `#3`, `#4` and `#5` here. Duplicate deliveries (the same `callId` and event recorded twice) are already dropped, exactly as settlement drops them, so the numbering never counts a fact twice. Records are printed as recorded. Nothing is reordered, escaped or truncated, and no `callId` is shown.

**How each fact reads.**

- `#N FileWrite <path> (via tool)` or `(via shell)`: a write through an edit tool, or one a shell command minted (such as `mv`, `cp` or a redirect).
- `#N FileRead <path>`.
- `#N TestRun <command>`, followed by indented detail lines:
  - `exit <code>`, or `exit none recorded` when the ledger holds no exit code for the run;
  - `no structured report` when no runner report was parsed for the run, or `report <source>: total <t>, failed <f>` when one was, followed by:
    - `per-file results not recorded` when the report carries no per-file results;
    - otherwise one line per test file, in report order: `<file>: executed <e>, failed <f>, skipped <s>`, with `, collection error` added when the file failed to collect. A report with an empty result list reads `no per-file results`.

A run that reads `exit none recorded`, `no structured report` or `per-file results not recorded` is never a qualifying run, because a qualifying run needs an exit code and a parsed report with per-file results (see [Task fails I6](#task-fails-i6-red-then-green)). Such runs are what a `red-missing` or `green-missing` gap with `untrustedOnly: true` means: tests ran, but no run qualified. The view shows the facts; it does not mark which runs qualify.

**Where the ledger is.** The script reads `$LOOM_SUBAGENT_DIR/<session>.evidence.jsonl`, with `LOOM_SUBAGENT_DIR` defaulting to `/tmp/claude-subagents`, the same file the hooks append to and settlement reads. Set `LOOM_SUBAGENT_DIR` to read a ledger elsewhere. The SessionStart stale sweep deletes old ledgers, so read the epoch while the session's files are still there.

**Outcomes and exit codes.**

- **0**: the view was printed on stdout. An epoch with no facts prints `epoch <agentId>:<agentType> holds no facts`, and an existing ledger with no records prints `ledger holds no epochs`. Both are statements, not refusals: they mean the ledger exists and holds nothing for that query.
- **1**: a ledger refusal on stderr, with empty stdout. `ledger-epoch: no evidence ledger at <path>` names the path it looked for. A missing ledger is refused rather than read as empty, so it never looks like "the agent recorded nothing". An unreadable or corrupt ledger relays the engine's own message, `ledger-epoch: evidence ledger <path> is corrupt; refusing partial evidence: line N: <error>`. `line N` counts non-blank lines, which in practice is the physical line.
- **2**: a usage refusal on stderr, with empty stdout: the reason, then the usage line. It covers a missing `--session`, `--agent` without `--type` or the reverse, an unknown or leftover argument, and an id the engine's identity parsers reject, such as `--session ../x`. No argument can address a file outside the subagent directory.

The script is read-only. It never writes, truncates or creates a file, including the ledger and the subagent directory, so it is safe to run while a Wave, a Wave Gate or a subagent is live.

**What it does not do.** It never judges I6: it does not say whether a run qualifies or whether the Task's red-then-green order holds. For that judgment, run [`helper red-then-green-status`](#where-does-a-task-stand-on-i6). It covers only Claude Code attempt epochs. A Pi implementation child's epoch, recorded under its parent-issued write grant, is not covered, and the script prints no machine-readable output.

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
# (populate-task-graph --force reset, reopened Wave). An anchor-only repair
# needs no attestation: amend-spec-trace keeps implementation proof.
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration attest \
  --task <task-id> \
  --reason "<why the work is known to be already present>"
```

`orchestration status` names the exact command for each escalated Task in its `implementation-escalation-required` reason, with the Task and receipt filled in and shell-quoted; only `--reason` is yours to write.

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

Fix surviving criticals through implementation Agents, then open a new Wave Gate run. Each affected Task is `implemented`, so it is owed no dispatch until it is reopened (see [Reopening an implemented Task to fix a Wave Gate Finding](#reopening-an-implemented-task-to-fix-a-wave-gate-finding)). Reopening increments its Review Generation. Do not remove Findings from the graph. The next Review Run verifies every prior id against a new Review Packet.

### Wave Gate awaits advisory disposition

Present the advisories the engine's request references. The only decision a Wave Gate records is exactly `{"kind":"approve"}` through `decide`; any other object is refused without writing. To fix an advisory first, `abandon` the run with a reason, reopen the Task, re-dispatch it, and start a fresh Wave Gate (see [Reopening an implemented Task to fix a Wave Gate Finding](#reopening-an-implemented-task-to-fix-a-wave-gate-finding)). Do not classify advisories silently in parent reasoning.

In a contract Wave, `helper orchestration status` adds an `acceptance-freeze-pending` reason at this pause. It lists every advisory whose file is a frozen path of a contract still `awaiting-red` there. When the completion suite accepts, only its receipt is installed. The Acceptance Freeze is stamped by the locked completion commit, so the contract is still `awaiting-red` at the pause, and abandoning the run freezes nothing ([ADR-0044](adr/ADR-0044-the-acceptance-freeze-is-stamped-by-the-completion-commit.md)). Approval lets the gate complete and stamp the Acceptance Freeze over those bytes, so after it each fix needs a Contract Revision. Fix a relevant advisory before approving: abandon the run, reopen the contract Task, re-dispatch it, and start a fresh Wave Gate. The fresh gate reports no frozen-path drift for the fixed files. The reason is a status projection only; the decision request and its identity are unchanged.

### Reopening an implemented Task to fix a Wave Gate Finding

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration abandon \
  --runs-root ".claude/reviews/wave-gate-runs" --run "<run-id>" --reason "fix comment-analyzer-1 first"
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration reopen-task \
  --wave 2 --task T4 --reason "comment-analyzer-1: the comment contradicts the code"
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration brief --task T4 --note "fix comment-analyzer-1"
```

`reopen-task` is the engine operation that makes an `implemented` Task of the active Wave dispatchable again ([ADR-0045](adr/ADR-0045-an-implemented-task-is-reopened-through-one-engine-operation.md)). Under the TaskGraph lock it requires all of the following:

- the execute Phase, with `--wave` equal to `current_wave`;
- no completed history for that Wave;
- `active_wave_gate` absent, or an abandoned tombstone for that Wave that names no successor (abandoning with `--superseded-by` authorizes exactly that successor, so start it instead);
- no executing Task, no active implementation attempt, and no active subagent (checked before and under the lock);
- every `--task` (one or more, distinct) is `implemented` in that Wave, with an implementation lineage that can derive a dispatch (an escalated lineage is remediated first, with `helper orchestration remediate`);
- a non-blank `--reason` of at most 512 characters.

It then applies the transition a Contract Revision uses. The abandoned run's review epoch, spec-check, suite receipt and tombstone are retired, and review evidence that run accepted is kept as Findings. Each named Task returns to protected `pending` revalidation at a new Review Generation, and its Findings stay as prior Findings for the next Review Run. The Wave's gate bits reset (`impl_complete: false`, `tests_passed: null`, `reviews_complete: false`), and the Wave's other Tasks stay `implemented`. One `implemented-tasks-reopened` audit is appended to `task_reopening_history`, recording the Wave, the Task ids, the reason, and the abandoned run id (or `null`). Status then owes each reopened Task an `initial-implementation` dispatch, `brief` renders it, and the Wave Gate cannot start until each settles afresh. Re-running the same command while those Tasks still await re-implementation changes nothing. The same request after they are `pending` but with a different reason, or for a Task that is no longer `implemented`, is refused. `populate-task-graph --force` is never the recovery: it resets every Task and discards all settled evidence.

### Pi reports runtime version skew

Do not repair state. The mutating CLI route compared the Runtime Revision published by Pi's loaded extension with the current checkout and refused before writing. Run `/reload` (or fully restart Pi while preserving the session), then retry the same idempotent operation. Canonical `orchestration status` remains available during skew.

A missing handshake means the Pi session predates this protocol or did not load Loom; it is also resolved by reload/restart, not by deleting fields from the TaskGraph.

### Wave Gate full-tier lint refuses imports the branch allows

The Wave Gate's `loom:full-tier-lint` check runs against the branch's files (the completion suite changes into the worktree), but the lint rule code is the loaded runtime's, not the branch's. A branch that changes a rule, for example a new per-file capability grant in `no-cross-boundary-imports` for a `node:` builtin or an exact-specifier package, therefore fails the gate with a boundary refusal that its own rule would admit. The branch's files are correct; the runtime is older.

This is the Runtime Revision design working as intended: infrastructure the gate depends on must be loaded before the gate can use it. Land the rule change on the checkout Loom is installed from (merge it, or port it there), run `/reload` (or restart Pi), then start a fresh Wave Gate. Do not weaken the branch's imports or its rules to get past the check.

The refusal names this case itself. When the full-tier lint fails, the gate's diagnostic carries the lint's refusal (`loom:full-tier-lint: …`). If the gated repository is a Loom checkout whose `lint-rules/` or `engine/src/linter/` files differ from the loaded runtime's, the refusal opens with a `⚠` sentence naming the loaded runtime and the differing rule files. A plain project carries no lint rules of its own and never gets the sentence. A replayed rejection keeps only the lint's exit code, so its diagnostic tells you to run `helper lint-wave-gate`, which prints the same refusal and the same skew sentence.

### Owner verification blocks a Wave Gate (G5b)

A plan's owned invariants (`**Owner module:**` a path) are Wave Gate obligations. Population stamps each one into the TaskGraph as an Owner Obligation (`owner_obligations`, written on every population, `[]` included). Whenever that stamp is present, the Wave completion suite carries the engine-reserved check `loom:owner-verification`. A graph populated before G5b has no stamp, owes nothing, and its suite roster and digest are unchanged.

**What the check does, in order:**

1. **Plan integrity, every Wave.** It re-reads the plan the graph names (`plan_file`) and re-derives the obligations. It blocks, as infrastructure, on a missing `plan_file` or an unreadable plan (`plan-unreadable`), on strays or malformed ownership (`plan-malformed`), and on any difference from the stamp (`plan-drift`). This runs even when the Wave owes nothing; then the check records `verified` with no verdicts.
2. **Scope.** It owes coverage and mutation only for the owned invariants whose family the Wave changed: some Wave Task's `file_list` holds the owner or a sibling. A Wave that touched only the matrix test owes nothing; unowned invariants are never checked.
3. **Sibling coverage**, per owed invariant: the matrix test's direct imports, followed through `export … from` re-exports and resolved through relative paths and the matrix test's tsconfig `paths`, must include the owner and every declared sibling. Type-only edges (`import type`, `export type … from`, and imports or re-exports whose every specifier is `type`) are erased at runtime and never count.
4. **Mutation verification**, per owed invariant without a mutation exemption:
   - the Wave base is the `start_sha` of the Wave Tasks listing the owner (their octopus merge-base when several); the owner's lines changed since then are the only mutation sites;
   - the owner is parsed with the script kind its extension names (`.tsx`/`.jsx` with JSX), the same rule the coverage import graph uses; an owner with syntax errors blocks as `owner-unparseable` instead of being mutated from a recovered tree;
   - six fixed operators (condition negation, comparison flip, logical swap, boolean-literal flip, return-value replacement, expression-statement removal) generate a deterministic set of at most 24 mutants, evenly spaced over the candidates; the rest are reported as unmutated;
   - one detached git worktree per invariant holds HEAD plus every changed, untracked and deleted path of the real workspace, with `node_modules` shared by symlink; it is removed afterwards whatever happened;
   - the matrix test runs first unmutated (the baseline), then once per mutant, through the frozen `affectedRunner` with the matrix test as its only file and a per-run limit of 60 s, clamped to the runner's own `timeoutMs`;
   - the runner's JUnit report decides: a failing testcase kills, a timeout kills, collection or import errors only make the mutant invalid, an all-passing report with exit 0 means it survived. A run whose every generated mutant is invalid carries no mutation evidence and blocks as `no-valid-mutants`.
5. **Isolation proof.** The real workspace's digest is taken before and after; any difference blocks (`real-workspace-changed`).

The reported time bound is Σ over owed, non-exempt invariants of (1 baseline + selected mutants) × the per-run limit.

**Prerequisite.** Mutation runs through the operator's frozen `affectedRunner` (a schema-2 `.loom/verification-manifest.json`, see [Affected-Test Stop Check](#affected-test-stop-check)); its report must be JUnit. Population refuses a plan with a non-exempt owned invariant and no `affectedRunner` (`owner-verification-runner-missing`). An exempt invariant needs no runner. Population also refuses an owned invariant whose path plays two roles (the owner listed as a sibling, the matrix test as the owner or a sibling, a sibling listed twice) or an invariant owned twice (`invalid-owner-obligations`); the State File parser refuses such a stamp too.

**Reading the result.** `helper orchestration status` (human and `--json`, one status document) reports, per owned invariant of the latest completion result:

- coverage: pass, or the missing paths, or the infrastructure failure;
- mutation: the counts generated, killed, timed out, invalid, survived and unmutated; or the declared exemption and its reason; or the infrastructure failure;
- the time bound.

In `--json`, `ownerVerification` is the persisted observation itself: `{ "kind": "verified", "obligationsDigest", "boundMs", "verdicts": [ { "invariant", "title", "owner", "matrixTest", "coverage": { "kind": "covered" | "missing" | "infrastructure", … }, "mutation": { "kind": "verified" | "exempt" | "red-baseline" | "infrastructure", … } } ] }`, or `{ "kind": "unavailable", "failure" }`. A verified mutation half carries `survivors`; the survived count is their number.

With no owner verification to report, status says `not observed` and why (`--json`: `{ "kind": "not-observed", "reason": … }`), with exactly one of these reasons: `no persisted completion result`, `the persisted completion result carries no owner verification`, or `the persisted completion result is unavailable: …`.

When the suite rejected the Wave for owner verification, the next action names the invariant and the remedy. The gate's own diagnostic carries one line per finding with the same remedy.

**Remedies:**

| Finding | Meaning | Remedy |
|---|---|---|
| missing siblings | the matrix test's imports do not reach the named owner/sibling paths | strengthen the matrix test to import each named path (directly, or through a re-export barrel); importing a module that itself imports the owner does not count |
| red baseline | the matrix test fails against the unmutated workspace, so no mutant ran | fix the failing testcases the diagnostic names |
| survivor | a mutant at `<owner>:<line>:<column>` (`<operator>`, original and mutated text shown) was not killed | strengthen the matrix test to kill it, or declare a mutation exemption with a reason on the invariant |
| `plan-unreadable`, `plan-malformed` | the named plan cannot be re-read, or it has strays or malformed ownership, or an owned invariant names a path in two roles | restore the plan file; fix the named declaration |
| `plan-drift` | the plan's owned invariants differ from the stamp, or a named owner is not a file in the workspace (the stamp names a path the Wave no longer has, so the stamp, not the filesystem, is what is out of date) | restore the plan's owned invariants (or the owner file), or re-populate the TaskGraph from the plan |
| `alias-config-unresolvable` | the matrix test's import graph cannot be resolved because the tsconfig that governs it does not parse, or has a malformed `extends`, `baseUrl` or `paths`; the plan itself is fine | fix the tsconfig/path alias configuration the detail names (the nearest `tsconfig.json` above the matrix test and its `extends` chain); re-run the gate |
| `runner-missing` | the frozen manifest has no `affectedRunner`, or it cannot run the matrix test | install the runner and re-populate, or exempt the invariant |
| `missing-wave-base` | a Wave Task listing the owner records no `start_sha`, or the base or the owner at it cannot be read, or the owner at the base is not a regular-file blob (a symlink, a gitlink or a directory: its bytes are not the owner's text, so the changed lines cannot be trusted) | make the recorded base commit reachable (fetch full history); a Task with no `start_sha` gets one when its implementation is dispatched; for an owner that was not a regular file at the base, name the real module as the owner, or declare a mutation exemption with a reason |
| `spawn-failed`, `report-missing`, `report-unreadable`, `matrix-test-not-collected`, `exit-unexplained-by-report`, `baseline-timed-out` | the runner could not give a trustworthy JUnit verdict for the matrix test | fix the runner (it must write a fresh JUnit report naming the matrix test's file, and exit 0 when it passes) or the matrix test's runtime; raise the runner timeout for a slow baseline |
| `worktree-failed` | the isolated copy could not be set up or removed, or failed during a run (the detail names a leftover worktree when a failed run also could not clean up) | check disk space, `git worktree list`, and stale worktrees (`git worktree prune` runs on each removal); remove a named leftover directory; re-run the gate |
| `coverage-bound-exceeded` | the matrix test's import frontier exceeded 512 files | import the entry points more directly |
| `owner-unparseable` | the owner module has syntax errors (the detail lists them as `line:column message`), so its mutation sites cannot be trusted | fix the syntax errors in the owner; a `.tsx`/`.jsx` owner must carry that extension to be parsed with JSX |
| `no-valid-mutants` | mutants were generated, but every one only failed to collect (a collection or import error), so the matrix test gave no mutation evidence | fix what makes the mutated owner fail to load in the matrix test (an import-time side effect, a module-level throw), or declare a mutation exemption with a reason |
| `repository-file-unreadable` | a file the check must read (a matrix test, an import it reaches, a tsconfig, the owner) exists but the filesystem refused it: `EACCES`, a symlink loop (`ELOOP`), `EIO`, `EMFILE`, `ENAMETOOLONG`; the detail names the path and the error. It is never reported as a missing sibling | fix the named path's permissions or link, free file descriptors, or shorten the path; re-run the gate |
| `real-workspace-changed` | the real workspace digest differs after the run, or could not be observed (the observer failed or threw) | find what changed the workspace during the gate (a parallel writer) and re-run |
| `unexpected-error` | a step built to return its failure as data threw anyway (an engine defect or an unanticipated exception), or an injected owner runner threw; the detail names the step and the error. The workspace digest is still compared, so a changed workspace reports `real-workspace-changed` instead | re-run the gate; if it repeats, report it with the detail, which names the throwing step |

Every infrastructure failure blocks and never counts as a kill. A rejection whose only infrastructure failures are the owner check's, with no semantic failure, is published as an attempt record beside the result slot (`completion-suites/<suite>/<workspace>.owner-infrastructure/<sha256>.json`), so the evidence persists and a retry at the same workspace runs the check again. There is no automatic retry: re-run the Wave Gate. A rejection that also carries a semantic failure is published in the result slot and replays as rejected.

**Declaring a mutation exemption after population is plan drift.** The exemption is part of the stamped obligation, so adding `**Mutation exemption:** <reason>` to the plan mid-flight makes the next gate block with `plan-drift` until the TaskGraph is re-populated, which resets every Task to `pending`. Prefer strengthening the matrix test; decide exemptions in the architecture phase.

**Limits, stated honestly:**

- A runtime import is proof of load, not of exercise. A matrix test that imports a sibling but never drives the rule through it passes coverage. A type-only import is erased at runtime and is not even proof of load, so it never counts.
- Mutation covers the owner's lines changed in the Wave only: never siblings, never unchanged lines, never other files. A Wave that changed only a sibling runs the baseline and zero mutants (`owner unchanged in Wave`). A changed line with no construct the six operators rewrite yields zero mutants and says so.
- Invalid mutants are neither killed nor survived; status and the verdict show the invalid count. A run whose every generated mutant is invalid blocks as `no-valid-mutants` (infrastructure, never a pass or a kill).
- A matrix-test-only change does not trigger coverage or mutation.
- Reviewers get the owner map and second-copy rule only in Wave review packets of the code-reviewer and architecture-tech-lead for Tasks touching an owned family. Such a Task is issued six reviewers, not five: architecture-tech-lead (profile `focused-review`, Skill `deepen`) is appended after the base five, and the Wave does not complete until it settles too (ADR-0047). Every other Task keeps exactly the base five. An identical second copy is advisory; whether a copy diverges is the reviewer's judgment, checked by the Refutation Panel. Standalone reviews carry no owner map.
- `typescript` is loaded at runtime by the two owner-verification seams (`core/owner-verification/mutation-plan.ts`, `core/owner-verification/import-graph.ts`). It is declared an engine runtime dependency (`engine/package.json` `dependencies`, `^5.9.0`; it was already the engine's compiler, so no package was added) and installed by the documented `(cd engine && bun install --frozen-lockfile)`. The `5.9` floor is load-bearing: type-only import detection reads `ImportClause.phaseModifier`, which older compilers lack. An engine checkout without its locked install cannot run the Wave Gate.

### Measuring second sites: the family-site metric

`helper family-sites` counts the raw sites each known invariant family still has outside its owner modules. It reads every `.ts` file under `<root>/engine/src`, excludes test files and each family's owners, skips comment lines, and matches line patterns defined once, in `FAMILIES` (`engine/src/core/family-sites.ts`). It is read-only: no State File, no writes.

```bash
bun "$LOOM_PLUGIN_ROOT/engine/src/cli.ts" helper family-sites            # human report
bun "$LOOM_PLUGIN_ROOT/engine/src/cli.ts" helper family-sites --json     # JSON, byte-identical for the same bytes
bun "$LOOM_PLUGIN_ROOT/engine/src/cli.ts" helper family-sites \
  --baseline docs/family-sites.baseline.json                             # per-family delta since the baseline
bun "$LOOM_PLUGIN_ROOT/engine/src/cli.ts" helper family-sites --json \
  --root /path/to/other/checkout                                         # measure another checkout
```

`--root` defaults to the Loom package that owns the engine, so the metric measures Loom itself wherever it is run from.

**Baseline.** `docs/family-sites.baseline.json` was recorded with `--root` against a detached worktree of `626db7fb`, the `main` merge the G5b owner-enforcement feature started from:

| Family | Owner modules | Raw sites at `626db7fb` |
|---|---|---|
| `fail-closed-path-probes` | `engine/src/utils/path-presence.ts` | 124 |
| `shell-tokenizing` | `engine/src/core/shell-{quoting,command,normalize,substitution,write-targets,ansi-c}.ts` | 23 |
| `claim-conservation` | `engine/src/core/findings.ts` | 13 |

A delta marks a family whose patterns changed since the baseline, so a count moved by re-calibrated patterns is not mistaken for consolidation. The patterns are line regexes: the count is a gauge of consolidation progress, not a proof, and the metric blocks nothing. Consolidating the sites is separate work.

### Acceptance Stop Check (claimants)

When an implementation agent that claims a frozen Acceptance Contract's Requirement tries to stop, the engine runs that contract's acceptance files before settling the Task. If a testcase the agent owes is still not passing, the stop is blocked and the same agent keeps working with the failures in front of it. A testcase is owed when it decides one of the agent's claims and all its anchors are due by the Task's Wave.

- **Opt in** with a schema-2 `.loom/verification-manifest.json` that declares an `acceptanceRunner`. The runner is frozen at population, like the project checks:

  ```json
  {
    "schemaVersion": 2,
    "kind": "loom-verification-manifest",
    "checks": [ … ],
    "acceptanceRunner": {
      "executable": "vitest",
      "args": ["run", "--reporter=junit", "--outputFile=.loom/completion-reports/acceptance.junit.xml", "{files}"],
      "cwd": ".",
      "timeoutMs": 120000,
      "report": { "kind": "required-file", "path": ".loom/completion-reports/acceptance.junit.xml" }
    }
  }
  ```

- **The command.** `{files}` must be exactly one whole argument; the engine replaces it with the acceptance file paths, one argument each, written relative to the runner's `cwd` (with `"cwd": "engine"`, `engine/tests/x.test.ts` is passed as `tests/x.test.ts`). An owed file outside `cwd` cannot be named, so the check notes it and does not decide. The executable, argv and report follow the project-check rules: the allowlist, no shell, and a report beneath `.loom/completion-reports/` that no Wave check also uses. `timeoutMs` is at most 240000, inside the SubagentStop hook's 300 s timeout.
- **Silent when off.** With no runner, or no owed testcase, the check does nothing and says nothing.
- **Fails open.** In each of these cases the stop proceeds, the operator gets a `systemMessage` saying why the check did not decide, and the orchestrating session gets the same note (see [Stop-check notes reach the orchestrator](#stop-check-notes-reach-the-orchestrator)):
  - another claimant's check holds the runner;
  - the runner cannot start or finish, times out, or is killed by a signal (a killed runner's report is partial, so it is not judged);
  - the report is missing or changed;
  - the report has no testcase of the acceptance files;
  - the block counter cannot be read;
  - the agent has reached its 3-block cap;
  - the check itself fails.

  A runner lock that will not release is appended to the note, or turns a pass into a note.
- **One run per repository at a time.** Every claimant shares the runner's one report path, and the runner resets that file before each launch. Checks are therefore serialized by a lock under the subagent directory. If a claimant stops while a sibling's check is running, its own check does not run, and the Wave Gate judges that claimant. A lock whose holder process has exited, or that is older than the longest permitted run plus 60 s, is reclaimed. Reclaiming renames the lock aside and deletes it only if it still holds the stale bytes. If another stop reclaimed it first and took a fresh lock, the renamed lock is linked back and this stop does not run.
- **Cap.** An agent is blocked at most 3 times; its next stop proceeds with a `systemMessage` naming the cap. The count is kept per spawned agent under the subagent directory, never in the TaskGraph, and is cleared once that agent's stop proceeds.
- **Not completion evidence.** Nothing is recorded as a test result or proof; the Wave Gate's completion suite stays the only authority.
- **Pi is report-only.** Pi settles after the subagent has ended, so the outcome is an operator note and part of the subagent result the parent model reads. It never blocks.

### Affected-Test Stop Check

Whenever any implementation agent stops, claimant or not, the engine runs the tests affected by the files that agent changed (I7). It runs them through the operator-declared `affectedRunner`, after the Acceptance Stop Check. If an affected test fails, the stop is blocked and the same agent keeps working, with each failing test and its file in front of it.

- **Opt in** with two optional keys in a schema-2 `.loom/verification-manifest.json`. Both are frozen at population and covered by the manifest digest:

  ```json
  {
    "schemaVersion": 2,
    "kind": "loom-verification-manifest",
    "checks": [ … ],
    "affectedRunner": {
      "executable": "npm",
      "args": ["run", "test:affected", "--", "{files}"],
      "cwd": "engine",
      "timeoutMs": 120000,
      "report": { "kind": "required-file", "path": ".loom/completion-reports/affected.junit.xml" }
    },
    "testFileSuffixes": [".test.ts", ".spec.ts"]
  }
  ```

  - Loom's own manifest uses this form. `npx` is not on the allowlist, and `npm` must name a script (`run`, `test`, `check` or `build`), so `vitest related` goes through the engine's `test:affected` script. `{files}` reaches the runner relative to its `cwd`.
  - `affectedRunner` gets the same form checks as `acceptanceRunner`: the allowlist, no shell, `{files}` as one whole argument, and a `required-file` JUnit report beneath `.loom/completion-reports/`. Two further rules apply. `timeoutMs` is at most 240000, the same cap as the acceptance runner's: a change set touching a hub module can select thousands of related tests (Loom's own `handler-routes.ts` took 138 s). Because the affected runner launches only when the time left holds its whole timeout, its `timeoutMs` plus the acceptance run's actual duration must fit in 270 s. Loom's own manifest declares 200000, which leaves 70 s for the acceptance run. The report path must differ from the `acceptanceRunner`'s and from every Wave check's.
  - `testFileSuffixes` is a non-empty list of distinct suffixes, none containing a path separator. Without it, the freeze records the engine default (`.test.ts`, `.spec.ts`, `.test.tsx`, `.spec.tsx`) as `testFiles: { source: "engine-default", … }`. The same classification decides I6's test and implementation files.

  A manifest change reaches only TaskGraphs populated after it. The digest of a TaskGraph frozen earlier never changes.
- **Changed files.** The changed files are the attempt epoch's ledger `FileWrite` paths, deduplicated in first-write order. Paths outside the repository are dropped, and so are paths absent at stop time, such as a deleted file. A renamed file appears under its new path, because a literal `mv`, `git mv` or `cp` mints a write for its destination. Only files beneath the runner's `cwd` are passed. Each is one argument, written relative to the `cwd`. A file written with no ledger event, for example by an interpreter or a generator, is not a changed file.
- **Silent when off.** With no `affectedRunner` frozen, the check does nothing and says nothing.
- **Fails open.** In each of these cases the stop proceeds, and a note names the cause to the operator (`systemMessage`) and to the orchestrating session:
  - no changed files, or none beneath the runner `cwd` (the note lists the files outside it);
  - the command cannot be formed for the changed files;
  - the runner cannot start or does not complete;
  - the runner times out or is killed;
  - the runner leaves no readable report;
  - another stop holds the runner lock;
  - the repository root is unavailable;
  - the block counter is unreadable;
  - the agent has reached its 3-block cap;
  - the check crashes.

  A report with zero testcases passes, and the stop notes it.
- **Expected-RED acceptance failures do not block.** A contract Wave writes acceptance tests that must fail until later Waves implement them, and an affected run can select them. The check excuses exactly the failures the Wave Gate excuses, by the same rule: a collected failure in an owed contract's acceptance file during the contract's Wave, or after it while every anchor the testcase names is still pending. When those are the only failures, the stop proceeds with a note naming them (`its only failing tests are acceptance tests this Wave expects to fail`), and no block is counted. When other tests also fail, the stop blocks for those alone, and the block message lists the excused acceptance failures under `Not blocking — acceptance tests this Wave expects to fail (the Wave Gate's rule):`. An acceptance file that fails to collect, a due or unanchored acceptance testcase, and a contract whose RED was never observed still block.
- **Budget.** Both checks run inside the SubagentStop hook's 300 s timeout, minus a 30 s reserve for settlement. The affected runner launches only if the remaining time holds its whole `timeoutMs`. Otherwise the stop notes that the budget was exhausted. The timeout is never clipped.
- **One lock, one message.** The acceptance check and the affected check run in sequence under one acquisition of the per-repository runner lock described above. Each report is read back digest-checked while the lock is held. When both checks fail, the agent gets one block message with an `## Acceptance stop check` section and an `## Affected-test stop check` section. Under the affected heading, each failure reads `- '<name>' (<file>) — failed` or `- '<name>' (<file>) — failed to collect`.
- **Separate caps.** Each check has its own per-agent counter (`*.acceptance-stop-check.json` and `*.affected-stop-check.json`), each capped at 3 blocks. A check's counter increases only when that check contributes failures to a block. Both counters clear when the stop proceeds.
- **Not completion evidence.** No affected-run fact reaches settlement, proof, receipts or Wave Gate evidence. A test proves this by settling the same Task under every affected outcome and finding byte-identical proof and receipts.
- **Pi is report-only.** The Pi parent runs both checks over the child's epoch in the parent ledger after the child has ended, and reports the outcome as below. It never blocks.

### Stop-check notes reach the orchestrator

A stop check that fails open, or reports only, leaves a note naming the cause. That note is the only trace of a check that did not decide, so it goes to the orchestrating session as well as the operator.

- **Claude Code.** A SubagentStop `systemMessage` reaches the operator's terminal but never the orchestrating model. So the dispatcher also writes the note to `<LOOM_SUBAGENT_DIR>/<session>.<agent>.stop-check-note.json` before settlement, so a settlement failure cannot lose it, and names it in any settlement or cleanup error. The `surface-stop-check-notes` PostToolUse hook on the orchestrator's `Task`/`Agent` calls takes every note of its session, deletes each one, and adds them to the model's context as `additionalContext`, under the heading "Loom stop checks did not decide, or reported only, for these Tasks". It also shows them to the operator.
  - A foreground spawn's note is waiting when its call returns.
  - A background spawn's PostToolUse fires at launch, before its stop, so its note arrives with the next `Task`/`Agent` result.
  - A claimed sidecar is renamed before it is read, so concurrent hooks never deliver a note twice. An unreadable sidecar is named once and removed. An undelivered note is swept with the other runtime files after the stale-subagent TTL.
  - The shim skips the bun spawn when no note sidecar exists at all.
- **Pi.** The parent settles after the child has ended. Each report line goes to the operator through the extension's operator sink: to the UI when there is one, otherwise to stderr as a `[loom]` line. The lines are also appended under the same heading to the subagent tool result the parent model reads. When settlement raises processing errors, the notes follow the error text that replaces the result.

### Pi evidence ledger recorder

A Pi implementation child records its own tool calls into the parent session's evidence ledger, under the epoch of its parent-issued write grant. It uses the same minting rule as Claude Code's PostToolUse recorder (`machine/tool-evidence-recorder.ts`), so I6 settlement and the I7 stop check on Pi read the same kind of facts as on Claude Code.

- **Ledger address.** The parent puts the ledger address (its session and the spawn item's agent type) into the grant at spawn. The grant MAC binds it.
- **No valid grant, no record.** A child with no grant, a rejected grant, or a binding that survives only as cleanup debt records nothing. It prints one stderr note per reason. Plain Pi sessions and the parent stay quiet.
- **Exit codes.** Pi 0.83 and 0.84 expose no bash exit code. The recorder reads an error result as exit 1 and a clean one as exit 0. A result ending in Pi's abort or timeout status line counts as interrupted.
- **Plan view.** `helper stop-check-plan` cannot resolve a Pi child's epoch from a separate process, so for a Pi run it shows no changed files.
- **No live gate.** The live phase gate is still absent on Pi; only recording was added.

### Population refuses the spec or a Requirement id

`populate-task-graph` proves the authored trace against the Spec Index before writing anything. It refuses, naming the cause:

- a declared `spec_file` that cannot be read, is not UTF-8, or does not parse as a canonical specification (every required section, including `## Appendix: Glossary`), even when no Task claims from it;
- a Task whose `spec_anchors` or `spec_contributions` name an id the Spec Index does not define as a completable FR or AS entry (`NFR-`, `SC-` and Out-of-Scope ids included), listed as `T3 → NFR-001`;
- any Requirement trace when the plan has no `spec_file`.

Fix the specification or the decompose output and re-run population. The rule is the one `amend-spec-trace` applies to added ids (`unprovenRequirementTrace`), so an id population admits is one the Implementation Brief can render.

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

On success, one immutable `SpecTraceWaveGateRetirement` audit preserves the old run id, Wave, authority digest, revision, runs root, and exact abandonment reason/supersession. The same locked commit installs trace v2 and retires the run's review authority as a successor install would, except that another Wave's `spec_check` and its block are left alone: it clears `active_wave_gate`, `wave_review_epoch`, `active_wave_completion_suite`, the retired Wave's `spec_check`, the Wave's in-flight `review_run`s, and review acceptance granted by the abandoned run (those reviews reopen), and re-derives the retired Wave's block. Tasks, proofs, Findings, Review Generations, Refutations, Resolutions, issued packets, completed/orphan retirement history, and implementation evidence remain intact, so the next `start wave-gate` installs cleanly. An exact replay does not append another audit; a different mapping remains refused.

### Amending a v2 Requirement trace

A populated v2 graph whose Completion Claims or Contributions are wrong (a Requirement claimed by the wrong Task, a missing Contribution) is corrected in place, not by `populate-task-graph --force`. Re-population resets every Task to `pending` and discards all settled implementation, review and refutation results; an amendment keeps them. Prepare the same exact-roster JSON as the legacy upgrade, every Task once in protected order, then:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper amend-spec-trace \
  < /path/to/exact-trace-ownership.json
```

Arrays compare as sets, so a reordering is not an amendment and an exact replay writes nothing. The helper refuses, without writing, when:

- the input is not the exact Task roster in order, or a Task's array repeats an id;
- the graph is legacy (use `upgrade-spec-trace`) or not in the execute Phase;
- any Task is executing or a subagent is active;
- a Wave Gate is live: its review packets froze the old trace, so first run `helper orchestration abandon` on it. A `terminal-abandoned` tombstone is accepted and retired; a legacy terminal (`done` or `terminal-blocked`) registration is refused too and must first be migrated to terminal history;
- any Task in a completed Wave (`wave_gate_history`) would change. Completed Waves are verified scope, so moving a Completion Claim into or out of one is refused too;
- an added id is not a completable FR/AS entry in the Spec Index observed now, or that Spec Index is unavailable (fail closed; removals still apply), or `spec_file` moved during the call;
- the result breaks v2 ownership (`parseSpecTraceContract`).

On success, one locked write:

- replaces only the changed Tasks' `spec_anchors`/`spec_contributions`;
- keeps the recorded Requirement Content Hash of every retained Completion Claim (drift evidence survives), mints one from the observed Spec Index for every added claim, and drops removed claims' hashes;
- retires the current Wave's trace-derived review authority. Over an abandoned tombstone this is what a successor gate install does: it clears `review_run`, the current Wave's `spec_check`, `wave_review_epoch`, `active_wave_completion_suite`, the tombstone, and review acceptance granted by that run, and re-derives Wave blocks. Another Wave's `spec_check` and its block are left alone. With no gate registered, the same reset runs only if some of that review state is left for the current Wave; otherwise nothing else changes, so an older Wave's `spec_check` survives;
- appends a `spec_trace_amendments` audit naming the Wave, the retired run (or `null`), each change before and after, and the Spec Index observation.

Task status, proof, attempt history, test evidence, Findings, Refutations, Resolutions and completed history are untouched, so nothing is re-implemented. Start the Wave Gate next: it issues fresh packets over the amended trace, and spec-check and reviewers judge the new scope. The State File boundary refuses a graph whose trace contradicts a Task's latest amendment, or whose amendment history for a Task does not chain, and re-population drops the audit together with the Tasks it described.

### A frozen acceptance test or contract types file is wrong

An Acceptance Contract's frozen paths (its types file and acceptance tests) change only through an operator Contract Revision. A Wave Gate that finds them changed blocks with `frozen acceptance drifted: CT-n '<path>' changed`; a claimant that finds a frozen test wrong stops and reports it. Either restore the frozen bytes, or edit the frozen files yourself and record the revision:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper revise-contract \
  --contract CT-1 --reason "AS-003 asserted the wrong error variant"
```

The helper hashes the frozen paths as they are now, then commits under the TaskGraph lock. It refuses, without writing, when:

- the arguments are not exactly `--contract CT-<n>` and a non-blank `--reason` of at most 512 characters;
- the contract is not in the TaskGraph, or the graph is not in the execute Phase;
- any Task is executing or a subagent is active;
- a Wave Gate is live — abandon it with `helper orchestration abandon` first; an abandoned tombstone is accepted and retired;
- the contract is still `awaiting-red`: its contract Task owns the files until its Wave Gate observes them red;
- the contract Wave has not completed;
- any Task claiming a covered Requirement sits in a completed Wave — that Wave was verified against the old bytes, so reopen it first (`helper reopen-completed-wave`, above);
- a frozen path is missing or unreadable (the refusal names the read error, e.g. a symlink the no-follow read refuses), or the bytes did not change;
- the contracts changed between the helper's observation and its lock, so it never read a path the locked contract freezes (`observation-stale`) — retry.

On success, one locked write:

- sets the freeze to `revised` with the new digests and appends a numbered revision (reason, previous and new digests, revalidated Task ids) — the old bytes stay auditable;
- returns the current Wave's `implemented` claimants to `pending` with `revalidation_required`, keeping their proof and incrementing their review generation, exactly as a reopened Wave does — re-spawn them before starting the Wave Gate;
- retires the current Wave's review and suite authority (`active_wave_completion_suite`, review runs, the Wave's spec-check) and resets its `tests_passed` and `reviews_complete` — and its `impl_complete` too when any claimant was returned to revalidation.

The next Wave Gate judges the contract green against the new bytes and re-records its roster, which freezes it again.

### Where does each Acceptance Contract stand?

Before revising a contract, or to see which acceptance testcases are still allowed to fail, print the Contract Status:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper contract-status
```

It takes no arguments. For each Acceptance Contract, in TaskGraph order, it prints:

- `CT-n  <title>  (contract Task Tn)`;
- the freeze state: `awaiting RED`, `frozen at Wave N` followed by every roster testcase as `<file> › <name> — <anchors>`, or `revised (k revisions); roster cleared until the next Wave Gate re-records it` followed by the re-stamped paths;
- each covered Requirement as `AS-00n due Wave N` (the latest Wave of a Task that claims it) or `AS-00n unclaimed`;
- `revisions: k` when the contract has any Contract Revision.

A TaskGraph without contracts prints the single line `no Acceptance Contracts`. The helper is read-only: it never writes the State File and never takes its lock, so it is safe while a Wave Gate is live or a subagent is active. Set `LOOM_STATE_PATH` to read a non-default graph. It exits 1 with `No task graph at <path>` when no TaskGraph exists, and with the load boundary's error when the graph is unreadable or corrupt — a corrupt graph is never reported as missing.

### What will the stop checks run at a Task's stop?

Before dispatching a Task, or when a stop check keeps an Agent working and you want to see why, print the Stop-Check Plan for that Task. It covers both the Acceptance Stop Check and the Affected-Test Stop Check:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper stop-check-plan --task T2
```

It takes exactly one argument, `--task <id>`. When the check is on, it prints:

- `T2 (Wave 2): acceptance stop check on`;
- each owed testcase, grouped under its contract id, as `  <file> › <name>`. A roster testcase is owed only when every anchor it carries is due by the Task's Wave;
- `files:` followed by each owed acceptance file, repository-relative;
- `cwd: <runner cwd>`, then `argv: [...]` as JSON, with `{files}` already expanded so each owed file is one argument relative to the cwd, then `report: <report path>`.

When the check is off, it prints one line, `T2 (Wave 2): acceptance stop check off — <reason>`. The reason is one of: no acceptance runner is frozen in the TaskGraph, the Task owes no frozen acceptance testcase due by its Wave (a contract still awaiting RED owes nothing), or the runner command could not be formed for the owed files. In the last case the runner's refusal follows on indented lines.

An `affected tests:` section follows the acceptance lines. When the affected check is on, the section prints:

```text
affected tests:
  changed files:
    <file>              one line per file the runner gets, in first-write order
  cwd: <affected runner cwd>
  argv: [...]           {files} expanded, each file relative to the cwd
  report: <report path>
```

When the affected check is off, the section prints `  affected stop check off — <reason>`. The reason is exactly one of these, in this precedence:
1. no affected runner is frozen in this TaskGraph;
2. this Task's attempt has no changed files beneath the affected runner cwd. Each changed file outside the cwd follows on its own line, as `outside the affected runner cwd: <file>`;
3. the affected runner command could not be formed for the changed files. The refusal follows on indented lines.

The helper reads the changed files from the Task's live attempt, read-only, through the same `changedFilesAtStop` derivation the hook uses. On Claude Code, the live attempt is the one implementation sidecar naming the Task, read from the session ledger. With no live attempt, which includes every Pi run, there are no changed files. A live attempt whose ledger epoch cannot be read exits 1 with the cause, so it never reads as "no changed files".

The plan is `planStopChecks`, the one pure function both live checks decide from, on Claude Code and on Pi. So whenever a check's plan reads `off`, that check skips, or for a refused command it notes the refusal and runs nothing. When it reads `on`, the check would launch exactly the printed argv from the printed cwd. A parity matrix test runs the hook, the Pi stop and the helper over the same fixtures to pin this. At the stop itself the live checks also consult per-stop state the plan does not read: each check's block counter (after 3 blocks that check stops blocking), the repository root, the runner lock (another stop may hold it), and, for the affected check, the remaining hook budget. When one of those stops the check, the hook emits a note, the stop proceeds, and the plan still reads `on`. The helper never runs the runner. It is read-only: it never writes the State File and never takes its lock, so it is safe while a Wave Gate is live or a subagent is active. Set `LOOM_STATE_PATH` to read a non-default graph. It exits 1 on any of these:

- `--task` is missing or has no value, or an argument is left unconsumed;
- no TaskGraph exists (`No task graph at <path>`);
- the graph is unreadable or corrupt (the load boundary's error; a corrupt graph is never reported as missing);
- the Task id is not in the TaskGraph (`No task <id> in the TaskGraph`). A typo never reads as "nothing owed".

### Where does a Task stand on I6?

Use this before dispatching a Task, while its attempt is live, or after it fails with `proof:red-then-green-unproven:<gap>`. It prints the Red-Then-Green Status for that Task: whether the Task owes I6, how settlement splits its files, what the live attempt shows so far, and what the frozen Proof stores.

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper red-then-green-status --task T1
```

It takes exactly one argument, `--task <id>`. The output has four parts, always in this order.

**1. Header.** One line, `<id> (Wave N, <status>): ` followed by one of:

- `owes I6`;
- `I6 not owed — <reason>`, where the reason is the first of these that applies:
  - `TaskGraph predates I6`: the frozen manifest carries no `testFiles`;
  - `writes Acceptance Contract <id>'s frozen files; the contract gate's red window is its red evidence`: the Task is that contract's contract Task, which never owes I6 (see [Task fails I6](#task-fails-i6-red-then-green));
  - `claimant (acceptance contract)`: the Task is an Acceptance Contract claimant, which waives its new tests;
  - `new tests waived: <reason>`: any other new-test waiver, for example `new tests waived: documentation-only`;
  - `the frozen Proof carries no red-then-green obligation`: the Task requires new tests, but its frozen Proof owes no I6. The State File's load check makes this unreachable for a graph it admits; the line exists so every not-owed answer has a reason;
- `I6 undeterminable — <reason>`: the Task's test-file classification or its Proof is not frozen yet, so settlement could not decide either.

The reason only explains a `not owed` answer. The decision itself is `redThenGreenDuty`, the function settlement uses.

**2. Files.** This part is printed only when the header reads `owes I6`. It shows the same split settlement judges by (`classifyTaskFiles`), with each list in `file_list` order:

```text
test files:
  <file>
implementation files:
  <file>
```

An empty list prints as a single line, `test files: none` or `implementation files: none`. When you see `test files: none`, the Task fails with `no-test-files` (see [Task fails I6](#task-fails-i6-red-then-green)).

**3. Live attempt.** This is the I6 judgment over the epoch of the live Claude Code attempt so far, computed by `judgeRedThenGreen` exactly as settlement calls it. It prints one of:

- `live attempt not observable on this harness`: under Pi. The live attempt is never inspected;
- `live attempt: none`: no implementation sidecar names the Task;
- `live attempt: uninspectable — <reason>`: no readable sidecar names the Task, but some implementation attempt sidecars could not be read, so a live attempt may be missed;
- `live attempt: unreadable — <reason>`: an attempt is live but cannot be judged. Either several live attempts name the Task, the attempt is rostered without a parseable role, its ledger epoch cannot be read, or the repository root cannot be resolved;
- `live attempt: not judged (no I6 obligation to judge it by)`: an attempt is live, but the header reads `I6 not owed` or `I6 undeterminable`, so there is no obligation to judge it against;
- `live attempt: shown`, followed by the three facts in order:

  ```text
  live attempt: shown
    red #<index> <command>
    first implementation write <path>
    green #<index> <command>
  ```

- `live attempt: proof:red-then-green-unproven:<gap>`, with ` (untrusted runs only)` added when the gap's `untrustedOnly` is true. The gaps are listed in [Task fails I6](#task-fails-i6-red-then-green).

Only a `shown` judgment carries ledger references. `#<index> <command>` names a qualifying run: `index` is the run's 0-based position in the epoch's ordered events, and `command` is that run's command. For an unproven judgment the helper prints only the gap. It does not show references for steps met before the gap, because the judge returns none and inferring them would re-derive the judgment.

**4. Stored result.** This is the red-then-green result recorded in the Task's frozen Proof. The Proof holds each obligation's latest evaluation, so a Task pending a retry shows its latest gap. It prints one of:

- `stored: no proof (legacy)`: the Task carries no frozen Proof;
- `stored: no red-then-green obligation`: the frozen Proof owes no I6;
- `stored: pending`;
- `stored: shown`, followed by the same three indented `red`, `first implementation write` and `green` lines as a live `shown`;
- `stored: proof:red-then-green-unproven:<gap>`: the failure kind settlement wrote to the receipt. A Proof failure other than an I6 gap reads `stored: proof:<kind>`.

Problems with the live attempt (an uninspectable sidecar set, several live attempts, an unreadable epoch, an unresolvable repository root) and an undeterminable duty each print as their own line, and the helper still exits 0. It exits 1 only in these cases:

- `--task` is missing or has no value, or an argument is left unconsumed;
- no TaskGraph exists (`No task graph at <path>`);
- the graph is unreadable or corrupt. The load boundary's error is printed, and a corrupt graph is never reported as missing;
- the Task id is not in the TaskGraph (`No task <id> in the TaskGraph`). A typo never reads as "not owed".

The helper is read-only. It never writes the State File, the ledger or the runtime directory, and it never takes the TaskGraph lock, so it is safe to run while a Wave or a Wave Gate is live or a subagent is active. Set `LOOM_STATE_PATH` to read a non-default graph.

### State is malformed

Use only when the load boundary explicitly directs recovery:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper repair-task-graph
```

The repair path parses rejected bytes, applies conservative repair, refuses loss of Findings/audit data, validates both full and typed forms, installs atomically, and restores mode `0444`.

### Completing an orchestration

After the final Wave Gate, retire the TaskGraph:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper complete-orchestration
```

The helper refuses, listing every reason, unless the graph has Tasks, all of them `completed`, and no Wave Gate run is registered as active. Under the TaskGraph lock it publishes the exact graph bytes beside the live graph as `.claude/state/completed_task_graph-<issue|no-issue>-<UTC stamp>.json`. The publish is exclusive and whole: the bytes are prepared under a temporary name and hard-linked into place, so an existing archive is never overwritten and a partial archive is never visible. It then removes the live graph. The archive is published before the removal, so a failure leaves both files, never neither.

Every Loom guard keys on the live graph path: `block-direct-edits`, the Task/Agent spawn gates and the state guard. So they all lift, and a post-gate `/review-and-fix` can run in the same checkout. While a finished graph stays live, those guards stay on: Write and Edit into the Orchestrated Repository are refused, and spawns are phase-checked. `block-direct-edits` guards only the repository that owns the live graph, meaning the canonical root of the Git working tree holding the State File. Writes whose every symlink-resolved target lies outside that root are allowed. That covers a session scratchpad, another worktree of the same repository, and a sibling directory such as `<root>-other/`. Worktrees nested under the root (for example `.claude/worktrees/`) are still inside. A target or root the guard cannot resolve (a dangling symlink, malformed input, a `LOOM_STATE_PATH` outside Git and outside the documented layouts) stays guarded. The state directory keeps its separate state guard. See [ADR-0046](adr/ADR-0046-the-direct-edit-guard-protects-only-the-orchestrated-repository.md).

### Abandoning an orchestration

`/loom --complete` and `--abort` are not implemented lifecycle flags. To abandon an unfinished orchestration, use the guarded teardown, which keeps no copy:

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

## Rules gate (Claude Code and Pi)

One decision, two thin adapters. `engine/src/core/rules-gate.ts` (pure) holds the policy, full-read coverage, adherence check and block text; `engine/src/core/bash-code-mutation.ts` classifies Bash mutations. Each harness only maps its own evidence into the core's `TranscriptEvent`s:

| Harness | Adapter | Entry |
|---|---|---|
| Claude Code | `engine/src/handlers/pre-tool-use/claude-transcript-events.ts` (transcript JSONL → events) | `rules-gate` PreToolUse hook, `hooks/scripts/rules-gate.sh`, matcher `Edit\|Write\|MultiEdit\|Bash` |
| Pi | `pi/rules-gate.ts` (`buildContextEntries()` → events) | standalone Pi extension; `~/.dotfiles/pi/extensions/loom-rules-gate.ts` is a shim that loads it through the runtime loader |

`engine/tests/pi/rules-gate-parity.test.ts` runs one scenario matrix through both adapters and requires the same decision — change policy in the core only, and a drifting adapter fails there.

The gate blocks a code mutation until the Loom rules and skills are in the main agent's **current context**:

1. `rules/architecture.md` and the language rule for the target extension (`typescript-patterns.md`, `java-patterns.md`, `rust-patterns.md`) were fully `Read` — a `limit` skim does not count, and a read in the same assistant message as the edit does not count.
2. The `deepen` and `distill` skills were loaded: with the `Skill` tool (Claude Code), by the user's skill command (`/loom:deepen` on Claude Code, `/skill:deepen` on Pi), or by a full read of the skill's own `skills/<name>/SKILL.md`. The SKILL.md read is the path a Pi agent takes — Pi has no Skill tool. The block text names the mechanisms of the harness that raised it.
3. An existing target file was fully read, or written earlier in the session.
4. An assistant text line `LOOM: applying <rule|skill> — <how>` names a required rule or skill. A completed shell command carrying the marker (`: 'LOOM: applying …'`) also counts — commands are stored verbatim, while a harness may persist a rewritten copy of assistant prose that drops the line.

Evidence is read from the session transcript (`transcript_path`) and resets at the last compaction boundary, so after `/compact` the rules must be read and stated again. Non-code targets (`.md`, `.json`, …) are not gated. Bash is gated only through a path heuristic (redirects, `tee`, `cp`, `mv`, `sed -i`, `patch`, `rsync`, `install` onto a code file); an interpreter opening a file for write is not recognized.

Subagents are exempt — the orchestrator owns their compliance (Claude Code: `agent_id` present in the hook input; Pi: the `--mode json --no-session` process signature, or `LOOM_GATE_MODES` to choose modes explicitly). The Claude Code hook fails **closed**: an unreadable transcript or a missing runtime blocks the call.

| Env | Effect |
|---|---|
| `LOOM_GATE=off` | Disable the gate |
| `LOOM_GATE_MODES=tui,rpc` | Pi only: gate just these modes (overrides the subagent exemption) |
| `LOOM_RULES_DIR=/path` | Rules directory (default: `rules/` of the owning Loom package) |
| `LOOM_SKILLS_DIR=/path` | Skills directory whose `<name>/SKILL.md` satisfies a skill requirement (default: `skills/` of the owning Loom package) |

The gate proves context and articulation, never genuine adherence; the substance of the `LOOM:` line is judged in review.

## Linter operations

### Scan a path

```bash
bun scripts/lint-project.ts engine/src
```

### Rule tiers

Regex rules run on every edit (the `immediate` tier, `lint-file` PostToolUse) and at the Wave Gate. Each programmatic rule declares its own earliest tier: `no-cross-boundary-imports` and `no-io-in-pure-modules` are `immediate`, so a forbidden import is refused when the file is written; the rest (`max-function-lines`, `exhaustive-discriminant-branching`, `no-nested-ternary`, `prefer-array-methods`, `fugue-generated-integrity`) run only in the `full` tier at the Wave Gate.

### Validate rule files

```bash
bun engine/src/cli.ts helper validate-lint-rules .claude/linter/rules
# Pi project:
bun engine/src/cli.ts helper validate-lint-rules .pi/linter/rules
```

A nonexistent directory is an error for explicit validation. Runtime loading, by contrast, treats an absent project rules directory as “no project overrides.”

See [Lint Rules](../lint-rules/README.md) for configuration and tiers.

### Advisory type diagnostics

After an Edit/Write/MultiEdit on a TypeScript source (`.ts`, `.tsx`, `.mts`, `.cts`; not `.d.ts`), Loom runs the project's own `tsc --noEmit --incremental` and gives the model:

- the touched file's diagnostics, each with a remedy for common error codes;
- errors this edit introduced in other files, judged against the previous run, so errors that were already there are not repeated. A second identical error on another line counts as new.

When the same diagnostics survive 3, 5 and 8 consecutive edits of a file, an escalating repeat reminder tells the model to stop patching and change approach.

It is **advisory and fail-open**: it never blocks an edit. Claude Code receives it as PostToolUse `additionalContext` (`hooks/scripts/type-diagnostics.sh`, 45s hook timeout). Pi appends it to the edit's tool result. Both harnesses go through `adviceForEdit` (`engine/src/handlers/type-diagnostics-edit.ts`) to `engine/src/handlers/type-diagnostics-runner.ts`.

- **Project and compiler:** the project is the nearest `tsconfig.json` above the file; the compiler is the nearest `node_modules/typescript` above that. Without either, the check is silent. A `tsc` that exits nonzero without printing diagnostics (a crash) is reported to the operator, never treated as a clean program.
- **Deadline:** a run waits up to 30s. A cold build that misses the deadline keeps running in the background to warm the cache, and the operator sees one note. Later edits take the warm path (seconds on this repository).
- **One run per project at a time:** a run slot (`<key>.slot` in the cache; `engine/src/handlers/type-diagnostics-run-slot.ts`) allows one check per tsconfig. A run that misses the deadline hands the slot to its detached build. A second edit while a check, or a detached cold build, is still running gets no advisory. A slot whose owner has died, is older than 10 minutes, or is unreadable is reclaimed. Every run writes its own output file.
- **Memory window:** the baseline and repeat counts live in the user cache and outlive a session. They count only within a 30-minute window, so an earlier session's edits never escalate the reminder or get blamed on this edit. If memory cannot be saved, the model still gets the diagnostics and the operator gets a note.
- **Pi timing:** lint and the type check share one `tool_result` handler, so on a cold build Pi's lint feedback waits for the type check, up to the deadline.
- **Pi operator notes:** notes go to the UI, or to stderr in a headless session.

| Variable | Effect |
|---|---|
| `LOOM_TYPE_DIAGNOSTICS=off` | Disable the check on both harnesses |
| `LOOM_TYPE_DIAGNOSTICS_CACHE=/path` | Build-info and repeat memory location (default `$XDG_CACHE_HOME/loom/type-diagnostics`, else `~/.cache/loom/type-diagnostics`) |

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

The development/CI baseline is a full-history Git checkout on a non-root account with Node **22.23.2**, the Bun release pinned in the repository-root `.bun-version` (the one pin, never restated elsewhere: CI installs it through `oven-sh/setup-bun` `bun-version-file`, and the verification preflight blocks a local Bun that differs), npm, Git, and jq. Linux additionally requires Bash **4+** and GNU `timeout` on PATH. The macOS 13+ CI job uses Apple's Bash 3.2 and does not require GNU coreutils; its runtime support includes anchored report reset through a re-proven parent path. Full history is required because deterministic tests resolve the committed model-calibration corpus against historical revisions available through remote refs. A normal full clone checked out on `main` contains those objects; for an existing single-branch shallow clone, fetch every remote head before verification:

```bash
git fetch --unshallow origin '+refs/heads/*:refs/remotes/origin/*' --tags
```

From the Loom repository root:

```bash
bun install --frozen-lockfile
(cd engine && bun install --frozen-lockfile)
npm run verify
```

Both locks are required: root dependencies supply Pi/runtime resources; engine dependencies supply the compiler and Vitest, and `typescript`, which the Wave Gate's owner verification also loads at runtime and which is therefore declared under `dependencies` (no new package: it was already the engine's compiler). `preverify` checks required tools, that `bun --version` equals `.bun-version` (`engine/scripts/bun-version-pin.ts`), executable local Vitest/Pi, and that Pi resolves to the root-local locked CLI through npm's PATH. No global/latest Pi or network-fetching compiler fallback is accepted. Local preflight checks tool availability and the exact Bun pin (a different Bun can pass where the pinned one fails (`fs.closeSync(1)` is a silent no-op on 1.3.13 but not on the pinned release)); it does not pin Node, which CI checks explicitly alongside Bun.

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

### Test hermeticity

A test that passes or fails because of the machine, the run order, or the seed is a defect. Fix its cause; never add a retry.

- **Temp files.** The global setup `engine/tests/setup/run-temp-root.ts` points `TMPDIR` at one fresh `loom-vitest-run-*` directory per run before any worker starts. Workers and the `bun`/`git` children they spawn inherit it, and the directory is deleted when the run ends. A killed run leaves that one directory behind. When the code under test refuses symlinked paths, make the fixture directory with `canonicalTempDir`, because the macOS temp root sits behind the `/var` symlink.
- **Shared directories.** `LOOM_SUBAGENT_DIR` keeps its production default `/tmp/claude-subagents`, because the guard tests pin bypasses against that literal path. That is the directory a live Claude Code session's hooks use. A suite that writes there uses unique session ids and registers each session for cleanup at the moment it creates the id (see `record-evidence.test.ts`). `pi-extension-review-events.test.ts` keeps its shared fixture under the Git-ignored `.loom/completion-reports/`, because its paths must sit inside the project; a killed run leaves one directory there. Its tests that write Task artifacts each build a throwaway Git repository under the run's `TMPDIR` (`withTaskGraphRepository`) and assert each artifact path lies outside the checkout before writing it. A killed run once left `.tmp-pi-*` files in the checkout, and a live orchestration read them as a Task's out-of-scope writes.
- **Host prerequisites.** `tests/pi/emission-installed-launcher.test.ts` needs the installed Pi subagent launcher under `~/.pi/agent/extensions/`. It is skipped only when `CI=true`; elsewhere a missing launcher fails loudly.
- **Git config.** A test that fakes the operator's global Git config sets `GIT_CONFIG_GLOBAL` as well as `HOME`, because an ambient `GIT_CONFIG_GLOBAL` replaces `$HOME/.gitconfig`.
- **Order.** Every test must pass in any order. When two tests are one observation split across a test boundary, the suite declares `describe(name, { shuffle: false }, …)`.
- **Property tests.** Most property tests take a fresh random seed every run. A counterexample that turns up on CI is a real gap in the oracle or the code: add it as an explicit example and fix the cause. Never pin a seed to hide it.

To check for environment dependence, run the unit suite under varied conditions and compare which tests fail:

```bash
cd engine
npx vitest run --sequence.shuffle --sequence.seed=<n>      # run order
TMPDIR=<path-through-a-symlink> npx vitest run             # macOS-style temp root
TZ=Pacific/Kiritimati LC_ALL=C npx vitest run              # time zone and locale
npx vitest run --maxWorkers=1 --minWorkers=1               # one worker, then many
HOME=<empty-dir> GIT_CONFIG_GLOBAL=/dev/null npx vitest run # no operator config
```

The 2026-10-13 sweep ran each of these, plus every property-test file twice at 20× its declared runs on fresh seeds and a whole run with the clock moved 400 days ahead. A failing test in the empty-`HOME` run is expected only for the installed-launcher prerequisite above. A clock-shifting run cannot check file freshness, because Node reads file times with a system call that `libfaketime` does not intercept. Under it, a file written a moment ago looks as old as the shift.

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
engine/src/orchestration/      anchored persistence, event journal, effects, Git remediation
engine/src/handlers/           harness/CLI shell
engine/tests/                  unit, property, integration, contract tests
scripts/                       sync, lint, calibration, smoke scripts
calibration/                   committed corpus; generated results are ignored
docs/family-sites.baseline.json  family-site metric baseline at 626db7fb
```
