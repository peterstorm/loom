import { parseArtifactDigest, type ArtifactDigest } from "../../src/core/orchestration-contract";
import type { FrozenPathObservation } from "../../src/core/acceptance-contract";

/** A sha256 digest of one repeated hex character, minted by the real parser. */
export function digest(fill: string): ArtifactDigest {
  const parsed = parseArtifactDigest(fill.repeat(64));
  if (!parsed.ok) throw new Error(`fixture digest '${fill}' must parse`);
  return parsed.value;
}

/** A frozen path the shell read and digested. */
export const seen = (sha256: ArtifactDigest): FrozenPathObservation => ({ kind: "digest", sha256 });
