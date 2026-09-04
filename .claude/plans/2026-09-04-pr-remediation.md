# PR Remediation — 2026-09-04 (PR #41, review round 5)

- **Branch:** `feat/structural-spec-index` (worktree `/home/peterstorm/dev/claude-plugins/loom-structural-spec-index`, head `dfc88b4`)
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/review-20260904T155606Z-22321` (7 reviewers captured, 3 refutation verifiers — reproduction / intent / blast-radius — all upheld; canonical `result.json` digest `69f9d4de…`)
- **Reviewed scope (frozen):** `engine/src/parsers/parse-spec.ts`, `engine/src/parsers/index.ts`, `engine/tests/parsers/parse-spec.test.ts`, `engine/tests/parsers/parse-spec.property.test.ts`, `engine/tests/spec-template-contract.test.ts`, `references/spec-template.md`, `commands/specify.md`, `CONTEXT.md`, 5 plan records (phase 1 + remediation rounds 1–4)
- **Result:** 6 surviving criticals (all upheld 3–0), 0 refuted, 17 advisories — deduplicated into 3 critical fixes and 14 accepted advisories.

## Surviving critical findings (mandatory)

### Fix 1 — STRUCTURAL_ID near-miss net admits silent drops (code-reviewer-1, silent-failure-hunter-2, code-simplifier-2)

`engine/src/parsers/parse-spec.ts:61` — verified by execution by three panelists: bare `FR- 002:`, `FR - 002:`, `FR-002 :`, `FR-002  :`, `OOS - 003:`, `AS - 001:`, `FR-1234:`, `FR-  123:`, `FR-12345:`, and `123. FR-002:` all return `ok: true` with the line silently dropped, while the inside-bounds siblings error. The JSDoc promises "near-miss variants fail closed instead of vanishing".

**Concrete fix:** widen `STRUCTURAL_ID` so any ID-shaped line fails closed — any digit run (`\d+`), any combination of spaces/hyphens between family and digits (`[\s-]*`), optional space before the colon (`\s*:`), and the prefix alternation extended to blockquote (`>`) and heading (`#`) with 1–9-digit ordered-list markers (CommonMark §6.3):

```typescript
const STRUCTURAL_ID = /^\s*(?:\*\*|[*+-]|>|#|\d{1,9}[.)])?\s*(?:fr|as|oos)[\s-]*\d+\s*:\s*/iu;
```

The net is a boolean detector only (extraction stays with `ENTRY_PATTERNS`), so widening only converts silent drops into diagnostics. NFR/SC furniture stays legal (family must be exactly fr|as|oos after only whitespace/prefix). Pin with regression tests authored red against the buggy source across `FR- 002:`, `FR - 002:`, `FR-002 :`, `FR-002  :`, `OOS - 003:`, `AS - 001:`, `FR-1234:`, `FR-  123:`, `123. FR-002:`, `> FR-002:` (blockquote), `## FR-002:` (heading) — in FR body, acceptance block, OOS, and document-wide variants. Update the JSDoc to state the full accepted prefix set.

### Fix 2 — Tab-indented lines are parsed as real entries instead of indented-code furniture (silent-failure-hunter-1)

`engine/src/parsers/parse-spec.ts:114` — the furniture predicate tests `/^ {4,}/u` (spaces only). CommonMark expands each tab to the next 4-column tab stop, so a tab-indented line after a blank line is an indented code block: literal code, never spec text. Verified: FR-002 minted from the FR body, AS-002 from an acceptance block, OOS-002 from Out of Scope, glossary term "Beta" minted — all `ok: true`; the 4-space twins parse inert.

**Concrete fix:** expand leading tabs to 4-column tab stops at the top of the `withoutFences` loop (pure `expandLeadingTabs` helper; stops at the first non-space character so tabs inside content are untouched). This makes tabs behave exactly like their space equivalents uniformly — furniture blanking after a blank line/fence line/document start, fence openers indented ≤3 columns, closers marker-only at ≤3 columns (a tab-indented closer inside an open fence becomes literal code, keeping the fence open) — matching CommonMark in the same direction as round-4 fix 2. All downstream logic trims first or uses `^\s*`, so hashes and entry content are unchanged. Pin with regression tests authored red across FR bullet, acceptance bullet, and glossary row, mirroring the existing 4-space inert-furniture test.

### Fix 3 — Round-4 record claims suite evidence that does not exist (comment-analyzer-1, code-simplifier-1)

`.claude/plans/2026-09-04-structural-spec-index-remediation-round4.md:58` — "equality pinned by a suite assertion" — no engine test imports or asserts `STRUCTURAL_ID`/`RESERVED_FAMILY_ID` (verified by grep; the alias is a module-private const, so a suite pin is impossible without an export). The exact record-vs-artifact class round-2 critical C upheld 3–0. The remediation itself is implemented; only the evidence claim is false.

**Concrete fix:** reword the clause to state what is true: "one pattern constant derived once, both nets reference it; drift is prevented structurally by the binding (the alias is module-private, so no suite assertion pins it — and none is needed)." A runtime assertion would require exporting module-private symbols — an interface change out of scope for this PR.

## Advisory dispositions

| # | Advisory | Disposition | Reason |
|---|----------|-------------|--------|
| architecture-tech-lead-1 | ID net prefix grammar narrower than CommonMark (`> FR-002:`, `## FR-002:`, 100. FR-002: vanish) | **accepted** | Sound claim, same silent-drop class as Fix 1; folded into Fix 1 (blockquote/heading prefixes, `\d{1,9}` ordered markers) — complete in-scope fix in one move |
| architecture-tech-lead-2 | GFM single-dash delimiter row (`\|-,-\|`) mints bogus entry (`term: "-"`) | **accepted** | Sound, verified by execution; relax the separator test to `/^:?-{1,}:?$/u` (GFM accepts 1+) + regression test |
| pr-test-analyzer-1 | No test pins the acceptance-block thematic-break branch (parse-spec.ts:241) | **accepted** | Verified untested (only header-terminated variants pinned); small in-scope test |
| pr-test-analyzer-2 | No test pins the glossary non-row branch (parse-spec.ts:273) | **accepted** | Verified untested (grep: only the template fixture row); small in-scope test |
| pr-test-analyzer-3 | No test pins the preamble fail-closed variant of the document-wide net (parse-spec.ts:357) | **accepted** | Verified untested (only the non-required-section variant pinned); small in-scope test |
| pr-test-analyzer-4 | Round-4 record claims suite assertion (same as comment-analyzer-1) | **accepted** | Subsumed by Fix 3 — the record correction resolves it |
| pr-test-analyzer-5 | No test pins an empty Acceptance block terminated by `---` | **accepted** | Verified untested (header-terminated variants only); small in-scope test |
| pr-test-analyzer-6 | No test pins the case-insensitive header-shape skip (parse-spec.ts:291) | **accepted** | Verified untested; pins the deliberate skip-set behavior |
| pr-test-analyzer-7 | No test pins a tilde fence carrying an info string (`~~~yaml`) | **accepted** | Verified untested (bare `~~~` only); small in-scope test |
| code-reviewer-2 | Round-4 record claims suite assertion; alias unexported makes one impossible | **accepted** | Subsumed by Fix 3 — same record, same correction |
| type-design-analyzer-1 | Stringly-typed error payloads force substring matching | **deferred** | Round-4 deliberate deferral for the spec-check-consumer deepen phase; typed payloads are an interface change beyond this PR's documented boundary; no production consumer exists yet |
| type-design-analyzer-2 | Implicit hash↔content correlation (no smart constructor) | **deferred** | Same round-4 deferral and rationale — for the spec-check-consumer deepen phase |
| type-design-analyzer-3 | Barrel exports two tier-type names (`PlanInvariantTier`, `InvariantTier`) | **deferred** | Both names are defined on `engine/src/types.ts` (public engine surface) and re-exported through the parser barrel; out-of-scope consumers may import either name, so collapsing risks breaking them; deferred to the spec-check-consumer deepen phase with the other barrel-export work |
| comment-analyzer-2 | specify.md "one count per matching spec.md" ambiguous | **accepted** | Verified against GNU grep (`-c` prints one count line per file argument, including zero-count files); one-line rewording |
| comment-analyzer-3 | Round-1 correction note says the contract test is implemented "in" a plan file | **accepted** | The test lives in `engine/tests/spec-template-contract.test.ts`; one-line rewording |
| code-simplifier-3 | Redundant state fork in `withoutFences` backtick-info special case | **accepted** | Verified: the else-branch is byte-identical to the common fall-through tail; narrow the special case to `marker === null` — behavior-identical, one nested branch deleted (distill move) |
| code-simplifier-4 | Removable `as readonly string[]` cast in the `sections` guard | **accepted** | `REQUIRED_SECTIONS.some((section) => section === value)` is cast-free and behavior-identical; round-2 precedent for the cast-free shape (distill move) |

**Dismissed:** none.

## Refuted-finding audit

None — the refutation panel (reproduction / intent / blast-radius) upheld all 6 criticals 3–0; `refuted_critical_findings` is empty.

## Accepted advisory fixes (concrete)

1. **Fix 1 fold-in:** blockquote `>` and heading `#` prefixes; `\d{1,9}[.)]` ordered-list markers (CommonMark §6.3) — regression tests for `> FR-002:`, `## FR-002:`, `100. FR-002:`.
2. **GFM delimiter row:** separator test `/^:?-{2,}:?$/u` → `/^:?-{1,}:?$/u` + regression test (`|-|-|` parses as a separator; control `|------|` unchanged).
3. **New tests (red-authored):** acceptance-block `---` termination (subsequent bullets fail closed); glossary prose fail-closed; preamble fail-closed variant of the document-wide net; empty Acceptance block terminated by `---`; case-insensitive `| TERM | DEFINITION |` skip; tilde fence with info string.
4. **specify.md:** reword grep semantics to "one count per spec.md file (per-file, not a total) — including specs with zero markers."
5. **remediation.md (round-1 record):** reword the round-2 correction note to point at the real test location: `engine/tests/spec-template-contract.test.ts`.
6. **Distill moves:** narrow the `withoutFences` backtick-info special case to `marker === null` (delete one nested branch); cast-free `sections` guard.

## Support paths (not in reviewed scope)

- `.claude/plans/2026-09-04-pr-remediation.md` (this plan)

## Validation commands

```bash
cd engine
env -u PI_CODING_AGENT vitest run tests/parsers/parse-spec.test.ts tests/parsers/parse-spec.property.test.ts tests/spec-template-contract.test.ts --testTimeout=15000
npm run typecheck
env -u PI_CODING_AGENT vitest run --testTimeout=15000 --maxWorkers=4   # authoritative unit suite
npm run test:smoke
git diff --check
```

Regression tests are authored red first (watched fail against `dfc88b4`), then fixed green. Stop without staging or committing if validation cannot pass.
