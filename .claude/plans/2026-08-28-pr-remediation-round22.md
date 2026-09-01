# PR Remediation Round 22

## Authority
- Branch: `fix/deterministic-task-completion-post-merge`
- Source review: `review-20260828T191744Z-deterministic-task-completion-oracle-post-remediation-26`
- Source result digest: `61282731fafd34a514917b56660555af6a16211b7d03515af29db1f440c418c9`
- Exact frozen scope: the source result's 69-path `.scope` array.

## Mandatory fixes
1. Make anchored capability provenance identity-based and non-clonable at runtime: non-enumerable private brand plus module-private live/revoked WeakSets.
2. Revoke an `AnchoredDirectory` before closing its fd so stale capability objects cannot target recycled descriptor numbers.
3. Treat `#` as an unconditional comment marker for bound Python sources while retaining Rust attribute handling only for Rust/headerless compatibility.
4. Ignore escaped Python/Java triple-quote delimiters when tracking multiline strings.
5. Recognize a regex expression after a statement-closing brace as regex evidence, not executable matcher text.
6. Parse every SubagentStart JSON value into the domain shape before identity checks, string operations, or capability publication.

## Advisory dispositions
### Accepted
- Apply language-specific nested block-comment behavior: only Rust nests; TypeScript/Java close at the first delimiter.
- Close JSX attribute quotes at the quote character; backslash is not a JSX attribute escape.
- Add stale/unreserved failed Pi spec-check authority regression.
- Remove line-local regex flags from cross-line `AssertionLexicalState`.
- Derive `commitPiSpecCheck` reconciliation from `specCheck.wave` rather than a duplicate argument.
- Correct the no-follow module header from "refused" to "never followed" for safely removed/replaced leaf symlinks.

### Deferred
- Full scanner lexical-mode ADT: broader parser rewrite after this focused correctness set.
- ExactImplementationSettlement infrastructure ADT, ReservedSlot role ADT, Wave Gate module split, TaskGraph codec extraction, and Wave scope-parser/test-fixture cleanup: independent interface/deepening slices.

## Refuted-finding audit
- No critical finding was refuted; all six are mandatory.

## Validation
Focused scanner properties/examples, no-follow clone/revocation tests, SubagentStart domain-shape tests, failed Pi authority regression, typecheck/unused, full bounded Vitest, smoke with inherited Pi variables unset, production lint, diff check, registered remediation/index installation, commit/push, then fresh canonical review/refutation.
