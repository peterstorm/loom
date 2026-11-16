# PR #186 remediation: shipped machines are pinned by digest

- **Branch:** `fix/183-machine-integrity`
- **Review run:** `.claude/reviews/review-and-fix-runs/run.pr186-review`
  (result digest `d4fb96f98a4b70a1c22dfb86d29542f0d44a79386adeff158be3aaee4c9c6063`)
- **Policy run:** `.claude/reviews/review-and-fix-runs/run.pr186-policy`
  (disposition digest `9b466f18432a7e48c560f681abe7f0d1381451abc55da1ca8d050c11a7884a43`)
- **Frozen scope (18 files):**
  - Docs: `docs/adr/ADR-0076-shipped-machines-are-pinned-by-digest.md`, `docs/adr/README.md`,
    `docs/architecture.md`, `docs/development.md`, `docs/operations.md`, `machines/README.md`.
  - Engine: `engine/package.json`, `engine/scripts/pin-machines.ts`, `engine/src/config.ts`,
    `engine/src/core/machine-integrity.ts`, `engine/src/core/machine-pins.ts`, `engine/src/machine/ledger.ts`.
  - Handlers: `engine/src/handlers/pre-tool-use/enforce-phase-tools.ts`,
    `engine/src/handlers/subagent-start/mark-subagent-active.ts`,
    `engine/src/handlers/subagent-stop/update-task-status.ts`.
  - Tests: `engine/tests/core/machine-integrity.test.ts`, `engine/tests/machine/ledger.test.ts`,
    `engine/tests/machine/machine-pins.test.ts`.
- **Support paths (outside the frozen scope):**
  - `engine/src/core/frozen.ts`: the new `frozenMap`.
  - `engine/src/machine/index.ts`: exports `observeMachinePins`.
  - `engine/tests/fixtures/machine-definitions.ts`: the shared valid machine.
  - `engine/tests/handlers/pinned-machine-gate.test.ts`: the hook-level test.
  - This plan.

The engine's inspection emitted 15 findings, all advisory. After refutation, 0 critical findings survive
and 0 are refuted. No defect family is declared (`not-required`): every finding is local to this change.

## Advisory dispositions (all published under `run.pr186-policy`)

| Finding | Decision | Fix |
| --- | --- | --- |
| `silent-failure-hunter-1` | accepted | `directorySpellings` treats only `ENOENT`/`ENOTDIR` as absence. Any other realpath failure writes a stderr diagnostic, then compares by the resolved path alone. |
| `silent-failure-hunter-2` | accepted | SubagentStart writes a stderr notice when it binds a machine read from an operator directory (`LOOM_MACHINES_DIR`), naming the directory. Covered in `pinned-machine-gate.test.ts`, including the negative case for the shipped directory. |
| `pr-test-analyzer-1` | accepted | `pinned-machine-gate.test.ts` mocks the pin module, so the real shipped files stand in for every tampering case: a rewritten machine (digest mismatch), a deleted one (pinned, no file) and an added one (file, no pin). Each case binds at SubagentStart, and the PreToolUse gate blocks `Write`, naming the refusal and the re-pin command, never "vanished". Mutation-checked: mapping a refusal to `none` in the loader fails 4 of its 5 tests. |
| `pr-test-analyzer-2` | accepted | The realpath-failure branch is covered through the pure `machineTrustOf`: a resolved-only spelling equal to the shipped one stays pinned. |
| `pr-test-analyzer-3` | accepted | Known-answer test: the bytes `abc` are admitted against FIPS 180-2's published SHA-256, and `abd` is refused. |
| `type-design-analyzer-1` | dismissed | A `MachineSource` brand cannot exclude the dangerous case, operator trust over the shipped directory, without I/O. A pinned trust over any other directory only makes the gate stricter. The pairing is derived instead by the pure `machineTrustOf`, under property tests, and one `operatorMachineSource` factory replaces the hand-built literals. |
| `type-design-analyzer-2` | accepted | `frozenMap` (in `core/frozen.ts`, beside `frozenSet`) rejects `set`/`delete`/`clear` at runtime. `parseMachinePins` returns one, and the tests cover both the parser and the shipped pin set. |
| `comment-analyzer-1` | accepted | The test title now names the spellings it covers: a symlink, a trailing slash and a `..` detour. |
| `comment-analyzer-2` | accepted | The script header documents exit 2 (a definition that cannot be pinned). |
| `architecture-tech-lead-1` | accepted | The trust decision moved into core as the pure `machineTrustOf(configured, shipped, pins)`. `machineSource()` in `config.ts` only gathers the spellings. |
| `architecture-tech-lead-2` | accepted | `observeMachinePins` moved to `engine/src/machine/ledger.ts` and parses with the loader's own parser. `scripts/pin-machines.ts` is now a thin CLI with no exports. |
| `code-simplifier-1` | accepted | `admitMachineDefinition` uses an `UNGATED` constant and an `admitted(bytes)` constructor. |
| `code-simplifier-2` | accepted | Definitions decode through one `TextDecoder("utf-8", { ignoreBOM: true })`, so a byte-order mark survives into the parse exactly as the digest saw it. |
| `code-simplifier-3` | accepted | `observeMachinePins` reads each file once and digests the same bytes it parses. |
| `code-simplifier-4` | accepted | The tests share `validMachineJson` (`tests/fixtures/machine-definitions.ts`), `agentTypeOf` (`tests/fixtures/machine-identities.ts`) and `operatorMachineSource`. |

## Refuted findings

None.

## Validation

- `cd engine && npx tsc --noEmit && npm run -s typecheck:unused && npm run -s lint`
- `cd engine && npm run -s pin-machines -- --check`
- `cd engine && env -u PI_CODING_AGENT npx vitest run tests/handlers/pinned-machine-gate.test.ts tests/machine/machine-pins.test.ts tests/core/machine-integrity.test.ts tests/machine/ledger.test.ts`
- Full suite: `cd engine && env -u PI_CODING_AGENT npx vitest run`
- Smoke tests: `cd engine && env -u PI_CODING_AGENT npm run -s test:smoke`
- The registered remediation runs `project:verify` itself.
