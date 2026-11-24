# PR #255 remediation: Java owner verification

- **Branch:** `feat/java-owner-verification` (worktree `loom-java-owner-verification`)
- **Scope:** the PR's whole diff against `origin/main` (31 files), review kind `all`
- **Review run:** `.claude/reviews/review-and-fix-runs/pr255-review-1`. Result digest `8dd6f023…0ab1ff`: 2 surviving critical findings, 0 refuted, 39 advisory
- **Advisory publication:** `.claude/reviews/review-and-fix-runs/pr255-policy-1`, disposition digest `593f03b4…c80788`

## Surviving critical findings (DECLARED)

| Finding | Disposition | Repair group |
|---|---|---|
| `code-reviewer-1` | repaired | `group.java-contextual-keyword-names` |
| `silent-failure-hunter-1` | repaired | `group.java-contextual-keyword-names` |

**Group `group.java-contextual-keyword-names`**
- **Root cause (DECLARED):** `qualifiedNameOf` and `isIdentifier` in `java-syntax.ts` matched `tokenType.name === "Identifier"` exactly. `java-parser` lexes each contextual keyword (`record`, `module`, `open`, `to`, `with`, `var`, `sealed`, `permits`, `exports`, `uses`, …) as its own token type in the `Identifier` category. Those segments were therefore dropped from package names, import names, static-import owners and dotted chains.
- **Invariant (DECLARED):** a token is a name when its type is `Identifier` or carries the `Identifier` category. Every package and import segment javac reads as a name is kept, so the reach rule compares the import the compiler honours.
- **Siblings (DECLARED):** `usesOf` (identifiers and dotted chains) and `blankLocalsOf` share the one `isIdentifier` predicate, and both are repaired with it. No other module reads Java tokens (ADR-0102 seam).
- **Selected check:** `project:verify` (`npm run verify`, required-file `verify.junit.xml`).
- **Historical RED (DECLARED):** against the reviewed code, `parseJava("package a.record; import a.module.open.B; …")` returned package `a` and import `a.B`. The new tests in `owner-verification-java-syntax.test.ts` ("reads a contextual keyword…"), `owner-verification-java-reach.test.ts` ("…contextual-keyword segment…") and `owner-verification-coverage.test.ts` ("…contextual-keyword segment the test imports…") assert the full names and fail against it.

## Advisory decisions

38 accepted and 1 deferred, published in `pr255-policy-1` with a reason for each:
- **Deferred:** `architecture-tech-lead-3`, splitting `parseJava`'s projection or making the sites lazy. This changes the seam ADR-0102 decided and needs its own ADR amendment and deepen pass; no defect is shown.
- **Accepted fixes:**
  - **Withheld javac-rejected sites:** final-field, initializer and blank-local assignment removal; a `break` guard in an endless loop; pattern-declaring guard-removal and logical-swap.
  - **One language decision:** a lazy `LoadAliases` port replaces `NO_ALIASES` and the shell's duplicate decision. A broken tsconfig can no longer mask `unsupported-language`.
  - **Parsed classifications:** `ObligationReading` carries the Java identities, the owner is `due[0]` by type, and `SourceLanguage`'s Java arm carries its identity. `javaSourceRootOf` is removed.
  - **Distill moves:** `tokensOf` returns source order, `importsOf`, `ruleChildren`, one message reader, one lexing pattern, the cast removed, the fixture `Family` cleaned, the duplicate import merged, and a plain loop in place of the constant property.
  - **Docs and comments:** ADR-0102 (path-only classification, no "total", the coverage reads, what the seam can prove), the `verification.md` remedies table (`unsupported-language`, Java `owner-unparseable`), and the seam header, test titles and fixture comments.
  - **New tests:** lambda discrimination, condition-negation per construct, guard shapes, record patterns, grammar refusal versus foreign errors, lazy grammar load in a fresh process, UTF-16/CRLF positions, the Java plan and runner `owner-unparseable` arm, and alias precedence.

## Refuted-finding audit

None. The panel (reproduction, intent and security lenses) upheld both critical findings. The security lens returned `uncertain` because no trust boundary is involved.

## Validation

Ordered by the user: the full suite runs in CI, not locally. Local runs covered `tsc --noEmit` over the engine and five of the changed core test files: java-syntax, mutation-plan, coverage, java-reach and language (169 tests green). The runner integration test was left to CI. The registered remediation (`helper orchestration start remediation`) was not run: it executes `npm run verify` locally, which the user asked to leave to CI.
