# Running a security audit

`security-audit` is a registered Loom program (ADR-0064), not a prompt. It
enumerates what it will cover, records what it proved, and reports the
difference. This is the operator's page: how to start a run, what the run
directory holds, what each operation refuses, and what to do with the result.

For the method — lenses, sandbox evidence, the finding trichotomy — read
`skills/security-audit/SKILL.md`. For why the program is code rather than prose,
read `docs/deterministic-core.md` §8 and ADR-0064.

## Start here

```bash
loom helper security-audit start --out .audit/run-1 --repo . --profile standard --budget 24 <<'JSON'
{ "units": [
    { "refs": { "surface": "http-ingress", "boundary": "api-edge",
                "subsystem": "auth", "attack_class": "injection" },
      "starting_paths": ["src/api/login.ts"],
      "ordinary_attack_class_block": "Injection: untrusted input reaching an interpreter.",
      "selected_companion_blocks": ["WEB-PROTOCOL-AND-AUTH.md#authentication-and-session-handling"] } ],
  "signals": { "languages": ["ts"], "manifests": ["package.json"], "servesHttp": true } }
JSON
```

`start` writes the run directory and prints the lens selection it chose. The
seed list is the enumeration: one entry per `(surface, boundary, subsystem,
attack_class[, lifecycle])` cell. A cell seeded twice is refused — duplicate
seeds mean the enumerator produced the same unit twice, which is worth seeing.

`--source <sha>` pins the revision; without it the run reads `git rev-parse
HEAD` through the one Git seam and records whether the worktree was dirty. A
dirty worktree is recorded, never hidden: a run over uncommitted bytes must say
so in its report.

### The run directory

| File | Written by | Holds |
|---|---|---|
| `run.json` | `start`, `publish` | frozen revision, scope, profile, budget, run status |
| `ledger.json` | `start`, `assign`, `submit`, `defer`, `merge-critic` | the coverage ledger: one unit per cell, with owners, evidence and dispositions |
| `lenses.json` | `start` | the selection, with each lens's score and reasons |
| `findings.json` | `submit` | candidate findings as filed (the trichotomy records) |
| `verdicts.json` | `verify` | refutation ballots, accumulated across waves |
| `security-findings.json` | `publish` | the adjudicated records that leave the run |
| `disposition.json` | `disposition` | one decision per published record, for `/review-and-fix` |
| `REPORT.md`, `FINDINGS-DETAIL.md`, `NEEDS-VALIDATION.md` | `publish` | prose derived from the records |

Every read is parsed by the module that owns the document, so a hand-edited or
half-written file stops the next operation with a named violation instead of
flowing into a report. Writes go through no-follow primitives: a symlinked run
file is refused rather than followed.

## Operations

| Operation | Input | Refuses when |
|---|---|---|
| `start` | stdin (`units`, optional `signals`, optional `scope`) | a run already exists (unless `--force`), a seed is malformed or duplicated, the budget cannot seat the first wave |
| `assign` | flags `--unit --agent [--wave]` | the unit is not `planned`, the agent is not a catalog id, the agent already owned an archived attempt |
| `submit` | stdin (`units`, optional `findings`) | a unit is not the agent's or not the current wave, a check is malformed, a `local` check names no receipt |
| `defer` | flags `--reason [--unit]` | the reason is missing, the unit is not `planned` |
| `merge-critic` | stdin (critic result) | a proposal is malformed, a reassigned unit has no evidence to archive |
| `verify` | stdin (`verdicts`) | a ballot is malformed, a field is invented |
| `findings` | flags `[--json]` | the ledger or records do not parse |
| `publish` | flags | any publication blocker (see below) |
| `disposition` | flags | nothing has been published yet |
| `status` | flags `[--json]` | the run does not parse |

`status` and `findings` are read-only and stay available while the Pi runtime is
skewed; every other operation proves the runtime first.

## Publication blockers

`publish` refuses instead of publishing a smaller truth than the run covered:

- a `confirmed` claim with **no verification ballot**;
- a `confirmed` claim verified only on the **hunt profile** (a ballot from the
  profile that found the bug verifies nothing — INV-S3);
- a ledger with `planned`, `in_progress` or `blocked` units.

`deferred` and `out_of_scope` units do not block: they are disclosed gaps with a
reason, and the report prints them. `coverageComplete` (every unit settled with
evidence) is what earns the word "complete"; `coverageSettled` (no unit silent)
is what allows the report at all.

## Budget

Budgets are counted **agent invocations**, and critics and validation are
reserved *before* hunters. `deep` reserves two verifier calls per expected
candidate; `quick` reserves one critic and no clean-critique pass. A budget that
cannot fund reconnaissance, the critic and one validation call is refused at
`start` with the upstream reason token.

Budget exhaustion is not cleanliness: an unreached unit becomes `deferred` with
its reason, and the run reports `incomplete` with `critic_budget_exhausted` or
`validation_budget_exhausted`. Two runs are comparable only when their profiles
and budgets are.

## Profiles and lens breadth

The profile also caps how many **companion lens documents** one run holds in
context (`quick` 2, `standard` 4, `deep` 8; ATTACK-CLASSES.md is always
included on top). A lens trimmed by the cap is listed in `excluded` with its
rank, so a missing lens is a visible choice rather than a silent omission. If a
defect sits in a trimmed lens, run again with a wider profile — or add its
coverage cell, which is the cheaper fix.

## Handoff to remediation

The audit never patches. `disposition` derives one decision per **published**
record:

| Record | Decision |
|---|---|
| `confirmed` | `accepted` |
| `needs_validation` | `deferred` (the blocking fact is named) |
| `rejected` | `dismissed` |

`REPORT.md` renders the same decision set from the same function, so the prose
and `disposition.json` cannot disagree. `/review-and-fix` reads the set under
`standalone-disposition`; remediation, tests and the verified Git index are its
job, not the audit's.

## Calibration

`engine/tests/fixtures/security/calibration/` is a small application with one
planted defect per attack class, each marked on a known line and described in
`DEFECTS.json`. `engine/tests/security/security-calibration.test.ts` holds the
program to three claims: the markers are where the file says, the enumeration
selects the lens and seeds a unit for every defect, and a recorded run publishes
each defect exactly once with complete coverage. Change a lens rule, the seeding
rules or the report derivation and that test tells you whether the audit still
reaches what it used to reach.

## What the report means

Read `REPORT.md` top-down:

1. **Security posture** — counts per verdict and coverage unit totals.
2. **Confirmed findings** — severity, boundary, the observed result. Each has a
   demonstrated impact; the overall severity may not exceed it.
3. **Needs validation** — leads with **no severity at all**, each naming the one
   fact that would settle it and a plan that does not touch a live target.
4. **Coverage** — the status table, the critic's verdict, and every deferred or
   out-of-scope unit with its reason.
5. **Disposition handoff** — the decision counts and the command that loads them.

A rejected claim stays in the record (with its refutation) so a later run must
bring changed evidence rather than rediscover it.

## Honest limits

- Coverage is only as good as the seeded cells: an attack class nobody seeded is
  not audited, and the report says so by omission from the table.
- A hunter demonstrates impact only through a bounded sandbox run whose receipt
  proves the limits held; a receipt is evidence that the run happened under
  those limits, not that the exploit is exploitable in production.
- The audit proves an exploit for the *frozen revision*. A dirty worktree is
  recorded; the report is about the commit, not the bytes on disk.
- Verification is a panel of model reviewers on a different profile, not a
  proof. INV-S3 makes a same-profile ballot worthless, not a wrong one right.
