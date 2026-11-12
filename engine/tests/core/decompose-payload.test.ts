import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DECOMPOSE_FIELDS,
  parseDecomposeEnvelope,
  parseDecomposeInput,
  type DecomposeInput,
  type DecomposeParse,
} from "../../src/core/decompose-payload";
import type { AuthoredTask } from "../../src/core/task-graph-population";

const required = { kind: "required" } as const;
const requirement = <Reason extends string>(reason: Reason) =>
  fc.constantFrom(required, { kind: "waived", reason } as const);

const strings = fc.array(fc.string(), { maxLength: 3 });

const authoredTask: fc.Arbitrary<AuthoredTask> = fc.record(
  {
    id: fc.string({ minLength: 1 }),
    description: fc.string(),
    agent: fc.string(),
    wave: fc.integer({ min: 1, max: 9 }),
    depends_on: strings,
    spec_anchors: strings,
    spec_contributions: strings,
    plan_context: fc.string(),
    verification_policy: fc.record({
      regression: requirement("documentation-only"),
      new_tests: requirement("documentation-only"),
    }),
    file_list: strings,
  },
  { requiredKeys: ["id", "description", "agent", "wave", "depends_on", "verification_policy", "file_list"] },
);

const decomposeInput: fc.Arbitrary<DecomposeInput> = fc.record(
  {
    plan_title: fc.string(),
    plan_file: fc.string(),
    spec_file: fc.string(),
    tasks: fc.tuple(authoredTask, fc.array(authoredTask, { maxLength: 3 })).map(([first, rest]) => [first, ...rest] as const),
  },
  { requiredKeys: ["plan_title", "tasks"] },
);

const wireOf = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/** Both steps over one wire value, as `populate-task-graph` runs them. */
function decode(wire: unknown): DecomposeParse<DecomposeInput> {
  const envelope = parseDecomposeEnvelope(wire);
  return envelope.ok ? parseDecomposeInput(envelope.value) : envelope;
}

/** One Task field replaced, in the first Task of a payload. */
const withFirstTask = (input: DecomposeInput, patch: Readonly<Record<string, unknown>>): unknown =>
  wireOf({ ...input, tasks: [{ ...input.tasks[0], ...patch }, ...input.tasks.slice(1)] });

describe("parseDecomposeEnvelope", () => {
  it("admits every valid payload unchanged", () => {
    fc.assert(fc.property(decomposeInput, (input) => {
      const wire = wireOf({ spec_trace_version: 2, ...input });
      expect(parseDecomposeEnvelope(wire)).toEqual({ ok: true, value: wire });
    }));
  });

  it("refuses every JSON value that is not an object", () => {
    fc.assert(fc.property(fc.jsonValue().filter((value) => typeof value !== "object" || value === null || Array.isArray(value)), (value) => {
      expect(parseDecomposeEnvelope(value)).toEqual({ ok: false, error: "Decompose JSON must be an object" });
    }));
  });

  it("refuses any field outside the decompose contract, naming each in order", () => {
    const foreign = fc.uniqueArray(fc.string({ minLength: 1 }).filter((field) => !DECOMPOSE_FIELDS.includes(field) && field !== "__proto__"), { minLength: 1, maxLength: 3 });
    fc.assert(fc.property(decomposeInput, foreign, (input, fields) => {
      const wire = wireOf({ ...input, ...Object.fromEntries(fields.map((field) => [field, true])) });
      expect(parseDecomposeEnvelope(wire)).toEqual({
        ok: false,
        error: `Decompose JSON contains unsupported field(s): ${[...fields].sort().join(", ")}`,
      });
    }));
  });

  it("refuses a payload with no Task", () => {
    fc.assert(fc.property(decomposeInput, fc.constantFrom<unknown>([], undefined, null, "T1", {}), (input, tasks) => {
      expect(parseDecomposeEnvelope(wireOf({ ...input, tasks }))).toEqual({ ok: false, error: "No tasks in decompose JSON" });
    }));
  });
});

describe("parseDecomposeInput", () => {
  it("round-trips every valid input through its wire form", () => {
    fc.assert(fc.property(decomposeInput, (input) => {
      expect(decode(wireOf(input))).toEqual({ ok: true, value: wireOf(input) });
    }));
  });

  it("carries only the authored fields of a Task", () => {
    const executionState = {
      status: "completed",
      review_status: "passed",
      test_result: { verdict: "trusted-pass" },
      findings: [{ id: "F1" }],
    };
    fc.assert(fc.property(decomposeInput, (input) => {
      const forged = wireOf({ ...input, tasks: input.tasks.map((task) => ({ ...task, ...executionState })) });
      expect(decode(forged)).toEqual({ ok: true, value: wireOf(input) });
    }));
  });

  it("reads an absent or null depends_on as no dependency", () => {
    fc.assert(fc.property(decomposeInput, fc.constantFrom(undefined, null), (input, dependsOn) => {
      const decoded = decode(withFirstTask(input, { depends_on: dependsOn }));
      expect(decoded.ok && decoded.value.tasks[0].depends_on).toEqual([]);
    }));
  });

  it("refuses a Task field of the wrong type", () => {
    const wrongField = fc.constantFrom<readonly [string, unknown]>(
      ["id", 7],
      ["id", ""],
      ["description", null],
      ["agent", ["code-implementer-agent"]],
      ["wave", "1"],
      ["depends_on", "T1"],
      ["depends_on", [1]],
      ["spec_anchors", "FR-001"],
      ["spec_contributions", [null]],
      ["plan_context", 7],
      ["verification_policy", null],
      ["verification_policy", { regression: required }],
      ["verification_policy", { regression: required, new_tests: { kind: "waived", reason: "legacy-new-tests-required-false" } }],
      ["file_list", "src/a.ts"],
      ["file_list", [7]],
    );
    fc.assert(fc.property(decomposeInput, wrongField, (input, [field, value]) => {
      expect(decode(withFirstTask(input, { [field]: value })).ok).toBe(false);
    }));
  });

  it("refuses a Task without a required field, and a Task that is not an object", () => {
    const requiredField = fc.constantFrom("id", "description", "agent", "wave", "verification_policy", "file_list");
    fc.assert(fc.property(decomposeInput, requiredField, (input, field) => {
      const { [field]: _dropped, ...rest } = input.tasks[0] as Readonly<Record<string, unknown>>;
      expect(decode(wireOf({ ...input, tasks: [rest] })).ok).toBe(false);
    }));
    fc.assert(fc.property(decomposeInput, fc.constantFrom<unknown>(null, "T1", 7, []), (input, task) => {
      expect(decode(wireOf({ ...input, tasks: [...input.tasks, task] }))).toEqual({
        ok: false,
        error: `Task [${input.tasks.length}]: must be an object`,
      });
    }));
  });

  it("refuses a top-level field of the wrong type", () => {
    const wrong = fc.constantFrom<readonly [string, unknown]>(["plan_title", 7], ["plan_title", undefined], ["plan_file", 7], ["spec_file", ["spec.md"]]);
    fc.assert(fc.property(decomposeInput, wrong, (input, [field, value]) => {
      expect(decode(wireOf({ ...input, [field]: value })).ok).toBe(false);
    }));
  });
});
