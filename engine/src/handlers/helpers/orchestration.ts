/**
 * Orchestration façade — one deep interface for the parent.
 *
 * Usage:
 *   helper orchestration status [--json] [--wave N]
 *   helper orchestration resume --run <run-directory> --runs-root <root>
 *   helper orchestration submit --run <run-directory> --runs-root <root>
 *                               --request <request-id> --slot <slot-id>
 *                               --attempt <1|2>   (raw bytes on stdin)
 *   helper orchestration decide --run <run-directory> --runs-root <root>
 *                               --request <decision-id>   (decision on stdin)
 *
 * Each mutating call parses authority, applies at most one event or receipt
 * reconciliation, persists it, and returns exactly one external action. The
 * parent therefore never assembles an action itself, and never has to know
 * which program produced it.
 *
 * `status` is a pure read: it derives ONE `LoomStatus` value and hands it to
 * a renderer. Both renderers project that same value, so the human and JSON
 * forms cannot disagree — neither contains readiness or action policy, and
 * neither re-runs a gate check. If authority cannot be parsed, every fact
 * category is still present as `unavailable` and the sole action is `blocked`,
 * rather than fabricated zero-or-ready values.
 */

import { existsSync } from "node:fs";
import { TASK_GRAPH_PATH } from "../../config";
import { parseTaskGraph } from "../../state-manager";
import type { HookHandler, HookResult } from "../../types";
import {
  deriveLoomStatusFromParsedGraph,
  renderLoomStatusHuman,
  renderLoomStatusJson,
  type GateDeps,
} from "../../core/wave-gate-machine";
import { loadPlanModelsSource } from "./complete-wave-gate";
import { openRunDirectory, type RunDirHandle } from "../../orchestration/run-directory-handle";
import {
  parseAgentRequestAuthority,
  type AgentRequestAuthority,
} from "../../core/orchestration-contract";
import { readFileSync } from "node:fs";

const OPERATIONS = ["status", "resume", "submit", "decide"] as const;
type Operation = (typeof OPERATIONS)[number];

const isOperation = (value: string | undefined): value is Operation =>
  value !== undefined && (OPERATIONS as readonly string[]).includes(value);

function usage(): HookResult {
  return {
    kind: "error",
    message: [
      "Usage: bun cli.ts helper orchestration <operation> [flags]",
      "",
      "  status  [--json] [--wave N]",
      "  resume  --runs-root <root> --run <run-directory>",
      "  submit  --runs-root <root> --run <run-directory> --request <id> --slot <id> --attempt <1|2>",
      "  decide  --runs-root <root> --run <run-directory> --request <decision-id>",
    ].join("\n"),
  };
}

function flag(args: readonly string[], name: string): string | null {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

const hasFlag = (args: readonly string[], name: string): boolean => args.includes(`--${name}`);

/** The real filesystem seams status reads through. */
const productionGateDeps: GateDeps = {
  loadPlanModels: loadPlanModelsSource,
  fileExists: existsSync,
};

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * Derive one canonical status value and render it.
 *
 * A missing or malformed graph is NOT an error exit: an operator asking "where
 * am I" when the state file is unreadable needs the answer "authority is
 * unavailable, here is why", not a stack trace. The status contract already
 * represents that case, so it is rendered like any other.
 */
export function renderStatus(
  rawGraph: unknown,
  deps: GateDeps,
  asJson: boolean,
): string {
  const parsed = parseTaskGraph(rawGraph);
  const status = deriveLoomStatusFromParsedGraph(parsed, deps);
  return asJson ? renderLoomStatusJson(status) : renderLoomStatusHuman(status);
}

function readGraph(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch (error) {
    // A parse failure is itself a status fact: hand the boundary something it
    // will reject, so the reason travels through the same contract.
    return { __unreadable: error instanceof Error ? error.message : String(error) };
  }
}

function statusOperation(args: readonly string[]): HookResult {
  const output = renderStatus(readGraph(TASK_GRAPH_PATH), productionGateDeps, hasFlag(args, "json"));
  process.stdout.write(`${output}\n`);
  return { kind: "allow" };
}

// ---------------------------------------------------------------------------
// Run-bound operations
// ---------------------------------------------------------------------------

type RunBinding = Readonly<{ handle: RunDirHandle }>;

/**
 * Bind to one anchored run directory. Both the runs-root and the run
 * directory are required: the handle proves the run is a direct child of the
 * root it claims, which is what stops a caller naming an arbitrary path.
 */
function bindRun(args: readonly string[]): Readonly<{ ok: true; value: RunBinding }> | HookResult {
  const runsRoot = flag(args, "runs-root");
  const runDirectory = flag(args, "run");
  if (runsRoot === null || runDirectory === null) {
    return { kind: "error", message: "both --runs-root and --run are required" };
  }
  const opened = openRunDirectory(runsRoot, runDirectory);
  return opened.ok
    ? { ok: true, value: { handle: opened.value } }
    : { kind: "error", message: `cannot bind run directory: ${opened.error.message}` };
}

const isBound = (
  value: Readonly<{ ok: true; value: RunBinding }> | HookResult,
): value is Readonly<{ ok: true; value: RunBinding }> => "ok" in value;

/**
 * Resume is idempotent and never silently spawns or decides policy: it reports
 * what the run's durable evidence already says. A run whose authority cannot
 * be read is reported as such rather than restarted, because restarting would
 * discard the very evidence that explains the failure.
 */
function resumeOperation(args: readonly string[]): HookResult {
  const bound = bindRun(args);
  if (!isBound(bound)) return bound;

  const authority = bound.value.handle.readAuthority();
  if (!authority.ok) return { kind: "error", message: authority.error.message };

  process.stdout.write(`${JSON.stringify({
    kind: "resumed",
    runId: authority.value.runId,
    runDirectory: authority.value.runDirectory,
  }, null, 2)}\n`);
  return { kind: "allow" };
}

/**
 * Accept one semantic result's exact bytes into its reserved transcript slot.
 *
 * The bytes arrive on stdin and are written verbatim — never trimmed, joined,
 * or re-encoded — so the stored artifact is byte-identical to what the harness
 * produced. The slot is exclusive, so a duplicate or late submission for an
 * attempt that already landed is refused rather than allowed to overwrite
 * accepted evidence.
 */
async function submitOperation(stdin: string, args: readonly string[]): Promise<HookResult> {
  const bound = bindRun(args);
  if (!isBound(bound)) return bound;

  const requestId = flag(args, "request");
  const slotId = flag(args, "slot");
  const attempt = flag(args, "attempt");
  if (requestId === null || slotId === null || (attempt !== "1" && attempt !== "2")) {
    return { kind: "error", message: "--request, --slot, and --attempt (1 or 2) are required" };
  }

  const authority = bound.value.handle.readAuthority();
  if (!authority.ok) return { kind: "error", message: authority.error.message };

  const reserved = readReservedRequest(bound.value.handle, requestId);
  if (reserved === null) {
    return { kind: "error", message: `request ${requestId} was never reserved in this run` };
  }
  if (reserved.slotId !== slotId || String(reserved.attempt) !== attempt) {
    return {
      kind: "error",
      message: `request ${requestId} is reserved for slot ${reserved.slotId} attempt ${reserved.attempt}, not ${slotId} attempt ${attempt}`,
    };
  }

  const captured = await bound.value.handle.captureTranscript(reserved, [...Buffer.from(stdin, "utf-8")]);
  if (!captured.ok) return { kind: "error", message: captured.error.message };

  process.stdout.write(`${JSON.stringify({
    kind: "captured",
    requestId,
    artifact: captured.value,
  }, null, 2)}\n`);
  return { kind: "allow" };
}

/**
 * Read back the immutable request authority a reservation wrote, and PARSE it
 * rather than trusting the bytes. The stored file is the run's own evidence,
 * but a capture is accepted against it, so it earns the same scrutiny as any
 * other untrusted input.
 */
function readReservedRequest(
  handle: RunDirHandle,
  requestId: string,
): AgentRequestAuthority | null {
  const raw = ((): unknown => {
    try {
      return JSON.parse(readFileSync(`${handle.runDirectory}/requests/${requestId}.json`, "utf-8")) as unknown;
    } catch {
      return null;
    }
  })();
  if (raw === null) return null;
  const parsed = parseAgentRequestAuthority(raw);
  return parsed.ok ? parsed.value : null;
}

/**
 * Record a genuine user decision. The decision is durable evidence like any
 * other result, so it lands in the run directory rather than being applied
 * from memory — a crash between the decision and its effect re-reads it on
 * resume instead of losing it.
 */
async function decideOperation(stdin: string, args: readonly string[]): Promise<HookResult> {
  const bound = bindRun(args);
  if (!isBound(bound)) return bound;

  const decisionId = flag(args, "request");
  if (decisionId === null) return { kind: "error", message: "--request <decision-id> is required" };
  if (stdin.trim().length === 0) return { kind: "error", message: "a decision must be supplied on stdin" };

  const decision = ((): unknown => {
    try {
      return JSON.parse(stdin) as unknown;
    } catch (error) {
      return { __malformed: error instanceof Error ? error.message : String(error) };
    }
  })();
  if (typeof decision !== "object" || decision === null ||
      typeof (decision as Record<string, unknown>)["__malformed"] === "string") {
    return { kind: "error", message: "decision must be a JSON object" };
  }

  await bound.value.handle.appendEvent({
    schemaVersion: 1,
    sequence: 0,
    dedupKey: `decision:${decisionId}`,
    recordedAtMs: Date.now(),
    event: { kind: "user-decision-recorded", decisionId, decision },
  });

  process.stdout.write(`${JSON.stringify({ kind: "decision-recorded", decisionId }, null, 2)}\n`);
  return { kind: "allow" };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const handler: HookHandler = async (stdin, args) => {
  const operation = args[0];
  if (!isOperation(operation)) return usage();
  const rest = args.slice(1);

  switch (operation) {
    case "status":
      return statusOperation(rest);
    case "resume":
      return resumeOperation(rest);
    case "submit":
      return submitOperation(stdin, rest);
    case "decide":
      return decideOperation(stdin, rest);
  }
};

export default handler;
