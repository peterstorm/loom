import { parseReservedSlot, type ReservedSlot, type ReservedSlotClaims } from "../../../pi/reserved-slot";

/**
 * The role claims a spawn producer makes for one slot: every role authority
 * present, `null` unless the test supplies one.
 */
export const slotClaims = (
  fields: Pick<ReservedSlotClaims, "agentType" | "taskId"> & Partial<ReservedSlotClaims>,
): ReservedSlotClaims => Object.freeze({
  implementationAuthority: null,
  reviewAuthority: null,
  specCheckAuthority: null,
  ...fields,
});

/**
 * A reserved slot exactly as the spawn producer builds it — parsed through the
 * production constructor, so a fixture can never hold a slot production could
 * not reserve. Contradictory claims throw.
 */
export const slot = (
  fields: Pick<ReservedSlotClaims, "agentType" | "taskId"> & Partial<ReservedSlotClaims>,
): ReservedSlot => {
  const parsed = parseReservedSlot(slotClaims(fields));
  if (!parsed.ok) throw new Error(`fixture slot is not reservable: ${parsed.error}`);
  return parsed.value;
};
