# PR 41 remediation — round 8

**Branch**: `feat/structural-spec-index` (worktree
`/home/peterstorm/dev/claude-plugins/loom-structural-spec-index`, head `bb16a98`)

**PR**: <https://github.com/peterstorm/loom/pull/41> — *feat(spec): add structural
spec index with canonical AS-N/OOS-N ids*

**Review Run Directory**:
`.claude/reviews/review-and-fix-runs/review-20260905T053611Z-24444`
(canonical `result.json`, digest
`3d099d8207273b37aa584e12fdac4ff388010bc4737be3f4fd05f639f1227274`)

**Frozen scope** (changed-path union vs `main`, 16 paths):

```
.claude/plans/2026-09-01-structural-spec-index-phase1.md
.claude/plans/2026-09-04-pr-remediation-round6.md
.claude/plans/2026-09-04-pr-remediation-round7.md
.claude/plans/2026-09-04-pr-remediation.md
.claude/plans/2026-09-04-structural-spec-index-remediation-round2.md
.claude/plans/2026-09-04-structural-spec-index-remediation-round3.md
.claude/plans/2026-09-04-structural-spec-index-remediation-round4.md
.claude/plans/2026-09-04-structural-spec-index-remediation.md
CONTEXT.md
commands/specify.md
engine/src/parsers/index.ts
engine/src/parsers/parse-spec.ts
engine/tests/parsers/parse-spec.property.test.ts
engine/tests/parsers/parse-spec.test.ts
engine/tests/spec-template-contract.test.ts
references/spec-template.md
```

## Adjudication summary

| Bucket | Count |
|---|---|
| Critical findings found | 0 |
| Refuted criticals | 0 |
| Surviving criticals (mandatory) | 0 |
| Advisories | 8 |
| Advisories accepted | 8 |
| Advisories deferred / dismissed | 0 |

Zero criticals were raised, so the registered Refutation Panel had no non-empty
critical set to route; `refuted_critical_findings` is empty and there is no
refuted-finding audit to report.

### Refuted-finding audit

None. No reviewer raised a critical finding in this round, so no refutation
verdicts exist to audit.

## Advisory dispositions

Every advisory is **accepted**: each claim was verified against the source, each
is sound, and each has a complete fix inside the frozen scope. `parseSpec` has
no production consumer yet (`grep` over `engine/src` finds only the parser
barrel re-export), so type-level changes are total within this PR's own files
and cannot break a caller elsewhere.

| ID | Agent | Claim | Disposition |
|---|---|---|---|
| `pr-test-analyzer-1` | pr-test-analyzer | Acceptance-block near-miss matrix has no bold-asterisk in-block row; round 7's PTA-3 row landed in the Functional Requirements section instead | ACCEPT — Fix D |
| `pr-test-analyzer-2` | pr-test-analyzer | Failure-path tests assert only substrings of a joined error string, never a typed identity or an exact count | ACCEPT — Fix C + Fix E |
| `type-design-analyzer-1` | type-design-analyzer | `frs`, `scenarios`, `oos` share `readonly SpecEntry[]`, so two families can be swapped with no compile error | ACCEPT — Fix A |
| `type-design-analyzer-2` | type-design-analyzer | `content` and `contentHash` are structurally independent, so a mismatched `SpecEntry` is constructible | ACCEPT — Fix B |
| `type-design-analyzer-3` | type-design-analyzer | `errors` are plain strings, not a discriminated union of failure reasons | ACCEPT — Fix C |
| `comment-analyzer-1` | comment-analyzer | `STRUCTURAL_ID` JSDoc omits the close-paren ordered-list form `1)` that the regex accepts and the suite pins | ACCEPT — Fix F |
| `comment-analyzer-2` | comment-analyzer | The trailing section's `+ 1` in `sections()` is load-bearing and unexplained | ACCEPT — Fix G |
| `code-simplifier-1` | code-simplifier | `sections()` counts lines two different ways (`markdown.split("\n").length` vs `lineAt`) | ACCEPT — Fix G |

`comment-analyzer-2` and `code-simplifier-1` are the same seam from two angles
and are discharged by one change (Fix G).

## Fixes

### Fix A — family-typed entry collections (`type-design-analyzer-1`)

`engine/src/parsers/parse-spec.ts`. Introduce the family as a type parameter so
the three collections are mutually non-assignable:

```ts
export type SpecFamily = "FR" | "AS" | "OOS";
export type SpecEntryId<F extends SpecFamily = SpecFamily> = string & { readonly [SPEC_ENTRY_ID]: F };
export type SpecEntry<F extends SpecFamily = SpecFamily> = …;
export type ParsedSpec = Readonly<{
  frs: readonly SpecEntry<"FR">[];
  scenarios: readonly SpecEntry<"AS">[];
  oos: readonly SpecEntry<"OOS">[];
  glossary: readonly SpecGlossaryEntry[];
}>;
```

`parseEntries` becomes generic over the family it is parsing, driven by one
frozen per-family descriptor (pattern + section label + family tag) so the
pattern and the family tag cannot drift apart. The defaulted type parameter
keeps the exported `SpecEntryId` / `SpecEntry` names usable unparameterised.

### Fix B — unforgeable content hash (`type-design-analyzer-2`)

`engine/src/parsers/parse-spec.ts`. Add a phantom construction witness to
`SpecEntry` and `SpecGlossaryEntry` (`SpecGlossaryEntry` carries the identical
`content`/`contentHash` independence, and fixing one while leaving the other
forgeable would be incoherent) so the only way to obtain either type is through
the module-private smart constructors `specEntry` / `glossaryEntry`, which are
the sole place `specContentHash` is applied. External code can no longer build
an entry whose hash disagrees with its content.

### Fix C — `SpecParseError` discriminated union (`type-design-analyzer-3`)

`engine/src/parsers/parse-spec.ts`, `engine/src/parsers/index.ts`. Replace the
`readonly [string, ...string[]]` error channel with a sealed union of failure
reasons, each carrying its structured data (section, line, id, term), plus a
total `specParseErrorMessage` renderer built with `ts-pattern`'s `.exhaustive()`
(already a dependency, already the repo's idiom in `src/cli.ts`,
`src/machine/advance.ts`, `src/handlers/pi-adapter.ts`). Rendered messages stay
byte-identical to today's strings, so operator-facing diagnostics do not change;
what changes is that callers can now discriminate without matching on prose.
Export `SpecParseError` and `specParseErrorMessage` from the parser barrel.

### Fix D — bold-asterisk in-block near-miss rows (`pr-test-analyzer-1`)

`engine/tests/parsers/parse-spec.test.ts`. Add the two missing rows to the
acceptance-block near-miss matrix (the one round 7's PTA-3 committed to and its
triple-asterisk twin, which is only pinned in the Functional Requirements
section today):

```
["bold-asterisk", "** AS-999: Given a typo, When parsed, Then it fails closed"],
["bold-italic asterisks", "*** AS-999: Given a typo, When parsed, Then it fails closed"],
```

### Fix E — typed error assertions (`pr-test-analyzer-2`)

`engine/tests/parsers/parse-spec.test.ts`. With Fix C in place:

1. Every near-miss matrix asserts the exact expected error **object** with
   `toContainEqual`, not a substring of the joined prose.
2. Add one test pinning the **exact ordered error list** for a small determinate
   document, so a reorder, merge, or reword is caught rather than absorbed.
3. Add one test proving `specParseErrorMessage` renders every error the parser
   can emit — the renderer's totality is the thing that keeps diagnostics honest
   once they are typed.
4. Remaining prose assertions go through one `messagesOf` helper so the message
   surface is still pinned where the prose itself is the contract.
5. `parse-spec.property.test.ts` gains the runtime witnesses of the two new
   type-level invariants (every minted entry's hash is derived from its own
   content; each collection carries only its own family) and one totality
   property (no emitted error renders to empty text, for arbitrary input).

### Fix F — close-paren ordered-list in the `STRUCTURAL_ID` JSDoc (`comment-analyzer-1`)

`engine/src/parsers/parse-spec.ts`. The JSDoc's ordered-list example gains the
`1)` form the regex `\d+[.)]` accepts and `parse-spec.test.ts` pins as
`"close-paren ordered-list"`.

### Fix G — one line-counting rule in `sections()` (`comment-analyzer-2`, `code-simplifier-1`)

`engine/src/parsers/parse-spec.ts`. The trailing section's end becomes
`lineAt(markdown.length) + 1` — the same `lineAt` the other branch uses — with a
comment stating why the `+ 1` is load-bearing: the collected ranges are
half-open `[startLine, endLine)`, so the final section's end must be one past
the document's last line or the document-wide fail-closed net stops covering it.

### Fix H — CONTEXT.md ubiquitous language

`CONTEXT.md`. The **Spec Index** entry currently says only that malformed or
duplicate identifiers "fail parsing". Record that the failure channel is a
typed, exhaustively rendered diagnostic, so the living language matches the
type. In scope (`CONTEXT.md` is a reviewed path).

## Validation

Run from `/home/peterstorm/dev/claude-plugins/loom-structural-spec-index/engine`:

```bash
npm run typecheck
npm run test:unit
```

The unit suite is the relevant full suite for this scope; `test:smoke` shells
out to the installed plugin runtime and fails closed on worktree version skew
(recorded in round 5), which is unrelated to this change.

Both must pass before any staging. Nothing is staged or committed if validation
cannot pass.

## Follow-up — Fix I: non-empty projections (operator-directed, not a review finding)

Raised in review of this round's own result, not by a reviewer: on `ok: true`
the parser has *proved* every collection non-empty — `parseEntries` and
`parseGlossary` record `section-has-no-entries` / `glossary-has-no-terms` and
any error forces `ok: false` — yet `ParsedSpec` still typed them as plain
arrays. A consumer therefore had to re-check `.length > 0` for something the
parse had already established: the parse-don't-validate smell this PR otherwise
closes.

`engine/src/parsers/parse-spec.ts`:

- Add `NonEmpty<T> = readonly [T, ...T[]]` (the per-module idiom already used in
  `core/proof-obligations.ts`, `core/panel-program.ts`,
  `core/orchestration-contract/identity.ts`), and give all four `ParsedSpec`
  collections that type. `SpecParseResult`'s error channel reuses the same name
  for the tuple it already had.
- `parseEntries` and `parseGlossary` return `NonEmpty<…> | null`, recording the
  emptiness diagnostic at the same point they do today, so the emitted error
  **order is unchanged** and the round-8 exact-ordered-list pin still holds
  byte-for-byte.
- `parseSpec` gates on `frs === null || … || errors.length > 0`, the idiom
  `core/standalone-review.ts` uses. A `null` collection and a recorded
  diagnostic are the same condition, so the guard cannot report a failure
  without a reason — and unlike `preparationFailure` there, no sentinel error
  and no non-null assertion is needed.

`engine/tests/parsers/parse-spec.test.ts`: two expected-error directives pin
what no runtime assertion can — an empty array is not assignable to
`ParsedSpec["frs"]`, and `ParsedSpec["scenarios"]` does not accept
`parsed.value.frs`. `tsc` fails the build if either error stops occurring, so
this also converts the round-8 family-branding fix (`type-design-analyzer-1`)
from a runtime witness into a compile-time one.

**Known limit, stated rather than implied**: `noUncheckedIndexedAccess` is off
in `engine/tsconfig.json`, so indexing a plain array already yields a
non-`undefined` type. `NonEmpty` therefore does not remove `| undefined` at use
sites here; what it buys is that the guarantee is stated in the signature and
that a future change projecting an empty collection fails to compile. Turning
that flag on is a repo-wide change and is not in this PR's scope.

## Remediation run

A fresh remediation Run Directory under
`.claude/reviews/review-and-fix-runs`, `sourceRun`
`review-20260905T053611Z-24444`, with this plan file named in `supportPaths`
(it is outside the frozen review scope).
