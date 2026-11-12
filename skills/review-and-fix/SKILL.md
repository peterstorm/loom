---
name: review-and-fix
version: "6.0.0"
description: "Review a PR, adjudicate critical findings, remediate, validate, and install an exact verified Git index."
---

# Review and Fix

Workflow: registered standalone review → engine-owned refutation → plan and
publication of the advisory decisions → remediation → validation → verified
index installation → commit and push.

## Arguments

```text
/review-and-fix [code|errors|tests|types|comments|architecture|simplify|all]
  [--files file1,file2] [--no-push] [--dry-run] [--commit-msg "..."]
```

`all` is the default. Resolve `LOOM_DIR` once from the active plugin package:

```bash
LOOM_DIR="${CLAUDE_PLUGIN_ROOT}"
test -f "$LOOM_DIR/engine/src/cli.ts" || exit 1
```

## Invariants

- The orchestration façade owns scope derivation, reviewer, model and Skill
  selection, request authority, transcript capture, retries, aggregation,
  adjudication, publication, path audit, temporary-index staging, verification
  and installation.
- Execute only the `spawn-batch`, `await-user`, `blocked` or `done` action a
  command returns.
- Never hand-build findings, verdicts, manifests, transcript files, Git
  pathspecs, Run artifacts or protected-state mutations.
- Refuted criticals are reported and never fixed. Every surviving critical ID
  is copied exactly once from the canonical `result.json` into a disposition;
  you never mint a replacement Finding ID.
- Advisory dispositions are your policy: accepted, deferred or dismissed.
  Publish the complete ordered inventory as soon as you have decided, even if
  no fix follows. A correction is a fresh revision; published history is never
  edited. An advisory never goes into a critical repair group.
- What you declare (grouping, root cause, invariant, siblings, Historical RED)
  is `DECLARED`; only the checks the engine runs are observed. Call the outcome
  `repair-checked`, never closed, proven or resolved.
- Validation must pass before remediation installation. Never force-push.
- A freshly installed or updated Pi package needs `/reload` or a restart
  before these commands can mutate anything. Never unset runtime admission
  variables to force a CLI through an older loaded extension.

## Phase 1 — Registered standalone review

Every program below takes a runs root and a fresh run id. The runs root must
exist; the engine never creates it. `start` creates that Run Directory; `--run`
takes the bare run id or the full path of that direct child of the runs root.

<!-- wire-example: standalone-review-start -->
```bash
mkdir -p ".claude/reviews/review-and-fix-runs"
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration start standalone-review \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run "<fresh-review-run-id>" <<'JSON'
{"kind":"all","files":null,"dryRun":false}
JSON
```

For `--files`, `files` is a non-empty JSON string array. If `start` refuses the
scope for size, split it into `files` slices and review each in its own run, as
[`/review-pr` step 3](../../commands/review-pr.md#3-start-one-fresh-run)
describes. Never treat a slice you did not review as covered.

Spawn the exact returned batch, preserving each request's Agent, model,
required Skill, task text and `LOOM_REQUEST_ID`; on Pi send at most eight
requests per subagent call. Claude Code and Pi capture each reviewer's final
bytes themselves. On another harness, hand them to the engine with
`helper orchestration submit`
([operations: read coverage](../../docs/standalone-review.md#read-coverage-reviewer-protocol-v4)).
Then resume until `done`:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration resume \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run "<same-review-run-id>"
```

Reviewers return one JSON payload; the engine admits or retries it. A
malformed payload is failed evidence, never a Finding. Surviving criticals
block. The engine routes any critical through its Refutation Panel and
publishes `result.json`. Read remediation inputs only from that result:

- `surviving_critical_findings` — every one must be accounted for
- `advisory_findings` — yours to triage
- `refuted_critical_findings` — report, never fix

Take counts and Finding details from the engine's inspection, never from
arithmetic of your own:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration inspect \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run "<same-review-run-id>"
```

A successor review is never automatic. If the user asks for one, follow
[operations: explicit successor review](../../docs/standalone-review.md#explicit-successor-review).

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

### Publish the advisory decisions

Before stopping or implementing, get the engine's exact source and complete
ordered advisory inventory:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration inspect \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run "<same-review-run-id>" --lineage
```

Copy `source` unchanged into both source fields. Copy every
`advisoryInventory[].origin` in order, including retired and resolved
advisories, into `record.entries` with your decision and reason. Do not use
bare Finding IDs, compute origin hashes or infer an entry from prose:

<!-- wire-example: standalone-disposition-start -->
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

`entries` covers the whole inventory; `[]` is legal only for an empty one.

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration start standalone-disposition \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run "<fresh-policy-run-id>" < /path/to/declared-policy.json
```

Read `done.outcome.kind: standalone-disposition-published`, `publication`,
`record` and `receipt`. The engine publishes `artifacts/disposition.json`;
never write it yourself. The program spawns no Agents and asks no question. An
exact repeat is idempotent, and if it is interrupted, `resume` finishes it
without re-triage. A record with no receipt is not published. To correct a
published decision, or to import one recorded before this program existed, use
the revision shapes in
[operations: immediate advisory publication](../../docs/standalone-review.md#immediate-advisory-publication).

If no code or documentation fix remains, report the published decisions and
stop. Zero surviving criticals need no remediation check, but a remediation
start still requires `defectFamily: {"kind":"not-required"}`.

Write `.claude/plans/YYYY-MM-DD-pr-remediation.md` containing the branch, exact
scope, review Run Directory, every surviving-critical disposition, every
Declared Repair Group with its sibling dispositions, selected check ID and
Historical RED declaration, every advisory disposition and reason, the accepted
advisory fixes, the refuted-finding audit, the policy publication reference and
the validation commands. Keep what you declare distinct from what the engine
will observe. `--dry-run` stops here: the review, adjudication and publication
happen, but nothing is implemented, installed or committed.

## Phase 3 — Implement and validate

Read `rules/architecture.md` and the relevant language rules. Apply only
criticals dispositioned `repaired` and accepted advisories; never repair a
refuted Finding. Run typecheck, build and the relevant tests, and iterate to a
real fix. These runs are yours, not remediation evidence: the registered
remediation freshly runs each selected check itself. Stop without staging or
committing if validation cannot pass.

## Phase 4 — Registered remediation

Name a fresh remediation run id. The source review run remains immutable
authority, and `sourceRun` names it the same way `--run` does — bare run id or a
full path resolved against `sourceRunsRoot`. The start input contains exactly
`sourceRunsRoot`, `sourceRun`, `supportPaths`, and `defectFamily`.

For a source with zero surviving criticals:

<!-- wire-example: remediation-start -->
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

<!-- wire-example: remediation-start -->
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

`start` checks the source, the accounting, the selected checks and the
candidate **before** creating the Run Directory. An invalid source, input,
declaration, manifest or check configuration is a start error and creates no
run. Once registration exists, a returned `blocked` action is durable run
evidence. Never delete it to retry. Recovery depends on the cause:

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

<!-- wire-example: defect-family-accounting -->
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

Resume until `done`. For a critical repair, each selected check must be
enrolled with `report.kind = "required-file"` and must itself write its report
anew on every run; the engine deletes the old report before launch, so touching
an existing file cannot pass. This reset works on Linux and macOS. A report
path it cannot reset safely fails before launch with
`required report reset failed before launch`. The engine then requires a normal
exit, more than zero executed tests, zero failures, and an unchanged candidate.
Several groups may select one check ID; it runs once. Enrollment and the report
limits are in
[operations: enrolling a critical-repair check](../../docs/verification.md#enrolling-a-critical-repair-check).

The engine audits the dirty paths, stages them in a temporary index and
installs the verified index. Do not stage anything yourself, and never pass
command authority, process outcomes, report bytes, events or receipts through
the remediation input.

Read success from the returned action's `outcome.installation` (the actual Git
receipt) and `outcome.defectFamilyAssessment` (`repair-checked` or
`not-required`). Commit the installed index and push unless `--no-push`. A push
failure leaves the valid local commit intact; report it with its SHA.

## Phase 5 — Report

Relay the inspection's counts; never count inherited history as newly emitted.
Report every original critical Finding ID with its disposition, the Declared
Repair Groups, any blockers, every advisory disposition and reason with its
publication reference, every refuted Finding with the panel's reasoning, the
review, policy and remediation Run Directories, the plan, changed files,
validation evidence, the Defect-Family Assessment, the installation receipt,
the commit SHA, branch and push status. Say `repair-checked`, not closed, proven
or resolved.
