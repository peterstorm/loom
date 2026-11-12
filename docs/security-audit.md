# Running a security audit

`security-audit` is a registered Loom program (ADR-0066), not a prompt. It
enumerates what it will cover, records what it proved, and reports the
difference. This is the operator's page: how to start a run, what the run
directory holds, what each operation refuses, and what to do with the result.

For the method — lenses, sandbox evidence, the finding trichotomy — read
`skills/security-audit/SKILL.md`. For why the program is code rather than prose,
read `docs/deterministic-core.md` §8 and ADR-0066. `/security-audit`
(`commands/security-audit.md`) is the same workflow expressed as a slash command.
The operations table below is the authoritative one; the command keeps a short
copy, and a test binds both to the traits table the engine routes on.

## Start here

<!-- wire-example: security-audit-start -->
```bash
loom helper security-audit start --out ../audit-run-1 --repo . --profile standard --budget 24 <<'JSON'
{ "units": [
    { "refs": { "surface": "http-ingress", "boundary": "api-edge",
                "subsystem": "auth", "attack_class": "injection" },
      "starting_paths": ["src/api/login.ts"],
      "ordinary_attack_class_block": "Injection: untrusted input reaching an interpreter.",
      "selected_companion_blocks": ["WEB-PROTOCOL-AND-AUTH.md#browser-session-attack-classes"] } ],
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
| `verdicts.json` | `verify --from` | a CACHE of imported ballots, each bound to the verifier spawn that cast it; re-proven against its run and capture attestation before every adjudication |
| `verification-runs/` | `start` (the root), `helper orchestration start security-verification` (each run) | the `security-verification` runs that issue verifier spawns and publish their bound ballots |
| `security-findings.json` | `publish` | the adjudicated records that leave the run |
| `disposition.json` | `disposition` | one decision per published record, for `/review-and-fix` |
| `standalone-disposition.json` | `disposition` | the exact start input the handoff command loads |
| `disposition-runs/` | `helper orchestration start standalone-disposition` | the remediation run the handoff command names |
| `REPORT.md`, `FINDINGS-DETAIL.md`, `NEEDS-VALIDATION.md` | `publish` | prose derived from the records |
| `agents/<owner-id>/{scratch,artifacts}/` | the hunter | its sandbox scratch and receipt artifacts — the only part a subagent may write |

Every read is parsed by the module that owns the document, so a hand-edited or
half-written file stops the next operation with a named violation instead of
flowing into a report. Writes go through no-follow primitives: a symlinked run
file is refused rather than followed. The `--out` directory's *parent* is the
run base and is resolved to its real path once, the way every Loom run base is,
so a base behind a system symlink works (macOS spells its temp root
`/var/folders/…`, and `/var` → `/private/var`); the run directory itself and
everything below it stay no-follow, so a symlinked run directory or a symlink
planted inside it is still refused. The run is reported and registered under
that one canonical path, whichever alias `--out` used. Every entry above except `agents/` is an
**authority entry** (`engine/src/core/audit-run-authority.ts` owns the names for
the CLI and the subagent guard alike), so a subagent cannot write it — see
[The subagent authority guard](#the-subagent-authority-guard).

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
| `merge-critic` | stdin (critic result) | the run is published, a proposal is malformed, a reassigned unit has no evidence to archive (`reassign-unit-has-no-evidence`), a reassignment carries no reason of its own (`missing-reassignment-reason`), a settled unit to reassign has no recorded owner to archive the attempt under (`terminal-unit-has-no-owner`), a resolution names a lead the engine cannot place (`unplaceable-resolution`) |
| `verify` | flags (`--from <verification-run>`) | stdin ballots; the run is published; the verification run is not a `security-verification` run under this audit, is unfinished, was issued against an older ledger or findings, or its `result.json` differs from the replay of its captured evidence |
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

Every **writing** operation also registers the run directory with the subagent
guard's registry (under the protected subagent directory) — `start` after its
fresh documents land, every other writer before it writes. Registration is
idempotent; if the registry was wiped mid-audit (a `/tmp` cleaner, a reboot),
the next write rebuilds it, and a write whose run cannot be registered is
refused rather than left unprotected.

## Verification

A `confirmed` claim publishes only on a ballot cast by an **issued** verifier
spawn on a profile that did not hunt, and **natively captured by the harness**
(ADR-0067, amended). There is no way to hand `verify` ballots on stdin, and no
CLI path writes into a verifier slot: `helper orchestration submit` and
`correlate` refuse every `security-verification` request. A ballot exists only
as the harness-captured output of a `security-verifier-agent` spawn of a
`security-verification` run; its agent and profile are read from the request the
engine minted, never from the payload.

**The data path carries the proof.** When the harness captures a verifier's
transcript (Claude Code's SubagentStop hook; the Pi extension's request-bound
capture), the capturing process also writes a **capture attestation** —
`{program, runId, runDirectory (realpath), requestId, slotId, attempt, role,
harness, nativeId, digest, byteLength}` — into a store under the protected
subagent directory (`security-capture-attestations/`, one immutable entry per
attempt, exclusive publish, no-follow, never swept). A ballot's
`binding.captureDigest` must equal its request's attested digest, and the
transcript in the run must still hash to it.

1. **Let the wave's hunt settle first.** A verification run is issued against
   the digests of `ledger.json` and `findings.json` as they stand. Any later
   `assign`, `submit`, `defer` or `merge-critic` moves them, and `verify --from`
   then refuses the run as stale; `status` names a NEW run (the run name binds
   both digests). Start verification once no hunter of the wave is in flight
   and the critic is merged, and import before the next ledger change.
2. **`status` prints the start command.** When confirmed claims await a bound
   ballot, `status` (and `status --json`, field `verification`) prints the exact
   `loom helper orchestration start security-verification --runs-root
   '<run-dir>/verification-runs' --run 'run.verify-w<wave>-g<generation>-<id>'`
   command with its input on a here-document, and the import command; every
   path is one shell-quoted word. Run them as printed. Claims are grouped into
   briefs of at most four; each brief is one verifier request on the
   `refutation` profile. When the current generation of a claim set is blocked
   or unimportable (a refused retry, a capture without its attestation),
   `status` names the next generation — up to 16 — and says why it retired
   each earlier one: the prose prints one `verification run <run> is retired:
   <reason>` line per dead run (it cannot be opened, its evidence cannot be
   read — possibly transient —, it is blocked, or its result is unimportable)
   before the start command, and `status --json` carries the same list as
   `verification.retiredRuns` (`[{ "run", "reason" }]`, empty when no run is
   retired). Read it before spending verifier spawns on a new generation.
3. **Spawn the verifiers it issues.** The start returns a spawn batch; dispatch
   each request with its task verbatim. The harness captures each verifier's
   final message into its slot and attests it. A malformed answer gets one
   retry, told why; a refused retry blocks the run. `helper orchestration
   resume` drives the run to `done`, publishing `result.json`. Start and resume
   also re-register the audit with the subagent guard's registry.
4. **Import it.** `loom helper security-audit verify --out <run-dir> --from
   <verification-run>` authenticates the run (registered, under this audit,
   issued against the current ledger and findings), requires `result.json` to
   be byte-identical to the replay of its captured evidence, and requires every
   ballot to match its capture attestation — a transcript with no attestation is
   refused as "not natively captured". It then appends the bound ballots to
   `verdicts.json`. Re-importing the same run adds nothing; a fingerprint that
   already carries another verification run's ballot is refused (one
   fingerprint, one verification run).
5. **`verdicts.json` is a cache.** `findings`, `status` and `publish` re-prove
   every cached ballot before counting it: its run must be a registered
   `security-verification` run of this audit, its evidence must replay to a
   result holding exactly the cached ballots (the replay checks the audit's
   identity, not its current digests, so later waves do not unprove earlier
   ballots), and every ballot must match its attestation. A ballot that fails is
   not counted and its run is a named publication blocker; a ballot written
   into `verdicts.json` by hand never reaches a report.

## The subagent authority guard

Hunters have Bash, so the commands that could inject authority are fenced off
from every subagent (ADR-0067 D6): Claude Code's `guard-subagent-authority`
PreToolUse hook on `Bash`, and its Pi `tool_call` twin. The caller signal is the
harness's own — Claude Code sets `agent_id` only on a subagent's call; on Pi
every child agent carries an explicit environment marker (`LOOM_PI_SUBAGENT=1`
on the extension's own `--mode rpc` children; `LOOM_PI_PARENT_PID` naming the
launching session process on every process it spawns) — so the parent session
is never affected, and a headless parent (`pi --mode json -p --no-session`
started without the marker) is a parent. The `LOOM_PI_PARENT_PID` path rests on
the installed subagent launcher copying the parent's environment into each
child; a launcher that drops it yields an unmarked child, which is a parent and
runs ungated. The extension cannot decide the role from launch flags, but it
writes a one-time stderr notice when it loads in a process launched like a
headless child (`--mode json|rpc`, `--no-session`) that carries no marker.

The authority guard and the rules gate read the same marker with opposite safe
directions. For **authority**, any marked process — explicit, inherited or
malformed — is a subagent, because refusing authority writes is safe. For the
**rules gate**, exemption is the unsafe direction, so only a provable child
agent is exempt: `LOOM_PI_SUBAGENT=1`, or a headless launch (`json`, `rpc` or
`print` mode) whose inherited `LOOM_PI_PARENT_PID` names another process. An
interactive `pi` that merely inherited the marker (for example one started from
a Loom Pi session's shell) and any malformed marker stay gated, and an
interactive process the authority guard treats as a subagent gets a stderr
notice naming why and which policy applies.

- **Helper operations.** A subagent may run only the read-only operations:
  `security-audit nonce|status|findings` and the read-only `orchestration`
  projections. The split is derived from the operation tables' `subagent`
  trait (`read-only` vs `parent-only`, declared beside `runtimeSkew` but a
  separate fact), so every writing operation (`start`, `assign`, `submit`, `defer`,
  `merge-critic`, `verify`, `publish`, `disposition`; `orchestration start`,
  `resume`, `submit`, `correlate`, `decide`, `abandon`, …) is refused, as is an
  operation the guard cannot name statically.
- **Harness entrypoints.** A Loom CLI hook route (`subagent-stop`,
  `post-tool-use`, …, including running `hooks/scripts/*.sh`) and a nested
  harness (`claude`, `pi`, `npx`/`bunx`/`pnpm dlx` of either) are refused.
- **Authority paths.** A write or redirection onto a registered run's authority
  entries, onto the run directory itself or an ancestor of it, or into a
  protected Loom directory (the subagent directory — run registry and capture
  attestation store — and the machine definitions) is refused. Each path is also
  judged in its canonical spelling (the realpath of its deepest existing
  ancestor), and each run is registered under both its spelled and real path,
  so `/tmp` ↔ `/private/tmp` and a symlinked `--out` are covered. Reads, copying
  authority *out*, and writes under `agents/<owner-id>/{scratch,artifacts}`
  stay allowed, as does `scripts/security-sandbox.sh`. The run's entry names
  have one owner, `core/audit-run-authority.ts`.
- **The run registry.** Every writing `helper security-audit` operation — and
  the `security-verification` program's `start` and `resume` — registers its run
  in `<subagent dir>/security-audit-runs/`. Registration is idempotent and never
  swept, so a registry wiped mid-audit is rebuilt by the next write; a write
  whose run cannot be registered is refused. At 4096 live entries the registrar
  prunes entries whose directory is gone, and the reader fails closed only while
  still over the cap. An unreadable registry refuses every authority-named path.
- **Normalisations.** Escaped command words (`\loom`), wrappers (`time`,
  `command`, `builtin`, `nice`, `nohup`, `timeout`, `stdbuf`, `setsid`, `env`,
  `sudo`, …), `coproc` and `!`; programs a shell is fed through a pipe, a
  here-string, an input redirect, a script file argument, `source`/`.` or an
  executed `./x.sh` (read at decision time, bounded, regular files only, in
  every directory a `cd`/`pushd` on the same line may lead to — the Pi import
  gate below reads them in the same places);
  `find -exec` and `xargs`; and interpreter code (`python -c`, `node -e/-p`,
  `bun -e`, `perl -e`, `ruby -e`, awk) that invokes a writing helper operation
  or a hook route, or imports an engine authority module.

A refused subagent is told to return its result to the parent session, which
runs every write. The guard is **defence in depth, not the proof**: it reads
shell strings, and it does not see a command or helper name the shell builds
from pieces (`eval "$a $b"`), a variable holding a whole authority path,
interpreter code built at runtime, names spelled in `printf` escapes, or a
script whose text is runtime-built. `engine/tests/core/subagent-authority.test.ts`
pins each of these as a known gap. None of them can produce an *attested*
capture: the capturing harness writes a capture attestation into
`<subagent dir>/security-capture-attestations/` (one immutable entry per
verifier attempt, never swept), `verify --from` requires it for every ballot,
and `findings`/`status`/`publish` re-prove every ballot `verdicts.json` caches.

This section is the one statement of the ADR-0067 guard and import-gate
contract. `docs/operations.md`, `docs/architecture.md` and
`docs/deterministic-core.md` point here and repeat only the invariant they rely
on; an amendment edits this section.

**Pi's import gate.** On Pi, the parent's `helper security-audit verify --from
<run>` is checked before it runs, by the same proof `verify --from` itself runs
(`proveVerificationSource`): `result.json` replayed byte for byte from the run's
evidence and every ballot matched to its persisted capture attestation. The
persisted attestation is the one authority on both harnesses — the extension
keeps no in-process witness of verification runs — so a restart or another
session never strands a correctly captured run, and the gate and the CLI cannot
disagree about one. The gate reads the import's `--out` and `--from`
statically: spell `--out` as the absolute run directory and `--from` as the run
name (as `status` prints them); a value the shell completes at runtime, or an
import fed to a shell through a script, pipe or here-string, is blocked.

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
scratch), and its descriptors likewise: stdin is the null device and every
descriptor the caller held above stderr is closed before the command starts, so
an open file or pipe the caller inherited (a CI runner's control pipe, say)
cannot be written through past the read-only mounts. The last stdout line is the receipt, and a `local` check counts as
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

`loopbackUp` is **recorded, not gated**: whether `ip link set lo up` succeeded
inside the network namespace, observed before the command starts. No external
network exists either way, so a dead loopback leaves the isolation intact and
the run can still count — but a command that probes a local service then fails
for a reason the receipt names, instead of reading as a healthy run. The ledger
epoch view prints it on the SandboxRun detail line (`network namespace,
loopback up yes|no; …`).

Every enforcement fact comes from one line the sandbox's inner shell prints
before the command starts:

```
LOOM-SANDBOX-LIMITS target_ro=<0|1> root_ro=<0|1> home_ro=<0|1> cpu=<0|1> mem=<0|1> procs=<0|1> files=<0|1> lo=<0|1> unremounted=<n>
```

`lo=` is the loopback fact (`loopbackUp`); the others map to `targetReadOnly`,
`readOnlyRoot`, `homeReadOnly`, the four `enforced` limits and
`unremountedMounts`. A missing or malformed line reads every fact as `0` —
nothing enforced, nothing closed, loopback down — so a sandbox that died early
never reads as bounded. That shell is PID 1 of the sandbox's pid namespace,
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
- A ballot is bound to the spawn that cast it (ADR-0067): its agent and profile
  come from the engine-minted request, its bytes from the harness capture, and
  its capture digest from the attestation the capturing harness wrote. The
  **parent session is trusted** — it runs every write and every capture hook,
  so an operator who forges a capture as the parent is outside this model.
  Against subagents, the [guard](#the-subagent-authority-guard) is a fence with
  known bypass classes: a subagent that evades it can still write FILES — a
  transcript into a verification run, a ballot into `verdicts.json` — but it
  cannot produce an attested capture, so neither is ever counted.
- What protects the attestation store: it lives in the protected subagent
  directory, which `guard-state-file` refuses every Bash and helper write into,
  `block-direct-edits` refuses for file tools, and the subagent guard refuses
  for subagents; it is written exclusively (never replaced) and read
  fail-closed. Its own residual is the fence's: a subagent that evades every
  Bash guard and writes a canonical attestation into the store by hand, for a
  forged transcript, would be believed. The guards above are what stand
  between a subagent and that write.
