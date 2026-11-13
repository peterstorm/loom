# Harness

How Loom runs Agents on Claude Code and on Pi. Most of these name engine and Pi internals; they are here so the code and its reviews use one word for each. Core terms (Agent, Hook, Dispatch, Epoch, Evidence Ledger, Context Packet, …) are in the root [CONTEXT.md](../../../CONTEXT.md).

## Language

### Agents and models

**Agent Catalog**:
The single declarative registry defining every Agent's identity: its kind, model profile, required Skill and Pi transport, one record per Agent, keyed by name. Every agent set, phase map and policy table is derived from it, never declared a second time.
_Avoid_: Agent list, agent config, roster (a roster is an ordered per-run selection drawn from the catalog, not identity)

**LLM Profile**:
A semantic policy assigning one Agent role its model on each harness: a Claude Code model and an exact Pi provider, model and thinking setting. A missing binding fails closed. Retired profiles and bindings stay readable as recorded history.
_Avoid_: Model alias, Sonnet equivalent, current model, implicit model fallback

**Launch Route**:
The provider and model a Pi child actually runs on: its Agent's LLM Profile binding after the spawn-boundary routing policy for the observed parent. A stored request on a route the catalog no longer issues is on a retired route: its run is restarted, never resumed.
_Avoid_: Declared binding (that is the profile's binding before routing), frozen binding, current route

**Served-Model Evidence**:
What a route's model-list answer proves about the model: listed (the server's list was read) or unverified (the server answered but its list could not be read). Unverified routes are admitted and reported, never silently treated as confirmed.
_Avoid_: Model check passed, reachable (alone — reachability does not confirm the model)

**Agent Request Authority**:
An engine-issued immutable binding of one Agent request: its Run, roster slot, semantic attempt, program, Agent role, LLM Profile, harness bindings, required Skill, Context Packet digest and transcript slot. Harness-native ids correlate to it but never replace it. It is checked against the catalog once, when minted; read back later it is recorded history.
_Avoid_: Prompt metadata, spawn args, transcript filename

**Runtime Revision**:
A content-addressed identity over Loom's extension, engine, and runtime package bytes. Pi captures it when the extension loads; every fresh Pi-launched CLI mutator must present the same identity before changing a TaskGraph or Run Directory.
_Avoid_: Package version, schema version, commit hash, current checkout

**Guarded Skill Machine**:
A deterministic phase machine that drives one Agent run: the runtime enforces the Agent's phase order and tool availability, and the Agent's own attributed tool calls are the events that advance it. A machine file that cannot be parsed still binds, so the gate fails closed. Unrelated to the Lifecycle Machine: see Flagged Ambiguities in the root file.
_Avoid_: Skill state machine, agent statechart, phase gate (alone)

### Spawning and write authority

**Spawn Admission**:
The pure decision that accepts or blocks one subagent spawn batch before any state changes, returning an allow or a block that names the exact guard that decided. The Hook is the shell that gathers its inputs and applies it.
_Avoid_: Spawn gate (that is the Hook applying the decision), spawn validation

**Write Grant**:
A one-time Pi capability minted per spawn that lets one child write while a TaskGraph is active. An implementation Agent's grant covers the session and is bound to its Task; a phase or panel writer's grant is scoped to the artifact directories its prompt names. Issuance follows the Agent's role: a read-only Agent (judge, verifier, reviewer, decompose, spec-check) receives none even when its prompt names artifact paths.
_Avoid_: Write permit, edit allowance, blanket phase write, Scoped Write Grant (as the name of the concept — "scoped" is the phase and panel writers' kind)

**Interactive Phase Transport**:
The Pi-only transport for one interactive phase Agent: the parent relays the child's questions to its own dialogs and returns exactly correlated answers, keeping the same child process and Agent turn. Headless Agents stay on the normal subagent transport.
_Avoid_: Question-file fallback, parent interview, interactive subagent (that is the tool surface, not the transport contract)

**Orchestrated Repository**:
The repository that owns a live State File: the root of the Git working tree holding it. The direct-edit guard protects this repository and Loom's own protected directories; a write whose every target lies outside both (another worktree, a scratchpad) is allowed, and a target that cannot be resolved stays guarded.
_Avoid_: Project dir, cwd, checkout (when the guard's scope is meant)

**Inline-Program Stdin Inheritance**:
The case the state-file guard treats specially: an interpreter's inline program inherits the command's standard input, so when that program itself reads and executes its input, a heredoc body is a script and is judged as command text. When the inline program names its own source or only reads data, the body is data.
_Avoid_: Nested interpreter, double interpreter, inner shell

### Pi session bookkeeping

**Spawn Claims Ledger**:
The record of every capability one Pi spawn batch holds (write grants, roster entries, the pointer lease, emission launches, a newly bound review run), released together by one rule on refusal, settlement or shutdown. It is total: a duplicate or unclaimed capability is refused, never dropped or overwritten. What fails to release stays on the parent session as cleanup debt.
_Avoid_: Rollback list, cleanup closure, admission state

**Orphaned Spawn Claim**:
A durable capability (a write grant or a pointer lease) that a refused **Spawn Claims Ledger** claim took and whose compensating release failed. No ledger owns it, so the parent session keeps it as cleanup debt and retries its release at every settlement and at shutdown.
_Avoid_: Leaked grant, compensation debt

**Session TaskGraph Pointer Lease Registry**:
The record beside one session's TaskGraph pointer of who is using it. Every binder of the same target holds one lease; only the release of the last lease restores the pointer's previous target, and a different target or contradictory crash state fails closed.
_Avoid_: Pointer owner flag, shared pointer, best-effort rollback

**Trusted Review Witness Aggregate**:
The Pi extension's in-process authority over which Standalone Review Run is current for one session and review root. A run becomes current when its first spawn is bound; verification considers only the current run and never falls back to an older one.
_Avoid_: Review cache, accepted result fallback, global witness map

**Pi Ledger Recorder**:
The Pi child's handler that records its tool calls into the parent session's Evidence Ledger, under the child's own Epoch. Only a child holding a valid parent-issued **Write Grant** records; any other child records nothing and says so. It adds no live phase gate on Pi.
_Avoid_: Pi transcript converter, Pi evidence bridge

### Emission

**Payload Producer**:
An Agent that emits a structured payload, classified by producer kind: a reviewer payload, a refutation verdict or a judge verdict. The kinds are derived from the Agent Catalog, never declared per request, and each selects exactly one **Emission Tool**.
_Avoid_: Output agent, emitter, payload type (the kind names the producer's payload contract, not a data type)

**Emission Tool**:
The exact frozen-schema tool one emission-enabled child request advertises: one registered name per producer kind, with parameters identical to the frozen payload schema. The child registers and runs it; the engine's parser stays the authority on validity, and the model selects neither the tool nor its version.
_Avoid_: output schema, structured output (generic), second schema (there is exactly one frozen schema)

**Emission Source**:
The engine-side provenance recorded for every ingested payload: the emission tool's arguments, or extraction from the final message. Choosing between them is one deterministic decision bound to the issued request attempt; a wrong-request, wrong-kind, incomplete or otherwise unusable tool observation is refused rather than treated as absent.
_Avoid_: payload origin, delivery path

**Qualified Emission Route**:
The exact provider, served model and schema digest whose recorded qualification accepts the frozen emission schemas: the sole authority for enabling emission on an issued request. A capability flag, a provider name or a successful local round-trip is not qualification.
_Avoid_: capable provider, strict-sampling support (unproven), auto-detected capability

**Readiness Barrier**:
The request-bound gate at the Pi launcher before any model request: the child must prove that its registered, active tool matches the issued request, producer kind, version and schema digest. Missing, stale, contradictory or wrong-request readiness fails closed, naming the actual cause.
_Avoid_: startup notification, readiness flag, parent hash check

## Relationships

- An **Agent** has exactly one **Agent Catalog** record and resolves exactly one **LLM Profile** before spawn
- A Pi child runs on exactly one **Launch Route**, which carries one **Served-Model Evidence**
- An engine-issued Agent request has exactly one **Agent Request Authority**
- A Pi-launched mutating CLI process must match the extension's **Runtime Revision**
- An Agent run is bound to at most one **Guarded Skill Machine**
- A spawn batch gets exactly one **Spawn Admission** decision
- A Pi child holds at most one **Write Grant**; a read-only Agent holds none
- An interactive Pi phase Agent runs through the **Interactive Phase Transport**; every headless role does not
- A live State File has exactly one **Orchestrated Repository**
- A Pi spawn batch has exactly one **Spawn Claims Ledger**; an **Orphaned Spawn Claim** belongs to none
- A session's TaskGraph pointer has one **Session TaskGraph Pointer Lease Registry** with one lease per binder
- A session and review root have at most one current run in the **Trusted Review Witness Aggregate**
- A **Payload Producer** has one or two producer kinds; each kind has exactly one **Emission Tool**
- An ingested payload has exactly one **Emission Source**
- Emission is enabled only on a **Qualified Emission Route** and only past the **Readiness Barrier**
