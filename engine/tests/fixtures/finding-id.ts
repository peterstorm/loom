import { parseFindingId, type FindingId } from "../../src/core/findings";

/**
 * Mint a fixture `FindingId` through its sole smart constructor,
 * `parseFindingId`, so tests never forge the brand with a cast. A malformed
 * fixture id is a broken test, so it throws rather than returning null.
 */
export function findingId(raw: string): FindingId {
  const id = parseFindingId(raw);
  if (id === null) throw new Error(`fixture Finding id is not a task-local Finding ID: ${JSON.stringify(raw)}`);
  return id;
}
