import { describe, expect, it } from "vitest";
import { issueEmissionBinding } from "../../src/core/emission-tool";
import { EMISSION_DESCRIPTOR_MARKER, parseEmissionDescriptor } from "../../src/core/issued-emission-capability";

const REQUEST_ID = "request:vocabulary";
const CONTEXT_DIGEST = "c".repeat(64);

describe("the issued-binding mint parses untrusted kind and version strings itself", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "refuses the inherited prototype name %s as an unknown producer kind instead of reading it as a spec cell",
    (kind) => {
      const minted = issueEmissionBinding({ requestId: REQUEST_ID, kind, version: "v1" });
      expect(minted.ok).toBe(false);
      if (!minted.ok) expect(minted.error.code).toBe("unknown-producer-kind");
    },
  );

  it("accepts plain strings and refines nothing the registry did not certify", () => {
    const untrustedKind: string = "judge-verdict";
    const minted = issueEmissionBinding({ requestId: REQUEST_ID, kind: untrustedKind, version: "v1" });
    expect(minted.ok).toBe(true);
    if (minted.ok) expect([minted.value.kind.kind, minted.value.version]).toEqual(["judge-verdict", "v1"]);
  });

  it("keeps the vocabulary check before the kind check", () => {
    const minted = issueEmissionBinding({ requestId: REQUEST_ID, kind: "constructor", version: "v9" });
    expect(minted.ok).toBe(false);
    if (!minted.ok) expect(minted.error.code).toBe("unsupported-schema-version");
  });
});

describe("the emission descriptor parse is total over prototype-name kinds", () => {
  it("refuses a descriptor naming an inherited prototype member as its kind", () => {
    const task = `${EMISSION_DESCRIPTOR_MARKER}: loom_emit_judge_verdict constructor v1 ${REQUEST_ID} ${CONTEXT_DIGEST} ${"a".repeat(64)}\n`;
    const parsed = parseEmissionDescriptor(task);
    expect(parsed).toMatchObject({ kind: "malformed", code: "unknown-producer-kind" });
  });
});
