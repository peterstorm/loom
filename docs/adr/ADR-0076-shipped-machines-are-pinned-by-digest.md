# ADR-0076: Shipped machines are pinned by digest

## Status
Accepted (2026-11-16).

## Context
Issue #183. A Guarded Skill Machine is the gate on its own agent: `machines/<agent-type>.machine.json` decides which
tools the agent may use in each phase and what its completion requires (`machines/README.md`). The loader
(`loadMachine`, `engine/src/machine/ledger.ts`) read whatever definition the directory held, with no
integrity check.

The directory was fenced from writes by guards that read command text: `guard-subagent-authority`,
`guard-state-file` and `block-direct-edits`. A whole class of bypass passes every such fence. An agent writes
a file it is allowed to write, then runs an ordinary tool that executes it:

- the repository's Git config (`core.fsmonitor`), then any `git status`;
- a Git hook, then `git commit`;
- a `package.json` script, then `npm test`;
- a Makefile, then `make`.

The planted command can then rewrite, add or delete a machine. Deleting a definition ungated its agent
outright, since a missing file meant "this agent has no machine". Refusing writes to every file some tool
might later execute is not a workable rule. ADR-0067 met the same problem for security ballots by moving the
proof onto the data path, with the fence kept as defence in depth.

## Options Considered

1. **Integrity on load: pin each shipped machine's digest in engine source (chosen).**
   - Pros: the gate stops trusting data that the gated agent could rewrite. Tampering of any kind fails
     closed. Works for every install, a Git checkout or a plugin cache without `.git`.
   - Cons: a change to `machines/` takes effect only once it is re-pinned.

2. **Integrity on load: pin to the blob at `HEAD`** (`git show HEAD:machines/...`).
   - Cons: a plugin cache install has no repository, so it would need a second mechanism. Uncommitted machine
     edits stop working in a dev checkout. Code that can run `git status` through an fsmonitor hook can run
     `git commit` too, so it is no stronger than an engine-source pin.

3. **OS enforcement: run subagent Bash with `machines/` mounted read-only (bubblewrap or similar).**
   - Cons: neither harness exposes per-subagent sandboxing. A session-wide Claude Code sandbox would also bind
     the parent, which must write the subagent directory. It remains the only way to close the residual below.

## Decision
**A definition in the shipped machines directory is admitted only when the SHA-256 of its exact bytes equals
the pin the engine carries for its agent type. The pin set, not the directory listing, says which agent types
are gated.**

- **The pins.** `engine/src/core/machine-pins.ts` holds the SHA-256 of every shipped definition, keyed by agent
  type. `engine/scripts/pin-machines.ts` generates it (`cd engine && npm run pin-machines`) from
  `observeMachinePins` (`engine/src/machine/ledger.ts`), which parses each definition with the loader's own
  parser and digests the same single read, so only a definition the loader would load is pinned. The script
  exits 2 when a definition cannot be pinned, and `--check` exits 1 when the pins drifted.
- **The decision** (`admitMachineDefinition`, `engine/src/core/machine-integrity.ts`, pure and total):

  | Shipped directory | No pin | Pin |
  |---|---|---|
  | No file | ungated | refused: `pinned-machine-missing` |
  | File | refused: `unpinned-machine` | admitted if the digest matches, otherwise refused: `digest-mismatch` |

  `admitted` carries the bytes it judged, and the loader parses exactly those, so the file is read once.
- **Refused means fail closed.** The loader maps a refusal to an `invalid` machine. The agent binds at
  SubagentStart and its gate (`enforce-phase-tools`) blocks every enforced tool, naming the refusal and the
  re-pin command. A deleted, added or rewritten machine makes the gate stricter, never weaker.
- **Which directory is pinned** (the pure `machineTrustOf`, fed by `machineSource` in `engine/src/config.ts`).
  It is pinned when any spelling of the configured directory (its resolved path or realpath) is a spelling of
  the shipped `machines/`. A directory that cannot be canonicalized compares by its resolved path, and any
  failure other than its absence is reported on stderr. A directory `LOOM_MACHINES_DIR` points elsewhere is
  `operator-directory` and admitted as it stands. The hook's environment comes from the harness, not from the
  agent (ADR-0067 note L), and tests point it at fixture machines. SubagentStart says on stderr whenever it
  binds a machine from an operator directory, so a configuration that bypasses the pins is never silent.
- **The pins are immutable at runtime.** `parseMachinePins` returns a `frozenMap`, so not even a cast can
  add, replace or remove a pin in the running engine.
- **Drift is a test failure.** `engine/tests/machine/machine-pins.test.ts` renders the pins from the shipped
  machines and compares them with the generated file byte for byte, so a machine changed without its pin
  fails the suite and CI. `engine/tests/handlers/pinned-machine-gate.test.ts` drives SubagentStart and the
  PreToolUse gate with a mocked pin module, proving that a rewritten, deleted or unpinned shipped machine
  binds and then blocks.
- **The fences stay.** `machines/` remains in `protectedDirs()` for every guard. They are defence in depth; the
  pin is the authority.

## Consequences

- Rewriting, adding or deleting a shipped machine can no longer weaken any agent's gate. It blocks that agent
  until the definition is restored or re-pinned.
- Changing a machine is a two-file change, reviewed together: the definition and its pin. In a dev checkout an
  unpinned edit blocks the agent with a message naming `cd engine && npm run pin-machines`. This also applies
  when Loom is installed from that checkout.
- **Residual, stated.** Code running as the user can rewrite a machine and its pin in engine source together,
  and the engine would believe both. Pinning raises the forgery from one data file to a coordinated change of
  shipped code. This is the same class ADR-0067 accepts for the capture attestation store. Only OS isolation
  (option 3) closes it.
- A directory the operator configures through `LOOM_MACHINES_DIR` is not pinned. Pointing the hooks there is
  the operator's decision, made in the harness's environment, not the agent's.
