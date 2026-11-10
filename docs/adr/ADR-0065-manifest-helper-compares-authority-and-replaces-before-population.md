# ADR-0065: The manifest helper compares authority, not bytes, and replaces it only before population

## Status
Accepted (2026-11-10). Found by a production run: the host-memory-spikes orchestration in fugue-dags, whose
plan declared an owned, mutation-verified invariant and therefore needed its schema-1 Verification Manifest
upgraded to schema 2 (an `affectedRunner`) before Task population. It changes `helper
write-verification-manifest` only. Population, the freeze, and every later reader of the frozen manifest
are unchanged.

## Context
`helper write-verification-manifest` is the one sanctioned seam for installing the operator's
`.loom/verification-manifest.json` while a State File is active: the guards block every direct write to the
path. It was create-only. It validated the candidate, wrote it with `O_EXCL`, and on `EEXIST` compared the
installed file's bytes with the candidate's canonical JSON, accepting an identical replay and refusing
anything else.

Two things went wrong in that run:

- **A false conflict.** The installed manifest was valid but hand-formatted (arrays inline), so its bytes
  differed from the canonical JSON of the same manifest. The helper reported `already exists with different
  authority` for a manifest that was, as parsed, identical.
- **No way to upgrade.** The manifest really did need to change (schema 1 to 2). The helper could not replace
  it, the guards blocked the orchestrator from editing it, and the documented route was an operator action
  "at an approved idle boundary". In practice that meant asking the user to run a `cp` themselves, an
  unvalidated write to a protected path with nothing checking what was copied.

The freeze rule this guards is narrower than "create-only": population reads the manifest once and freezes
it into the TaskGraph, and the helper already refuses every mutation once Tasks exist. Before population no
TaskGraph has frozen the old commands, so a replacement changes nothing anyone has relied on.

## Options Considered

1. **Keep create-only; document the operator `cp`.**
   - Pros: no code change.
   - Cons: keeps the false conflict; the sanctioned path to an upgrade is an unvalidated write that bypasses
     the very seam meant to validate it.
2. **Fix the comparison only.**
   - Pros: removes the false conflict.
   - Cons: a genuine upgrade still needs the unvalidated `cp`.
3. **Compare parsed authority, and add an explicit `--replace` that works only before population (chosen).**
   - Pros: the false conflict disappears; an upgrade goes through the same validation as a first install; the
     freeze boundary is unchanged; replacement still needs the operator's approval of the helper call.
   - Cons: the helper is no longer create-only, so a mistaken `--replace` before population can overwrite a
     manifest. Mitigated by requiring the flag explicitly and by the approval every sanctioned helper call
     already requires.

## Decision
- **Authority, not bytes.** The helper canonicalizes both sides through `parseVerificationManifest` and
  compares the canonical JSON. A manifest that differs only in whitespace or key order is the same authority:
  the call succeeds and the installed file is left untouched.
- **Explicit replacement.** `helper write-verification-manifest --replace` replaces different installed
  authority, and an installed file that is not a valid manifest. Without the flag both are refused, and the
  refusal names `--replace`. Any other argument is refused, so a typo can never silently mean create-only.
- **Only before population.** The existing rule is unchanged and checked first: once the TaskGraph has Tasks,
  every call is refused, with or without `--replace`.
- **Atomic and no-follow.** A replacement stages the canonical bytes in a fresh sibling with `O_EXCL` and
  renames it over the target inside the same anchored directory, so a reader sees the old manifest or the new
  one, never a partial file. A symlinked manifest file or directory is refused, as before.
- **Pure decision core.** `core/verification-manifest-install.ts` holds the argv parse, the canonicalization
  and `planManifestInstall`, a total function to `create | unchanged | replace | refuse`. The helper only
  reads, writes and maps the plan to a result.

## Consequences
- Upgrading a manifest before population is one validated helper call, approved like any other sanctioned
  helper, instead of an operator `cp` to a protected path.
- A hand-formatted manifest no longer reports a conflict with its own canonical form.
- Populated TaskGraphs are unaffected: their commands stay frozen at population, and the helper still
  refuses after population.
- `docs/workflows.md`, `docs/operations.md` and `commands/loom.md` no longer call the helper create-only.
