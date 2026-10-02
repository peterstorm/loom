/**
 * Which orchestration run a Claude Code hook speaks for.
 *
 * Claude's hooks run in fresh processes that inherit nothing from the façade
 * invocation that issued the requests, so they cannot learn their run from the
 * environment the way a supervisor-driven harness can. The façade therefore
 * publishes a durable SESSION RUN BINDING (`registerSessionRunBinding`, harness
 * `claude-code`) keyed by the main agent's `CLAUDE_CODE_SESSION_ID`, and every
 * Claude hook — whose payload `session_id` is that same parent session, for the
 * main agent and its subagents alike — reads it back here. It is the SAME
 * mechanism Pi uses (`pi/extension` resolves its runs from the same registry),
 * not a parallel copy.
 *
 * The explicit `LOOM_ORCHESTRATION_*` variables keep their precedence and their
 * semantics: when either is set it alone is the authority, and half of one is a
 * fault. Only when neither is set does the session binding decide.
 *
 * Every function here answers one question for every Claude call site — the
 * PostToolUse spawn correlator, SubagentStop capture, and the SubagentStop
 * dispatcher — so the three cannot disagree about which run a hook belongs to.
 * Decisions are reads only; the one write (recording a spawn correlator) is a
 * separate, explicitly named step its callers perform.
 *
 * Fail-closed discipline: an unreadable registry, a correlator that cannot be
 * read, or a marker no binding (or more than one) admits are errors, never a
 * silent "unrelated agent". Only the absence of any claim — no binding for the
 * session, no correlator and no request marker for this agent — is `unbound`.
 */

import { subagentDir } from "../config";
import { parseSessionId } from "../machine/evidence";
import { RUN_DIR_ENV, RUNS_ROOT_ENV } from "./harness-capture-runtime";
import { inspectRunDirectoryEntry, openRegisteredRunDirectory } from "./run-directory-handle";
import { readSessionRunBindings, type BindingResult, type SessionRunBinding } from "./session-run-bindings";

/** The run a hook was resolved to — the pair every run-directory primitive takes. */
export type ClaudeRun = Readonly<{ runsRoot: string; runDirectory: string }>;

/**
 * `unbound`: the hook belongs to nobody's orchestration run (the ordinary
 * ad-hoc agent) and its caller must leave it alone. `bound`: the hook speaks
 * for exactly this run.
 */
export type ClaudeRunAuthority =
  | Readonly<{ kind: "unbound" }>
  | Readonly<{ kind: "bound"; run: ClaudeRun }>;

/**
 * A SubagentStop additionally distinguishes a request-bound agent whose
 * correlator is not yet recorded. Claude Code runs a FOREGROUND Agent call to
 * completion before the Agent tool returns, so that agent's SubagentStop fires
 * BEFORE the PostToolUse that would have recorded its correlator. The stop
 * therefore names the exact issued request its own spawn prompt carries, and
 * the caller records the correlator (`recordClaudeSpawnCorrelator`, the same
 * write PostToolUse performs) before capturing.
 */
export type ClaudeStopAuthority =
  | ClaudeRunAuthority
  | Readonly<{ kind: "uncorrelated"; run: ClaudeRun; requestId: string }>;

/** Everything run resolution reads, gathered at the hook boundary. */
export type ClaudeRunContext = Readonly<{
  /** `LOOM_ORCHESTRATION_RUNS_ROOT`, when set. */
  runsRoot: string | undefined;
  /** `LOOM_ORCHESTRATION_RUN_DIR`, when set. */
  runDirectory: string | undefined;
  /** Where session run bindings live (`subagentDir()`). */
  bindingDirectory: string;
  /** The hook payload's `session_id` — the parent Claude Code session. */
  sessionId: string | undefined;
}>;

/**
 * Gather a hook's run-resolution inputs at its boundary: the explicit
 * environment authority, the binding registry location, and the payload's
 * `session_id` — the PARENT session that published its bindings, for the main
 * agent's PostToolUse and a subagent's SubagentStop alike (a subagent's own
 * transcript lines carry that same id). A non-string id is no id.
 */
export function claudeRunContext(
  sessionId: unknown,
  env: NodeJS.ProcessEnv = process.env,
  bindingDirectory: string = subagentDir(),
): ClaudeRunContext {
  return Object.freeze({
    runsRoot: env[RUNS_ROOT_ENV],
    runDirectory: env[RUN_DIR_ENV],
    bindingDirectory,
    sessionId: typeof sessionId === "string" ? sessionId : undefined,
  });
}

const ok = <T>(value: T): BindingResult<T> => ({ ok: true, value });
const failed = <T = never>(message: string): BindingResult<T> => ({ ok: false, message });
const UNBOUND: ClaudeRunAuthority = Object.freeze({ kind: "unbound" });
const bound = (run: ClaudeRun): ClaudeRunAuthority => Object.freeze({ kind: "bound", run: Object.freeze({ ...run }) });

const REQUEST_MARKER = /^LOOM_REQUEST_ID:[ \t]*(\S+)[ \t]*$/gm;

/** Every LOOM_REQUEST_ID marker an engine-issued Agent prompt carries (exactly one when it is engine-issued). */
export function requestMarkers(prompt: string): readonly string[] {
  return Object.freeze([...prompt.matchAll(REQUEST_MARKER)].map((match) => match[1]!));
}

/**
 * The run the explicit environment names, `null` when it names none. Half an
 * authority is a fault, never "unrelated".
 */
export function explicitClaudeRun(context: ClaudeRunContext): BindingResult<ClaudeRun | null> {
  const { runsRoot, runDirectory } = context;
  if (runsRoot === undefined && runDirectory === undefined) return ok(null);
  if (runsRoot === undefined || runDirectory === undefined) {
    return failed("Claude orchestration requires both run-root and run-directory authority");
  }
  return ok(Object.freeze({ runsRoot, runDirectory }));
}

function sessionBindings(context: ClaudeRunContext): BindingResult<readonly SessionRunBinding[]> {
  if (context.sessionId === undefined || context.sessionId === "") {
    return failed("Claude orchestration hook payload names no session_id, so no session run binding can be read");
  }
  return readSessionRunBindings(context.bindingDirectory, context.sessionId, "claude-code");
}

/** The one binding that issued `requestId`; none or several is a fault. */
function bindingIssuing(bindings: readonly SessionRunBinding[], requestId: string): BindingResult<ClaudeRun> {
  const matches = bindings.filter((binding) => (binding.requestIds as readonly string[]).includes(requestId));
  if (matches.length === 1) return ok(Object.freeze({ runsRoot: matches[0]!.runsRoot, runDirectory: matches[0]!.runDirectory }));
  return failed(matches.length === 0
    ? `no Claude Code session run binding contains issued request ${requestId}`
    : `multiple Claude Code session run bindings contain issued request ${requestId}`);
}

/**
 * Resolve the run that issued `requestId`, the single LOOM_REQUEST_ID marker a
 * spawn prompt carries. A marker is a claim of engine authority: the explicit
 * run when one is set, otherwise exactly one session binding must have issued
 * it, or the claim fails closed. (A spawn with no marker claims nothing and
 * never reaches this question.)
 */
export function resolveClaudeSpawnRun(
  context: ClaudeRunContext,
  requestId: string,
): BindingResult<ClaudeRun> {
  const explicit = explicitClaudeRun(context);
  if (!explicit.ok) return explicit;
  if (explicit.value !== null) return ok(explicit.value);
  const bindings = sessionBindings(context);
  if (!bindings.ok) return bindings;
  return bindingIssuing(bindings.value, requestId);
}

/** Does this bound run hold a Claude correlator for `nativeId`? Absent runs hold nothing. */
function correlatesAgent(binding: SessionRunBinding, nativeId: string): BindingResult<boolean> {
  // A run directory removed after its binding was published (a finished run
  // cleaned up, a test fixture) can hold no reservation to capture into, so it
  // cannot claim this agent. Anything else that is not a readable run is a
  // fault: it may well hold the reservation this stop answers.
  const entry = inspectRunDirectoryEntry(binding.runsRoot, binding.runDirectory);
  if (!entry.ok) return failed(entry.error.message);
  if (entry.value.kind === "absent") return ok(false);
  const opened = openRegisteredRunDirectory(binding.runsRoot, binding.runDirectory);
  if (!opened.ok) return failed(opened.error.message);
  const correlator = opened.value.readHarnessCorrelator("claude", nativeId);
  if (!correlator.ok) return failed(correlator.error.message);
  return ok(correlator.value !== null);
}

/**
 * Resolve the run a SubagentStop belongs to.
 *
 * Explicit authority wins unchanged. Otherwise the bound run whose correlator
 * records this native `agent_id` owns the stop; a correlator in several bound
 * runs is ambiguous and fails closed. With no correlator anywhere, the agent's
 * own spawn prompt (`spawnPrompt`, read lazily and only then) decides: no marker
 * means an ordinary ad-hoc agent, and a marker names the request whose
 * correlator the caller must record before capturing (see ClaudeStopAuthority).
 */
export function resolveClaudeStopRun(
  context: ClaudeRunContext,
  nativeId: string,
  spawnPrompt: () => BindingResult<string | null>,
): BindingResult<ClaudeStopAuthority> {
  const explicit = explicitClaudeRun(context);
  if (!explicit.ok) return explicit;
  if (explicit.value !== null) return ok(bound(explicit.value));
  // A session with no published binding has no run for any of its agents, and
  // a session id that is absent or unsafe as a file name can name no registry
  // at all. (The spawn side refuses that case: there a marker claims a run.)
  if (parseSessionId(context.sessionId ?? "") === null) return ok(UNBOUND);
  const bindings = sessionBindings(context);
  if (!bindings.ok) return bindings;
  if (bindings.value.length === 0) return ok(UNBOUND);
  if (nativeId.length === 0) {
    return failed("Claude SubagentStop names no agent_id, so it cannot be proven outside this session's bound runs");
  }

  const owners: SessionRunBinding[] = [];
  for (const binding of bindings.value) {
    const correlated = correlatesAgent(binding, nativeId);
    if (!correlated.ok) return correlated;
    if (correlated.value) owners.push(binding);
  }
  if (owners.length > 1) {
    return failed(`Claude agent ${nativeId} is correlated in multiple session-bound runs`);
  }
  if (owners.length === 1) {
    return ok(bound({ runsRoot: owners[0]!.runsRoot, runDirectory: owners[0]!.runDirectory }));
  }

  const prompt = spawnPrompt();
  if (!prompt.ok) return prompt;
  const markers = prompt.value === null ? [] : requestMarkers(prompt.value);
  if (markers.length === 0) return ok(UNBOUND);
  if (markers.length !== 1) {
    return failed("Claude orchestration prompt must carry exactly one LOOM_REQUEST_ID marker");
  }
  const run = bindingIssuing(bindings.value, markers[0]!);
  return run.ok ? ok(Object.freeze({ kind: "uncorrelated" as const, run: run.value, requestId: markers[0]! })) : run;
}

/**
 * Record that Claude agent `nativeId` answers issued request `requestId`.
 *
 * The one correlator write both Claude boundaries share: PostToolUse after a
 * spawn returns, and SubagentStop when a foreground spawn finished first. The
 * underlying write is idempotent for identical authority and refuses a
 * conflicting one, so whichever boundary runs second either agrees or fails.
 */
export async function recordClaudeSpawnCorrelator(
  run: ClaudeRun,
  spawn: Readonly<{ requestId: string; role: string; nativeId: string }>,
): Promise<BindingResult<null>> {
  const opened = openRegisteredRunDirectory(run.runsRoot, run.runDirectory);
  if (!opened.ok) return failed(opened.error.message);
  const issued = opened.value.readIssuedRequests();
  if (!issued.ok) return failed(issued.error.message);
  const request = issued.value.find(({ requestId }) => requestId === spawn.requestId);
  if (request === undefined) return failed(`Claude spawn claims unissued request ${spawn.requestId}`);
  if (request.role !== spawn.role) {
    return failed(`Claude spawn request ${request.requestId} belongs to ${request.role}, not ${spawn.role}`);
  }
  const recorded = await opened.value.recordHarnessCorrelator({
    schemaVersion: 1,
    harness: "claude",
    nativeId: spawn.nativeId,
    requestId: request.requestId,
    role: request.role,
    attempt: request.attempt,
  });
  return recorded.ok ? ok(null) : failed(recorded.error.message);
}
