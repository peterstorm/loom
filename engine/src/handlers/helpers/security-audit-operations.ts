/**
 * The security-audit helper's operation table: every `helper security-audit
 * <operation>`, each declaring the two traits the CLI route layer must know
 * before it imports the helper. Pure data with no imports, so `handler-routes`
 * can read it on every CLI start without loading the helper itself.
 *
 * The dispatcher matches exhaustively over these names, so an operation cannot
 * be added without declaring both traits here — and a route that is not in this
 * table is not a route the CLI will accept.
 *
 * The action set is CLOSED on purpose (ADR-0064). Every state change a run can
 * make is one of these operations; a caller cannot invent another way to move
 * the ledger, which is what keeps `status` a complete answer to "where is this
 * run".
 */

export type SecurityAuditOperationTraits = Readonly<{
  /**
   * `stdin`: the operation reads its input to end-of-input (units to seed,
   * candidate findings, critic proposals, verification ballots). `flags`: it
   * takes only flags, so the CLI must not wait for an end-of-input that an
   * inherited, still-open stdin never delivers.
   */
  input: "stdin" | "flags";
  /**
   * `available`: a read-only projection (`status`, `findings`, `nonce`) that writes
   * nothing and must stay usable during Pi runtime skew — it is what an
   * operator reads WHILE recovering, so gating it would make the skew
   * undiagnosable from inside the session that hit it.
   * `handshake-required`: every operation that writes run state.
   *
   * This is the ONLY policy field: "writes" and "gated by the handshake" are the
   * same fact stated twice, and two fields drift. `securityAuditOperationWrites`
   * derives the answer callers ask for.
   */
  runtimeSkew: "available" | "handshake-required";
  /** Input shape only; see `input` above. */
}>;

export const SECURITY_AUDIT_OPERATIONS = Object.freeze({
  /** Freeze the revision, seed the coverage ledger, select lenses. */
  start: Object.freeze({ input: "stdin", runtimeSkew: "handshake-required" }),
  /** Give a planned unit to a hunter for a wave. */
  assign: Object.freeze({ input: "flags", runtimeSkew: "handshake-required" }),
  /** Print the sandbox nonce and bounded-run instructions for one artifact of a
   *  unit in flight. Derived from the ledger; writes nothing. */
  nonce: Object.freeze({ input: "flags", runtimeSkew: "available" }),
  /** Settle units with a hunter's results and record its candidate findings. */
  submit: Object.freeze({ input: "stdin", runtimeSkew: "handshake-required" }),
  /** Mark a unit (or every still-planned unit) deferred, with its reason. */
  defer: Object.freeze({ input: "flags", runtimeSkew: "handshake-required" }),
  /** Fold the coverage critic's proposals, reassignments and resolutions in. */
  "merge-critic": Object.freeze({ input: "stdin", runtimeSkew: "handshake-required" }),
  /** Record verification ballots. Adjudication itself happens at publish. */
  verify: Object.freeze({ input: "stdin", runtimeSkew: "handshake-required" }),
  /** Render the report from validated records, to stdout. Writes nothing. */
  findings: Object.freeze({ input: "flags", runtimeSkew: "available" }),
  /** Adjudicate and publish `security-findings.json` plus the rendered docs. */
  publish: Object.freeze({ input: "flags", runtimeSkew: "handshake-required" }),
  /** Turn the published records into the decision set `/review-and-fix`
   *  consumes. Derived from `security-findings.json`, never authored beside it. */
  disposition: Object.freeze({ input: "flags", runtimeSkew: "handshake-required" }),
  /** Where is the run: coverage summary, blockers, settled? */
  status: Object.freeze({ input: "flags", runtimeSkew: "available" }),
} as const satisfies Readonly<Record<string, SecurityAuditOperationTraits>>);

export type SecurityAuditOperation = keyof typeof SECURITY_AUDIT_OPERATIONS;

/** Whether the operation writes anything under the run directory — the helper
 *  prepares (creates) the directory only for these, so a read-only projection
 *  never creates the run it was asked to read. Derived from the skew policy,
 *  which is the same fact: an operation that writes is the one the handshake
 *  gates. */
export const securityAuditOperationWrites = (operation: SecurityAuditOperation): boolean =>
  SECURITY_AUDIT_OPERATIONS[operation].runtimeSkew === "handshake-required";

/** The operation an argument names, or null when it names none. */
export function parseSecurityAuditOperation(value: string | undefined): SecurityAuditOperation | null {
  return value !== undefined && Object.hasOwn(SECURITY_AUDIT_OPERATIONS, value)
    ? value as SecurityAuditOperation
    : null;
}

/** The action set, in the order a run performs it — the order the helper's
 *  usage line lists them in. */
export const SECURITY_AUDIT_OPERATION_ORDER: readonly SecurityAuditOperation[] = Object.freeze([
  "start",
  "assign",
  "nonce",
  "submit",
  "defer",
  "merge-critic",
  "verify",
  "findings",
  "publish",
  "disposition",
  "status",
]);
