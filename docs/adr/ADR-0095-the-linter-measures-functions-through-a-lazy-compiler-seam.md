# ADR-0095: The linter measures functions through a lazy compiler seam

## Status
Accepted (2026-11-18). Amends ADR-0042: a fourth parse-only TypeScript compiler API seam, the first outside
`engine/src/core/`.

## Context
`max-function-lines` found functions with three line regexes and brace counting. A function was seen only
when one regex matched the line holding its opening brace, and once a function was being tracked every
line inside it was skipped. It missed signatures spanning several lines, functions nested in another
function, object-literal methods and arrow properties, callbacks passed as arguments, `export default
function`, accessors, class property arrows and multi-line arrow consts. Measured against one target
project, the rule reported clean while 32 functions ran past 50 body lines, the largest 286.

The forms it missed are the ones a parse sees and a line scan cannot. ADR-0042 already rules out a second
copy of TypeScript lexing, and `typescript` is a declared runtime dependency. Two forces constrain where
the parse may run:

- The linter is a pure bounded context (`pureModules` lists `engine/src/linter/`). The compiler enters
  engine code only through a file granted the exact `typescript` specifier (ADR-0042, amended).
- Every Edit and Write spawns the lint hook, which loads the whole rule registry. `max-function-lines` is a
  full-tier rule and never runs there, yet a static `import ts from "typescript"` in anything the registry
  reaches would make each edit load the compiler: about 150 ms, against a registry that loads in about
  20 ms and a 50 ms per-file budget.

## Options Considered

1. **Keep the regexes and add more of them.**
   - Pros: No compiler grant.
   - Cons: Each new pattern is another partial lexer. Nesting, multi-line signatures and callbacks need
     the tree, not the line.

2. **Widen an existing core seam (`ts-surface.ts` or `import-graph.ts`) and import it from the linter.**
   - Pros: No new grant.
   - Cons: Mixes an unrelated concern into a seam, which ADR-0042 option 2 and ADR-0053 option 1 rejected.
     The linter would depend on skeleton or owner-verification code. The core seams import the compiler
     statically, so every edit would still pay the load.

3. **A new seam in the linter that imports the compiler statically.**
   - Pros: The same shape as the three core seams.
   - Cons: Every edit pays the compiler's load for a rule that runs only at the Wave Gate.

4. **A new linter seam that requires the compiler on first use (chosen).**
   - Pros: Real parsing; the grant names one file; an edit never loads the compiler.
   - Cons: A second granted specifier (`node:module`) and a seam that differs from the core three in how
     it loads.

## Decision
**`engine/src/linter/programmatic/script-function-spans.ts` is the linter's compiler-API seam. It is
parse-only, and it requires `typescript` through `createRequire` on first use.**

- **Interface.** `scriptFunctionSpans(path, text): readonly FunctionSpan[]`: every function with a block
  body (declarations, expressions, block-bodied arrows, methods, constructors, accessors), in source
  order. A span carries a `FunctionName` (`named` or `anonymous`), the 1-based line the function starts on
  past its decorators, and its body lines: the lines strictly between the opening and closing brace lines,
  the count the regex rule used. A nested function is a span of its own and also counts in its parent.
  The script kind follows the path's extension. A file with syntax errors yields what the parser
  recovered; the seam never throws on its input.
- **Parse-only contract (unchanged from ADR-0042).** `ts.createSourceFile`, node visitors and a scanner
  over the given text. Never `ts.sys`, a Program, module resolution or a type checker.
- **Lazy load.** The module binds `require = createRequire(import.meta.url)` and calls
  `require("typescript")` when it first measures a file. The module cache makes later calls a lookup.
  The type comes from `import type ts from "typescript"`. Both spellings name the exact specifier, so the
  boundary rule and the closure audit see the edge.
- **Grant.** `.claude/linter/rules/config.json` grants the seam `["typescript", "node:module"]` in the
  linter boundary's `perFileExactAllow`. The derived seam list and the machine-purity closure audit read
  that grant; the audit admits `node:module` only where it is granted.
- **Deadline.** The rule declares `firstCallSetup`, so the executor runs it after every other rule and
  never charges the compiler's load to a per-file deadline.
- **Java** keeps the bracket-depth line scan; the compiler cannot read it.
- **Baseline.** Measuring every function surfaces debt the regexes hid, so the rule joins the baselined
  rules: `maxFunctionLinesBaseline`, keyed `path::name` with multiplicity (`path::<anonymous>` for an
  unnamed function). A function keeps its key when it moves or grows.

## Consequences

**Positive:**
- Every function form is measured, and a function the regexes did find keeps its line, its text and its
  message, so existing reports do not move.
- The per-edit hook loads nothing new; the Wave Gate and `lint-project` load the compiler once per process.
- Projects can grandfather the newly visible debt with `lint-project --write-baseline` and fail only on new
  long functions.

**Negative:**
- Four files now hold the compiler grant, one of them outside the core, and it is the only one that
  requires the compiler instead of importing it.
- `node:module` is a capability in a pure module. It is granted to this one file and used for the one
  `require`.
- A rule declared `firstCallSetup` is never checked against the per-file deadline. A parse is linear in
  the file, so the five-second hook timeout and the Wave Gate's own budget remain the bound.
- A baseline keyed by name lets a grandfathered function grow, and two unnamed functions in one file share
  a key, as the other baselines' multiplicity already allows.
