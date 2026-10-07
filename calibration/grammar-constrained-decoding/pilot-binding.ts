/**
 * The pilot's engine issuance for ONE attempt — PURE: the per-attempt request
 * identity and the issued binding minted for it.
 *
 * This is the one place the request-id → binding issuance rule lives. The
 * window dispatch (`pilot-window.ts`) mints through it; the live Pi adapter
 * (`pilot-dispatch.ts`) only consumes the binding it is handed, so neither
 * pure core loads the child-process adapter to issue a binding.
 */

import { issueEmissionBinding, type IssuedEmissionBindingOf } from "../../engine/src/core/emission-tool";
import { parseContextDigest } from "../../engine/src/core/orchestration-contract/identity";
import { err, ok, type Result } from "../kernel";
import { contentDigest, PILOT_CELLS, type CellKey, type PilotArm } from "./pilot-vocabulary";

/** Canonical, per-attempt request id (SAFE_AUTHORITY_ID-shaped): a fresh
 *  engine-issued identity per spawn, as attempt 2 is in production. */
export function pilotRequestId(windowId: string, pairId: string, arm: PilotArm, attempt: number): string {
  const armCode = arm === "emission-enabled" ? "em" : "ex";
  return `cal-${contentDigest(`${windowId}\0${pairId}`).slice(0, 16)}-${armCode}-a${attempt}`;
}

/** The issued binding of one attempt, path-refined by its cell's producer kind. */
export type CellBinding =
  | Readonly<{ path: "reviewer"; binding: IssuedEmissionBindingOf<"reviewer-payload">; contextDigest: string }>
  | Readonly<{ path: "verdict"; binding: IssuedEmissionBindingOf<"judge-verdict" | "refutation-verdict">; contextDigest: string }>;

/** Mint the issued binding for one attempt through the engine's one mint,
 *  `issueEmissionBinding`; the context digest is the content address of the
 *  exact prompt the child gets. */
export function mintCellBinding(cell: CellKey, requestId: string, prompt: string): Result<CellBinding, string> {
  const contextDigest = parseContextDigest(contentDigest(prompt));
  if (!contextDigest.ok) return err(contextDigest.error.message);
  const producer = PILOT_CELLS[cell];
  if (producer.kind === "reviewer-payload") {
    const minted = issueEmissionBinding({ requestId, kind: "reviewer-payload", version: producer.version });
    return minted.ok
      ? ok(Object.freeze({ path: "reviewer" as const, binding: minted.value, contextDigest: contextDigest.value }))
      : err(minted.error.message);
  }
  const minted = issueEmissionBinding({ requestId, kind: producer.kind, version: producer.version });
  return minted.ok
    ? ok(Object.freeze({ path: "verdict" as const, binding: minted.value, contextDigest: contextDigest.value }))
    : err(minted.error.message);
}
