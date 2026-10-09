/**
 * The shell step of Refutation Panel verifier preparation: read the panel's
 * record, then let the pure decision (`core/refutation-verifiers.ts`) read it
 * back as history or mint it from today's catalog (ADR-0023).
 *
 * One policy for every program: a panel the program checkpointed is its
 * record; otherwise the attempt-1 batch receipt, when one was published, is;
 * otherwise the panel has none. A caller states which checkpoint it holds —
 * there is no default — so the policy cannot be bypassed by omission; each
 * call site says why it holds the checkpoint it passes.
 */
import {
  decideRefutationVerifiers,
  refutationVerifierRequestIds,
  type RefutationPanelRecord,
  type RefutationVerifierPlan,
  type RefutationVerifierPreparation,
} from '../../../core/refutation-verifiers';
import type { RefutationPanelAuthority } from '../../../core/panel-authority';
import type { RunDirHandle } from '../../../orchestration/run-directory-handle';
import { durablePublishedReceipt, refutationBatchEffectId } from './durable-requests';

/** Where a panel's attempt-1 batch is published, and the panel the program checkpointed (`null` when it holds none). */
export type RefutationPanelSource = Readonly<{
  handle: RunDirHandle;
  /** The durable effect label the attempt-1 batch is published under. */
  label: string;
  checkpointed: RefutationPanelAuthority | null;
}>;

/**
 * Read the panel's record: the checkpointed panel when the program holds one,
 * else the requests its attempt-1 batch receipt published, else none. A
 * receipt that cannot be read throws: the record exists but is unknowable,
 * and minting over it would issue a second, different panel.
 */
function readRefutationPanelRecord(source: RefutationPanelSource, plan: RefutationVerifierPlan): RefutationPanelRecord {
  if (source.checkpointed !== null) return Object.freeze({ kind: "checkpointed-panel", panel: source.checkpointed });
  const requestIds = refutationVerifierRequestIds(plan);
  if (!requestIds.ok) throw new Error(requestIds.error.message);
  const effectId = refutationBatchEffectId(source.label, requestIds.value);
  if (!effectId.ok) throw new Error(effectId.error.message);
  const receipt = durablePublishedReceipt(source.handle, effectId.value);
  if (receipt.kind === "corrupt") throw new Error(receipt.message);
  return receipt.kind === "absent"
    ? Object.freeze({ kind: "none" })
    : Object.freeze({ kind: "receipt-requests", requests: Object.freeze(receipt.receipt.issuedRequests.map(({ authority }) => authority)) });
}

/**
 * Prepare a refutation panel's verifier requests for the run `source.handle`
 * names. Throws on a refusal, as the programs' preparation always has for an
 * authority it cannot build; the decision itself returns it as data.
 */
export function prepareRefutationVerifiers(
  source: RefutationPanelSource,
  panel: Omit<RefutationVerifierPlan, "runId">,
): RefutationVerifierPreparation {
  const plan: RefutationVerifierPlan = { ...panel, runId: source.handle.runId };
  const prepared = decideRefutationVerifiers(plan, readRefutationPanelRecord(source, plan));
  if (!prepared.ok) throw new Error(prepared.error.message);
  return prepared.value;
}
