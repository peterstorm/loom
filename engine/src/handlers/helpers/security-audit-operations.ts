/**
 * The security-audit helper's operation table: every `helper security-audit
 * <operation>`, each declaring the traits that the CLI route layer, the helper
 * and the subagent write guard consult. Pure data with no imports, so
 * `handler-routes` can read it on every CLI start without loading the helper
 * itself.
 *
 * The dispatcher matches exhaustively over these names, and every trait is
 * required, so an operation cannot be added without declaring each policy
 * here — and a route that is not in this table is not a route the CLI will
 * accept.
 *
 * Each policy is its own trait with exactly one reader. Today the three policy
 * traits coincide (the projections are skew-available, read-only on disk and
 * subagent-runnable), but they are different facts: an operation that is
 * read-only yet handshake-gated is one row edit, not a rework of three readers.
 *
 * The action set is CLOSED on purpose (ADR-0066). Every state change a run can
 * make is one of these operations; a caller cannot invent another way to move
 * the ledger, which is what keeps `status` a complete answer to "where is this
 * run".
 */

export type SecurityAuditOperationTraits = Readonly<{
  /**
   * `stdin`: the operation reads its input to end-of-input (units to seed,
   * candidate findings, critic proposals). `flags`: it
   * takes only flags, so the CLI must not wait for an end-of-input that an
   * inherited, still-open stdin never delivers.
   */
  input: "stdin" | "flags";
  /**
   * Pi runtime skew, read by `handler-routes`. `available`: usable while the
   * Pi extension and this CLI disagree — what an operator reads WHILE
   * recovering, so gating it would make the skew undiagnosable from inside the
   * session that hit it. `handshake-required`: the process must first prove it
   * matches the extension runtime.
   */
  runtimeSkew: "available" | "handshake-required";
  /**
   * Run-directory writes, read by `securityAuditOperationWrites`. `writes`: the
   * operation writes under the run directory, so the helper prepares (creates)
   * it. `reads`: a projection that must never create the run it was asked to
   * read.
   */
  runDirectory: "writes" | "reads";
  /**
   * Subagent authority (ADR-0067 D6), read by the subagent write guard
   * (`pre-tool-use/subagent-authority-operations.ts`). `read-only`: a subagent
   * may run it. `parent-only`: it moves audit authority and is the parent's
   * alone.
   */
  subagent: "read-only" | "parent-only";
}>;

/** Declared in the order a run performs them: `SECURITY_AUDIT_OPERATION_ORDER`
 *  (and so the usage line) is this table's key order. */
export const SECURITY_AUDIT_OPERATIONS = Object.freeze({
  /** Freeze the revision, seed the coverage ledger, select lenses. */
  start: Object.freeze({ input: "stdin", runtimeSkew: "handshake-required", runDirectory: "writes", subagent: "parent-only" }),
  /** Give a planned unit to a hunter for a wave. */
  assign: Object.freeze({ input: "flags", runtimeSkew: "handshake-required", runDirectory: "writes", subagent: "parent-only" }),
  /** Print the sandbox nonce and bounded-run instructions for one artifact of a
   *  unit in flight. Derived from the ledger; writes nothing. */
  nonce: Object.freeze({ input: "flags", runtimeSkew: "available", runDirectory: "reads", subagent: "read-only" }),
  /** Settle units with a hunter's results and record its candidate findings. */
  submit: Object.freeze({ input: "stdin", runtimeSkew: "handshake-required", runDirectory: "writes", subagent: "parent-only" }),
  /** Mark a unit (or every still-planned unit) deferred, with its reason. */
  defer: Object.freeze({ input: "flags", runtimeSkew: "handshake-required", runDirectory: "writes", subagent: "parent-only" }),
  /** Fold the coverage critic's proposals, reassignments and resolutions in. */
  "merge-critic": Object.freeze({ input: "stdin", runtimeSkew: "handshake-required", runDirectory: "writes", subagent: "parent-only" }),
  /** Import a finished verification run's bound ballots (`--from`, ADR-0067).
   *  Stdin ballots are refused. Adjudication itself happens at publish. */
  verify: Object.freeze({ input: "flags", runtimeSkew: "handshake-required", runDirectory: "writes", subagent: "parent-only" }),
  /** Render the report from validated records, to stdout. Writes nothing. */
  findings: Object.freeze({ input: "flags", runtimeSkew: "available", runDirectory: "reads", subagent: "read-only" }),
  /** Adjudicate and publish `security-findings.json` plus the rendered docs. */
  publish: Object.freeze({ input: "flags", runtimeSkew: "handshake-required", runDirectory: "writes", subagent: "parent-only" }),
  /** Turn the published records into the decision set `/review-and-fix`
   *  consumes. Derived from `security-findings.json`, never authored beside it. */
  disposition: Object.freeze({ input: "flags", runtimeSkew: "handshake-required", runDirectory: "writes", subagent: "parent-only" }),
  /** Where is the run: coverage summary, blockers, settled? */
  status: Object.freeze({ input: "flags", runtimeSkew: "available", runDirectory: "reads", subagent: "read-only" }),
} as const satisfies Readonly<Record<string, SecurityAuditOperationTraits>>);

export type SecurityAuditOperation = keyof typeof SECURITY_AUDIT_OPERATIONS;

/** Whether the operation writes anything under the run directory — the helper
 *  prepares (creates) the directory only for these, so a read-only projection
 *  never creates the run it was asked to read. */
export const securityAuditOperationWrites = (operation: SecurityAuditOperation): boolean =>
  SECURITY_AUDIT_OPERATIONS[operation].runDirectory === "writes";

/** The operation an argument names, or null when it names none. */
export function parseSecurityAuditOperation(value: string | undefined): SecurityAuditOperation | null {
  return value !== undefined && Object.hasOwn(SECURITY_AUDIT_OPERATIONS, value)
    ? value as SecurityAuditOperation
    : null;
}

/** The action set, in the order a run performs it — the order the helper's
 *  usage line lists them in. Derived from the table, which declares the
 *  operations in exactly that order, so no second list can omit one. */
export const SECURITY_AUDIT_OPERATION_ORDER: readonly SecurityAuditOperation[] =
  Object.freeze(Object.keys(SECURITY_AUDIT_OPERATIONS) as SecurityAuditOperation[]);
