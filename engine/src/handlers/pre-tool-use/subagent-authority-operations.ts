/**
 * The authority helpers' operations, split by the trait each operation table
 * already declares (ADR-0065 D6): a `runtimeSkew: "available"` operation is a
 * read-only projection a subagent may run; every other operation writes run
 * state and is the parent's alone. Derived, never copied, so an operation added
 * to either table is classified by the trait it is forced to declare.
 *
 * Lives beside the guard rather than in core because core may not import the
 * handler operation tables; both harness adapters pass this to
 * `decideSubagentAuthority`. Pure data.
 */

import type { AuthorityHelperOperations, HelperOperationSplit } from "../../core/subagent-authority";
import { ORCHESTRATION_OPERATIONS } from "../helpers/orchestration-operations";
import { SECURITY_AUDIT_OPERATIONS } from "../helpers/security-audit-operations";
import { KNOWN_HANDLERS } from "../../handler-routes";

type SkewTraits = Readonly<Record<string, Readonly<{ runtimeSkew: "available" | "handshake-required" }>>>;

const splitByRuntimeSkew = (table: SkewTraits): HelperOperationSplit => Object.freeze({
  known: new Set(Object.keys(table)),
  readOnly: new Set(Object.entries(table).filter(([, traits]) => traits.runtimeSkew === "available").map(([name]) => name)),
});

export const AUTHORITY_HELPER_OPERATIONS: AuthorityHelperOperations = Object.freeze({
  "security-audit": splitByRuntimeSkew(SECURITY_AUDIT_OPERATIONS),
  orchestration: splitByRuntimeSkew(ORCHESTRATION_OPERATIONS),
});

/** The CLI's harness-hook route families (every top-level route but
 *  `helper`): a subagent invoking one would be forging a harness event. */
export const HARNESS_HOOK_ROUTES: ReadonlySet<string> =
  Object.freeze(new Set(Object.keys(KNOWN_HANDLERS).filter((route) => route !== "helper")));
