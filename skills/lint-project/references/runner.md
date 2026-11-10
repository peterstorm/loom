# Lint Runner

Run the linter with the one shipped runner, `scripts/lint-project.ts`, from
any directory inside the project:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/lint-project.ts
```

There is no inline copy to paste: an earlier version of this reference carried
a second walker that skipped test files and `.mts`/`.cts`/`.mjs`/`.cjs`
modules, so it and the shipped runner linted different trees. One runner, one
scope.

## The scope: everything, minus explicit exclusions

The runner lints **every file with a lintable extension** — `.ts .tsx .mts .cts
.js .jsx .mjs .cjs .java .kt .scala`, test files and declaration files included
— except:

- directories that never hold a project's own source, in any project
  (`node_modules`, `.git`, `.claude`, `.pi`, `dist`, `build`, `out`, `.next`,
  `target`, `.gradle`, `coverage`, `vendor`, `.cache`, …); and
- the project's `exclude` list in `config.json`, where every entry names a path
  and the reason it must not be checked (vendored upstream code, generated
  files):

```json
{
  "exclude": [
    { "path": "third_party/", "reason": "vendored upstream, byte-pinned by its manifest" }
  ]
}
```

A trailing `/` names a directory (every file beneath it); otherwise the entry
names one file. Globs are refused.

Rules that do not apply to tests say so themselves (`excludePatterns` on a
regex rule, `isTestFile` in a programmatic one) — the walk never drops tests
for every rule at once.

## Options

| Option | Effect |
|--------|--------|
| *(paths…)* | Lint these files or directories. An explicit file is linted exactly — unless the exclusion list names it, which prints `excluded: <file> (<reason>)` |
| `--tier=full` | All rules (default) |
| `--tier=immediate` | The edit-time tier only: regex rules, the import-boundary pair, `switch-totality` |
| `--summary` | Counts by rule |
| `--json` | `{ violations, errorCount, staleEntries, excluded }` |
| `--no-fix-hints` | Hide fix hints |
| `--no-baseline-check` | Skip the staleness pass |
| `--write-baseline` | Record pre-existing totality sites in `config.json`, then exit |
| `--init` | Scaffold `.claude/linter/rules/config.json` (`.pi/linter/rules/` in a project with `.pi` and no `.claude`) |

## What fails the run

Exit 1 on any violation, any file the linter could not lint, and — in the full
tier — any **stale entry**: a baseline key no live site consumes, an exclusion
that matches no file, a pure root, governance root or boundary module that
matches no file, a declared shell (`impureModules`) that names no file under a
pure root, or a per-file capability grant for a file that no longer exists.
Every list that subtracts from the linter's reach is checked for decay.

Exit 2 when the run cannot be trusted at all: a `config.json` the strict parser
refuses (an unknown key is refused by name), or a project that carries both
`.claude/linter/rules` and `.pi/linter/rules` ("keep one rules directory").

## Project root and rules directory

The project root is the nearest ancestor holding `.claude/linter/rules` or
`.pi/linter/rules`, else the nearest holding `.git` — so running from a
subdirectory with its own `package.json` (such as `engine/`) still lints the
whole repository under its rules. A project has ONE rules directory, and the
lookup does not depend on the harness: `.claude/linter/rules` when present,
else `.pi/linter/rules` (a Pi-only project). Claude Code's edit hook, Pi's
post-edit lint, the Wave Gate lint, `helper validate-lint-rules` with no
argument and this runner all read that same directory, so there is no second
copy to keep in step. A project carrying both layouts is refused (exit 2): the
hooks read only `.claude/linter/rules`, so the `.pi` twin would look enforced
while nothing reads it. `--write-baseline` writes only the one directory;
`--init` creates `.claude/linter/rules` unless the project has a `.pi`
directory and no `.claude` one.

## Important Notes

- `${CLAUDE_PLUGIN_ROOT}` means the owning Loom package root. Claude Code expands it directly; Loom's Pi resource adapter renders it from the extension module's `import.meta.url`.
- If no rules directory exists, only loom's default rules fire — the boundary and purity rules are then inert (their defaults govern nothing).
