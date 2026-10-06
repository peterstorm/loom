import { architectureCriterion, type ArchitectureCriterion } from "../../src/core/panel-contract";

/**
 * Mint a fixture `ArchitectureCriterion` through the closed interview
 * vocabulary — the same boundary the production callers mint at — so a foreign
 * or typo'd test criterion fails loudly here instead of compiling into the
 * branded criteria order. A malformed fixture is a broken test, so it throws.
 */
export function mintedCriterion(raw: string): ArchitectureCriterion {
  const criterion = architectureCriterion(raw);
  if (criterion === null) throw new Error(`test criterion is outside the validated interview vocabulary: ${JSON.stringify(raw)}`);
  return criterion;
}
