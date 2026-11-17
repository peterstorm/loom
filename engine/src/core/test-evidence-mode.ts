/**
 * The shape of a TaskGraph's frozen test-evidence mode (loom#198): the
 * `test_evidence` field `types.ts` declares. A leaf with no imports, so the
 * TaskGraph type can name it without depending on the module that parses and
 * adopts it (`test-evidence-authority.ts`), which itself reads the TaskGraph.
 */

/** Who froze the engine-run mode: population, or the operator with the reason they gave. */
export type TestEvidenceAdoption =
  | Readonly<{ adoptedBy: "population" }>
  | Readonly<{ adoptedBy: "operator"; reason: string }>;

export type EngineRunTestEvidence = Readonly<{
  kind: "engine-run";
  /** The frozen manifest this mode was adopted under; it must stay the graph's. */
  manifestDigest: string;
}> & TestEvidenceAdoption;
