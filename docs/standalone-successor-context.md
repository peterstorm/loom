# Standalone successor native context and workload

Only explicitly registered standalone successor v3 uses this protocol. Independent standalone reviews and fresh Wave reviews remain P4 v2. Neither response shape nor a global current-version flag chooses a decoder. V1/v2 schemas, rubric, result serializers and retry contracts are unchanged; their role guidance remains in the explicit version archives.

## Reviewer delivery

Execute the exact `LOOM_CONTEXT_READ_COMMAND` in the issued task using Claude Bash or Pi bash. It calls `scripts/read-context-packet.ts` with the actual packet path, request, digest, role, skill, and explicit `--purpose standalone-successor`.

The first response is a bounded section index. Append:

- `--section standalone-lineage` for the complete prior inventory, original origins, old decisions/refutations/resolutions, selected DECLARED policy, current source identity and reopening references.
- `--section reviewer-payload-schema` and `--section reviewer-impact-rubric` for the unchanged issued v3 grammar/rubric.
- `--section standalone-frozen-source` for current path/digest/mode metadata; `--file EXACT_PATH` for an explicitly selected lossless UTF-8 postimage. Binary/absent postimages are not invented text.
- `--section predecessor-frozen-source` for predecessor observations and the precise archive label/purpose.
- `--archive predecessor-context:ROLE --archive-purpose v1-v2` for an original v1/v2 packet, or `--archive-purpose standalone-successor` for an original v3 packet. Issued predecessor retries use `predecessor-context:ROLE:attempt-2`. Add `--section` or `--file` to browse that packet.
- `--offset N --limit 4096` to continue text pages. Text offsets are UTF-16 units, not source line numbers; index offsets count sections. Limits are 1–4096 units, at most 32 index entries and 48 KiB encoded output.

Fresh predecessor sections contain exact publication references: absolute original packet path, encoded byte length, SHA-256 and explicit decode purpose. Every issuance/resume independently authenticates the original publication and packet; the reader checks the exact retained byte identity. Missing/foreign/corrupt originals refuse. No mutable live source lane, latest lookup or decoder fallback exists. References do **not** recursively embed predecessor packets, so source transport does not grow exponentially. Earlier frozen gzip-base64 archives remain bounded-readable and preserve their exact original encoding; no recompression comparison is used as an identity oracle.

This projection checks integrity and supplied identity. It does not itself grant publication, source, request or capture authority.

## Refutation Panel delivery

The verifier has Read/Glob/Grep, **not Bash**; its tool roster is unchanged. Current successor panels therefore receive `LOOM_CONTEXT_VIEW_PATH`, naming an immutable Markdown view in `artifacts/context-views/<packet-digest>.md`. Use Claude Read or Pi read with line offset and limit 200, continuing after any tool truncation. Display lines wrap at 4096 UTF-16 units; finding locations still name original source lines.

The panel packet binds the current frozen source, retained lineage and predecessor references in addition to the exact finding roster/lens and full current reopening reports. The view contains those facts plus bounded readable current/predecessor source. Delivery and native capture regenerate and compare the view against those exact packets; an uploaded, missing or changed view is not authority. Views are recoverable delivery projections, never reviewer evidence or replacement result bytes. The ordinary verdict grammar, full lens roster and strict-majority rule are unchanged.

## Native provenance and replay

Both adapters record the existing durable `raw-transcript-captured` effect receipt at the **actual independently correlated native capture boundary**, immediately after the exclusive raw transcript write. Its effect identity matches the CLI capture identity. Before a fresh v3 raw write, a bounded 16 KiB immutable observation records the exact issued request, native correlator, context, payload identity and origin; it is inert evidence, not a receipt. If raw writing succeeds but receipt recording fails, only a freshly re-observed identical final from the same native identity/attempt can reconcile that exact observation and unchanged raw bytes, with no rejection marker and no existing receipt. Missing/corrupt observation, changed identity/bytes/context, or existing/contradictory receipt refuses; successful recapture does not rewrite the raw file or consume another semantic attempt. Replay never fills in a missing receipt. The existing adapter-specific `CaptureReceipt` and durable native correlator remain explicit: Claude agent ID versus Pi tool-call/index/role. Claude still rejects ambiguous final blocks instead of guessing.

Registered resume owns v3 admission, exact prior coverage, retry, aggregation, panel work and canonical publication. Native hooks never merge marker counts or mutate an unrelated TaskGraph. P3 authenticates the same durable capture replay and exact result publication; it conserves original IDs/history and canonical source bytes through actual guarded installation.

Pi additionally requires its exact current-session process witnesses, not caller-supplied hashes. Verification is checkpoint-independent, rejects missing/foreign/corrupt current capture/result authority, checks that the current witness did not change during asynchronous source authentication, and never falls back to an older Run. Acceptance retires older witnesses; shutdown prunes the session.

## Supported bounded workload

The owned native integration test uses the explicit production-source roster in
`engine/tests/fixtures/standalone-native-workload.ts`. The import-cycle extraction
added three new shell owner volumes to that roster — `handlers/helpers/programs/
program-result.ts`, `standalone-evidence.ts` and `standalone-disposition-source.ts` —
so it now lists 46 production paths; the integration test reports 49 files (the 46
scope paths plus the three fixture remediation scope paths `src/repair.mjs`,
`src/types.ts` and `README.md`). It copies exact current bodies into its multi-file
scope, proves identical ordered paths/bytes after staging and after a clean fixture
commit, selects all seven roles, captures real Claude adapter results and publishes
the actual canonical successor. It does not depend on dirty Git state, HEAD ancestry
or untracked files, and is a representative workload—not a dependency closure or
claim to cover every production path. The pre-extraction B5 co-scheduled run observed
**1,518,151 production bytes** across the then-43-path roster (46 selected paths
including three fixture paths), a 6,909,979-byte packet and a 6,831,141-byte
registration; its scenario took 10.835s under the unchanged 15s ceiling. That dated
measurement is retained as history for the smaller roster, not a current claim;
exact measurements are emitted as `SUPPORTED_NATIVE_WORKLOAD` by
`standalone-successor-native.integration.test.ts` and vary with the selected source
bodies, so current totals are re-observed per run rather than inferred from this note.
This is scripted protocol/transport execution evidence, not semantic proof or a live
model review.

Concrete simultaneous bounds:

| Boundary | Limit |
| --- | ---: |
| Current source regular file | 524,288 bytes (512 KiB) |
| Current raw source aggregate | 2,097,152 bytes (2 MiB) |
| Scope | 4096 paths |
| Prepared lineage + current source + predecessor-section payload | 4,194,304 bytes (4 MiB), before packet byte-array construction |
| Retained predecessor section payload | 2,097,152 bytes; at most 15 sections |
| Exact predecessor packet observation aggregate | 67,108,864 bytes (64 MiB), also charged to the existing traversal allowance |
| Individual context/registration/result/source read | 16,777,216 bytes (16 MiB) |
| Predecessor traversal | 64 Runs, cycle refusal, existing 64 MiB carried observation allowance |
| Current reader outer packet / one archive expansion | 16 MiB / 16 MiB |
| Current native final payload | unchanged 1,048,576 bytes before raw byte-array construction |
| Current Claude transcript before decode/split | 16 MiB |
| Current Pi decoded transcript | 16 MiB string/key UTF-8 bytes, 65,536 values, depth 32 before adapter copying |
| Current panel readable view | 16 MiB; 4096-unit display lines |

These are simultaneous limits, not a promise that every maximum can be saturated together. A long chain or many issued retries can exhaust the retained-observation allowance even when each source fits; it refuses rather than truncating history. This is not a whole-process heap or all-files/all-reads cumulative budget. Legacy reader ceiling remains 128 MiB. Report/check limits, v2 12 KiB schema budget and v3 16 KiB schema budget are unchanged.

The chosen source cap has headroom above the measured production workload while retaining an early per-file limit. Exact predecessor references remove repeated source/archive copies; constructor/parser-owned immutable ByteSections and v3 packets can be reused without rehashing caller data. V3 resolvers retain only an operation-local authenticated registration snapshot; every request still proves its own durable publication/reservation and rereads exact packet bytes. After rehashing both parsed registrations' sections, registration equality compares their complete metadata/digests rather than serializing large byte arrays again. The v3 packet serializer reuses only parser/constructor-owned immutable section JSON; property tests pin exact canonical JSON.stringify bytes, including parsed round trips and stale-cache refusal. No global registration/result cache or relaxed provenance check was introduced.
