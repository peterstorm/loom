# ADR-0064: Bun reports — file identity from the `file` attribute, collection errors from the console

## Status
Accepted (2026-11-09). Found by a production run: the host-memory-spikes orchestration in fugue, a Bun
monorepo. It amends the per-file identity rule of the G4 slice-2 per-file results (`AS-004`: identity "is
the classname exactly as written") and extends where capture reads report facts (`findReport`). It changes
nothing for Vitest, Jest, Surefire or Node reports.

## Context
I6 (red-then-green) judges an attempt from the per-file results of its ledger `TestRun` facts. A Task that
creates implementation files meets the red step when its test files fail to load them (a collection error).
Under Bun, both halves of that judgment failed:

- **Identity.** Bun's JUnit reporter writes the `describe` chain as a testcase's `classname` (`"outer"`,
  `"inner > outer"`, and `""` for a top-level test) and the test file as a separate `file` attribute. Loom
  grouped per-file results by `classname`. A green Bun run was keyed by describe titles, so no Task test file
  was ever attributed and green could never be proven. A top-level test's empty classname made the whole
  report's per-file results unrecorded. The Wave Gate's acceptance attribution and owner verification read
  `classname` too.
- **Collection errors.** Verified on the pinned Bun release and the one before it: a test file that fails to load is absent from
  Bun's JUnit report, and when every file of the run fails to load, Bun writes no report at all. Loom had no
  way to see the red a creating Task's brief tells it to produce, so a correct test-first attempt settled
  `retry-required: red-then-green-unproven:red-missing` and spent its retry.

Bun's console output does carry the fact. Each file's results follow a `<path>:` header, and a file that
throws while loading (or between tests) prints `# Unhandled error between tests`. Bun's own summary counts
each such error as a failing test (`Ran 5 tests across 3 files … 2 fail`, for four JUnit testcases with one
failure plus one file that never loaded).

## Options Considered

1. **Leave Loom as is; Bun projects write tests that import inside the test body.** A missing module then
   fails a testcase Bun records.
   - Cons: shapes every project's test code around a reporter gap, and the green-identity bug remains.
2. **Infer a collection error from the command line** (a test file named on the command but absent from the
   report, with a non-zero exit).
   - Cons: the command string would contribute to report facts, which the per-file contract forbids (FR-002);
     it misses files Bun discovers itself; it cannot tell a load failure from a filtered-out file.
3. **Read Bun's identity from `file`, and its collection errors from its console (chosen).**
   - Pros: both facts come from the runner's own output, never from the command. One rule serves Claude Code
     and Pi, because both harnesses already hand the run's output to the shared recorder.
   - Cons: the console is less structured than XML, so its grammar is pinned to Bun's real output and fails
     closed on anything else.

## Decision

**Identity.** `ReportTestcase` gains `file`: the testcase's own `file` attribute when it writes a non-blank
one, else its `classname`. Per-file results group by it, and the Wave Gate (`observeTestcase`,
`classifyFailedTestcase`) and owner verification attribute by it. A testcase that names no file through
either attribute is refused, as before. Vitest and Surefire write no `file` attribute, so their identity is
unchanged.

**Collection errors** (`core/structured-test-report.ts`, pure):

- `parseBunConsoleCollectionErrors(output)` lists, once each and in order, the files whose console section
  contains `# Unhandled error between tests`. A header is a bare test-file path (Bun's `*.test|spec` and
  `*_test|spec` names) alone on its line ending in `:`. Code-frame lines and prose never match, ANSI colour
  and CRLF are tolerated, and an error before any header belongs to no file.
- `bunRunSummary(junit, collectionErrors)` joins them to the run's JUnit summary through
  `parseReportSummary`. Each collection error is one failing testcase, as Bun counts it: a file the report
  omitted is added as `{executed: 1, failed: 1, collectionError: true}`. A listed file did load, so it
  gains the failing testcase but keeps its own collection-error flag: an error printed between tests
  never hides a genuine assertion failure (which I6 counts as red) behind a collection error (which I6
  counts as red only for a Task that creates implementation files). With no JUnit report the summary's
  source is the new `bun-console`, whose entries the reconcile rule allows only as exactly that shape. A
  JUnit summary with unrecorded per-file results is returned unchanged, never half-merged, and capture
  says so on stderr.

**Capture** (`machine/report-discovery.ts`). `findReport` takes the finished run (`TestRunOutput`: its output
and the exit `attributeExit` gives the segment) in place of bare stdout, and `FindReportForSegment` carries
the same value. Console facts are read only:

- for an explicit `bun test --reporter=junit --reporter-outfile=…` segment (the one Bun shape Loom already
  trusts);
- when the run's non-zero exit is the segment's own, so `bun test …; false` cannot plant console text for it;
- beside the JUnit report they complete, or in place of one Bun did not write (ENOENT). A vetoed, stale,
  malformed, uninspectable or unstamped report leaves the run untrusted, console and all (INV-8: a run's
  reports vouch together or not at all).

The ledger read-back accepts `bun-console`.

## Consequences

**Positive:**
- A Bun Task that creates implementation files meets I6's red step exactly as a Vitest one does, and its green
  run is attributed to its test files.
- Bun acceptance contracts and owner verification attribute by file, as Vitest ones do.
- Verified against the failing production run: its red output yields exactly the Task's two test files as
  collection errors, and both attribute to the Task's declared files.

**Negative:**
- Console grammar is a weaker contract than XML. It is pinned by recorded Bun fixtures, each named for the release it was captured on; a format change
  makes Loom see fewer collection errors, which withholds a red rather than inventing one. The fixtures are recorded by
  `engine/scripts/bun-console-probe.ts`, and `engine/tests/machine/bun-console-pinned-release.test.ts` runs the same
  probe on every suite: the release in `.bun-version` must have a recording, the installed Bun's real output must
  yield the facts the fixtures encode, and on the pinned release it must match the recording byte for byte. A
  Bun upgrade that changes the grammar therefore fails verification instead of passing on stale fixtures.
- Bun prints two consoles: under an agent it omits passing tests, otherwise it prints a section for every file. The
  probe records both, the first with `CLAUDECODE` set as Claude Code sets it, and the grammar reads both the same way.
- Bun runs a run's files in directory-scan order, which is the file system's (ext4 hashes names), so two machines
  print one run's sections in different orders. The grammar reads sections in any order; the probe runs one shard of
  one (`--shard=1/1`, which sorts the files by path) and removes that mode's notice, so its recordings compare byte
  for byte on every machine.
- A test-file path containing whitespace is not recognized as a header (fail closed).
- Console text inside a recognized run is agent-influenced in the same way a JUnit file is. As with every I6
  fact, the proof is as strong as the ledger (`machines/README.md#known-residual-limits`), and a
  forged collection error can only claim a red, never a pass.
