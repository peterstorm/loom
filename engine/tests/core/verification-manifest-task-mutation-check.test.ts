/**
 * ADR-0071's operator switch: the optional `taskMutationCheck` key of a
 * schema-2 verification manifest. It moves in lockstep through every form the
 * manifest takes: parsed strictly from the source, frozen only when declared,
 * covered by the manifest digest only when declared, refused on the engine
 * default, and read as `on` when absent.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  defaultVerificationManifest,
  freezeVerificationManifest,
  legacyDefaultVerificationManifest,
  parseFrozenVerificationManifest,
  parseVerificationManifest,
  TASK_MUTATION_CHECK_SETTINGS,
  taskMutationCheckSetting,
  type TaskMutationCheckSetting,
} from "../../src/core/verification-manifest";

type Declaration = TaskMutationCheckSetting | undefined;

const KEY = "taskMutationCheck";
const MUST_BE_A_SETTING = 'must be one of "on", "off"';
const DIGEST_MISMATCH = "frozenVerificationManifest.manifestDigest does not match its canonical authority";

/** An operator manifest that declares `setting`, or declares none. */
const operatorManifest = (setting: unknown = undefined): Record<string, unknown> =>
  ({ schemaVersion: 2, kind: "loom-verification-manifest", checks: [], ...(setting === undefined ? {} : { [KEY]: setting }) });

/** The frozen form of an operator manifest, as a TaskGraph stores it. */
function storedForm(setting: Declaration): Record<string, unknown> {
  const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify(operatorManifest(setting))));
  if (!frozen.ok) throw new Error(frozen.error.errors.join("; "));
  const stored: unknown = JSON.parse(JSON.stringify(frozen.value));
  if (typeof stored !== "object" || stored === null) throw new Error("a frozen manifest serializes to an object");
  return { ...stored };
}

/** What re-reading a stored form says: its switch, or the refusals. */
function reread(stored: Record<string, unknown>): TaskMutationCheckSetting | readonly string[] {
  const parsed = parseFrozenVerificationManifest(stored);
  return parsed.ok ? taskMutationCheckSetting(parsed.value) : parsed.error.errors;
}

describe("taskMutationCheck through the manifest's forms", () => {
  it.each(TASK_MUTATION_CHECK_SETTINGS)("a declared %s is parsed, frozen, stored and read back as itself", (setting) => {
    const source = parseVerificationManifest(operatorManifest(setting));
    expect(source.ok && source.value.taskMutationCheck).toBe(setting);
    const stored = storedForm(setting);
    expect(stored[KEY]).toBe(setting);
    expect(reread(stored)).toBe(setting);
  });

  it("an undeclared switch is carried by no form and reads as on", () => {
    const source = parseVerificationManifest(operatorManifest());
    expect(source.ok && KEY in source.value).toBe(false);
    expect(KEY in storedForm(undefined)).toBe(false);
    expect(reread(storedForm(undefined))).toBe("on");
    for (const manifest of [defaultVerificationManifest(), legacyDefaultVerificationManifest(), undefined]) {
      expect(taskMutationCheckSetting(manifest)).toBe("on");
    }
    expect(KEY in defaultVerificationManifest()).toBe(false);
  });

  it.each([true, "auto", "Off", null, 0, { kind: "off" }])("the source refuses %j", (setting) => {
    const parsed = parseVerificationManifest(operatorManifest(setting));
    expect(parsed.ok ? [] : parsed.error.errors).toEqual([`verificationManifest.${KEY} ${MUST_BE_A_SETTING}`]);
  });

  it("is a schema-2 key: a schema-1 manifest refuses it", () => {
    const parsed = parseVerificationManifest({ ...operatorManifest("off"), schemaVersion: 1 });
    expect(parsed.ok ? "" : parsed.error.errors.join("\n")).toContain(KEY);
  });

  it("the digest covers a declared switch: a stored form whose switch was flipped, dropped or added is refused", () => {
    const { [KEY]: _declared, ...dropped } = storedForm("off");
    expect(reread({ ...storedForm("off"), [KEY]: "on" })).toEqual([DIGEST_MISMATCH]);
    expect(reread(dropped)).toEqual([DIGEST_MISMATCH]);
    expect(reread({ ...storedForm(undefined), [KEY]: "off" })).toEqual([DIGEST_MISMATCH]);
  });

  it("a stored form refuses a switch outside the two, and any switch on the engine default", () => {
    expect(reread({ ...storedForm("off"), [KEY]: "never" })).toContain(`frozenVerificationManifest.${KEY} ${MUST_BE_A_SETTING}`);
    const onDefault: unknown = JSON.parse(JSON.stringify(defaultVerificationManifest()));
    expect(reread({ ...(typeof onDefault === "object" ? onDefault : {}), [KEY]: "off" }))
      .toContain(`frozenVerificationManifest engine-default source cannot carry a ${KEY} setting`);
  });

  it("property: two manifests share a digest exactly when they declare the same switch, and each stored form re-reads as declared", () => {
    const declaration = fc.option(fc.constantFrom(...TASK_MUTATION_CHECK_SETTINGS), { nil: undefined });
    fc.assert(fc.property(declaration, declaration, (left, right) => {
      const [a, b] = [storedForm(left), storedForm(right)];
      expect(a.manifestDigest === b.manifestDigest).toBe(left === right);
      expect(reread(a)).toBe(left ?? "on");
    }));
  });

  it("is independent of the distillPass switch: declaring both freezes both", () => {
    const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({ ...operatorManifest("off"), distillPass: "off" })));
    expect(frozen.ok && [frozen.value.taskMutationCheck, frozen.value.distillPass]).toEqual(["off", "off"]);
  });
});
