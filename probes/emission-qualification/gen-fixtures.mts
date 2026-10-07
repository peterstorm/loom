/**
 * FR-002 qualification fixtures — the writer. Derives the manifest from the
 * real zod schemas and the frozen registry (`fixture-manifest.mts`, where
 * every detector is pinned before anything is written) and writes it.
 *
 * Run: npx tsx probes/emission-qualification/gen-fixtures.mts (or bun)
 * Writes: probes/emission-qualification/fixtures/manifest.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildManifest, MANIFEST_PATH, renderManifest } from "./fixture-manifest.mts";

const manifest = buildManifest();
mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
writeFileSync(MANIFEST_PATH, renderManifest(manifest));
console.log(`wrote ${manifest.length} fixtures to fixtures/manifest.json`);
for (const entry of manifest) {
  console.log(`  ${entry.registeredToolName}: schema ${(entry.schemaBytes.length / 1024).toFixed(1)}KB digest ${entry.schemaDigest.slice(0, 16)}…`);
}
