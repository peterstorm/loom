# Lint Rules Reference

Loom's linter runs declarative JSON regex rules and programmatic TypeScript rules after every edit and at the Wave Gate. This file is the reference for the rule schema, the project configuration and every shipped rule.

- Setting up and running the linter in a project: the `lint-project` skill (`skills/lint-project/SKILL.md`).
- The runner's scope, options, exit codes and how the rules directory is found: [`runner.md`](../skills/lint-project/references/runner.md).
- Boundary templates per language: [`typescript.md`](../skills/lint-project/references/typescript.md), [`java.md`](../skills/lint-project/references/java.md).
- Where the linter sits in the engine: [`docs/architecture.md`](../docs/architecture.md).

## Scoping Model

**Everything is linted; exclusions are explicit and reasoned.** Nothing is in
scope by being listed, and nothing is out of scope by being forgotten.

| Question | Answer | Where it is declared |
|----------|--------|----------------------|
| Which files does `lint-project` read? | Every file with a lintable extension (`.ts .tsx .mts .cts .js .jsx .mjs .cjs .java .kt .scala`), tests and declaration files included | — |
| …except? | Never-source directories (`node_modules`, `.git`, `.claude`, `.pi`, build output, `vendor`, …) and the project's `exclude` list | `exclude: [{ path, reason }]` |
| Which rules skip tests? | Each rule that should, by itself | a regex rule's `excludePatterns`; `isTestFile` in a programmatic rule |
| Which files must be pure? | Every non-test file under a `pureModules` root | `pureModules` |
| …except? | The declared shells inside the roots, each with the I/O it does | `impureModules: [{ path, reason }]` |
| Which files must belong to a boundary? | Every file under a `requireGovernance` root — an ungoverned file is a violation, not an allow | `requireGovernance`, `boundaries` |

Every subtracting list is checked for decay on each full run: an exclusion, root, shell, boundary, capability grant or baseline entry that names nothing fails the run.

With no project configuration the boundary rule governs nothing and the purity rule holds nothing pure; the other rules apply as shipped. Nothing Loom-specific is hard-coded: Loom's own roots, shells, boundaries and exclusions are in its `.claude/linter/rules/config.json`.

## Where Rules Live

| Source | Directory | Tagged |
|---|---|---|
| Default rules, shipped with Loom | `lint-rules/*.json` | `source: "default"` |
| Project rules | the project's one rules directory, `.claude/linter/rules/*.json` | `source: "project"` |

The loader sets `source`; do not write it in a rule file. `config.json` in the rules directory is the project configuration, not a rule. `runner.md` states how the rules directory and project root are found and what happens in a Pi-only project.

The linter is on for every project that uses Loom; a project opts out rule by rule:

| Project rule file | Effect |
|---|---|
| Same `name` as a default rule | Replaces the default entirely |
| Same `name` as any rule, regex or programmatic, with `"enabled": false` | Disables that rule |
| A new `name` | Adds a rule beside the defaults |

## Rule File Schema

One regex rule per `.json` file:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `kind` | `"regex"` | yes | The only kind a JSON file can declare |
| `name` | `string` | yes | Unique kebab-case identifier; overrides match on it |
| `description` | `string` | yes | What the rule catches |
| `extensions` | `string[]` | yes | File extensions the rule reads, with the leading dot |
| `pattern` | `string` | yes | Regex source without delimiters, tested against each line |
| `flags` | `string` | no | Regex flags; defaults to `""` |
| `excludePatterns` | `string[]` | no | Files the rule skips. An entry ending in `/` is a **directory**: `src/infra/` (or `/src/infra/`) skips every file beneath it, matched at a segment boundary, so never `src/infrastructure/`. Any other entry is a file **suffix**: `.test.ts`. A directory is matched against the file's path inside the project (the directory holding `.claude/` or `.pi/`), so a directory of the same name above the checkout excludes nothing, and neither does a directory entry for a file outside the project or in a run with no project rules directory: the rule reads that file. A checkout reached through a symlink is the same project. A suffix matches wherever the file is. Entries are parsed when the rule loads, and an entry that would not mean what its author wrote is refused by name: an empty entry and a bare `/` name nothing (as a suffix, the empty entry would match every file); a glob (`*`) is compared byte for byte, since no glob support exists; and an empty, `.` or `..` segment (`./src/`, `src//infra/`) is one no linted path holds |
| `fixHint` | `string` | yes | The instruction shown with the violation. Must be non-empty, also on a disabled rule |
| `enabled` | `boolean` | yes | `false` disables the rule |

<!-- wire-example: linter-regex-rule -->
```json
{
  "kind": "regex",
  "name": "no-ts-ignore",
  "description": "Disallow @ts-ignore — use @ts-expect-error with an explanation",
  "extensions": [".ts", ".tsx"],
  "pattern": "@ts-ignore",
  "flags": "",
  "fixHint": "Replace @ts-ignore with @ts-expect-error and a comment explaining why",
  "enabled": true
}
```

### Disabling a rule

A file in the project rules directory with the rule's `name` and `"enabled": false`. The loader still validates every required field, so the file needs a non-empty `fixHint` and a `pattern`; the same file shape disables a programmatic rule such as `no-cross-boundary-imports`.

<!-- wire-example: linter-regex-rule -->
```json
{
  "kind": "regex",
  "name": "no-console-log",
  "description": "Disabled: this project logs through console",
  "extensions": [".ts"],
  "pattern": "x^",
  "flags": "",
  "fixHint": "disabled",
  "enabled": false
}
```

### Writing a rule

- Express the defect as a regex that matches one line, and scope it with `extensions`.
- Write a `fixHint` that says what to do: "Replace `var` with `const`, or `let` if it is reassigned", not "Don't do this".
- A rule that should ship with Loom goes in `lint-rules/`; a project's own rule goes in its rules directory.
- Prove the file loads: `bun <loom-plugin-dir>/engine/src/cli.ts helper validate-lint-rules <project-rules-dir>`. A directory that does not exist is an error, never "no rules".

Plan invariants marked checkable (`INV-N`) are written as project rules by the Loom architecture phase, with the same `inv-<n>-<slug>` as filename and `name`; see [`references/executable-models.md`](../references/executable-models.md).

### Regex safety

Every pattern is statically analysed for catastrophic backtracking when it loads, and an unsafe pattern is rejected with its rule.

| Dangerous | Why | Use instead |
|-----------|-----|-------------|
| `(a+)+`, `(x*)*` | Nested quantifiers | `a+` |
| `(a\|a)+` | Overlapping alternation | `a+` |
| `(\w+\s*)+` | Nested quantifiers over overlapping sets | `[\w\s]+` |
| `(.*a){10}` | Quantified greedy match | `(?:.*?a){10}`, or restructure |

Matching is line by line, so a pattern rarely needs `.*`; prefer `\b` and character classes.

Static rejection is the primary defence. At run time the executor checks a 50ms per-file deadline every 100 lines and after each regex rule, and fails closed when it is exceeded. The deadline is cooperative: JavaScript cannot interrupt one `RegExp.test()` that is already backtracking, and a programmatic handler is checked before it is called, not while it runs. A programmatic rule whose first call does project-wide work declares it (`firstCallSetup`; `no-duplicate-block` builds its clone corpus) and runs after every other rule, so no rule is refused for time a setup spent.

## Project Configuration

`config.json` lives inside the project rules directory, beside the rule files (`.claude/linter/rules/config.json`). A file one level up, at `.claude/linter/config.json`, is never read. Every path in it is relative to the project root.

The parse is strict: an unknown key (at the top level, in a boundary, an exemption or a grant) is refused by name, as are globs, absolute or `./` paths, empty scopes, and exemptions or grants without a reason. A typo fails the run; it never falls back to a default that checks nothing.

<!-- wire-example: linter-project-config -->
```json
{
  "exclude": [
    { "path": "third_party/", "reason": "vendored upstream, byte-pinned by its manifest" }
  ],
  "requireGovernance": ["src/"],
  "boundaries": [
    {
      "module": "src/domain/",
      "description": "The functional core: imports itself only",
      "allow": ["./", "src/domain/", "zod"],
      "deny": ["src/infra/", "src/api/"]
    },
    {
      "module": "src/infra/",
      "description": "Adapters: implement the domain's ports",
      "allow": ["./", "src/infra/", "src/domain/", "node:", "pg"],
      "deny": ["src/api/"]
    }
  ],
  "pureModules": ["src/domain/"],
  "impureModules": [
    { "path": "src/domain/order-repository.ts", "reason": "reads and writes orders through the database pool" }
  ],
  "maxFunctionLines": 40,
  "excludeFromMaxLines": [".test.ts", ".spec.ts", "Test.java"]
}
```

### Config Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `exclude` | `{ path, reason }[]` | `[]` | Paths `lint-project` never reads (vendored, generated). `dir/` or one file; every entry states why |
| `boundaries` | `BoundaryRule[]` | `[]` (governs nothing) | Import boundary rules for `no-cross-boundary-imports` |
| `requireGovernance` | non-empty `string[]` | absent | Roots inside which a file no boundary names is a violation ("ungoverned module") |
| `pureModules` | `string[]` | `[]` (nothing pure) | The functional core: `dir/` roots and single files. Every non-test file beneath a root is pure |
| `impureModules` | `{ path, reason }[]` | `[]` | The shells inside the pure roots, each with the I/O it does |
| `maxFunctionLines` | `number` | `50` | Max lines per function body for `max-function-lines` |
| `excludeFromMaxLines` | `string[]` | Test file patterns | Files to exclude from line-length checking, in the same two forms as a regex rule's `excludePatterns`, parsed and matched the same way: a file suffix, or a directory ending in `/` matched against the path inside the project |
| `switchTotalityModules` | non-empty `string[]` | every non-test TS file | Narrows `switch-totality` to these path prefixes. An empty list is refused — disable the rule by name instead |
| `switchTotalityBaseline` | `string[]` | `[]` | Grandfathered `path::scrutinee` sites `switch-totality` excuses, one entry per site |
| `maxDiscriminantBranches` | `number` | `3` | Branches on one tag at which `exhaustive-discriminant-branching` reads an if-chain as a switch |
| `discriminantTags` | `string[]` | `kind`, `status`, `verdict`, `stage`, `severity`, `type` | Field names that tag a discriminated union |
| `discriminantBranchingBaseline` | `string[]` | `[]` | Grandfathered `path::discriminant` chains `exhaustive-discriminant-branching` excuses |
| `duplicateBlockMinTokens` | `number` | `100` | Identical tokens in a row that make a copy for `no-duplicate-block` |
| `duplicateBlockMinLines` | `number` | `8` | Lines a copy must span on both sides |
| `duplicateBlockBaseline` | `string[]` | `[]` | Grandfathered `path::otherPath@digest` copies `no-duplicate-block` excuses, one entry per copy |
| `wireCastBaseline` | `string[]` | `[]` | Grandfathered `path::as T` / `path::name: T` sites `no-wire-cast` excuses, one entry per site |

### BoundaryRule

```typescript
{
  module: string;        // Path prefix that identifies the module (with trailing /), or one file
  description?: string;  // What the module is and which way its imports point
  allow: string[];       // The closed list of import prefixes the module may use
  deny: string[];        // Denied import prefixes, checked first; a deny beats an allow
  // Per-file capability beyond `allow`, each with the reason it was granted.
  // A boundary with no blanket "node:" allow refuses every node builtin in a
  // file it does not grant here.
  perFileAllow?: { [file: string]: { allow: string[]; reason: string } };      // prefix grants
  perFileExactAllow?: { [file: string]: { allow: string[]; reason: string } }; // exact specifiers
}
```

`allow` is an allowlist: inside a governed module, an import that matches no `allow` entry is a violation even when no `deny` names it. `deny` exists to refuse part of what an `allow` prefix admits and to give the violation a precise message. A relative import is resolved against the importing file and matched as a project-relative path; a Java import is matched as its package name. A grant must name one file under the boundary's `module`.

### Baselines

`switch-totality`, `exhaustive-discriminant-branching`, `no-duplicate-block` and `no-wire-cast` apply without configuration, so the sites that predate them in an existing codebase would block the next edit to each file. Record them once:

```bash
bun <loom-plugin-dir>/scripts/lint-project.ts --write-baseline
```

This writes the four `…Baseline` lists, keyed relative to the project root. A baselined site costs nothing until it is converted; a new site is held to the rule. A copy across two files has two entries, one per file, and an entry names the copied tokens, so editing one side of a baselined copy makes it a new copy that is reported again.

The lists are debt and only shrink: the full tier fails on an entry no live site consumes. Re-running `--write-baseline` removes the entries of converted sites.

## Shipped Rules

### TypeScript regex rules (immediate tier)

All read `.ts .tsx .mts .cts`; `no-catch-ignore` and `no-todo-fixme` also read `.js .jsx .mjs .cjs`.

| Rule | Pattern | What it catches |
|------|---------|-----------------|
| `no-any-type` | `[\w)>]\s*:\s*any\b(?!\s*\w)` | An explicit `: any` annotation on a binding, parameter or return |
| `no-unsafe-as-any` | `\bas\s+any\b` | `as any` casts, tests included |
| `no-non-null-assertion` | `[\w$)\]]!(?=[.\[),;:\]}])` | Non-null and definite-assignment assertions: `x!.`, `x![`, `f()!.`, `a[0]!`, `let x!:` |
| `no-catch-ignore` | `catch\s*(?:\([^)]*\))?\s*\{\s*\}` | Empty catch blocks, with or without a binding |
| `no-console-log` | `console\.log\(` not preceded by a quote or backtick | `console.log()` calls |
| `no-todo-fixme` | `//\s*(TODO\|FIXME)` | `// TODO` and `// FIXME` comments |
| `no-alias-export` | `^export (?:const\|let) X = Y;\s*$` with bare identifiers | An export that only renames another symbol. `tsc` cannot see a dead export, so such an alias outlives its callers |

`no-non-null-assertion`, `no-console-log` and `no-todo-fixme` exempt test files: `.test.` and `.spec.` before every extension the rule reads, so a test file is never exempt from one rule's spelling and held to another's. In a test a failed assumption throws and fails the test, which is the assertion's purpose. `engine/tests/linter/regex-rules.test.ts` pins each rule's matching and non-matching lines and that exemption list.

### Java regex rules (immediate tier)

| Rule | Pattern | Enabled | What it catches |
|------|---------|---------|-----------------|
| `no-system-out` | `System\.(out\|err)\.(print\|println\|printf)\(` | yes | `System.out` / `System.err` printing |
| `no-raw-exception-catch` | `catch\s*\(\s*(Exception\|Throwable)\s+` | yes | Catching raw `Exception` or `Throwable` |
| `no-null-return` | `return\s+null\s*;` | yes | Returning `null` |
| `no-field-injection` | `^\s*@(Autowired\|Inject)\s*$` | yes | `@Autowired` or `@Inject` alone on a line, whatever it annotates. An annotation written on the same line as its field is not matched |
| `no-star-import` | `^import\s+[\w.]+\.\*\s*;` | yes | Wildcard imports |
| `no-mutable-entity-fields` | `^\s+(private\|protected)\s+(?!static\|final\|transient)[A-Z][\w]*\s+\w+\s*[;=]` | no | Non-final instance fields. Enable it with a project file of the same `name`, the shipped pattern and `"enabled": true` |

### Programmatic rules

Each is a TypeScript handler, `(content, filePath) => Violation[]`, registered in `engine/src/linter/programmatic/index.ts`. JSON cannot declare one.

| Rule | Tier | Languages | What it enforces |
|------|------|-----------|-----------------|
| `no-cross-boundary-imports` | immediate + full | TS, JS, Java | Import direction between modules; under `requireGovernance`, every file belongs to one |
| `no-io-in-pure-modules` | immediate + full | TS, JS (Java: globals only) | No filesystem, network, console or non-determinism in the functional core |
| `switch-totality` | immediate + full | TS | A switch with 2+ arms proves totality in its `default` arm |
| `no-duplicate-block` | immediate + full | TS, JS | No block of 100+ identical tokens over 8+ lines that another project file, or the same file, already holds |
| `no-wire-cast` | immediate + full | TS | `JSON.parse` / `.json()` output is bound as `unknown` and parsed — never typed by `as T` or a `: T` annotation |
| `max-function-lines` | full | TS, JS, Java | Function bodies ≤ `maxFunctionLines` (default 50); test files excluded by default |
| `fugue-generated-integrity` | full | TS | Structural projection of Fugue-generated files matches the stamped SHA-256 |
| `exhaustive-discriminant-branching` | full | TS | 3+ branches on one discriminant without a totality proof |
| `no-nested-ternary` | full | TS | A ternary whose else-branch opens another ternary |
| `prefer-array-methods` | full | TS | A mutable accumulator whose loop only pushes into it |

**These encode judgement, so read what they deliberately do NOT flag.**
A rule that fires on correct code teaches people the rule is wrong, and then it
gets disabled — which is worse than not having it.

- `no-cross-boundary-imports` checks nothing in a file no boundary's `module`
  names, unless the file is under a `requireGovernance` root; there it is
  reported as an **ungoverned module**, so a new directory states its dependency
  direction before it holds code.
- `no-io-in-pure-modules` holds a file to purity when it is under a
  `pureModules` root (or named there), is not a test file, and is not declared
  in `impureModules`. A banned global named inside a quoted string or a comment
  is not flagged; code inside a template literal still is. `new Date(value)` is
  deterministic and allowed. The full list is under
  [`no-io-in-pure-modules`](#no-io-in-pure-modules) below.
- `no-duplicate-block` applies to **every TypeScript and JavaScript file, tests
  included** — a fixture builder pasted into a second test file is the copy it
  exists for. It compares tokens, so reformatting or re-commenting a copy does
  not hide it, and renaming one identifier inside it does: it finds pasted
  code, not similar code. Import statements never count, and a file under
  `exclude` is never the other side of a copy. It needs the project to have a
  rules directory (`lint-project --init`): the directory is how the linter
  knows the project root, and without one only repeats inside the edited file
  are found. On an edit the other files are found through a fingerprint cache
  under the temp directory, keyed by each file's size and modification time.
  The cache can hide a copy only in a file whose content changed while its
  size and modification time both stayed identical; it can never invent one,
  because a nominated file is compared by its current bytes. The Wave Gate and
  `lint-project` read every file, never the cache, and are the authority. A
  cache written under another fingerprint scheme (another lexer, hash or
  `duplicateBlockMinTokens`) is discarded and rebuilt.
  One line repeated dozens of times (a generated table) is reported for its
  first 32 repetitions of any one fingerprint, not for every pairing of every
  repetition: a copy goes unreported only when everything in it has already
  been repeated 32 times earlier in one of the two files.
- `switch-totality` applies to **every non-test TypeScript file** by default.
  Only the `default` arm can prove a switch: `default: return assertNever(x)`,
  a binding typed `never`, or `default: return match(x)…exhaustive()`. Prefer
  `assertNever(x)`: an unused `const _: never = x` fails `noUnusedLocals`, and
  `x satisfies never` is not accepted as a proof. An `.exhaustive()` inside a
  `case` arm proves that nested match, not the switch.
  `default: throw new Error("unreachable")` is **not** a proof: it compiles
  after a variant is added. Quoted literals (`case "a":`) and qualified members
  (`case Kind.Draft:`) are arms; one-arm switches are guards and exempt, as is
  `switch (typeof raw)`. An open domain (a plain `string`) has no `never` to
  bind — write `match(raw).with("a", …).otherwise(…)`, which makes the fallback
  a visible decision.
- `no-wire-cast` applies to **every non-test TypeScript file**. It reads text,
  not types, so it flags exactly three shapes — an assertion on the call, an
  annotated `const`/`let`/`var` initialised by it, and an assignment to a name
  whose nearest visible declaration is annotated — and only when the type is
  not `unknown` (`Promise<unknown>` counts as `unknown` for an un-awaited
  `.json()`). The call in argument position (`parseOrder(JSON.parse(text))`)
  is the intended shape and never fires, and neither does the text of a refused
  shape inside a string, a comment, template text or a regex literal. It does
  **not** see an unannotated `const value = JSON.parse(text)`, a `return` under
  a declared return type, a property read (`JSON.parse(text).id`), a class
  field or a parameter default: there the `any` travels through a position
  only the type checker can judge. A `.json()` call that takes arguments
  (`Response.json(body)`, Express `res.json(body)`) writes a body and is not a
  wire read. See [`no-wire-cast`](#no-wire-cast) below and ADR-0072.
- `exhaustive-discriminant-branching` ignores one- and two-branch guard clauses.
  Guards are the *preferred* shape; only at three does an if-chain stop reading
  as a guard and start reading as a switch. It accepts either
  `match(…).exhaustive()` or a `never` proof — it is about totality,
  not about which library you reach for. Chains must be contiguous
  (10-line max gap), so two unrelated guards on the same tag at opposite ends of
  a file are not merged into a phantom chain.
- `no-nested-ternary` exempts **type-level** conditionals. `S extends X ? A : …`
  is the only way to express a mapped relation in the type system — there is no
  `if` and no `match` there, so the chain is essential, not incidental.
- `prefer-array-methods` fires only on the narrow accumulator shape: an array
  declared immediately before a loop whose single statement pushes into it. Loops
  with `break`, `continue`, `return`, or `await` are exempt, as are
  multi-statement bodies — those are folds, and spelling a fold `reduce` is
  frequently *harder* to read. The bar is that a mechanical rewrite exists AND it
  deletes a mutable binding.
- `max-function-lines` counts by bracket depth over `function` declarations,
  block-bodied arrow functions and class methods.

#### `no-io-in-pure-modules`

What a pure TypeScript or JavaScript module may not use (`IO_IMPORTS` and `BANNED_GLOBALS` in `engine/src/linter/programmatic/no-io-in-pure-modules.ts` are the source):

| Banned | Entries |
|---|---|
| Imports, with or without `node:`, and their subpaths | `fs`, `net`, `http`, `https`, `child_process`, `crypto`, `process`, `util`; `node:` only: `dgram`, `dns`, `tls`, `os`, `worker_threads`, `readline` |
| Process and environment | `process.env`, `process.exit`, `process.stdout.write`, `process.stderr.write`, `process.cwd`, `chdir`, `hrtime`, `uptime`, `platform`, `arch`, `argv`, `pid`, `kill`, `nextTick` |
| Output and network | `console.log/error/warn/info/debug`, `fetch()` |
| Time and scheduling | `new Date()` with no argument, `Date.now()`, `performance.now()`, `setTimeout()`, `setInterval()` |
| Randomness | `Math.random()`, `crypto.randomUUID`, `randomBytes`, `randomFill`, `randomFillSync`, `getRandomValues` |

Allowed in a pure module: `path`, `url` (with or without `node:`), `ts-pattern`, `zod/v4`, and two named capability imports, `import { createHash } from "node:crypto"` and `import { isDeepStrictEqual } from "node:util"`. A namespace, default or dynamic import of those two modules is refused.

Java: the import scan reads quoted specifiers only, so a Java `import java.io.File;` is not reported by this rule; only the globals above that also exist in Java (`Math.random()`, `new Date()`) are. Keep I/O packages out of a Java core with `deny` entries on its boundary (`java.md` has the list).

#### `no-wire-cast`

`JSON.parse(text)` and `response.json()` return `any`. Naming a type for that
value by assertion or annotation checks nothing: the compiler takes the name on
trust, and every read written afterwards is believed. The rule refuses the
naming and asks for a parse.

**Refuses** (`T` is any type but `unknown`):

```typescript
const order = JSON.parse(text) as Order;
const order = (await response.json()) as Order;
const order = JSON.parse(text) as unknown as Order;
const order: Order = JSON.parse(text);
let order: Order;
order = await response.json();
```

**Accepts:**

```typescript
const raw: unknown = JSON.parse(text);
const order = parseOrder(raw);                 // Either<ParseError, Order>
const order = parseOrder(JSON.parse(text));    // the call in argument position
let raw: unknown;
try { raw = JSON.parse(text); } catch { return left(invalidJson()); }
```

Multi-line forms are read whole (the type, the argument or the `as` may sit on
later lines). The scan is a balanced-bracket walk over the file's code — no
compiler API — and a file whose text holds neither `JSON` nor `json` is
answered without being lexed. That exit is a substring test, not a test for the
call: a file that holds `json` anywhere (`./package.json`, a `toJSON` method, a
comment) is lexed even when it names no wire call. An assignment is judged by the nearest `const`/`let`/`var` declaration of
that name whose block still encloses it; parameters are not declarations.

`wireCastBaseline` grandfathers pre-existing sites, keyed `path::as T` (an
assertion) or `path::name: T` (a binding), one entry per site.

#### `fugue-generated-integrity`

Recognizes TypeScript generated by `fugue new --from` through its strict `@fugue-integrity sha256:<hex>` banner. It recomputes the hash over the generated structural projection while collapsing sanctioned `@fugue-body-start` / `@fugue-body-end` regions. Implementing a body is allowed; changing imports, schemas, node ids, wiring, or other generated structure blocks at the full tier.

A file with no marker is not Fugue-generated and is ignored. A malformed marker prefix, executable content above the banner, or a digest mismatch is a violation. See [Executable models: enforcement](../docs/executable-models-enforcement.md#known-residuals-honest-limits).

## Execution Model

| Tier | When | Rules |
|------|------|-------|
| `immediate` | After every edit (Claude Code PostToolUse, Pi tool result) | Regex rules, plus the programmatic rules marked immediate above |
| `full` | At the Wave Gate and in `lint-project` | Every rule |

- Regex rules are tested line by line: `^` and `$` anchor to the line, and the matched line is reported.
- Both hook tiers are touch-scoped: the edit hook lints the file that was edited and the Wave Gate lints the Wave's `files_modified`, so enabling a rule with a backlog does not block unrelated edits. `lint-project` is not touch-scoped: it lints the whole project, and a backlog fails it until it is fixed or baselined.
- The linter fails closed: a malformed rule, a refused config, an exceeded deadline or a crash blocks the edit and shows the error.
- Type errors are not a lint tier. A separate advisory check runs the project's incremental `tsc` after an edit and never blocks; see [Advisory type diagnostics](../docs/operations.md#advisory-type-diagnostics).

## Editing the Linter Itself

For Loom maintainers changing a rule or the engine under `engine/src/linter/`.

- **The edit-time hook reads the installed plugin, not your checkout.** `lintFile` resolves `lint-rules/` and `engine/src/linter/` from the Loom installation the hook was loaded from, so a rule or a `perFileExactAllow` grant written in a worktree is invisible to the hook until it loads your build. Prove a new rule with `bun scripts/lint-project.ts`, which lints the checkout it lives in, and with the rule's own test; a quiet hook proves nothing.
- **A newer `config.json` can outrun the installed engine.** The strict parser refuses unknown keys only from the version that knows them: an older installed plugin may misread a config that uses a newer key. Prove config changes from the checkout the same way.
- **A baseline-backed rule registers in `baselineOwners`** (`engine/src/linter/programmatic/index.ts`). That joins it to the stale-entry report and to `--write-baseline`. A baseline's failure mode is silence: a renamed scrutinee or a deleted switch leaves an entry protecting nothing, which is why stale entries fail the full tier. Loom asserts its own lists against its live tree in `tests/linter/programmatic/totality-baseline.test.ts`.
- **A new JSON example in this file or under `skills/` carries a `wire-example` marker**, and the docs suite parses it with the production loader (`engine/tests/docs/doc-wire-examples.test.ts`).
