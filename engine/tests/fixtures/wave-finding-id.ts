import { parseWaveFindingId, type WaveFindingId } from "../../src/core/review-panel";

/**
 * Mint a fixture `WaveFindingId` through its parser, `parseWaveFindingId`, so
 * tests never forge the wave-scoped brand with a cast. A malformed fixture id
 * is a broken test, so it throws rather than returning null.
 */
export function waveFindingIdFixture(raw: string): WaveFindingId {
  const id = parseWaveFindingId(raw);
  if (id === null) throw new Error(`fixture wave Finding id is not task-id:finding-id: ${JSON.stringify(raw)}`);
  return id;
}
