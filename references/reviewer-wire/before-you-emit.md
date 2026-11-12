## Before you emit

A payload that fails the issued schema is refused and costs your one retry. Check it first:

- It is one JSON object. A final message that carries it holds no other `{...}`, in prose or in an example.
- It parses. A long payload most often loses its last closing brace.
- `execution-trace` evidence has `kind`, `preconditions`, `steps`, `observed`, `expected` and `reference`. `reproduction` evidence has `kind`, `execution` (`"not-executed"` or `"reviewer-reported"`), `setup`, `input`, `observed`, `expected` and `reference`. Only `reproduction` takes an `execution` key, and no object takes a key the schema does not list.
- A critical carries the whole `basis`: `evidence`, `violatedContract`, `consequence`, `truthConfidence` (0–100) and `severityRationale`. An advisory carries `reason`; its `basis` is complete or absent, never null or partial.
- Each finding makes one assertion and names its file and line. `file: null` requires `line: null`; use it only when the assertion has no single location in the frozen scope.
- No findings is `"findings": []`. Everything you have to say goes in the payload's fields: no summary, score or report beside it.
