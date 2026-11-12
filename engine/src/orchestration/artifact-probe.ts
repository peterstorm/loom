/**
 * The real phase-artifact reads: the filesystem adapter of the `ArtifactProbe`
 * port (`core/validate-phase-order`). It lives here, not in a hook handler, so
 * every shell that reads a phase artifact (the phase-order gate, the plan
 * design acceptance) shares one adapter without importing another handler.
 *
 * Artifact absence only ever ADDS a block reason at the phase gate, so a false
 * "missing" cannot open it: plain `existsSync` is the correct probe for this
 * direction, unlike the protected-state read (`realPhaseOrderDeps`).
 */
import { existsSync, readFileSync } from "node:fs";
import { sha256Bytes } from "../core/digest";
import type { ArtifactProbe } from "../core/validate-phase-order";
import { findFile } from "../utils/find-file";

export const realArtifactProbe: ArtifactProbe = {
  exists: existsSync,
  readText: (path: string): string => readFileSync(path, "utf-8"),
  findFile,
  sha256: (path: string): string => sha256Bytes(readFileSync(path)),
};
