/**
 * Which directories' `node_modules` the isolated worktree shares, read from
 * `git ls-files --others --ignored --exclude-standard --directory -z`
 * (issue #265): the root's, each workspace package's, nothing that is not a
 * `node_modules` directory, nothing beneath another, and the one refusal.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ignoredNodeModulesDirectories } from "../../src/core/owner-verification/node-modules-directories";
import { compareStrings } from "../../src/core/ordering";

const output = (...entries: readonly string[]): string => `${entries.join("\0")}\0`;

describe("ignoredNodeModulesDirectories", () => {
  it.each([
    ["nothing ignored", "", []],
    ["the root's", output("node_modules/"), ["."]],
    [
      "each workspace package's beside the root's, sorted",
      output("packages/host/node_modules/", "node_modules/", "apps/web/node_modules/", "packages/framework/node_modules/"),
      [".", "apps/web", "packages/framework", "packages/host"],
    ],
    [
      "none of the other ignored entries",
      output(".loom/completion-reports/", "dist/", "debug.log", "node_modules", "my-node_modules/", "node_modules-cache/", "packages/host/node_modules/"),
      ["packages/host"],
    ],
    ["a holder whose path has spaces", output("tools/a b/node_modules/"), ["tools/a b"]],
    ["each holder once", output("packages/host/node_modules/", "packages/host/node_modules/"), ["packages/host"]],
    [
      "none beneath another named node_modules",
      output("node_modules/", "node_modules/pkg/node_modules/", "vendor/node_modules/", "vendor/node_modules/x/node_modules/"),
      [".", "vendor"],
    ],
  ] as const)("names %s", (_case, raw, expected) => {
    expect(ignoredNodeModulesDirectories(raw)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ["a traversal segment", output("../node_modules/")],
    ["an empty segment", output("packages//node_modules/")],
    ["an absolute path", output("/abs/node_modules/")],
  ] as const)("refuses a holder with %s", (_case, raw) => {
    const parsed = ignoredNodeModulesDirectories(raw);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/unusable node_modules directory/);
  });

  it("names exactly the distinct holders of the listed node_modules, sorted, whatever else Git lists", () => {
    const segment = fc.stringMatching(/^[a-z][a-z0-9 ._-]{0,7}$/).filter((text) => text !== "node_modules" && !text.endsWith(" ") && text.trim() === text);
    const holder = fc.array(segment, { minLength: 1, maxLength: 3 }).map((segments) => segments.join("/"));
    const noise = fc.oneof(
      holder.map((path) => `${path}/`),
      holder.map((path) => `${path}.log`),
      holder.map((path) => `${path}/node_modules`),
    );
    fc.assert(fc.property(fc.array(holder, { maxLength: 6 }), fc.array(noise, { maxLength: 6 }), (holders, others) => {
      const entries = [...holders.map((path) => `${path}/node_modules/`), ...others];
      const expected = [...new Set(holders)].sort(compareStrings);
      expect(ignoredNodeModulesDirectories(output(...entries))).toEqual({ ok: true, value: expected });
    }));
  });
});
