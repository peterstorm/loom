---
name: security-audit
version: "1.0.0"
description: "This skill should be used when the user asks to 'audit security', 'run a security audit', 'find vulnerabilities', 'threat model this', 'review for injection/XSS/SSRF/authz', 'check the attack surface', 'pentest prep', or needs a coverage-accounted, evidence-backed security review of a repository rather than a one-shot scan. Runs as the registered `security-audit` program: selected lenses over enumerated coverage units, hunters that may only claim what a sandbox receipt proves, independent verification, a finding trichotomy with no severity on unverified leads, and a deterministic report. NOT for applying fixes (confirmed findings hand off to `/review-and-fix`) and NOT for infrastructure, network, cloud-IAM or container hardening."
---

# Security Audit

A security audit that can say **what it covered** and **what it proved** — not a
scan that reports whatever looked suspicious and calls it a day.

Three properties separate this from a prompt that says "find vulnerabilities":

1. **Coverage is enumerated and settled before the run may claim completeness.**
   Every entrypoint × attack class is a unit with an owner, a status and a
   terminal disposition. A budget timeout is *not* cleanliness — an unsettled
   unit leaves the run incomplete with its reason recorded.
2. **Evidence is machine-checked, not asserted.** A hunter is read-only by
   machine gate; the only way it demonstrates an exploit is a bounded sandbox
   run whose receipt proves the limits actually held.
3. **Severity is earned.** A finding nobody verified has **no severity at all** —
   it is a `needs_validation` lead. Severity enters the record only at
   verification, by a reviewer from a different catalog profile.

## The attack taxonomy is vendored, not paraphrased

`references/security-lenses/*.md` is the Cloudflare `security-audit-skill`
taxonomy, byte-identical to upstream at the commit pinned in
`references/security-lenses/MANIFEST.json` (see `ATTRIBUTION.md`). Lenses are
selected, never rewritten: `selectSecurityLenses` scores each against the
repository's stack signals and always keeps ATTACK-CLASSES first. The drift test
re-digests every file, so "vendored" stays true.

Read the selected lens files before hunting. They carry the per-class attack
mechanics — the part that is genuinely hard to re-derive per run.

## Phases

The program is a closed action set, not prose to follow loosely:

```
start → assign → submit → verify → findings → publish
                                ↘ defer / merge-critic ↗
```

| Action | What it does |
|--------|--------------|
| `start` | Freeze the source revision, enumerate coverage units, select lenses, write run metadata |
| `assign` | Give a planned unit to a hunter (reassignment archives the prior attempt) |
| `submit` | Record a hunter's candidates against its unit |
| `defer` | Mark an unreachable unit with one of the four reason tokens |
| `merge-critic` | Fold the critic's added units in, deduped by canonical coverage id |
| `verify` | Adjudicate candidates: confirmed / needs-verification / rejected |
| `findings` | Render the report from the validated records |
| `publish` | Emit `security-findings.json`; confirmed findings hand off to disposition |

`status` is read-only and answers the only question that matters before
stopping: **is the ledger settled?**

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

Mirrors upstream `report-schema.json` exactly (differential-tested against the
vendored validator):

| Verdict | Severity | Meaning |
|---------|----------|---------|
| `confirmed` | loom `critical` \| `advisory`; upstream 5-level `overall_severity` recorded and refutable | Demonstrated, with a verification verdict from a different profile |
| `needs_validation` | **none** | Plausible, unverified — stays in the report as a lead |
| `rejected` | n/a | Retained with its refutation; never silently dropped |

Confirmed findings are the only ones that reach disposition. Upstream's
`overall_severity` is kept as a *recorded opinion* that may not exceed the
demonstrated impact (INV-S3), so a hunter cannot inflate by adjective.

## Invariants

`INV-S1` hunter cannot write outside its scratch dir · `INV-S2` one terminal
disposition per unit · `INV-S3` confirmed requires a verdict from a different
catalog profile · `INV-S4` `needs_validation` carries no severity · `INV-S5`
budget exhaustion ≠ clean coverage · `INV-S6` reports derive from validated
records, byte-identically.

## Handoff

An audit **never patches**. `publish` writes the report and hands confirmed
findings to `standalone-disposition`; remediation belongs to `/review-and-fix`.
Keeping the audit read-only is what makes its coverage claims checkable after
the fact.

## Running it

```
loom helper security-audit start   --out <run-dir>     # enumerate + select lenses
loom helper security-audit assign  --unit <id> --agent security-hunter-agent
loom helper security-audit submit  <candidates.json>
loom helper security-audit verify  <verdicts.json>     # different-profile verdicts
loom helper security-audit findings                    # render
loom helper security-audit publish
loom helper security-audit status                      # settled?
```

The run directory holds the ledger, the lens selection, each hunter's
candidates, the sandbox receipts, the verification verdicts, and the rendered
report. Everything the report says is derivable from those files.
