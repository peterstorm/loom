/**
 * Exact own-data snapshots of untrusted JSON-shaped values.
 *
 * Durable panel authority, events, checkpoints and verdict-source records are
 * read back from disk, so every field is inspected through property
 * descriptors rather than ordinary reads: a getter, a foreign prototype, a
 * symbol key or a sparse/oversized array refuses as `null` instead of running
 * code or admitting a value the JSON form could never have carried. The
 * snapshot is frozen and detached from its input.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

export function safeArray(raw: unknown): readonly unknown[] | null {
  try {
    if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(raw, "length");
    if (length === undefined || !("value" in length) || !Number.isSafeInteger(length.value) ||
        length.value < 0 || length.value > 65_536) return null;
    const keys = Reflect.ownKeys(raw);
    if (keys.length !== length.value + 1 || keys[length.value] !== "length") return null;
    const values: unknown[] = [];
    for (let index = 0; index < length.value; index++) {
      if (keys[index] !== String(index)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return null;
      values.push(descriptor.value);
    }
    return Object.freeze(values);
  } catch {
    return null;
  }
}

export function safeRecord(
  raw: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(raw);
    if (keys.some((key) => typeof key !== "string") ||
        (keys as string[]).some((key) => !fields.includes(key))) return null;
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return null;
      Object.defineProperty(snapshot, key, { value: descriptor.value, enumerable: true });
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}
