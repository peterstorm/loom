# ADR-0043: The pure core is enforced by the purity linter, not a project regex rule

## Status
Accepted (2026-10-23). Shipped with the G5b owner-enforcement feature
(`.claude/specs/2026-10-21-g5b-owner-enforcement/spec.md`; plan
`.claude/plans/2026-10-21-g5b-owner-enforcement.md`, AD-13 and INV-2). This ADR records a deviation from
interview Q4d.

## Context
G5b adds owner verification. It finds which tests cover an owner module's siblings, plans deterministic
mutations of the owner, runs the tests against each mutant and turns the results into a verdict. The
decisions (coverage resolution, mutation planning, outcome classification, verdict assembly, obligations,
the owner map and the status projection) live in `engine/src/core/owner-verification/`. The work that has
effects (creating worktrees, spawning runner processes, reading files) lives in
`engine/src/orchestration/owner-mutation-workspace.ts` and
`engine/src/orchestration/owner-verification-runner.ts`. The split only holds if something stops a core
file from reaching for `child_process`, `fs`, the clock, randomness or `process.*`. A mutation verdict that
depends on wall-clock time or on ambient file state would also lose its determinism, and the property tests
over the core rely on that determinism.

In interview Q4d the user asked for this to be a `checkable` Invariant, which means a project regex lint
rule. Project regex rules cannot express it. They match line text and can only be narrowed by
`excludePatterns`, which are file-path suffixes (`engine/src/linter/loader.ts`, applied in
`engine/src/linter/executor.ts` with `normalizedPath.endsWith(p)`). No regex rule can say "only files under
this directory". A repo-wide rule such as "no `child_process` import" would be false, because the
orchestration shell has to import it. The plan grammar does not allow a `checkable` tier on a rule the linter
cannot enforce as written.

The engine already has a rule that can be scoped this way. The programmatic `no-io-in-pure-modules` rule
(`engine/src/linter/programmatic/no-io-in-pure-modules.ts`) applies to every path that matches
`DEFAULT_PURE_MODULES`. Its `isPureModule` treats a pattern with a trailing `/` as a directory prefix that
matches at a path boundary.

## Options Considered

1. **A checkable regex INV as asked in Q4d (one project regex rule per banned capability)**
   - Pros: Matches the interview answer literally. It sits in the plan's Invariant grammar as `checkable`,
     so the plan shows it as machine-enforced. A reader sees the rule text beside the INV.
   - Cons: It cannot be scoped to `engine/src/core/owner-verification/`. A repo-wide rule fires on the
     orchestration shell, which legitimately spawns processes and reads files. Making it hold would mean
     listing every impure file in the repo as a suffix exclude, an open-ended allowlist that breaks each
     time a shell file is added. Line-text matching also cannot tell an import from prose. It misses
     `require` or dynamic-import forms that the programmatic rule already handles, and it cannot grant
     narrow capabilities such as `import { createHash } from "node:crypto"`.

2. **Extend the regex rule loader with directory-scoped includes**
   - Pros: Would make Q4d literally expressible, and the change would be reusable by other projects.
   - Cons: It widens the general linter rule grammar (loader, executor, safety checks and docs) to serve
     one Invariant. It still duplicates what `no-io-in-pure-modules` already does better. The engine would
     then have two purity mechanisms that can disagree, which is the second-copy problem G5b exists to
     prevent.

3. **List the package in `DEFAULT_PURE_MODULES` and tier INV-2 `advisory` (chosen)**
   - Pros: Reuses the one purity rule the engine already trusts for its other pure modules. The
     trailing-slash entry covers every current and future file of the package, at any depth, with no per-file
     upkeep. It is still a text scanner, but a purpose-built one: one regex over the whole file finds
     `from`/`import`/`require` specifiers (dynamic `import("…")` and `require("…")` included), comment lines
     are skipped, banned globals are matched per line, and capability grants such as
     `import { createHash } from "node:crypto"` are exact patterns. It runs in the full-tier lint that the
     Wave Gate already runs. The AST-level check is `machine-purity.test.ts`, which parses every listed file
     with the TypeScript compiler API and audits its transitive import closure.
   - Cons: In the plan grammar INV-2 reads `advisory`, which on its own would suggest it is unenforced. The
     enforcement lives in the linter's shipped defaults rather than in the plan, so a reader has to follow
     the INV's `Unowned reason` to find it. This deviates from what the user asked for in Q4d.

## Decision
**The owner-verification core's purity (INV-2) is enforced by the programmatic `no-io-in-pure-modules` rule.
The package is listed in `DEFAULT_PURE_MODULES`, and INV-2 is tiered `advisory` in the plan, with an
`Unowned reason` that names the real enforcement.**

Concretely:

- `DEFAULT_PURE_MODULES` in `engine/src/linter/programmatic/no-io-in-pure-modules.ts` carries the directory
  entry `"engine/src/core/owner-verification/"` (added by T4). Every file in the package, at any depth, is
  therefore pure, the CT-1 contract surface `types.ts` that `engine/src/types.ts` imports included. An exact
  entry for `types.ts` once sat beside the directory entry; it was redundant (`isPureModule` treats the
  trailing-slash entry as a prefix, and the closure audit expands it), and the PR #131 review remediation
  removed it.
- The pure leaves that the package shares with the rest of the engine are listed as exact entries in the
  same list. `"engine/src/core/sibling-entry-point.ts"` is the `SiblingEntryPoint` shape that `types.ts`
  and the owner-verification contract both name. `"engine/src/core/owner-check-authority.ts"` is the
  `OwnerCheckAuthority` that the suite authorization (`core/verification-manifest.ts`) and
  `core/owner-verification/obligations.ts` share. `"engine/src/core/invariant-id.ts"` is the branded
  `InvariantId` that the plan model, the owner check authority and the owner-verification core share (PR #131).
  All three are leaves so that neither side imports the other through them.
- T3 enrolled the G5b family-site metric the same way, as the exact entry
  `"engine/src/core/family-sites.ts"`. Its fs shell is `engine/src/handlers/helpers/family-sites.ts` (see
  ADR-0041).
- `engine/tests/linter/programmatic/machine-purity.test.ts` expands each trailing-slash entry to every `.ts`
  file beneath it, nested subdirectories included (`PURE_FILES`). It requires every one of those files to pass the shipped default
  rule, and it audits each file's import closure. The test named "expands the owner-verification package
  entry to every file and grants typescript only to its two seams" pins the directory entry. It also checks
  that the `typescript` compiler API is granted only to `import-graph.ts` and `mutation-plan.ts` (ADR-0042,
  INV-1): `typescript` added to `verdict.ts` is rejected, and so is `typescript/lib/tsserverlibrary` added
  to a seam.
- `engine/tests/core/orchestration-contract-acyclic.test.ts` ("keeps top-level source domains acyclic
  across runtime and type-only imports") keeps the shared leaves honest. If `sibling-entry-point.ts` or
  `owner-check-authority.ts` were folded back into either side, the resulting cycle between
  `engine/src/types.ts` and the owner-verification package would fail it.
- Effects stay in the shell: `engine/src/orchestration/owner-mutation-workspace.ts` and
  `engine/src/orchestration/owner-verification-runner.ts`. Neither is a pure module.

## Consequences

**Positive:**
- One purity mechanism covers the whole engine. The owner-verification core is held to exactly the same
  rule, capability grants and closure audit as the machine, acceptance-contract and red-then-green cores.
- A new file added under `engine/src/core/owner-verification/` is pure by default. Nobody has to remember
  to enroll it, and the closure audit picks it up through the directory expansion.
- The ban is applied to import specifiers (including `require` and dynamic forms) and banned globals, with
  narrow capability grants, rather than to arbitrary line text. There are fewer false positives and fewer
  evasions than with a project regex rule, but the lint is not evasion-proof: it scans text, so a computed
  specifier (`require(name)`) or a global reached indirectly (`globalThis["process"]`) can slip past its
  patterns. The closure audit in `machine-purity.test.ts` narrows that gap for imports, since it parses
  real import syntax, but it too sees only string-literal specifiers.
- The linter's regex rule grammar stays unchanged, with no directory-scoping feature added for one caller.

**Negative:**
- INV-2 is tiered `advisory` in the plan even though it is enforced fail-closed. A reader who stops at the
  tier will underrate it, and only the `Unowned reason` and this ADR explain the gap.
- The enforcement lives in the linter's shipped defaults, not in project config or the plan. Removing or
  editing the directory entry in `DEFAULT_PURE_MODULES` silently drops the Invariant unless
  `machine-purity.test.ts` catches it. That test is now load-bearing for INV-2.
- The directory expansion in `machine-purity.test.ts` first read only the files directly inside the package,
  so a future subdirectory would have escaped the closure audit. #127 made it recursive before merge, with
  a test that pins nested expansion, so lint (`isPureModule`) and audit now cover the same files.
- This deviates from interview Q4d. The user asked for a checkable regex INV and got an equivalent but
  differently tiered mechanism instead.
