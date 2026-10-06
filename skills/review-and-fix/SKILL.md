---
name: review-and-fix
version: "6.0.0"
description: "Review a PR, adjudicate critical findings, remediate, validate, and install an exact verified Git index."
---

# Review and Fix

Canonical workflow: registered standalone review → engine-owned refutation →
Plan and immediate immutable advisory publication → remediation → validation →
verified index installation → commit/push. Explicit successor review is optional,
never an automatic extra roster after remediation.

## Availability and P5 bootstrap

Skill 6 adds P5 advisory publication and explicit successor handling. The selected
design is implemented on the feature worktree; **final validation, registered review
and publication remain pending**. P4 merged as `96153ed` and reload was verified.

**P5's own final registered source review/remediation MUST use the admitted main
CLI and frozen Skill 5.0.0 contract, including its existing Plan advisory triage.**
Loaded main runtime:
`sha256:086c472e4e913376c07d69f5116c9ad9655546e22c91e40d28cba9fdd795bc79`.
It does not implement the P5 publisher. Do not call the new mutator through it,
switch a live parent to the feature CLI, unset admission, or retrofit P5 records
into that source review. Feature mutations belong only in owned matching-runtime
fixtures until publication/reload. After merge/package publication/reload, **new**
triage may publish new P5 records honestly. The P5 instructions below apply only
to that matching runtime; this bootstrap restriction takes precedence.

## Arguments

```text
/review-and-fix [code|errors|tests|types|comments|architecture|simplify|all]
  [--files file1,file2] [--no-push] [--dry-run] [--commit-msg "..."]
```

`all` is the default. Resolve `LOOM_DIR` once from the active plugin package.

## Invariants

- The orchestration façade owns scope derivation, reviewer/model/Skill policy,
  request authority, transcript capture, retries, aggregation, adjudication,
  publication, path audit, temporary-index staging, verification, and install.
- Execute only `spawn-batch`, `await-user`, `blocked`, or `done` actions.
- Never hand-build findings, verdicts, manifests, transcript files, Git
  pathspecs, or protected-state mutations.
- Refuted criticals are audited and never fixed. Every surviving critical ID
  must be copied exactly once from canonical `result.json` into a disposition;
  no caller mints a replacement Finding ID. A repaired disposition may refer to
  a separately named Declared Repair Group, but that group ID never replaces
  the source Finding ID. Unresolved/out-of-scope dispositions are valid and
  block installation.
- Advisory dispositions remain parent policy: accepted, deferred or dismissed.
  Publish the complete ordered inventory immediately through the no-agent P5
  publisher on a matching runtime, even if no fix/successor follows. Corrections
  publish a new exact revision; never edit history. Advisories are never inserted
  into critical repair groups.
- Grouping, root cause, invariant, sibling accounting, and Historical RED are
  `DECLARED`. Repaired checks alone become `ENGINE_OBSERVED`. Call the bounded
  result `repair-checked`, never proven closure or `ResolvedFinding`. An
  operator-owned fixed command can fabricate a syntactically valid new report;
  fresh structured engine observations are not proof of test semantics.
- Validation must pass before remediation installation. Never force-push.

## Phase 1 — Registered standalone review

Name one fresh Run Directory and start the façade with user policy only. The
engine creates the Run Directory; `--run` takes either its bare run id or a full
path to that same direct child of `--runs-root`:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration start standalone-review \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run "<fresh-review-run-id>" <<'JSON'
{"kind":"all","files":null,"dryRun":false}
JSON
```

Every fresh review carries an engine-enforced **read obligation** (ADR-0022). Each
reviewer must be observed paging the scope's complete frozen diff with the reader's
`--diff` mode, and a result with any unread page is refused and retried with the
unread ranges. `start` refuses a scope whose frozen diff exceeds one reviewer's
240,000-unit budget. When it does, partition the scope into explicit `--files` slices
(roughly ≤ 230 KB of `git diff` each), one registered Run per slice, and review each
slice. Never pass a larger slice to bypass the budget, and never treat a skimmed
review's verdict as coverage.

Spawn the exact returned batch. Each reviewer's exact raw bytes must then reach
its reserved slot. On a harness that captures transcripts itself (Claude Code, Pi)
this already happened at spawn completion, together with the engine's read-coverage
observation, and a repeat submit is an idempotent confirmation. On any other harness
the parent performs it, once per issued request, and hands over the reviewer's
delivered tool outputs (a JSON array of strings, in order) so coverage can be verified:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration submit \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run "<same-review-run-id>" \
  --request "<exact-request-id>" --slot "<exact-slot-id>" --attempt 1 \
  --tool-outputs "<reviewer-tool-outputs.json>" \
  < "<reviewer-raw-output>"
```

Then resume until `done`:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration resume \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run "<same-review-run-id>"
```

The registered Standalone Review Program automatically routes non-empty
critical sets through its registered Refutation Panel and publishes canonical
`result.json`. Read remediation inputs only from that authoritative result:

- `surviving_critical_findings` — mandatory fixes
- `advisory_findings` — autonomous parent triage by default
- `refuted_critical_findings` — report, never fix

### Issued reviewer protocol and canonical presentation

Fresh independent reviews remain v2. Only explicit schema-3 successor start input
selects v3; it does not change fresh Wave review. Independent reviews issue exactly
one JSON final payload under the frozen
`reviewer-payload-schema` and `reviewer-impact-rubric`. No Machine Summary,
markers, numeric tallies, or reviewer-chosen new Finding IDs. Criticals require
six fields: claim plus basis evidence, violatedContract, consequence,
truthConfidence, and severityRationale. Advisories require a concise reason;
optional basis must be complete. Truth confidence is not an impact score.
Blocking consequence must concern supported behavior, safety/authority, explicit
acceptance/verification obligations, or safe operator use. Factual error, style,
architectural shallowness, or a missing test alone is insufficient. Filled fields
prove neither truth, impact, reachability, execution, nor semantic test adequacy.

Malformed current output fails evidence admission and creates no synthetic
Finding or P3 repair obligation. It receives only the existing bounded retry.
The engine deterministically admits a final message that wraps exactly one
strict JSON object in prose or a code fence: the extracted payload still
crosses the frozen schema and rubric, the original transcript stays immutable
audit evidence, and zero or ambiguous candidates fail closed to the bounded
retry. The same panel lenses and strict majority assess the assertion including its
basis; a true assertion is not refuted merely because repair seems unimportant.
A surviving critical stays blocking, with no severity downgrade or standalone
severity-dispute action. The old explicit Wave operator override remains separate
and is never automatic fallback for reviewer failure.

Use the engine's existing inspection renderer, not parent-authored arithmetic:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration inspect \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run "<same-review-run-id>"
```

It authenticates registered protocol, source contexts and publication, then renders
emitted/admitted and after-refutation counts and full Finding details from the
published root `result.json`. JSON output retains the existing inspection shape. No new
summary artifact is authority. P3 retains every original source ID and full basis
immutably, including refuted/advisory partitions and original result digest.
Its selected operator checks, fresh required reports and verified-index policy
are unchanged. For v3, human inspection reports new/inherited/current counts and
coverage instead; full source JSON retains every origin/history.

Completed and unfinished issued reviewer v1/v2 runs keep their original protocol,
initial/resume/both-attempt retry behavior and exact context/result/receipt bytes.
Read the issued packet first; v1 follows its archived role/shared wire under
`references/reviewer-protocol-v1/`, while v2 keeps its exact P4 schema/rubric.
Do not apply successor grammar to either. Development-only pre-B4 v3 panel context
changes are not historical v1/v2 migrations. Unfinished remediation v1 is separately
refused by ADR-0008. See [protocol operations](../../docs/operations.md#reviewer-protocol-v2).

### Optional explicit successor

Do not automatically select `previousRun`, repeat the reviewer roster, reuse old
review as current completion, merge forks or infer identity from similarity.
For an explicitly requested successor, use the exact schema-3 start JSON in
[successor operations](../../docs/operations.md#explicit-successor-review): ordered
explicit files, `dryRun:false`, exact predecessor locator/Run/result digest, and
exact published policy revision (or honest explicit historical unavailability).
There is no new slash-command successor flag. Preserve all predecessor paths and
roles; include relevant dependency/configuration/contract paths explicitly.

The full current roster assesses every inherited origin in issued order. Resolution
requires unanimous `repaired` judgments with relevant implementation changes against
one frozen byte/mode snapshot; disagreement/not-assessable prevents it. Missing or
malformed coverage refuses the whole response under the existing single retry.
Critical reopening requires new evidence bound to the exact old decision and goes
through a fresh full Refutation Panel; only new criticals and explicit reopening
need current panel work. Already-upheld unchanged criticals remain blocking.
Preserve original IDs/assertions/severity/evidence, per-role high-water and all
history. Advisory policy reconsideration needs a later disposition publication,
never severity promotion. Digests, formal statements and Repair-Checked are not
semantic proof. Historical unknown source facts never become inferred absence.

V3 human inspection supplies new/inherited/current counts and coverage. P3 consumes
actual active `surviving_critical_findings`, not fresh panel counts; limited current
critical coverage blocks even a zero-active-critical install. Full source JSON and
lineage remain exact through unchanged schema-2 checks/index installation.

## Phase 2 — Plan

Every surviving critical Finding is mandatory to account for. Copy it exactly
once using its canonical `result.json` ID unchanged:

- `repaired` names one separately identified Declared Repair Group;
- `unresolved` gives a non-empty reason and blocks installation;
- `out-of-scope` gives a non-empty reason and blocks installation.

A repair group has a unique group ID, a non-empty set of those original Finding
IDs, one `DECLARED` root cause, one `DECLARED` invariant, mandatory sibling
accounting, and at least one selected fixed check. It does not merge or replace
Findings. Repeated sibling paths within one group are invalid. Distinct groups
may reuse one sibling path when the statuses are compatible; reasons remain
group-local declarations. Any unresolved/out-of-scope sibling blocks.

Independently disposition every advisory as `accepted`, `deferred`, or
`dismissed`. By default, make this choice autonomously from the evidence,
correctness impact, risk, and reviewed scope; do not ask the operator to choose advisory IDs. Accept an advisory when its claim is sound and a complete
in-scope fix is practical. Defer or dismiss only with a concrete evidence-based
reason. An explicit user instruction about a specific advisory overrides this
default. Never add an advisory or refuted critical to `defectFamily`.

### Publish advisory decisions now (matching P5 runtime only)

Before stopping or implementing, obtain the engine's exact source and complete
ordered advisory inventory:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration inspect \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run "<same-review-run-id>" --lineage
```

Copy `source` unchanged into both input source fields. Copy **every**
`advisoryInventory[].origin` in order, including retired/resolved advisories, into
`record.entries` with the parent decision/reason. Do not use bare Finding IDs,
compute origin hashes or infer a missing entry from prose. Prepare ordinary JSON:

```json
{
  "source": {"locator":"/absolute/review-root/run.review","runId":"run.review","resultDigest":"<exact-result-sha256>"},
  "record": {
    "schemaVersion": 1,
    "source": {"locator":"/absolute/review-root/run.review","runId":"run.review","resultDigest":"<exact-result-sha256>"},
    "provenance": "DECLARED",
    "revision": {"kind":"initial"},
    "entries": [{"origin":"<exact-inspection-origin>","decision":"accepted","reason":"Concrete evidence-based reason."}]
  },
  "previous": null
}
```

Expand entries to exact coverage; `[]` is legal only for an empty advisory inventory.
This input declares policy; it is not a hand-built Run artifact or receipt.

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration start standalone-disposition \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run "<fresh-policy-run-id>" < /path/to/declared-policy.json
```

Read `done.outcome.kind: standalone-disposition-published`, `publication`, `record`
and `receipt`. The engine publishes `artifacts/disposition.json`; never write it
manually. No Agents or await-user stage. Exact repeat/resume is idempotent; conflicting
bytes refuse. If interrupted, ordinary `resume` reconciles exact artifact/receipt
facts without re-triage. Do not treat an unreceipted record as published authority.

For a correction, publish a fresh policy Run with the same source, complete entries,
`revision:{"kind":"correction","previousDigest":"<prior-digest>"}` and
`previous:{"locator":"<absolute-prior-policy-run>","runId":"<prior-policy-id>","dispositionDigest":"<same-prior-digest>"}`.
The prior revision must already be published; no automatic latest choice. An explicit
present-day import uses `revision:{"kind":"historical-import","proseReference":"<retained-reference>","prose":"<exact-retained-prose>"}` and `previous:null`.
It remains DECLARED now, never backdated. Missing historical policy is explicit
`historical-decision-unavailable`, not an empty native record. Missing/corrupt
expected current publication fails, never falls back to historical absence.
See [complete publication/inspection operations](../../docs/operations.md#immediate-advisory-publication).

If no code or documentation fix remains, report the published decisions and stop;
do not require a successor merely to retain them. Zero surviving criticals require
no remediation check, manifest or check subprocess, but every remediation start
still requires `defectFamily: {"kind":"not-required"}` and, for v3, complete current
critical coverage. Under the P5-bootstrap restriction above, use the old Plan-only
triage instead; never pretend this publication occurred.

Write `.claude/plans/YYYY-MM-DD-pr-remediation.md` containing branch, exact
scope, review Run Directory, every surviving-critical disposition, every
Declared Repair Group, sibling disposition, selected check ID and Historical
RED declaration, every advisory disposition/reason, accepted advisory fixes,
refuted-finding audit, exact policy publication/revision reference (or explicit
bootstrap/historical unavailability), and validation commands. Keep `DECLARED`
facts distinct from checks the engine will later observe. `--dry-run` stops here:
review/adjudication and policy custody occur, but no implementation/install/commit.

## Phase 3 — Implement and validate

Read `rules/architecture.md` and relevant language rules. Apply only criticals
dispositioned `repaired` and accepted advisories; never repair a refuted
Finding. Register every necessary support path in the remediation start input.
Run typecheck/build and full relevant tests; iterate to a real fix. These
development runs are not P3 evidence—the registered remediation runner must
freshly observe each selected fixed check and its exact structured report.
Stop without staging or committing if validation cannot pass.

## Phase 4 — Registered remediation

Name a fresh remediation Run Directory. The source review run remains immutable
authority, and `sourceRun` names it the same way `--run` does — bare run id or a
full path resolved against `sourceRunsRoot`. Every new start input is schema v2
and contains exactly `sourceRunsRoot`, `sourceRun`, `supportPaths`, and
`defectFamily`.

For a source with zero surviving criticals:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration start remediation \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run "<fresh-remediation-run-id>" <<'JSON'
{
  "sourceRunsRoot": ".claude/reviews/review-and-fix-runs",
  "sourceRun": "<review-run-id>",
  "supportPaths": ["<plan-or-accepted-advisory-path-not-in-reviewed-scope>"],
  "defectFamily": { "kind": "not-required" }
}
JSON
```

For critical repairs, copy real Finding IDs and selected manifest check IDs;
do not reuse these placeholders literally:

```json
{
  "sourceRunsRoot": ".claude/reviews/review-and-fix-runs",
  "sourceRun": "run.source-review",
  "supportPaths": ["tests/repair-regression.test.ts"],
  "defectFamily": {
    "kind": "declared-defect-family-accounting",
    "provenance": "DECLARED",
    "dispositions": [
      {
        "findingId": "code-reviewer-1",
        "status": "repaired",
        "repairGroupId": "group.repair-predicate"
      }
    ],
    "groups": [
      {
        "kind": "declared-repair-group",
        "provenance": "DECLARED",
        "repairGroupId": "group.repair-predicate",
        "findingIds": ["code-reviewer-1"],
        "rootCause": {
          "provenance": "DECLARED",
          "statement": "The predicate returned the vulnerable constant."
        },
        "invariant": {
          "provenance": "DECLARED",
          "statement": "The repaired predicate returns the intended value."
        },
        "siblings": {
          "kind": "none-declared",
          "provenance": "DECLARED",
          "reason": "No sibling implementation paths were identified."
        },
        "checks": [
          {
            "checkId": "project:repair-regression",
            "historicalRed": {
              "kind": "historical-red",
              "provenance": "DECLARED",
              "statement": "The assertion fails against the reviewed vulnerable behavior.",
              "reference": null
            }
          }
        ]
      }
    ]
  }
}
```

Every path the remediation touches that is NOT inside the frozen review scope —
the plan file or a regression pin added for a fix — must be named in
`supportPaths` **at start**. The registered input is immutable, so a run cannot
authorize a path its own start input never named. If one was omitted, start a
**fresh** remediation run whose start input adds the path to `supportPaths`.

Preflight authenticates the source, parses accounting, selects operator check
authority when criticals exist, and captures candidate bytes **before** creating
the requested Run Directory. Invalid source/input/declaration/manifest/check
configuration is a start error and creates no run. Once registration exists, a
returned `blocked` action is durable run evidence. Never delete it to retry.
Recovery depends on the cause:

- **unrelated staged/dirty work** — remove it, then start a **fresh** run;
  removal changes the registered candidate, so the old run cannot be reused;
- **unauthorized remediation path** — start a **fresh** run whose input includes
  that `supportPath`. The blocked run stays in place as evidence.
- **failed/missing/malformed/zero-test check or candidate drift after
  registration** — correct the cause and start a fresh run; a failed check or
  changed candidate cannot reuse prior evidence;
- **unfinished schema-v1 remediation run** — start a fresh schema-v2 run. Completed v1 runs
  remain read-only with `historical-unknown` assessment, returning the old
  receipt without reinstalling or minting current installation authority.
- **missing/malformed completed-v2 checkpoint audit arrays** — retain the
  explicit `remediation checkpoint audit paths are missing or malformed`
  diagnostic; do not replace missing facts with empty arrays or edit evidence.
- **index installed but checkpoint recording failed** — preserve the actual
  installation receipt and installed-index diagnostic. Do not claim rollback,
  nothing-installed, or hand-repair/reinstall from the interrupted checkpoint.

All-unresolved accounting is represented without fake groups or checks:

```json
{
  "kind": "declared-defect-family-accounting",
  "provenance": "DECLARED",
  "dispositions": [
    {
      "findingId": "code-reviewer-1",
      "status": "unresolved",
      "reason": "The repair has not been implemented."
    }
  ],
  "groups": []
}
```

For a source whose exact critical set is represented above, this is valid
accounting and intentionally blocked during preflight, so no remediation Run
Directory is created. Do not convert the unresolved Finding into a fake repaired
group merely to pass preflight.

When a fresh run supersedes a blocked one, say so in the retired run rather
than only in this session, so the next operator reading the runs root can tell
which of the two is live:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration abandon \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run "<blocked-run-id>" --superseded-by "<fresh-run-id>" \
  --reason "<why it was replaced>"
```

`helper orchestration inspect --runs-root <root> --run <run-id>` reads any
run's program, state, per-slot capture, and rejection diagnostics in one
command — use it instead of hand-reading `checkpoint.json` and `events/`.

Resume until `done`. For critical repair, the selected operator command must
have `report.kind = "required-file"` and itself produce its exact configured,
ignored, untracked `.loom/completion-reports/...` JUnit/Vitest file **anew**.
Before launch the engine removes that exact old regular report through a retained
Linux parent descriptor with no-follow, descriptor-relative unlink. Touching
seeded bytes cannot pass; a new report with identical bytes may. Only ENOENT is
absence; unsafe paths, permission errors, or unsupported reset fail before launch
with `required report reset failed before launch`. Strict critical reset is
**Linux-only**: Darwin fails closed before launch. This does not change
zero-critical remediation or Wave behavior.

The engine requires normal exit, more than zero executed tests, zero failures,
and unchanged candidate authority. Reports are limited to **8 MiB**, with XML
element depth at most **128** (including diagnostics). V2 event reads, append
reconciliation/new appends, and CLI inspection enforce **12 MiB per encoded event,
64 MiB per encoded journal, 1024 records**, before oversized decoding/JSON parsing.
These are not blanket limits on other Run artifacts or legacy journal consumers.
Multiple groups may select the same check ID; each distinct selected ID executes
once. See [operator enrollment](../../docs/operations.md#enrolling-a-critical-repair-check).
Loom's user-approved 2026-09-09 idle enrollment now gives the unchanged root
`project:verify` command required report `.loom/completion-reports/verify.junit.xml`.
The existing Vitest invocation writes that Git-ignored, untracked report; it
contains only Vitest facts, not compiler or smoke testcases. Normal zero exit of
the whole command also proves the compiler and all six smokes passed; a green
unit report cannot override a later smoke failure. Enrollment and development
runs are not registered P3 evidence or a completed live schema-v2 remediation.
The create-only manifest helper was neither used nor changed for this approved
operator replacement; existing populated TaskGraphs retain frozen authority.

The engine proves observed dirty paths are authorized, rejects excluded Run
evidence and unrelated staged work, stages literal paths in a temporary index,
proves `audited == staged`, rechecks candidate and repository witnesses under
the real index lock, and atomically installs the verified index. The parent must
not run its own staging recipe and must never inject command authority, process
outcomes, report bytes/counts, events, manifests, temporary-index outcomes,
installation receipts, or Run JSON through remediation input or hand-built run
artifacts.

Read success from the external action's `outcome.installation` (the actual Git
adapter receipt) and `outcome.defectFamilyAssessment` (`repair-checked` or
`not-required`). Commit the installed index and push unless `--no-push`. A push
failure leaves the valid local commit intact and is reported with its SHA.

**Publication status:** P4 merged/reloaded; P5 final validation, registered review
and publication remain pending. Follow the bootstrap restriction at the start of
this Skill: admitted main CLI/Skill 5.0.0 and existing Plan advisory triage for
P5's own review/remediation. Source reviewer version never selects remediation
version; schema-2 installation/report policy remains unchanged. The earlier
Skill 3.1 bootstrap belongs to P3 history (ADR-0008). Documentation and development
validation do not advance a Run or mint an installation receipt.

A newly installed/updated Pi package requires `/reload` or a full Pi restart
before this schema-v2 live workflow can mutate anything. Never unset runtime
admission variables to force a fresh CLI through an older loaded extension.

## Phase 5 — Report

Relay the inspection renderer's emitted/admitted and after-refutation counts for
v1/v2, or new/inherited/current disposition and coverage counts for v3. Never count
inherited history as newly emitted. Report exact policy publication/revision and
DECLARED reasons (or honest bootstrap/historical unavailability), repaired
dispositions from actual P3 accounting, every original critical
Finding ID and disposition, Declared Repair Groups, blockers, every advisory
disposition/reason, review/policy/remediation Run Directories as applicable, Plan,
changed files, validation
evidence, Defect-Family Assessment with provenance, actual installation receipt,
commit SHA, branch, and push status. Include every refuted finding with panel
reasoning. Say `repair-checked`, not closed/proven/resolved.
