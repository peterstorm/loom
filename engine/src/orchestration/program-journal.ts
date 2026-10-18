/**
 * The Run Directory's program event record: the durable format of one journal
 * entry and the parser that admits stored bytes as one.
 *
 * Programs persist by appending these records through `RunDirHandle` and
 * writing a checkpoint projection beside them. A checkpoint never outranks its
 * log: whoever reads one back replays it against the events (ADR-0029).
 */

export const PROGRAM_JOURNAL_SCHEMA_VERSION = 1;

/** A durably recorded domain event. `sequence` is the append order, not a clock. */
export type ProgramEventRecord = Readonly<{
  schemaVersion: typeof PROGRAM_JOURNAL_SCHEMA_VERSION;
  sequence: number;
  dedupKey: string;
  recordedAtMs: number;
  event: unknown;
}>;

/** Parses one stored event, naming `source` when its bytes break the record contract. */
export function parseProgramEventRecord(raw: unknown, source: string): ProgramEventRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Corrupt program event ${source}: not an object`);
  }
  const record = raw as Record<string, unknown>;
  if (record["schemaVersion"] !== PROGRAM_JOURNAL_SCHEMA_VERSION ||
      typeof record["sequence"] !== "number" || !Number.isInteger(record["sequence"]) || record["sequence"] < 0 ||
      typeof record["dedupKey"] !== "string" || !/^[A-Za-z0-9:_-]{1,256}$/.test(record["dedupKey"]) ||
      typeof record["recordedAtMs"] !== "number" || !Number.isFinite(record["recordedAtMs"]) ||
      !("event" in record)) {
    throw new Error(`Corrupt program event ${source}: field contract violated`);
  }
  return Object.freeze({
    schemaVersion: PROGRAM_JOURNAL_SCHEMA_VERSION,
    sequence: record["sequence"],
    dedupKey: record["dedupKey"],
    recordedAtMs: record["recordedAtMs"],
    event: record["event"],
  });
}
