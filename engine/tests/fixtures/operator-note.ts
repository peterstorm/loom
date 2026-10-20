import { parseOperatorNote, type OperatorNote } from "../../src/core/implementation-brief";

/** An operator note the production parser admits; a fixture text it refuses fails the test that wrote it. */
export function admittedNote(text: string): OperatorNote {
  const parsed = parseOperatorNote(text);
  if (!parsed.ok) throw new Error(`fixture operator note refused: ${parsed.error}`);
  return parsed.value;
}
