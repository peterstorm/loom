import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArtifactDigest } from "../core/orchestration-contract";
import type {
  WaveSpecCheckDocumentAuthority,
  WaveSpecCheckDocumentsAuthority,
} from "../types";

function observeDocument(path: string | null): WaveSpecCheckDocumentAuthority {
  if (path === null) return Object.freeze({ path: null, contentDigest: null });
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new Error(
      `cannot read Wave spec-check document ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const digest = parseArtifactDigest(createHash("sha256").update(bytes).digest("hex"));
  if (!digest.ok) throw new Error(digest.error.message);
  return Object.freeze({ path, contentDigest: digest.value });
}

/** Imperative-shell byte observation. Call before entering any TaskGraph lock. */
export function observeWaveSpecCheckDocuments(
  specFile: string | null,
  planFile: string | null,
): WaveSpecCheckDocumentsAuthority {
  return Object.freeze({
    spec: observeDocument(specFile),
    plan: observeDocument(planFile),
  });
}
