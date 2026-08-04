import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { packageRootBinding, renderMarkdownForPi } from "../../src/core/harness-resources";

describe("Pi markdown resource lowering", () => {
  it("replaces braced and unbraced Claude package-root tokens", () => {
    expect(renderMarkdownForPi(
      "Read `${CLAUDE_PLUGIN_ROOT}/rules/a.md` and `$CLAUDE_PLUGIN_ROOT/rules/b.md`.",
      "/opt/loom",
    )).toBe("Read `/opt/loom/rules/a.md` and `/opt/loom/rules/b.md`.");
  });

  it("rejects relative roots and roots unsafe for context-free markdown lowering", () => {
    expect(() => renderMarkdownForPi("x", "relative/loom")).toThrow(/must be absolute/);
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
      expect(() => renderMarkdownForPi("x", root)).toThrow(/unsupported metacharacters/);
    }
    expect(renderMarkdownForPi("${CLAUDE_PLUGIN_ROOT}", "/tmp/loom-safe"))
      .toBe("/tmp/loom-safe");
  });

  it("derives a frontmatter-safe stable package binding", () => {
    expect(packageRootBinding("/opt/loom")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(packageRootBinding("/opt/loom")).toBe(packageRootBinding("/opt/./loom"));
    expect(packageRootBinding("/opt/loom")).not.toBe(packageRootBinding("/opt/other"));
  });

  it("is idempotent after lowering", () => {
    fc.assert(fc.property(fc.string(), (text) => {
      const once = renderMarkdownForPi(text, "/opt/loom");
      expect(renderMarkdownForPi(once, "/opt/loom")).toBe(once);
    }));
  });
});
