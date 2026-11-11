/**
 * ADR-0068's operator switch: the optional `distillPass` key of a schema-2
 * verification manifest. Parsed strictly, frozen only when declared, covered
 * by the manifest digest only when declared, and read as `on` when absent.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DISTILL_PASS_SETTINGS } from "../../src/core/distill-pass-setting";
import {
  defaultVerificationManifest,
  distillPassSetting,
  freezeVerificationManifest,
  legacyDefaultVerificationManifest,
  parseFrozenVerificationManifest,
  parseVerificationManifest,
  type FrozenVerificationManifest,
} from "../../src/core/verification-manifest";

/**
 * Digests computed by the engine before this key existed: the population
 * default's, the legacy default's, and that of the operator file
 * `{"schemaVersion":2,"kind":"loom-verification-manifest","checks":[]}`.
 * Adding the key must move none of them.
 */
const PRE_FEATURE_DEFAULT_DIGEST = "a4408176dc5df5ebd1f6ad9459ea9a0f71a92b9aa8b23467fc38ed04420bbbea";
const PRE_FEATURE_LEGACY_DIGEST = "f151b9015dd8afd2c9ff94add17a86f6b5a9b0408931b31af70e9d4629823d6c";
const PRE_FEATURE_EMPTY_OPERATOR_DIGEST = "5c90251769e3af9a2d0eac4d90593921c9f699edd26723265dec762de6f191cc";

const source = (document: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  ({ schemaVersion: 2, kind: "loom-verification-manifest", checks: [], ...document });

const bytes = (document: Readonly<Record<string, unknown>>): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(source(document)));

const frozen = (document: Readonly<Record<string, unknown>>): FrozenVerificationManifest => {
  const result = freezeVerificationManifest(bytes(document));
  if (!result.ok) throw new Error(result.error.errors.join("; "));
  return result.value;
};

const refusal = (document: Readonly<Record<string, unknown>>): readonly string[] => {
  const result = parseVerificationManifest(source(document));
  return result.ok ? [] : result.error.errors;
};

const stored = (manifest: FrozenVerificationManifest): Record<string, unknown> =>
  JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;

const DIGEST_MISMATCH = "frozenVerificationManifest.manifestDigest does not match its canonical authority";

describe("distillPass in the source manifest", () => {
  it.each(DISTILL_PASS_SETTINGS)("parses and freezes a declared %s", (setting) => {
    const parsed = parseVerificationManifest(source({ distillPass: setting }));
    expect(parsed.ok && parsed.value.distillPass).toBe(setting);
    const manifest = frozen({ distillPass: setting });
    expect(manifest.distillPass).toBe(setting);
    expect(distillPassSetting(manifest)).toBe(setting);
    expect(Object.isFrozen(manifest)).toBe(true);
  });

  it("carries the key only when declared, and reads absent as on", () => {
    const parsed = parseVerificationManifest(source({}));
    expect(parsed.ok && "distillPass" in parsed.value).toBe(false);
    const manifest = frozen({});
    expect("distillPass" in manifest).toBe(false);
    expect(distillPassSetting(manifest)).toBe("on");
    expect(distillPassSetting(defaultVerificationManifest())).toBe("on");
    expect(distillPassSetting(legacyDefaultVerificationManifest())).toBe("on");
    expect(distillPassSetting(undefined)).toBe("on");
  });

  it.each([
    ["a boolean", true],
    ["another word", "auto"],
    ["a differently cased setting", "Off"],
    ["null", null],
    ["an object", { kind: "off" }],
  ])("refuses %s", (_name, distillPass) => {
    expect(refusal({ distillPass })).toEqual(['verificationManifest.distillPass must be one of "on", "off"']);
  });

  it("is a schema-2 key: schema 1 refuses it as an unknown field", () => {
    const result = parseVerificationManifest({ ...source({ distillPass: "off" }), schemaVersion: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.errors.join("\n")).toMatch(/distillPass/);
  });
});

describe("distillPass and the manifest digest", () => {
  it("leaves the engine defaults' digests where they were", () => {
    expect(defaultVerificationManifest().manifestDigest).toBe(PRE_FEATURE_DEFAULT_DIGEST);
    expect(legacyDefaultVerificationManifest().manifestDigest).toBe(PRE_FEATURE_LEGACY_DIGEST);
    expect("distillPass" in defaultVerificationManifest()).toBe(false);
  });

  it("leaves a stored manifest that declares none loading under its stored digest", () => {
    const manifest = frozen({});
    expect(manifest.manifestDigest).toBe(PRE_FEATURE_EMPTY_OPERATOR_DIGEST);
    const reloaded = parseFrozenVerificationManifest(stored(manifest));
    expect(reloaded.ok && reloaded.value.manifestDigest).toBe(manifest.manifestDigest);
    expect(reloaded.ok && "distillPass" in reloaded.value).toBe(false);
  });

  it("covers a declared setting: changing or dropping the stored key breaks the digest", () => {
    const manifest = frozen({ distillPass: "off" });
    const roundTrip = parseFrozenVerificationManifest(stored(manifest));
    expect(roundTrip.ok && roundTrip.value).toEqual(manifest);

    const flipped = parseFrozenVerificationManifest({ ...stored(manifest), distillPass: "on" });
    expect(flipped.ok ? [] : flipped.error.errors).toEqual([DIGEST_MISMATCH]);
    const { distillPass: _dropped, ...withoutKey } = stored(manifest);
    const dropped = parseFrozenVerificationManifest(withoutKey);
    expect(dropped.ok ? [] : dropped.error.errors).toEqual([DIGEST_MISMATCH]);
    const added = parseFrozenVerificationManifest({ ...stored(frozen({})), distillPass: "off" });
    expect(added.ok ? [] : added.error.errors).toEqual([DIGEST_MISMATCH]);
  });

  it("refuses a stored setting outside the two, and one on the engine default", () => {
    const bad = parseFrozenVerificationManifest({ ...stored(frozen({ distillPass: "off" })), distillPass: "never" });
    expect(bad.ok ? [] : bad.error.errors).toContain('frozenVerificationManifest.distillPass must be one of "on", "off"');
    const onDefault = parseFrozenVerificationManifest({ ...stored(defaultVerificationManifest()), distillPass: "off" });
    expect(onDefault.ok ? [] : onDefault.error.errors)
      .toContain("frozenVerificationManifest engine-default source cannot carry a distillPass setting");
  });

  it("property: parse after freeze is the identity, and the digest differs exactly when the declaration does", () => {
    const declaration = fc.option(fc.constantFrom(...DISTILL_PASS_SETTINGS), { nil: undefined });
    fc.assert(fc.property(declaration, declaration, (left, right) => {
      const document = (setting: typeof left) => (setting === undefined ? {} : { distillPass: setting });
      const [a, b] = [frozen(document(left)), frozen(document(right))];
      const reloaded = parseFrozenVerificationManifest(stored(a));
      expect(reloaded.ok && reloaded.value).toEqual(a);
      expect(a.manifestDigest === b.manifestDigest).toBe(left === right);
    }));
  });
});
