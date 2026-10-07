/**
 * The orchestration helper's operation table: every `helper orchestration
 * <operation>`, each declaring the two traits the CLI route layer must know
 * before it imports the helper. Pure data with no imports, so `handler-routes`
 * can read it on every CLI start without loading the helper itself.
 *
 * The helper's dispatcher matches exhaustively over these names, so a new
 * operation cannot be added without declaring both traits here.
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
   * `available`: a pure projection that mutates nothing and stays usable
   * during Pi runtime skew, because it is what an operator needs WHILE
   * recovering from skew (`status`: where is the graph; `inspect`: what state
   * is this run in, and is it recoverable). Gating it would make the handshake
   * failure undiagnosable from inside the session that hit it.
   * `handshake-required`: every other operation, `abandon` included, since its
   * marker is durable and terminal.
   */
  runtimeSkew: "available" | "handshake-required";
}>;

export const ORCHESTRATION_OPERATIONS = Object.freeze({
  status: Object.freeze({ input: "flags", runtimeSkew: "available" }),
  inspect: Object.freeze({ input: "flags", runtimeSkew: "available" }),
  brief: Object.freeze({ input: "flags", runtimeSkew: "available" }),
  start: Object.freeze({ input: "stdin", runtimeSkew: "handshake-required" }),
  restart: Object.freeze({ input: "flags", runtimeSkew: "handshake-required" }),
  "recover-orphan": Object.freeze({ input: "flags", runtimeSkew: "handshake-required" }),
  resume: Object.freeze({ input: "flags", runtimeSkew: "handshake-required" }),
  submit: Object.freeze({ input: "stdin", runtimeSkew: "handshake-required" }),
  correlate: Object.freeze({ input: "flags", runtimeSkew: "handshake-required" }),
  complete: Object.freeze({ input: "flags", runtimeSkew: "handshake-required" }),
  decide: Object.freeze({ input: "stdin", runtimeSkew: "handshake-required" }),
  abandon: Object.freeze({ input: "flags", runtimeSkew: "handshake-required" }),
  remediate: Object.freeze({ input: "flags", runtimeSkew: "handshake-required" }),
  attest: Object.freeze({ input: "flags", runtimeSkew: "handshake-required" }),
} as const satisfies Readonly<Record<string, OrchestrationOperationTraits>>);

export type OrchestrationOperation = keyof typeof ORCHESTRATION_OPERATIONS;

/** The operation an argument names, or null when it names none. */
export function parseOrchestrationOperation(value: string | undefined): OrchestrationOperation | null {
  return value !== undefined && Object.hasOwn(ORCHESTRATION_OPERATIONS, value)
    ? value as OrchestrationOperation
    : null;
}
