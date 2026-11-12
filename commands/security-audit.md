---
description: "Run a coverage-accounted, evidence-backed security audit over a repository"
argument-hint: "[--out ../audit-run-1] [--repo .] [--profile quick|standard|deep] [--budget N] [--resume <run-dir>]"
allowed-tools: ["Bash", "Glob", "Grep", "Read", "Write", "Edit", "Task", "Agent"]
---

# Security Audit

**Arguments:** "$ARGUMENTS"

Read `${CLAUDE_PLUGIN_ROOT}/skills/security-audit/SKILL.md` completely, then
`${CLAUDE_PLUGIN_ROOT}/docs/security-audit.md` (Operations: the one operations
table, with every refusal). Run the audit through the registered
`security-audit` program in the order the skill gives. Every operation takes
`--out <run-dir>`; the run directory is the whole record.

`LOOM_DIR="${CLAUDE_PLUGIN_ROOT}"`, and `loom helper` in the engine's printed
lines means `bun "$LOOM_DIR/engine/src/cli.ts" helper`.

This file adds only what the parent session does around the operations.

## Briefing a hunter

One hunter, one coverage unit. After `assign`, spawn
`loom:security-hunter-agent` with a brief that carries:

- the unit as `ledger.json` records it: coverage id, the four refs, starting
  paths, the ordinary attack-class block, and the companion and excluded blocks;
- the owner id and wave `assign` printed, the absolute run directory, and the
  repository path;
- the absolute path of each lens file the unit names:
  `${CLAUDE_PLUGIN_ROOT}/references/security-lenses/ATTACK-CLASSES.md` and the
  lens of each companion block. `start` prints these paths relative to the
  plugin, and a hunter's working directory is the audited repository;
- for a bounded local run, the output of `loom helper security-audit nonce --out
  <run-dir> --artifact agents/<owner-id>/artifacts/<file>`, with the script path
  written as `${CLAUDE_PLUGIN_ROOT}/scripts/security-sandbox.sh`. Skip this on a
  host without `unshare`: the hunter then files leads only.

`submit` the hunter's final message unchanged.

## Running the coverage critic

When every hunter of the wave is submitted and before verification, spawn one
`loom:security-critic-agent`. Its brief is the absolute run directory and the
wave number; it reads `ledger.json`, `findings.json` and `run.json` itself.

Pipe its JSON to `merge-critic`. If it lists `reassignIds` or
`resolvedPriorLeads`, wrap it with `reassignmentReasons` and `priorLeadOwners`
(doc, "Critic merge"). The critic's document has no field for a reassignment
reason, so write each one from the unit's ledger record.

- `stop: true`: go on to verification.
- Otherwise the merge leaves `planned` units. If the budget still holds a
  hunter and another critic pass, assign them as the next wave and run the
  critic again after it. If not, `defer` them. `quick` reserves a single critic,
  so its first pass is its last.

## Verifying

Run `status` and follow the doc's Verification steps: start the run it prints,
spawn each `loom:security-verifier-agent` request with its task verbatim,
`resume` until `done`, then `verify --from`. The harness captures each
verifier's answer; you do not submit it.

## Before stopping

- `defer` every unit the budget could not reach, with a reason. A deferred unit
  is a disclosed gap; a silent one is a coverage claim the run cannot support.
  A `blocked` unit blocks `publish` and cannot be deferred until a critic
  reassignment returns it to `planned`.
- Run `status`. `runStatus` `incomplete` means the run disclosed what it did not
  cover. Report that, never "no critical findings".
- The audit never patches. `disposition` prints the `standalone-disposition`
  command; hand confirmed findings to `/review-and-fix` from there.
