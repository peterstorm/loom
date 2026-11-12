# ADR-0009: Version reviewer evidence at issued protocol authority

## Status

Accepted (2026-09-10). Implemented; merged in PR #49 (`96153edc3dd755b4ac648ed48920b6670753c5a6`). Successor: [ADR-0010](ADR-0010-standalone-finding-lineage.md).

## Context

Reviewer v1 supplied redundant markers, counts, findings blocks and Wave lifecycle
objects. Reconciliation preserved old evidence but let formatting failures become
synthetic product Findings. Confidence, factual wrongness and delivery impact also
needed distinct treatment. Prompt-only correction would leave redundant ingress;
a severity-dispute vote would add decision authority that was not approved.

## Decision

Fresh standalone and Wave registrations select Reviewer Protocol v2 internally:
**one JSON final payload**, engine-derived counts and IDs, and an impact rubric.
The independent durable registration, published request and Context Packet join
mints nominal `IssuedReviewerProtocol`. Output shape, agent name, self-hashes,
caller hints and parsing failure cannot select a decoder. Current packets freeze
exact generated schema and rubric bytes/digests; other Agent contracts remain
unchanged. The executable Zod schema generates both issued schema and the shared
fragment/seven stamped reviewer regions.

Criticals require six fields: claim plus basis evidence, violatedContract,
consequence, truthConfidence and severityRationale. Evidence can be a reproduction
or concrete execution trace; reproduction execution is not universally required.
Advisories require concise reason and may supply a complete basis. Accepted text,
entry order and explicit duplicates remain exact; attribution alone mints IDs.
Blocking means a concrete consequence to supported behavior, safety/authority,
explicit acceptance/verification obligations or safe operator use. Factual error,
confidence, style, shallowness or a missing test alone is insufficient. Structure
proves neither truth, impact, reachability, execution nor semantic test adequacy;
reviewer-reported execution is not an engine receipt.

The bounded codec requires fatal UTF-8, no BOM, strict JSON grammar and decoded
member-name uniqueness before strict schema admission. Limits are 1,048,576 final
bytes, 32 containers, 128 findings and 4,096 priors, with bounded narrative fields.
These bound semantic admission, not raw capture or whole-process allocation.
Wave joins exact packet/generation and complete ordered prior IDs. Malformed
current evidence refuses the entire response, creates no synthetic Finding or P3
obligation, and consumes only existing bounded retries. Attempt 2 is final.
Infrastructure observation failure remains unavailable at the same attempt.

### Dependency decision

The initial `json-bigint@1.0.0` proposal was rejected: eager stringify/numeric
initialization reaches `bignumber.js` ambient `Math.random()`, even with
`storeAsString:true`. It is not the implemented dependency.

The selected exact dependency is `jsonc-parser: "3.3.1"`, using native `JSON.parse`
for strict grammar and its visitor for decoded duplicate-member detection. Both
must succeed: no JSONC, repair, AST fallback or last-key-wins admission. Its actual
six-file UMD runtime closure has no production dependencies or entropy/I/O
initialization. The consumed Zod 4.3.6 ESM closure is independently pinned too.
Exact closure bytes/dependency edges and deterministic import/parse/schema
sentinels are audited in `machine-purity.test.ts`. Only the actual codec consumer
gets jsonc-parser and only the leaf gets `zod/v4`; no blanket package/core allowlist.
Zod's pinned dormant `randomString` export has no caller in the audited closure;
its exact-byte/line exception does not permit invocation, and the entropy sentinel
still rejects it. This is not a claim every dependency export is pure.

### Prerelease schema representation correction (adjudicated P4 repair)

Before any live current-v2 production authority was issued, JSON Schema generation
changed only `reused:"inline"` to `reused:"ref"`, retaining draft-2020-12, output,
unrepresentable-throw and cycles-throw. The same executable Zod schema, refinements
and bounds remain. Exact pretty schema bytes decrease from 57,099 to **10,257**
(5,721 compact); current schema SHA-256 is
`3ac3395301c1d38f41cd93accb19b942e832d7ebced990976335208259f40c37`.
Expanding local `$defs` references reproduces the inline schema in tests; the
issued-schema work bound is 12 KiB. This changes current descriptor/context bytes,
not historical v1 bytes, and is not labeled a distill semantic-equivalence claim.
The completed source review used immutable v1 authority. No current-v2 live
production authority is migrated; only disposable current fixtures are regenerated.
No timeout, worker count, context/provenance recheck or verification policy changed.

### Native, panel, publication and P3 seams

Claude current reviewer stop captures exact final bytes then returns; registered
Wave resume owns semantic application under existing protected-state authority.
Pi retains tool-call/index/agent and session-run capture identity plus its existing
run-bound short-circuit. Current evidence never enters legacy concatenation or
CRITICAL_COUNT polling. Missing current registration/context cannot become history.

Full versioned Finding data survives stored parsing, repair, resolution/refutation,
panel projection, checkpoint/event replay and canonical result publication. The
existing default three lenses, complete critical coverage and strict majority are
unchanged. A panel assesses the assertion including preconditions, contract and
consequence; it must not refute a true assertion merely because repair seems
unimportant. Structurally admitted surviving criticals remain blocking. No severity
downgrade, impact ballot or standalone severity-dispute action is added.

The existing explicit Wave `store-review-findings`/`--dismiss-all` operator override
is unchanged and separate, never automatic fallback on malformed reviewer output.
It preserves original full Finding audit data and does not prove an assertion false.

`inspectStandaloneFacade` authenticates registered protocol and publication,
including actual canonical result/receipt bytes. Human CLI inspection uses
`renderStandaloneReviewSummary` from the published root `result.json`, showing
emitted/admitted and after-refutation counts plus full detail. JSON inspection
retains its existing shape. No summary artifact or parent arithmetic is authority.

P3 consumes opaque published review result v1 or v2, retaining original IDs, full
basis, partitions and original result digest. Selected operator commands, fresh
required-file reports, immutable candidate checks and verified-index installation
policy are unchanged (ADR-0008). Reviewer-wire major version does not change
remediation schema or turn a reviewer-v1 source into a remediation-v1 run.

### Historical conservation

Completed **and unfinished issued reviewer v1** runs retain their original protocol,
normalization, synthetic shortfalls, IDs, retries, publication and result bytes.
All seven shims read the issued packet first; genuine v1 selects the exact archived
baseline role/shared fragment under `references/reviewer-protocol-v1/`. Delivery
covers initial publication, outstanding attempt-1 reissue, newly issued attempt 2,
and already-published attempt-2 recovery, for standalone and registered Wave.
Missing archive/authority fails visibly. Archive selection stays outside frozen
packet/request/retry bytes. Old packets did not freeze full rubric/persona inputs;
the archive is preserved implementation guidance, not invented original provenance.

This is deliberately different from **unfinished remediation v1**, which ADR-0008
still refuses. Completed remediation v1 remains read-only historical-unknown.

Two gzip packs retain 90 exact logical historical files (20,250,407 original bytes;
3,395,759 storage bytes). Independent decoded path/length/hash checks use the
unchanged original inventory; no receipts or anchoring metadata are rewritten.
Production pure parsers replay those bytes using in-memory resolvers, proving
semantic/result-byte compatibility, not relocated RunDirHandle admission. Separate
legitimate disposable fixtures prove native capture/publication/reload/witness
replay and actual P3 repair-check/index installation. Scripted assertions are not
live semantic findings. Early inherited B5 checkout-cwd/mismatched-handshake runs
are not positive evidence; corrected child-only matching-runtime tests are.

## Consequences

- One admission contract replaces redundant current representations without
  rewriting historical truth or changing refutation/P3 authority.
- Weak but structurally valid criticals can still block: semantic strength is not
  parser-proven and no new severity adjudication was approved.
- Explicit current/legacy branches and exact generated schema copies cost storage
  and maintenance; deleting them would remove compatibility/authority, not noise.
- Per-program drivers, LC-1 projection and curated exports remain as ADR-0005,
  ADR-0006 and ADR-0007 require. No lineage ledger, dual-snapshot executor, generic
  driver or other priority is included.
- Runtime publication is a separate parent-owned registered workflow. Reload or
  restart after package installation; never bypass admission by unsetting PI.
