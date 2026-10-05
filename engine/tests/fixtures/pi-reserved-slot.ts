import type { ReservedSlotRecord } from "../../../pi/reserved-slot";

/**
 * A stored Pi reservation exactly as the extension writes it: every role
 * authority present, `null` unless the test supplies one.
 */
export const slot = (
  fields: Pick<ReservedSlotRecord, "agentType" | "taskId"> & Partial<ReservedSlotRecord>,
): ReservedSlotRecord => Object.freeze({
  implementationAuthority: null,
  reviewAuthority: null,
  specCheckAuthority: null,
  ...fields,
});
