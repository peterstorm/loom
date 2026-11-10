/**
 * The orchestration helper's operation table: every `helper orchestration
 * <operation>`, each declaring the traits that the CLI route layer and the
 * subagent write guard consult. Pure data with no imports, so `handler-routes`
 * can read it on every CLI start without loading the helper itself.
 *
 * The helper's dispatcher matches exhaustively over these names, and every
 * trait is required, so a new operation cannot be added without declaring each
 * policy here. Each policy is its own trait with exactly one reader; today the
 * skew-available operations are exactly the subagent-runnable ones, but that
 * is a coincidence of two facts, not one fact stated twice.
 */

export type OrchestrationOperationTraits = Readonly<{
  /**
   * `stdin`: the operation reads its input to end-of-input. `flags`: it takes
   * only flags, so the CLI must not wait for an end-of-input that an
   * inherited, still-open stdin never delivers (that wait once hung
   * `abandon`/`resume`/`inspect` indefinitely under such a parent).
   */
  input: "stdin" | "flags";
  /**
   * Pi runtime skew, read by `handler-routes`. `available`: a pure projection
   * that stays usable during Pi runtime skew, because it is what an operator
   * needs WHILE recovering from skew (`status`: where is the graph; `inspect`:
   * what state is this run in, and is it recoverable). Gating it would make
   * the handshake failure undiagnosable from inside the session that hit it.
   * `handshake-required`: every other operation, `abandon` included, since its
   * marker is durable and terminal.
   */
  runtimeSkew: "available" | "handshake-required";
  /**
   * Subagent authority (ADR-0067 D6), read by the subagent write guard
   * (`pre-tool-use/subagent-authority-operations.ts`). `read-only`: a subagent
   * may run it. `parent-only`: it moves orchestration authority and is the
   * parent's alone.
   */
  subagent: "read-only" | "parent-only";
}>;

export const ORCHESTRATION_OPERATIONS = Object.freeze({
  status: Object.freeze({ input: "flags", runtimeSkew: "available", subagent: "read-only" }),
  inspect: Object.freeze({ input: "flags", runtimeSkew: "available", subagent: "read-only" }),
  brief: Object.freeze({ input: "flags", runtimeSkew: "available", subagent: "read-only" }),
  start: Object.freeze({ input: "stdin", runtimeSkew: "handshake-required", subagent: "parent-only" }),
  restart: Object.freeze({ input: "flags", runtimeSkew: "handshake-required", subagent: "parent-only" }),
  "recover-orphan": Object.freeze({ input: "flags", runtimeSkew: "handshake-required", subagent: "parent-only" }),
  resume: Object.freeze({ input: "flags", runtimeSkew: "handshake-required", subagent: "parent-only" }),
  submit: Object.freeze({ input: "stdin", runtimeSkew: "handshake-required", subagent: "parent-only" }),
  correlate: Object.freeze({ input: "flags", runtimeSkew: "handshake-required", subagent: "parent-only" }),
  complete: Object.freeze({ input: "flags", runtimeSkew: "handshake-required", subagent: "parent-only" }),
  decide: Object.freeze({ input: "stdin", runtimeSkew: "handshake-required", subagent: "parent-only" }),
  abandon: Object.freeze({ input: "flags", runtimeSkew: "handshake-required", subagent: "parent-only" }),
  remediate: Object.freeze({ input: "flags", runtimeSkew: "handshake-required", subagent: "parent-only" }),
  attest: Object.freeze({ input: "flags", runtimeSkew: "handshake-required", subagent: "parent-only" }),
  "reopen-task": Object.freeze({ input: "flags", runtimeSkew: "handshake-required", subagent: "parent-only" }),
} as const satisfies Readonly<Record<string, OrchestrationOperationTraits>>);

export type OrchestrationOperation = keyof typeof ORCHESTRATION_OPERATIONS;

/** The operation an argument names, or null when it names none. */
export function parseOrchestrationOperation(value: string | undefined): OrchestrationOperation | null {
  return value !== undefined && Object.hasOwn(ORCHESTRATION_OPERATIONS, value)
    ? value as OrchestrationOperation
    : null;
}
