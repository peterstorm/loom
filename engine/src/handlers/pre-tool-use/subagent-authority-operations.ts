/**
 * The authority helpers' operations, split by the `subagent` trait each
 * operation table declares (ADR-0067 D6): a `read-only` operation is a
 * projection a subagent may run; a `parent-only` one moves run state and is
 * the parent's alone. Derived, never copied, and the trait is required at
 * declaration, so an operation added to either table is classified by the
 * authority it is forced to state — not by a proxy policy such as Pi runtime
 * skew.
 *
 * Lives beside the guard rather than in core because core may not import the
 * handler operation tables; both harness adapters pass this to
 * `decideSubagentAuthority`. Pure data.
 */

import type { AuthorityHelperOperations, HelperOperationSplit } from "../../core/subagent-authority";
import { ORCHESTRATION_OPERATIONS } from "../helpers/orchestration-operations";
import { SECURITY_AUDIT_OPERATIONS } from "../helpers/security-audit-operations";
import { KNOWN_HANDLERS } from "../../handler-routes";

type SubagentAuthorityTraits = Readonly<Record<string, Readonly<{ subagent: "read-only" | "parent-only" }>>>;

const splitBySubagentAuthority = (table: SubagentAuthorityTraits): HelperOperationSplit => Object.freeze({
  known: new Set(Object.keys(table)),
  readOnly: new Set(Object.entries(table).filter(([, traits]) => traits.subagent === "read-only").map(([name]) => name)),
});

export const AUTHORITY_HELPER_OPERATIONS: AuthorityHelperOperations = Object.freeze({
  "security-audit": splitBySubagentAuthority(SECURITY_AUDIT_OPERATIONS),
  orchestration: splitBySubagentAuthority(ORCHESTRATION_OPERATIONS),
});

/** The CLI's harness-hook route families (every top-level route but
 *  `helper`): a subagent invoking one would be forging a harness event. */
export const HARNESS_HOOK_ROUTES: ReadonlySet<string> =
  Object.freeze(new Set(Object.keys(KNOWN_HANDLERS).filter((route) => route !== "helper")));
