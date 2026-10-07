import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  collectDenseArray,
  exactRecordErrors,
  hasExactKeys,
  isPlainRecord,
  isRecord,
  parseExactRecord,
  toElementResult,
  type ElementResult,
} from "../../src/core/plain-record";

const key = fc.string({ maxLength: 8 });
const fieldList = fc.uniqueArray(key, { maxLength: 6 });
const recordOf = (keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(keys.map((name, index) => [name, index]));

class Instance {
  readonly field = 1;
}

const nonPlainObjects: readonly [string, () => unknown][] = [
  ["class instance", () => new Instance()],
  ["foreign prototype", () => Object.create({ inherited: true })],
  ["Map", () => new Map()],
  ["Date", () => new Date(0)],
  ["boxed string", () => new String("x")],
];

describe("isRecord / isPlainRecord", () => {
  it("never admits null, arrays or primitives", () => {
    fc.assert(fc.property(
      fc.oneof(fc.constant(null), fc.constant(undefined), fc.string(), fc.double(), fc.boolean(), fc.array(fc.anything())),
      (value) => {
        expect(isRecord(value)).toBe(false);
        expect(isPlainRecord(value)).toBe(false);
      },
    ));
  });

  it("strict guard implies lax guard over arbitrary values", () => {
    fc.assert(fc.property(fc.anything({ withNullPrototype: true, withMap: true, withSet: true, withDate: true }), (value) => {
      if (isPlainRecord(value)) expect(isRecord(value)).toBe(true);
    }));
  });

  it.each(nonPlainObjects)("%s is a record but not a plain record", (_label, make) => {
    const value = make();
    expect(isRecord(value)).toBe(true);
    expect(isPlainRecord(value)).toBe(false);
  });

  it("admits Object.prototype and null-prototype records", () => {
    fc.assert(fc.property(fieldList, (keys) => {
      const nullProto = Object.assign(Object.create(null) as object, recordOf(keys));
      expect(isPlainRecord(recordOf(keys))).toBe(true);
      expect(isPlainRecord(nullProto)).toBe(true);
    }));
  });
});

describe("parseExactRecord", () => {
  it("accepts exactly the declared key set and returns the input itself", () => {
    fc.assert(fc.property(fieldList, fc.boolean(), (fields, nullPrototype) => {
      const record = nullPrototype
        ? Object.assign(Object.create(null) as object, recordOf(fields))
        : recordOf(fields);
      const parsed = parseExactRecord(record, fields, "root");
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value).toBe(record);
    }));
  });

  it("rejects any other key set with every missing field before every surplus key", () => {
    fc.assert(fc.property(fieldList, fieldList, (fields, present) => {
      const record = recordOf(present);
      const missing = fields.filter((field) => !present.includes(field)).map((field) => `root.${field} is required`);
      const surplus = Reflect.ownKeys(record)
        .filter((name) => !fields.includes(name as string))
        .map((name) => `root.${String(name)} is not allowed`);
      const parsed = parseExactRecord(record, fields, "root");
      if (missing.length === 0 && surplus.length === 0) {
        expect(parsed.ok).toBe(true);
      } else {
        expect(parsed).toEqual({ ok: false, problem: "field-mismatch", errors: [...missing, ...surplus] });
      }
    }));
  });

  it("reports symbol keys as not allowed", () => {
    const record = { kind: "x", [Symbol("hidden")]: true };
    expect(parseExactRecord(record, ["kind"], "root")).toEqual({
      ok: false,
      problem: "field-mismatch",
      errors: ["root.Symbol(hidden) is not allowed"],
    });
  });

  it("does not read inherited fields as present", () => {
    expect(parseExactRecord({}, ["toString"], "root")).toEqual({
      ok: false,
      problem: "field-mismatch",
      errors: ["root.toString is required"],
    });
  });

  it.each(nonPlainObjects)("refuses a %s as not-plain-record", (_label, make) => {
    expect(parseExactRecord(make(), [], "root")).toEqual({ ok: false, problem: "not-plain-record" });
  });

  it("refuses every non-record as not-plain-record", () => {
    fc.assert(fc.property(fc.oneof(fc.constant(null), fc.string(), fc.integer(), fc.array(fc.anything())), (value) => {
      expect(parseExactRecord(value, ["kind"], "root")).toEqual({ ok: false, problem: "not-plain-record" });
    }));
  });
});

describe("hasExactKeys", () => {
  it("agrees with the sorted own-key comparison it replaced, in any key order", () => {
    fc.assert(fc.property(fieldList, fieldList, (keys, present) => {
      const record = recordOf(present);
      const sortedJoin = JSON.stringify(Object.keys(record).sort()) === JSON.stringify([...keys].sort());
      expect(hasExactKeys(record, keys)).toBe(sortedJoin);
      expect(hasExactKeys(record, [...keys].reverse())).toBe(sortedJoin);
    }));
  });

  it("ignores inherited and symbol keys and never checks the prototype", () => {
    expect(hasExactKeys({}, ["toString"])).toBe(false);
    expect(hasExactKeys({ kind: "x", [Symbol("hidden")]: true }, ["kind"])).toBe(true);
    expect(hasExactKeys(Object.assign(Object.create({ inherited: true }) as object, { kind: "x" }), ["kind"])).toBe(true);
  });
});

const identity = (value: unknown): ElementResult<unknown> => ({ ok: true, value });

describe("collectDenseArray", () => {
  it("returns dense arrays unchanged, in order, with no diagnostics", () => {
    fc.assert(fc.property(fc.array(fc.anything()), (values) => {
      const collected = collectDenseArray(values, "items", identity);
      expect(collected).toEqual({ kind: "array", values, errors: [] });
      if (collected.kind === "array") expect(Object.isFrozen(collected.values)).toBe(true);
    }));
  });

  it("reports exactly the holes of a sparse array and keeps the present elements", () => {
    fc.assert(fc.property(fc.sparseArray(fc.integer(), { maxLength: 20 }), (sparse) => {
      const holes: string[] = [];
      const present: number[] = [];
      for (let index = 0; index < sparse.length; index += 1) {
        if (Object.prototype.hasOwnProperty.call(sparse, index)) present.push(sparse[index]!);
        else holes.push(`items[${index}] must be present`);
      }
      expect(collectDenseArray(sparse, "items", identity)).toEqual({ kind: "array", values: present, errors: holes });
    }));
  });

  it("interleaves hole and element diagnostics in index order", () => {
    fc.assert(fc.property(fc.sparseArray(fc.integer(), { maxLength: 20 }), (sparse) => {
      const parseEven = (value: unknown, path: string): ElementResult<number> =>
        typeof value === "number" && value % 2 === 0 ? { ok: true, value } : { ok: false, errors: [`${path} must be even`] };
      const expected: string[] = [];
      for (let index = 0; index < sparse.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(sparse, index)) expected.push(`items[${index}] must be present`);
        else if (sparse[index]! % 2 !== 0) expected.push(`items[${index}] must be even`);
      }
      const collected = collectDenseArray(sparse, "items", parseEven);
      expect(collected.kind === "array" ? collected.errors : null).toEqual(expected);
    }));
  });

  it("refuses non-arrays as not-array", () => {
    fc.assert(fc.property(fc.oneof(fc.constant(null), fc.string(), fc.object(), fc.integer()), (value) => {
      expect(collectDenseArray(value, "items", identity)).toEqual({ kind: "not-array" });
    }));
  });
});

describe("exactRecordErrors", () => {
  it.each([
    ["an object", "root must be an object"],
    ["a plain object", "root must be a plain object"],
  ])("renders a not-plain-record failure with the caller's noun %j", (noun, expected) => {
    const parsed = parseExactRecord(null, ["kind"], "root");
    if (parsed.ok) throw new Error("null must not parse as a record");
    expect(exactRecordErrors(parsed, "root", noun)).toEqual([expected]);
  });

  it("returns field-mismatch diagnostics unchanged, whatever the noun", () => {
    fc.assert(fc.property(fieldList, fieldList, key, (fields, present, noun) => {
      const parsed = parseExactRecord(recordOf(present), fields, "root");
      if (parsed.ok || parsed.problem !== "field-mismatch") return;
      expect(exactRecordErrors(parsed, "root", noun)).toBe(parsed.errors);
    }));
  });
});

describe("toElementResult", () => {
  it("passes a success through as the same object", () => {
    fc.assert(fc.property(fc.anything(), (value) => {
      const parsed = Object.freeze({ ok: true as const, value });
      expect(toElementResult(parsed)).toBe(parsed);
    }));
  });

  it("lifts a failure's errors into a frozen ElementResult failure", () => {
    fc.assert(fc.property(fc.array(fc.string()), (errors) => {
      const lifted = toElementResult<never>({ ok: false, error: { errors } });
      expect(lifted).toEqual({ ok: false, errors });
      expect(Object.isFrozen(lifted)).toBe(true);
      if (!lifted.ok) expect(lifted.errors).toBe(errors);
    }));
  });

  it("feeds collectDenseArray so element diagnostics surface in index order", () => {
    const parse = (value: unknown, path: string) =>
      typeof value === "number"
        ? { ok: true as const, value }
        : { ok: false as const, error: { errors: [`${path} must be a number`] } };
    expect(collectDenseArray([1, "x", 3, null], "items", (value, path) => toElementResult(parse(value, path)))).toEqual({
      kind: "array",
      values: [1, 3],
      errors: ["items[1] must be a number", "items[3] must be a number"],
    });
  });
});
