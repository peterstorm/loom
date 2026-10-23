# ADR-0041: Family-site metric as one pure module with an in-repo baseline

## Status
Accepted (2026-10-23). Shipped with the G5b owner-enforcement feature
(`.claude/specs/2026-10-21-g5b-owner-enforcement/spec.md`, US6; plan
`.claude/plans/2026-10-21-g5b-owner-enforcement.md`, AD-11; interview Q4b).

## Context
G5a gave each owned Invariant one owner module, and G5b adds the gate checks that stop a Wave from writing a
new second copy of an owned rule. Neither one says how many second copies already exist. Three known
families have raw sites spread across the engine:

- **Fail-closed path probes.** `existsSync(` probes and hand-rolled "ENOENT proves absence" decisions outside
  `engine/src/utils/path-presence.ts`. These fail open on EACCES, ELOOP and EIO.
- **Shell tokenizing.** Whitespace splits and hand-rolled quote-state tokenizers outside the `core/shell-*.ts`
  owners.
- **Claim conservation.** Hand-derived `critical_findings` / `advisory_findings` views and `splice`-based
  multiset removals outside `engine/src/core/findings.ts`.

The operator decided (2026-10-21) that the metric ships now, and that consolidating the path probes is G5b's
separate live pilot, with the shell and claim families following later (OOS-001). The metric therefore has to
make consolidation progress a number recorded before and after the work, not a claim (US6). It has to:

- define every family's owners and patterns in one module (FR-029);
- give deterministic output that is available as JSON and can be compared with a recorded baseline (FR-030,
  AS-031..AS-033);
- leave the baseline at the feature's base commit recorded in the docs (FR-031, AS-034, SC-007).

The baseline has a further constraint: it must stay exact even though later Waves of this same feature add
engine files. The metric must also block nothing, because the sites it counts are existing debt and no Wave
in this feature is chartered to pay it down.

## Options Considered

1. **One blocking lint rule per family in the programmatic linter**
   - Pros: reuses the existing `engine/src/linter/programmatic/` machinery; new copies would be refused when
     they are written.
   - Cons: the 160 existing sites would fail every edit at once, so the rules would need allow-lists, which
     then become a second place that defines each family. A lint rule says pass or fail, not a count, so it
     gives no "before and after" number and no baseline comparison. Line regexes are too coarse to block on;
     blocking would turn every false positive into an edit failure. It also contradicts the decision that
     consolidation is separate work (OOS-001).

2. **AST-based scan over the TypeScript compiler API**
   - Pros: more precise. A comment, a string literal or a type annotation could never match by accident.
   - Cons: each family would need its own syntactic matcher, which costs far more than a gauge is worth.
     "Hand-rolled quote-state tokenizing" and "multiset claim removal" are idioms, not syntax shapes, so
     an AST matcher would still be a heuristic. It would also pull the compiler into a module that otherwise
     needs nothing. Here `typescript` is a devDependency, loaded at runtime only by the two owner-verification
     seams (`docs/operations.md`).

3. **Compute the baseline when it is needed (check out the base commit on demand), or keep it outside the
   repository (vault note, CI artifact)**
   - Pros: no committed JSON to keep fresh, and no risk of a stale file.
   - Cons: an on-demand checkout makes the helper write a worktree and depend on git history, though it is
     otherwise read-only. A baseline outside the repository cannot be reviewed with the change that cites it,
     and AS-034 / SC-007 ask for the counts in the docs at merge. A baseline taken from the branch HEAD would
     already include sites that later Waves add or remove, so it would not be the base.

4. **One pure module holding the `FAMILIES` table, scan, baseline parser, delta and renderers; a read-only
   shell helper; a committed baseline recorded with `--root` against the base commit** (chosen)
   - Pros: one place defines owners and patterns. The core is pure, so it is tested on in-memory files with
     no fixtures on disk, and determinism becomes a property of the bytes. The baseline is reviewable, diffable
     and pinned to `626db7fb`, whatever later Waves do. The same `--json` shape works as output and as baseline
     input, so a later run's output can serve as a new baseline.
   - Cons: line regexes are a gauge, not a proof (see Consequences). A committed baseline has to be re-recorded
     on purpose when the patterns are re-calibrated.

## Decision
**`engine/src/core/family-sites.ts` is the one pure home of the family-site metric. `helper family-sites` is
its read-only file-system shell, and `docs/family-sites.baseline.json` is its baseline at `626db7fb`.**

**Pure core: `engine/src/core/family-sites.ts`.** It is listed in `DEFAULT_PURE_MODULES` in
`engine/src/linter/programmatic/no-io-in-pure-modules.ts`, so I/O in it is a lint failure.

- `FAMILIES` is a frozen table of `Family = { id: FamilyId; owners: NonEmpty<string>; patterns: NonEmpty<RegExp> }`.
  `FamilyId` is the closed union `"fail-closed-path-probes" | "shell-tokenizing" | "claim-conservation"`.
  T3 calibrated the patterns against the known second copies at the base commit. It narrowed each pattern
  until mentions that decide nothing stopped matching: an ENOENT in an errno list, a view's type annotation,
  a one-sided quote check, a split on a single space. The final patterns live only in this table:
  - `fail-closed-path-probes` (owner `engine/src/utils/path-presence.ts`): `\bexistsSync\(`, and an
    `ENOENT` string literal on either side of `===` / `!==`.
  - `shell-tokenizing` (owners `engine/src/core/shell-quoting.ts`, `shell-command.ts`, `shell-normalize.ts`,
    `shell-substitution.ts`, `shell-write-targets.ts`, `shell-ansi-c.ts`): `.split(/\s+/`, one line comparing a
    character against two quote characters, and `let inSingleQuote` / `let inDoubleQuote` state flags.
  - `claim-conservation` (owner `engine/src/core/findings.ts`): `critical_findings` / `advisory_findings`
    used as a written object key, but not as a property read or a `readonly` / `string` / `never`
    annotation, and `.splice(<ident>, 1)`.
- `scanFamilySites(files: readonly SourceFile[]) → FamilySiteReport` scans only `engine/src/**/*.ts`. It drops
  test files through the shared `isTestFileBySuffixes(path, DEFAULT_TEST_FILE_SUFFIXES)`, which is the
  plan's `isTestFile` exclusion through the suffix-explicit entry point. Each family skips its own owners
  and only those, so an owner of one family is still scanned for the others. Comment lines are skipped. This
  was added during calibration and was not in the plan. Paths are normalized to `/`. Files are sorted by path
  in code-unit order (independent of locale), so the output depends only on the bytes and never on read order
  or host. Each `FamilySites` entry is `{ family, owners, patterns, count, sites }`, where `sites` is sorted
  `path:line` and `count === sites.length`. Unlike the plan's seed, the entry also carries the patterns'
  `source` strings. The report is `{ schema: 1, families }`.
- `parseFamilySiteBaseline(unknown) → DomainResult<FamilySiteBaseline, string>` parses rather than validates.
  It refuses a non-object input, a schema other than 1, a family named twice, and a count that is not
  `sites.length`. A baseline may name a family that `FAMILIES` no longer defines.
- `familySiteDelta(report, baseline)` returns a closed union per family:
  - `compared { baseline, current, delta, patternsChanged }`;
  - `unrecorded { current }` for a family that is new since the baseline;
  - `retired { baseline }` for a family the table dropped.

  `patternsChanged` flags a count that re-calibrated patterns moved, so it is never mistaken for
  consolidation. This variant set goes beyond the plan seed's bare delta.
- `serializeFamilySites` (the JSON, with `delta` appended when a baseline is given, and one trailing newline)
  and `renderFamilySites` (the human report) are both pure.

**Shell: `engine/src/handlers/helpers/family-sites.ts`.** It is registered as `family-sites` in
`engine/src/handler-routes.ts`. Usage: `helper family-sites [--json] [--baseline <file>] [--root <dir>]`.

- It walks `<root>/engine/src` and reads only directories and regular files, never following symlinks, so a
  scan cannot leave the tree. It hands the bytes to the core and prints the result.
- `--root` defaults to `LOOM_PACKAGE_ROOT`, so the metric measures Loom itself wherever it runs.
- An unknown argument, a value flag with no value, an unreadable or malformed baseline, and an unreadable root
  each return an error result.
- It never writes a file and never touches the State File.

**Baseline: `docs/family-sites.baseline.json`.** It is the helper's `--json` output, run with `--root` against
a detached worktree of `626db7fb` (the `main` merge this branch starts from), and the worktree was then
removed. The recorded counts are:

| Family | Owners | Raw sites at `626db7fb` |
|---|---|---|
| `fail-closed-path-probes` | `engine/src/utils/path-presence.ts` | 124 |
| `shell-tokenizing` | `engine/src/core/shell-{quoting,command,normalize,substitution,write-targets,ansi-c}.ts` | 23 |
| `claim-conservation` | `engine/src/core/findings.ts` | 13 |

The counts are cited in `docs/operations.md` ("Measuring second sites: the family-site metric") and in its
repository layout listing.

**Tests.** `engine/tests/core/family-sites.test.ts` covers the pure core:

- the table, owner exclusion, scope and comment skipping, calibration negatives and sort order;
- byte-identical output under any read order, and the JSON round trip through the baseline parser;
- the delta variants, malformed-baseline refusal, and purity listing.

`engine/tests/handlers/family-sites.test.ts` covers the shell through the real route:

- `--json --root`, the human output, and symlink containment;
- repeat-run identity, including over the repository itself;
- `--baseline` delta, including the recorded baseline against the live tree;
- argument and baseline errors.

## Consequences

**Positive:**
- Owners and patterns have one definition (`FAMILIES`), so the metric cannot disagree with itself. Adding a
  family is one table entry plus one `FamilyId` member.
- The core is pure, so determinism (AS-032) holds by construction, and the tests run on in-memory files with
  no repository fixtures.
- The baseline is pinned to `626db7fb` and committed, so later Waves of this feature, and the path-probe
  pilot after it, measure against a fixed reference. The before and after numbers are reviewable in the same
  diff as the work they measure.
- The `patternsChanged`, `unrecorded` and `retired` delta variants make each kind of change to the gauge
  itself visible, instead of folding it silently into a count.
- The metric is read-only and blocks nothing, so it adds no gate risk and no write authority.

**Negative:**
- Line regexes are a gauge, not a proof. A probe written across two lines, renamed, or wrapped in a helper
  outside the owner can escape the count. A line can also still match without being a real second copy. The
  `fail-closed-path-probes` count of 124 includes `existsSync(` calls whose fail-open behavior may be
  harmless where they are. Each family's count shows a trend, not a list of defects.
- Comment lines are skipped by a line-level heuristic (a line starting with `//`, `/*` or `*`), and no
  tokenizer runs. A pattern mentioned in a trailing `//` comment on a code line is still counted. A code line
  that happens to start with `*` would be skipped.
- The baseline JSON is committed by hand. Re-calibrating patterns without re-recording the baseline shows up
  only as `patternsChanged` in the delta, and nothing forces a re-record.
- The scan is fixed to `engine/src`. Second copies in `scripts/`, the Pi extension, or test helpers are not
  counted.
- Being a non-blocking metric means a Wave can add new raw sites without failing. The G5b owner-verification
  gate checks only owned Invariants whose family the Wave changed, not these three families as a whole, so
  growth shows only when someone runs the delta.
