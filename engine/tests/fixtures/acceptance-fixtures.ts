import { sha256Hex } from "../../src/core/digest";
import { parseArtifactDigest, type ArtifactDigest } from "../../src/core/orchestration-contract";
import type { FrozenPathObservation } from "../../src/core/acceptance-contract";

/** A sha256 digest of one repeated hex character, minted by the real parser. */
export function digest(fill: string): ArtifactDigest {
  const parsed = parseArtifactDigest(fill.repeat(64));
  if (!parsed.ok) throw new Error(`fixture digest '${fill}' must parse`);
  return parsed.value;
}

/** The sha256 digest of some text, as the engine hashes file bytes. */
export function contentDigest(text: string): ArtifactDigest {
  const parsed = parseArtifactDigest(sha256Hex(text));
  if (!parsed.ok) throw new Error("content digest must parse");
  return parsed.value;
}

/** A frozen path the shell read and digested. */
export const seen = (sha256: ArtifactDigest): FrozenPathObservation => ({ kind: "digest", sha256 });
