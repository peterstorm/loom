import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { packageRootBinding, renderMarkdownForPi } from "../../src/core/harness-resources";

/** Unwrap a rendering the test asserts must succeed. */
const lowered = (content: string, packageRoot: string): string => {
  const result = renderMarkdownForPi(content, packageRoot);
  if (!result.ok) throw new Error(`expected a rendering, got refusal: ${result.error.message}`);
  return result.value;
};

/** Unwrap a binding the test asserts must succeed. */
const binding = (packageRoot: string): string => {
  const result = packageRootBinding(packageRoot);
  if (!result.ok) throw new Error(`expected a binding, got refusal: ${result.error.message}`);
  return result.value;
};

describe("Pi markdown resource lowering", () => {
  it("replaces braced and unbraced Claude package-root tokens", () => {
    expect(lowered(
      "Read `${CLAUDE_PLUGIN_ROOT}/rules/a.md` and `$CLAUDE_PLUGIN_ROOT/rules/b.md`.",
      "/opt/loom",
    )).toBe("Read `/opt/loom/rules/a.md` and `/opt/loom/rules/b.md`.");
  });

  it("rejects relative roots and roots unsafe for context-free markdown lowering", () => {
    // The refusal is a VALUE, not a throw: this module is functional core, and
    // the shells that render resources decide for themselves that a refusal is
    // fatal. A test asserting `toThrow` would pin the opposite contract.
    const relativeRoot = renderMarkdownForPi("x", "relative/loom");
    expect(relativeRoot.ok).toBe(false);
    if (!relativeRoot.ok) expect(relativeRoot.error.message).toMatch(/must be absolute/);

    for (const root of [
      '/tmp/loom"quote',
      "/tmp/loom$HOME",
      "/tmp/loom`id`",
      "/tmp/loom\\path",
      "/tmp/loom\npath",
      "/tmp/loom\tpath",
      "/tmp/loom path",
      "/tmp/loom*path",
    ]) {
      const refused = renderMarkdownForPi("x", root);
      expect(refused.ok, root).toBe(false);
      if (!refused.ok) expect(refused.error.message).toMatch(/unsupported metacharacters/);
    }
    expect(lowered("${CLAUDE_PLUGIN_ROOT}", "/tmp/loom-safe")).toBe("/tmp/loom-safe");
  });

  it("carries the refusal kind so a shell can match on it rather than on prose", () => {
    const refused = renderMarkdownForPi("x", "relative/loom");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.kind).toBe("harness-resource-rejected");
  });

  it("derives a frontmatter-safe stable package binding", () => {
    expect(binding("/opt/loom")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(binding("/opt/loom")).toBe(binding("/opt/./loom"));
    expect(binding("/opt/loom")).not.toBe(binding("/opt/other"));
  });

  it("refuses a binding for an unsafe root instead of throwing", () => {
    const refused = packageRootBinding("relative/loom");
    expect(refused.ok).toBe(false);
  });

  it("is idempotent after lowering", () => {
    fc.assert(fc.property(fc.string(), (text) => {
      const once = lowered(text, "/opt/loom");
      expect(lowered(once, "/opt/loom")).toBe(once);
    }));
  });
});
