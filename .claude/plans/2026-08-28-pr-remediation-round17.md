# PR Remediation — Deterministic Task Completion Oracle Round 17

Authority: `review-20260828T154746Z-deterministic-task-completion-oracle-post-remediation-21`, digest `f61098374d68a13e7c8de33b8c36741dad421d211ecc2eeafd3d95e91454c9b9`, branch `fix/deterministic-task-completion-post-merge`.

Mandatory fix: after any real `diff --git` file boundary, suppress all evidence until an unambiguous `+++ b/<path>` binds the file. Quoted or malformed Git paths therefore fail closed instead of inheriting headerless synthetic compatibility. Add quoted non-test path regressions.

Accept the top-level TypeScript matcher correction and focused non-test-source regression. Defer multiline JSX lexical-state support and broad ADT/module deepenings to dedicated changes; same-line JSX laundering is already closed.

Validation: focused Git tests, typecheck/unused, full bounded Vitest, smoke, lint, diff check, exact remediation index, commit/push, canonical review/refutation.
