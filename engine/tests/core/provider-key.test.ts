/**
 * The provider-key core (`core/provider-key.ts`): Pi's precedence for a
 * custom provider's key (a stored `auth.json` credential, else the
 * `models.json` `apiKey`, never both), the header-value guard, and the
 * scrubbing invariant — no form of a key survives in a text that leaves the
 * shell.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isHeaderValue, overlaidEnvironment, planProviderKey, scrubSecret } from "../../src/core/provider-key";

describe("Pi's precedence for a custom provider's key", () => {
  it("takes a stored api_key credential over the models.json apiKey, with the entry's env as overlay", () => {
    expect(planProviderKey({ type: "api_key", key: "$KEY", env: { KEY: "stored" } }, "sk-models")).toEqual({
      kind: "resolve",
      source: "auth-json",
      reference: { kind: "template", parts: [{ kind: "env", name: "KEY" }] },
      overlay: { KEY: "stored" },
    });
  });

  it("sends no key for a stored credential without one, and never falls back to models.json", () => {
    expect(planProviderKey({ type: "oauth" }, "sk-models"))
      .toEqual({ kind: "unusable", key: { kind: "stored-credential-keyless", credential: "oauth" } });
    expect(planProviderKey({ type: "api_key", key: null, env: {} }, "sk-models"))
      .toEqual({ kind: "unusable", key: { kind: "stored-credential-keyless", credential: "api_key" } });
    expect(planProviderKey({ type: "api_key", key: "", env: {} }, "sk-models"))
      .toEqual({ kind: "unusable", key: { kind: "stored-credential-keyless", credential: "api_key" } });
  });

  it("takes the models.json apiKey when nothing is stored, and no key when neither file holds one", () => {
    expect(planProviderKey(null, "!pass show vllm"))
      .toEqual({ kind: "resolve", source: "models-json", reference: { kind: "command", command: "pass show vllm" }, overlay: {} });
    expect(planProviderKey(null, null)).toEqual({ kind: "unusable", key: { kind: "absent" } });
  });

  it("reads an overlay's non-empty values before the environment, as Pi does", () => {
    expect(overlaidEnvironment({ A: "env-a", B: "env-b" }, { A: "stored-a", B: "" })).toEqual({ A: "stored-a", B: "env-b" });
  });
});

describe("the header-value guard", () => {
  it("accepts a one-line key and refuses empty, multi-line, control and non-Latin-1 values", () => {
    expect(isHeaderValue("sk-SECRET 123\t~")).toBe(true);
    expect(isHeaderValue("café")).toBe(true);
    for (const value of ["", "sk-a\nsk-b", "sk-a\r\n", "sk\u0000", "sk\u0007", "sk\u007f", "sk-€"]) {
      expect(isHeaderValue(value)).toBe(false);
    }
  });

  it("accepts exactly the strings of tab, printable ASCII and Latin-1", () => {
    const allowed = fc.constantFrom(..."\t !~\u0080ÿ aZ09".split(""));
    fc.assert(fc.property(fc.string({ unit: allowed, minLength: 1 }), (value) => isHeaderValue(value)));
    fc.assert(fc.property(
      fc.string(), fc.constantFrom("\n", "\r", "\u0000", "\u001f", "\u007f", "Ā", "\u{1F600}"), fc.string(),
      (before, bad, after) => !isHeaderValue(before + bad + after),
    ));
  });
});

describe("scrubbing a key out of a text", () => {
  it("removes the key, its JSON-escaped and percent-encoded forms, and each line of a multi-line key", () => {
    const key = "sk-a\"b/c\nline-two";
    const text = `invalid header "Bearer ${key}" ${JSON.stringify(key)} ${encodeURIComponent(key)} …line-two…`;
    const scrubbed = scrubSecret(text, key);
    for (const form of [key, JSON.stringify(key).slice(1, -1), encodeURIComponent(key), "line-two", "sk-a\"b/c"]) {
      expect(scrubbed).not.toContain(form);
    }
    expect(scrubbed).toContain("invalid header");
  });

  it("leaves a text without the key as it is", () => {
    expect(scrubSecret("connect ECONNREFUSED 127.0.0.1:9", "sk-SECRET")).toBe("connect ECONNREFUSED 127.0.0.1:9");
    expect(scrubSecret("anything", "")).toBe("anything");
  });

  it("removes a key the marker or its surroundings would splice back together", () => {
    expect(scrubSecret("x***y***", "y***")).not.toContain("y***");
    expect(scrubSecret("aaaaaaaa", "aaaa")).not.toContain("aaaa");
    expect(scrubSecret("xab", "ab")).not.toContain("ab");
  });

  it("never leaves the key in any text it is woven into", () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1, maxLength: 24 }),
      fc.array(fc.string({ maxLength: 12 }), { minLength: 1, maxLength: 5 }),
      (key, pieces) => {
        const text = pieces.join(key) + key + JSON.stringify(key) + encodeURIComponent(key);
        const scrubbed = scrubSecret(text, key);
        expect(scrubbed).not.toContain(key);
        for (const line of key.split(/[\r\n]+/).filter((piece) => piece.length >= 4)) expect(scrubbed).not.toContain(line);
      },
    ), { numRuns: 500 });
  });
});
