/**
 * Pi's config-value grammar (`core/pi-config-value.ts`): Loom must read a
 * provider's `apiKey` exactly as Pi does, so these cases mirror Pi's own
 * resolver: a `!` command, `$NAME` / `${NAME}` interpolation, `$$` / `$!`
 * escapes, and literal text.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseConfigValueReference, resolveTemplate, templateVariables, type ConfigValueReference } from "../../src/core/pi-config-value";

const resolved = (value: string, env: Readonly<Record<string, string | undefined>> = {}): string | null => {
  const reference: ConfigValueReference = parseConfigValueReference(value);
  if (reference.kind !== "template") throw new Error(`${value} is a command`);
  return resolveTemplate(reference.parts, env);
};

/** Escape text so Pi's grammar reads it back as that literal text. */
const asLiteral = (text: string): string => text.replaceAll("$", () => "$$").replace(/^!/, () => "$!");

describe("Pi config values", () => {
  it("reads a leading ! as a shell command, without the !", () => {
    expect(parseConfigValueReference("!pass show vllm")).toEqual({ kind: "command", command: "pass show vllm" });
  });

  it("reads plain text as a literal", () => {
    expect(resolved("sk-local-123")).toBe("sk-local-123");
  });

  it("interpolates $NAME and ${NAME} from the environment", () => {
    expect(resolved("$VLLM_KEY", { VLLM_KEY: "abc" })).toBe("abc");
    expect(resolved("Bearer-${VLLM_KEY}-x", { VLLM_KEY: "abc" })).toBe("Bearer-abc-x");
    expect(resolved("$A$B", { A: "1", B: "2" })).toBe("12");
  });

  it("leaves the value unresolved when a named variable is unset or empty", () => {
    expect(resolved("$VLLM_KEY", {})).toBeNull();
    expect(resolved("$VLLM_KEY", { VLLM_KEY: "" })).toBeNull();
    expect(resolved("x-${A}-${B}", { A: "1" })).toBeNull();
  });

  it("names every variable a template reads, once, in order", () => {
    const reference = parseConfigValueReference("${B}-$A-$B");
    if (reference.kind !== "template") throw new Error("expected a template");
    expect(templateVariables(reference.parts)).toEqual(["B", "A"]);
  });

  it("reads $$ and $! as literal $ and !, so an escaped ! is not a command", () => {
    expect(resolved("$$HOME")).toBe("$HOME");
    expect(parseConfigValueReference("$!cmd").kind).toBe("template");
    expect(resolved("$!cmd")).toBe("!cmd");
  });

  it("keeps a $ that starts no name, and a ${ with no closing brace or an invalid name, as literal text", () => {
    expect(resolved("cost$5")).toBe("cost$5");
    expect(resolved("a${b")).toBe("a${b");
    expect(resolved("${1x}")).toBe("${1x}");
    expect(resolved("end$")).toBe("end$");
  });

  it("round-trips any text escaped as a literal, under any environment", () => {
    fc.assert(fc.property(fc.string(), fc.dictionary(fc.stringMatching(/^[A-Z_]{1,6}$/), fc.string()), (text, env) => {
      expect(resolved(asLiteral(text), env)).toBe(text);
    }));
  });

  it("resolves text with no $ to itself, never as a command unless it starts with !", () => {
    fc.assert(fc.property(fc.string().filter((text) => !text.includes("$") && !text.startsWith("!")), (text) => {
      expect(resolved(text)).toBe(text);
    }));
  });
});
