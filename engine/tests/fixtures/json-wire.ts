/**
 * The wire as the parser-under-test receives it: a value that has been through
 * JSON text, so it holds exactly what `JSON.parse` would hand over (no
 * `undefined` fields, no shared references, no prototypes beyond `Object`).
 */

import fc from "fast-check";
import { isRecord } from "../../src/core/plain-record";

/** `value` after a round trip through JSON text. */
export const wireOf = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/** Every JSON value a record parser must refuse: null, an array, or a primitive. */
export const notAJsonObject: fc.Arbitrary<fc.JsonValue> = fc.jsonValue().filter((value) => !isRecord(value));

/**
 * The one array guard test support narrows wire data through: a JSON array,
 * its entries still `unknown`. `Array.isArray` alone narrows to `any[]`, which
 * erases every entry's type at the read.
 */
export const isJsonArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);
