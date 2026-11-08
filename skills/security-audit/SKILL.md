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
| `disposition` | Derive the decision set (`accepted`/`deferred`/`dismissed`) `/review-and-fix` consumes |

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

An audit **never patches**. `publish` writes the report; `disposition` derives
one decision per published record — `confirmed` → `accepted`,
`needs_validation` → `deferred`, `rejected` → `dismissed` — into
`disposition.json`, which `/review-and-fix` reads under `standalone-disposition`.
The decision set is a function of the records, so the report's handoff section
and the file cannot describe different decisions. Keeping the audit read-only is
what makes its coverage claims checkable after the fact.

## Running it

Every operation takes `--out <run-dir>`; the run directory is the whole record.

```bash
loom helper security-audit start --out .audit/run-1 --repo . \
  --profile standard --budget 24 <<'JSON'
{ "units": [ { "refs": { "surface": "http-ingress", "boundary": "api-edge",
                          "subsystem": "auth", "attack_class": "injection" },
               "starting_paths": ["src/api/login.ts"],
               "ordinary_attack_class_block": "…",
               "selected_companion_blocks": ["WEB-PROTOCOL-AND-AUTH.md#authentication-and-session-handling"] } ],
  "signals": { "languages": ["ts"], "servesHttp": true } }
JSON

loom helper security-audit assign  --out .audit/run-1 --unit <coverage-id> --agent security-hunter-agent --wave 1
loom helper security-audit submit  --out .audit/run-1 < hunter-result.json
loom helper security-audit verify  --out .audit/run-1 < verdicts.json   # a different profile's ballots
loom helper security-audit merge-critic --out .audit/run-1 < critic.json
loom helper security-audit defer   --out .audit/run-1 --unit <coverage-id> --reason budget_cut
loom helper security-audit findings --out .audit/run-1 [--json]
loom helper security-audit publish --out .audit/run-1
loom helper security-audit disposition --out .audit/run-1
loom helper security-audit status  --out .audit/run-1 [--json]
```

`status` and `findings` are read-only and stay available while the Pi runtime is
skewed — they are what you read *while* recovering. Every other operation proves
the runtime first.

`publish` refuses on any publication blocker (an unverified confirmed claim, a
ballot cast on the hunt profile, an unsettled ledger) instead of publishing a
smaller truth than the run covered.
