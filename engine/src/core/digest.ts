import { createHash } from "node:crypto";
import { parseArtifactDigest, type ArtifactDigest } from "./orchestration-contract/identity";

/** Deterministic SHA-256 over bytes, without an intervening text decode. */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Deterministic SHA-256 over UTF-8 text. */
export function sha256Hex(text: string): string {
  return sha256Bytes(Buffer.from(text, "utf-8"));
}

/**
 * SHA-256 over a value's `JSON.stringify` text: the content identity of an
 * engine-authored record. Key order is construction order, so callers digest
 * canonically constructed records, never caller-ordered objects.
 *
 * The brand is minted through `parseArtifactDigest`, the identity module's
 * one constructor for it, never by cast. sha256Hex always emits the digest
 * grammar, so the refusal is a constructor invariant, not an expected failure.
 */
export function canonicalDigest(value: unknown): ArtifactDigest {
  const digest = parseArtifactDigest(sha256Hex(JSON.stringify(value)));
  if (!digest.ok) throw new Error(`invariant: sha256Hex emitted a non-digest: ${digest.error.message}`);
  return digest.value;
}
