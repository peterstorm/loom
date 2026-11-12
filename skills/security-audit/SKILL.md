---
name: security-audit
version: "1.0.0"
description: "This skill should be used when the user asks to 'audit security', 'run a security audit', 'find vulnerabilities', 'threat model this', 'review for injection/XSS/SSRF/authz', 'check the attack surface', 'pentest prep', or needs a coverage-accounted, evidence-backed security review of a repository rather than a one-shot scan. Runs as the registered `security-audit` program: selected lenses over enumerated coverage units, hunters that may only claim what a sandbox receipt proves, independent verification, a finding trichotomy with no severity on unverified leads, and a deterministic report. NOT for applying fixes (confirmed findings hand off to `/review-and-fix`) and NOT for infrastructure, network, cloud-IAM or container hardening."
---

# Security Audit

A security audit that can say what it covered and what it proved. This is the
parent session's runbook; the hunter, verifier and critic agents do not load it.

**Platform.** A `confirmed` finding needs a bounded sandbox run, and the sandbox
needs Linux `unshare`. On a host without it (macOS has none) the sandbox refuses
to start, so every claim stays `needs_validation`. The audit still accounts for
coverage and reports leads there; say so in the summary.

**`loom helper`**, here and in every line the engine prints, stands for
`bun "$LOOM_DIR/engine/src/cli.ts" helper`, with `LOOM_DIR="${CLAUDE_PLUGIN_ROOT}"`.
No `loom` binary is installed.

Three properties separate this from a prompt that says "find vulnerabilities":

1. **Coverage is enumerated and settled before the run may claim completeness.**
   Every entrypoint × attack class is a unit with an owner, a status and a
   terminal disposition. A budget timeout is not cleanliness: an unsettled unit
   leaves the run incomplete with its reason recorded.
2. **Evidence is machine-checked, not asserted.** A hunter has no `Edit`,
   `Write` or `MultiEdit` tool; a shell write is not prevented (the doc's
   "Honest limits" says when it is recorded). The only way a hunter
   demonstrates an exploit is a bounded sandbox run — target read-only (the run
   aborts otherwise), home read-only exactly when the receipt attests
   `homeReadOnly` — whose receipt says the limits held.
3. **Severity is earned.** A finding nobody verified has no severity at all: it
   is a `needs_validation` lead. Severity enters the record only at
   verification, by a reviewer from a different catalog profile.

## The attack taxonomy is vendored

`${CLAUDE_PLUGIN_ROOT}/references/security-lenses/*.md` is the Cloudflare
`security-audit-skill` taxonomy, byte-identical to upstream at the commit
pinned in `MANIFEST.json`; `LOOM-DELTAS.md` beside it holds what Loom adds.
`start` selects lenses from the stack signals you give it, always keeps
`ATTACK-CLASSES.md`, and caps the count by profile. The lenses live in the
plugin, never in the audited repository.

## Enumerating units

`start` records the units you seed; it does not find them. Upstream's
reconnaissance prose is not vendored, so "Phase 1" in the lens files means this
step. Coverage is only as good as the cells seeded here.

1. **Signals.** Read the manifests and languages, then set each stack signal
   truthfully: `languages`, `manifests`, `servesHttp`, `rendersClientSide`,
   `drivesModelsOrTools`, `usesQueuesOrRpc`, `isolatesTenants`,
   `deploysInfrastructure`, `hasNativeMemory`, `hasAppOrLocalIpc`,
   `hasReleasePipelines`, `hasSharedResourcePressure`. They decide which lenses
   are selected; a misspelled signal is refused.
2. **Surfaces.** List every entrypoint where untrusted input arrives first:
   routes, CLI arguments, queue consumers, webhooks, file and protocol parsers,
   IPC endpoints, jobs that read external data. `surface` names one.
3. **Boundaries.** For each surface, name each trust boundary the input crosses
   on its way to a sink: anonymous to authenticated, tenant to tenant, user to
   admin, application to interpreter, service to service. One cell per boundary
   crossed, so a surface that crosses two boundaries is two cells.
4. **Subsystem.** The module that owns the path. Split a large codebase per
   subsystem, as `ATTACK-CLASSES.md` and each lens's "When to use this file"
   header advise.
5. **Attack class.** For each surface, boundary and subsystem, seed one cell per
   class in `ATTACK-CLASSES.md` that can apply there. `attack_class` is a short
   stable token (`injection`, `access-control`);
   `ordinary_attack_class_block` names that class's entry. The list at the top
   of `ATTACK-CLASSES.md` says which companion lens fits which target; add a
   companion block as `<LENS.md>#<section>`, the lens file and the slug of one
   of its headings (`WEB-PROTOCOL-AND-AUTH.md#browser-session-attack-classes`).
   The engine stores the reference as text and does not resolve it, so name a
   heading the lens has. A block you considered and left out goes in
   `excluded_blocks` with its reason.
6. **Starting paths.** Give the file where the input arrives, and the sink's
   file when you know it. Paths are repository-relative, and at least one is
   required. A hunter that cannot start from them reports `blocked`, so name
   real handlers, not directories.

Seed a cell you decide not to hunt with `status` `out_of_scope` or
`not_applicable` and its reason in `unresolved`, so the report discloses it. A
cell seeded twice is refused. Each planned unit costs one hunter invocation, and
`start` refuses a budget that cannot seat the first wave beside the critic and
validation reserve. The payload example is in the doc's
[Start here](../../docs/security-audit.md#start-here).

## Phases

`start` freezes the revision and records the units. `assign` and `submit` move
one unit through one hunter. The coverage critic checks the wave, and
`merge-critic` and `defer` settle what hunters did not. `status` prints the
`security-verification` run the settled wave owes; its verifier spawns cast the
ballots and `verify --from` imports them. `findings` and `publish` adjudicate
each claim as `confirmed`, `needs_validation` or `rejected`, and `disposition`
derives the handoff.

## The three things that go wrong without this shape

**Density collapse.** A hunter prompt that tries to cover the whole repo produces
a shallow pass over everything. One hunter, one unit, one boundary — the lens
file is the only thing it must hold in context.

**Assumed exploits.** "This looks like it would be exploitable" is a lead, not a
finding. The sandbox makes the difference mechanical: `scripts/security-sandbox.sh`
runs the proof under `unshare` with a read-only target, no network, and
`ulimit`-bounded cpu/memory/processes, then prints a receipt. No receipt, no
demonstrated impact, no severity.

**Coverage theatre.** A run that ran out of budget and reports "no critical
findings" is lying by omission. `coverageComplete` requires every unit settled;
`coverageSettled` allows deferrals but not silence. Both are computed, not
claimed.

## Finding trichotomy

Mirrors upstream `report-schema.json` (differential-tested against the vendored
validator):

| Verdict | Severity | Meaning |
|---------|----------|---------|
| `confirmed` | loom `critical` \| `advisory`; upstream 5-level `overall_severity` recorded and refutable | Demonstrated, with a verification verdict from a different profile |
| `needs_validation` | none | Plausible, unverified — stays in the report as a lead |
| `rejected` | n/a | Retained with its refutation; never silently dropped |

Upstream's `overall_severity` is kept as a recorded opinion that may not exceed
the demonstrated impact, so a hunter cannot inflate by adjective.

## Invariants

`INV-S1` a hunter's evidence is a sandbox receipt, and it has no write tool
(property 2) · `INV-S2` one terminal disposition per unit · `INV-S3`
confirmed requires a verdict from a different catalog profile · `INV-S4`
`needs_validation` carries no severity · `INV-S5` budget exhaustion ≠ clean
coverage · `INV-S6` reports derive from validated records, byte-identically.

## Handoff

An audit never patches; that is what keeps its coverage claims checkable.
`disposition` derives one decision per published record (`confirmed` →
`accepted`, `needs_validation` → `deferred`, `rejected` → `dismissed`) into
`disposition.json`, which `/review-and-fix` reads under `standalone-disposition`.

## Running it

[`docs/security-audit.md`](../../docs/security-audit.md#operations) owns the
operations table, every refusal, the run directory and the verification steps.
Read it before the first operation. This is only the order.

1. Choose a run directory outside the audited repository and pass it as
   `--out` to every operation. The sandbox refuses a scratch inside its target.
2. `start` with the enumerated units and signals on stdin. It prints the lens
   selection. If a unit names a companion lens the profile cap trimmed, start
   again with `--force` on a wider profile, or move that block to the unit's
   `excluded_blocks`.
3. Per planned unit: `assign --unit <coverage-id> --agent security-hunter-agent`,
   spawn one hunter with the owner id `assign` printed, and `submit` the JSON it
   returns. A hunter cannot compute the nonce its sandbox receipt is bound to;
   the parent runs `nonce` and puts the output in the brief.
4. Continue in the order Phases gives: critic and `merge-critic`, `defer`,
   `status` and the verification run it prints, `verify --from`, `findings`,
   `publish`, `disposition`, and `status` once more.

Only the parent session runs operations. The authority guard refuses a
subagent every writing operation and every write onto the run's authority
files, so each returns its result as its final message.
`commands/security-audit.md` holds the parent's spawning duties: each agent's
brief, when the critic runs, and what to check before stopping.
