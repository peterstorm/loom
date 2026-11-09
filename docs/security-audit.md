# Running a security audit

`security-audit` is a registered Loom program (ADR-0064), not a prompt. It
enumerates what it will cover, records what it proved, and reports the
difference. This is the operator's page: how to start a run, what the run
directory holds, what each operation refuses, and what to do with the result.

For the method — lenses, sandbox evidence, the finding trichotomy — read
`skills/security-audit/SKILL.md`. For why the program is code rather than prose,
read `docs/deterministic-core.md` §8 and ADR-0064. `/security-audit`
(`commands/security-audit.md`) is the same workflow expressed as a slash command.
The operations table below is the authoritative one; the command keeps a short
copy, and a test binds both to the traits table the engine routes on.

## Start here

```bash
loom helper security-audit start --out ../audit-run-1 --repo . --profile standard --budget 24 <<'JSON'
{ "units": [
    { "refs": { "surface": "http-ingress", "boundary": "api-edge",
                "subsystem": "auth", "attack_class": "injection" },
      "starting_paths": ["src/api/login.ts"],
      "ordinary_attack_class_block": "Injection: untrusted input reaching an interpreter.",
      "selected_companion_blocks": ["WEB-PROTOCOL-AND-AUTH.md#authentication-and-session-handling"] } ],
  "signals": { "languages": ["ts"], "manifests": ["package.json"], "servesHttp": true } }
JSON
```

Keep `--out` **outside** the audited repository. A bounded local check runs in
`<run-dir>/agents/<owner-id>/scratch`, the sandbox refuses a scratch inside its
target, and `nonce` refuses to bind a run the sandbox would refuse — a run
directory inside the repository can only ever hold source checks.

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

This is the authoritative operations table. Every operation takes `--out
<run-dir>`.

| Operation | Input | Refuses when |
|---|---|---|
| `start` | stdin (`units`, optional `signals`, optional `scope`) | a run already exists (unless `--force`), a seed is malformed or duplicated, `scope.kind` is not `tree` or `diff`, `signals` is malformed, the budget cannot seat the first wave |
| `assign` | flags `--unit --agent [--wave]` | the run is published, the unit is not `planned`, the Agent Catalog cannot place `--agent` |
| `nonce` | flags `--artifact` | the path is not `agents/<owner-id>/artifacts/<file>`, no `in_progress` unit is owned by that owner, an archived attempt already cited the artifact, the run directory lies inside the target |
| `submit` | stdin (`security-hunter-result`: `units`, optional `findings`) | the run is published, the envelope is not `{schemaVersion: 1, kind: "security-hunter-result"}` or carries an unknown key, a unit is not the named owner's or not the current wave, a check is malformed, a `local` check names no receipt or a receipt that does not prove a bounded run, a filed fingerprint the run already holds arrives with different content |
| `defer` | flags `--reason [--unit]` | the run is published, the reason is missing, the unit is not `planned` |
| `merge-critic` | stdin (critic result) | the run is published, a proposal is malformed, a reassigned unit has no evidence to archive |
| `verify` | stdin (`verdicts`) | the run is published, a ballot is malformed, a field is invented |
| `findings` | flags `[--json]` | the ledger or records do not parse |
| `publish` | flags | any publication blocker (see below) |
| `disposition` | flags | nothing has been published yet |
| `status` | flags `[--json]` | the run does not parse |

`status`, `findings` and `nonce` are read-only: they write nothing — they do
not even create the `--out` directory — and stay available while the Pi runtime
is skewed; every other operation proves the runtime first. `verify` only records
ballots (`critical` or `advisory`); the decision they make — `confirmed`,
`needs_validation` or `rejected` — is taken by one adjudication at `findings`
and `publish`.

### Owners

`assign --agent` names a **catalog agent** (`security-hunter-agent`), not an
attempt. The ledger mints the unit's owner id from it: the bare catalog name for
the unit's first attempt, `<agent>--<n>` (`security-hunter-agent--2`) once a
critic reassignment has archived an earlier one. `assign` prints the minted id:

```
assigned <coverage-id> to owner <owner-id> at wave <n>
nonce: loom helper security-audit nonce --out <run-dir> --artifact agents/<owner-id>/artifacts/<file>
```

The hunter settles under exactly that id — `agentId` and every check's
`agent_id` in its `submit` payload, and its scratch and artifact paths
(`agents/<owner-id>/scratch`, `agents/<owner-id>/artifacts/...`). Freshness
after reassignment holds by construction, and the catalog agent the owner id
carries is what `publish` reads to learn which model profile hunted.

### Filing

`submit` reads the hunter's own envelope,
`{ "schemaVersion": 1, "kind": "security-hunter-result", "units": [...], "findings": [...] }`
— not a reviewer payload. `units` is required (empty when a submit only files
records); `findings` is optional. A record the run already holds verbatim is
kept once, so a retried submit converges. A fingerprint the run already holds
with **different** content is refused, naming every such fingerprint, before
anything is written: omit it, or re-file it byte-identical — verification
adjudicates the record the run already holds.

### Receipt nonces

A hunter cannot compute the nonce its receipt is bound to. The parent runs

```bash
loom helper security-audit nonce --out ../audit-run-1 --artifact agents/<owner-id>/artifacts/<file>
```

and hands the output to the hunter: the nonce, and the exact sandbox command —
target, the owner's scratch, every limit, `--nonce`, and the redirect into that
artifact — with nothing left to fill in but the command under test. The local
check then cites exactly `agents/<owner-id>/artifacts/<file>` as its
`artifact`.

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

The profile also caps how many **lens documents** one run holds in context:
`quick` 2, `standard` 4, `deep` 8 in total. `ATTACK-CLASSES.md` is always one of
them — it occupies context like any other — so a profile leaves room for 1, 3 or
7 companion lenses (`selectSecurityLenses`). A lens trimmed by the cap is listed in `excluded` with its
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

## The sandbox

`scripts/security-sandbox.sh` is the only way a hunter demonstrates a result. It
runs one command under `unshare` with only loopback networking, the target
bind-remounted read-only, `ulimit` CPU, address-space, process and file-size
limits, and a wall clock. The child's environment is emptied and repopulated
with exactly `PATH HOME TMPDIR LANG TERM` (`HOME` and `TMPDIR` point at the
scratch). The last stdout line is the receipt, and a `local` check counts as
observed only when its receipt says:

- the command exited zero and every ulimit was really applied;
- `targetReadOnly` — **observed**, like home: the inner shell reports the
  target closed only after a write to it failed, and stops before the command
  when the remount fails or silently misses. A missing facts line reads as open;
- `homeReadOnly` — **observed**, not inferred. Home is closed first, so binds of
  a target or scratch that live inside it land on top of a read-only home; then
  a write to home must actually fail. An unknown home, or a remount that
  silently missed, reads as open, and the receipt does not count;
- the measured scratch footprint is within `--scratch-mb`. That is a **post-run**
  footprint check: nothing caps the scratch while the command runs.

`readOnlyRoot` and `unremountedMounts` are recorded residual exposure, not
gates: a user namespace cannot remount a superblock it does not own, so gating
on them would refuse every run. They are reported rather than claimed closed.

Every enforcement fact comes from one line the sandbox's inner shell prints
before the command starts. That shell is PID 1 of the sandbox's pid namespace,
so it points its own stdout and stderr at `/dev/null` right after printing the
line: once the command runs, no process inside the sandbox holds the stream the
facts are read from, and a write to `/proc/1/fd/1` cannot append a forged line.
The script also reads the **first** facts line, the only one that can predate
the command.

The receipt is marked with a nonce derived from the artifact path the ledger
names — `nonce` prints it (see [Receipt nonces](#receipt-nonces)) — so a receipt
is **bound** to that artifact: a receipt line the command
printed itself, or a receipt copied from another check, does not carry the
marker the engine looks for. The nonce does not **authenticate** the receipt: a
hunter that writes the artifact file itself can forge one. The defence against a
dishonest hunter is the independent verifier, not the receipt.

## Honest limits

- Coverage is only as good as the seeded cells: an attack class nobody seeded is
  not audited, and the report says so by omission from the table.
- A hunter demonstrates impact only through a bounded sandbox run whose receipt
  says the limits held; a receipt is evidence that the run happened under those
  limits — bound to its artifact, not authenticated (see the nonce above) — not
  that the exploit is exploitable in production.
- Hunters cannot edit through tools (the machine gate denies `Edit`, `Write` and
  `MultiEdit`), but a shell write outside the sandbox is **recorded, not
  prevented**: it is visible to the reviewer of the unit. Inside the sandbox the
  target and home are read-only.
- The audit proves an exploit for the *frozen revision*. A dirty worktree is
  recorded; the report is about the commit, not the bytes on disk.
- Verification is a panel of model reviewers on a different profile, not a
  proof. INV-S3 makes a same-profile ballot worthless, not a wrong one right.
- A ballot's `agent` and `profile` are **self-reported**. `verify` parses them
  for catalog consistency only — the profile must be the one the Agent Catalog
  assigns that agent — not for proof that a spawn of that agent cast the
  ballot. Binding a ballot to its spawn identity is deferred; until then INV-S3
  holds against an honest orchestrator, not against one that mislabels ballots.
