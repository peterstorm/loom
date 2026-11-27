/**
 * Which directories' `node_modules` the isolated worktree shares (issue #265):
 * the root's, the runner cwd's, and that of each directory Git lists an
 * ignored entry under, keyed on the outermost `node_modules`, with nothing
 * that is not under one, and the one refusal.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sharedNodeModulesDirectories } from "../../src/core/owner-verification/node-modules-directories";
import { compareStrings } from "../../src/core/ordering";
import { parseReviewPath, type ReviewPath } from "../../src/core/review-packet";

const output = (...entries: readonly string[]): string => `${entries.join("\0")}\0`;

function pathOf(raw: string): ReviewPath {
  const parsed = parseReviewPath(raw);
  if (!parsed.ok) throw new Error(`not a repository-relative path: ${raw}`);
  return parsed.value;
}

describe("sharedNodeModulesDirectories", () => {
  it.each([
    ["only the root when nothing is ignored", "", ["."]],
    ["the root's once when Git lists it", output("node_modules/"), ["."]],
    [
      "each workspace package's beside the root's, sorted",
      output("packages/host/node_modules/", "node_modules/", "apps/web/node_modules/", "packages/framework/node_modules/"),
      [".", "apps/web", "packages/framework", "packages/host"],
    ],
    [
      "nothing for entries under no node_modules",
      output(".loom/completion-reports/", "dist/", "debug.log", "node_modules", "my-node_modules/", "node_modules-cache/", "packages/host/node_modules/"),
      [".", "packages/host"],
    ],
    [
      "a package whose node_modules the checkout partly tracks, named entry by entry beneath it",
      output("packages/host/node_modules/installed/", "packages/host/node_modules/.yarn-integrity"),
      [".", "packages/host"],
    ],
    [
      "the outer holder only, for a node_modules beneath another",
      output("node_modules/pkg/node_modules/", "vendor/node_modules/x/node_modules/"),
      [".", "vendor"],
    ],
    ["a holder whose path has spaces", output("tools/a b/node_modules/"), [".", "tools/a b"]],
    ["each holder once", output("packages/host/node_modules/", "packages/host/node_modules/"), [".", "packages/host"]],
  ] as const)("names %s", (_case, raw, expected) => {
    expect(sharedNodeModulesDirectories(raw, ".")).toEqual({ ok: true, value: expected });
  });

  it.each([
    ["a runner cwd beside the root, listed or not", "tests", "", [".", "tests"]],
    ["a runner cwd that is also a listed holder, once", "packages/host", output("packages/host/node_modules/"), [".", "packages/host"]],
    ["a runner cwd inside a node_modules, by its outer holder", "node_modules/tool", "", ["."]],
  ] as const)("names %s", (_case, cwd, raw, expected) => {
    expect(sharedNodeModulesDirectories(raw, pathOf(cwd))).toEqual({ ok: true, value: expected });
  });

  it.each([
    ["a traversal segment", output("../node_modules/")],
    ["an empty segment", output("packages//node_modules/")],
    ["an absolute path", output("/abs/node_modules/")],
    ["surrounding whitespace", output(" odd/node_modules/")],
  ] as const)("refuses a holder with %s", (_case, raw) => {
    const parsed = sharedNodeModulesDirectories(raw, ".");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/unusable node_modules directory/);
  });

  it("names exactly the root and the distinct holders of the listed node_modules, sorted, whatever else Git lists", () => {
    const segment = fc.stringMatching(/^[a-z][a-z0-9 ._-]{0,7}$/).filter((text) => text !== "node_modules" && text.trim() === text);
    const holder = fc.array(segment, { minLength: 1, maxLength: 3 }).map((segments) => segments.join("/"));
    const beneath = fc.oneof(fc.constant("node_modules/"), segment.map((name) => `node_modules/${name}/`), segment.map((name) => `node_modules/${name}`));
    const noise = fc.oneof(holder.map((path) => `${path}/`), holder.map((path) => `${path}.log`), holder.map((path) => `${path}/node_modules`));
    fc.assert(fc.property(fc.array(fc.tuple(holder, beneath), { maxLength: 6 }), fc.array(noise, { maxLength: 6 }), (listed, others) => {
      const entries = [...listed.map(([path, rest]) => `${path}/${rest}`), ...others];
      const expected = [...new Set([".", ...listed.map(([path]) => path)])].sort(compareStrings);
      expect(sharedNodeModulesDirectories(output(...entries), ".")).toEqual({ ok: true, value: expected });
    }));
  });
});
