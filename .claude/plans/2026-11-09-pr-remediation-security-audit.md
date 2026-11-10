# PR remediation — 2026-11-09 (review campaign 3)

- **Branch:** `feat/security-audit-program` (base `main` @ `0e8df9a5`)
- **Scope:** the whole branch diff (109 files), reviewed as four `--files` slices because
  the frozen diff exceeds one reviewer's read budget:
  `run.rf3-cores` (16), `run.rf3-handler` (38), `run.rf3-tests` (26), `run.rf3-docs` (29).
- **Review Run Directories:** `.claude/reviews/review-and-fix-runs/run.rf3-{cores,handler,tests,docs}`
- **Counts (inspection renderer):** cores 4 critical / 29 advisory → 4 surviving, 0 refuted;
  handler 0 / 28; tests 0 / 31; docs 0 / 17.

## Surviving criticals (all in `run.rf3-cores`)

| Finding ID | Disposition | Repair group |
|---|---|---|
| `code-reviewer-1` | repaired | `group.sandbox-home-attestation` |
| `silent-failure-hunter-1` | repaired | `group.sandbox-home-attestation` |
| `code-simplifier-1` | repaired | `group.sandbox-home-attestation` |
| `type-design-analyzer-1` | repaired | `group.owner-identity` |

### `group.sandbox-home-attestation` (DECLARED)

- **Root cause:** the inner shell bound target and scratch first and then skipped the home
  remount whenever either lay under home (a later home bind would have hidden them), while
  `home_ro` stayed `1` — so `homeReadOnly:true` was printed for a home that stayed writable.
- **Invariant:** `homeReadOnly` is true only when a write to the operator's home outside the
  scratch was attempted inside the sandbox and failed.
- **Fix:** home is closed first (`--rbind` + `remount,ro,bind`), target and scratch are bound on
  top, and the flag is set from an observed write probe; an unknown home reads as open.
- **Siblings:** `targetReadOnly` (proven: the script exits 127 when that remount fails),
  `readOnlyRoot`/`unremountedMounts` (recorded, not gated — comment corrected to say so).
- **Check:** `project:verify`. **Historical RED (DECLARED):** reproduced on this host before the
  fix — a command run with scratch under `$HOME` wrote `$HOME/.sbx-probe-file-*` and the receipt
  read `homeReadOnly:true`; the new `security-sandbox.test.ts` case asserts the write fails.

### `group.owner-identity` (DECLARED)

- **Root cause:** one ledger field (`agent_id`) had to be both a fresh per-attempt identity and an
  exact catalog agent name; a critic-reassigned unit could be neither re-hunted under the catalog
  name (not fresh) nor published under another (unplaceable).
- **Invariant:** an owner id is minted by the ledger from a catalog agent — the bare name for the
  first attempt, `<agent>--<n>` after — so it is fresh by construction and always resolves through
  `catalogAgentOfOwner` to a catalog profile; assignment refuses an unplaceable agent up front.
- **Siblings:** `huntingProfiles` (now reads owners through `catalogAgentOfOwner`, moved beside
  adjudication behind `adjudicateRun(ledger, findings, verdicts)`); ballot `agent` ids stay exact
  catalog names (verifiers are not ledger owners).
- **Check:** `project:verify`. **Historical RED (DECLARED):** the reassignment test in
  `security-coverage.test.ts` fails against the pre-fix `assignUnits` (owner-not-fresh).

## Refuted criticals

None — the panel upheld all four (security, reproduction and intent lenses; one `uncertain` from
the security lens on `type-design-analyzer-1`, which the other two upheld).

## Advisory dispositions — published (P5)

Published through `standalone-disposition`, `revision: initial`, provenance DECLARED:

| Source run | Policy run | Disposition digest |
|---|---|---|
| `run.rf3-cores` | `run.rf3-cores-policy` | `87fceb3eebe206ebc263c443fcf19368a0de132cc43929ddb02762738abce7d0` |
| `run.rf3-handler` | `run.rf3-handler-policy` | `36cc7a8555cfc582e32abb59b1193295df660ec67ccd7a43f076953defa374c0` |
| `run.rf3-tests` | `run.rf3-tests-policy` | `48f885d15c0a997aad9fc9346bd3005b943e73d4852a48498a66b767af3e2f0f` |
| `run.rf3-docs` | `run.rf3-docs-policy` | `0145b20060dc3cd6ff6693eff7fd4e5bf52181cc33b7595f05611841dbaea2f9` |

102 accepted, 2 deferred, 1 dismissed. Every entry's reason is in the published record.
Deferred: cores `architecture-tech-lead-4` (ballot attribution needs a harness-captured verifier
seam), docs `architecture-tech-lead-4` (dedicated hunter kind deferred by ADR-0066 D2).
Dismissed: docs `code-simplifier-5` (terminal `requires` is what `missingRequirements` reads).

## Validation

- `npm run verify` (root) — typecheck, full Vitest suite (report `.loom/completion-reports/verify.junit.xml`), six smokes.
- Registered remediation run `run.rf3-remediation` executes `project:verify` freshly.
