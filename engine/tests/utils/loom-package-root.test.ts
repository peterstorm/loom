/**
 * The shell's one handling of a refused package root. `installedLoomPackageRoot`
 * runs at import in the engine and the Pi extension: a root no printed command
 * can be built on stops the process there, naming why, and an admitted root
 * passes through unchanged.
 */

import { describe, expect, it } from "vitest";
import { installedLoomPackageRoot } from "../../src/utils/loom-package-root";

describe("installedLoomPackageRoot", () => {
  it("returns an absolute root unchanged", () => {
    expect(installedLoomPackageRoot("/opt/loom")).toBe("/opt/loom");
  });

  it.each([
    ["a relative path", "opt/loom", /the Loom package root "opt\/loom" must be an absolute path/],
    ["a trailing separator", "/opt/loom/", /the Loom package root "\/opt\/loom\/" must not end in a path separator/],
    ["a control character", "/opt/lo\nom", /the Loom package root "\/opt\/lo\\nom" must not hold a control character/],
  ])("stops on %s, naming the refusal", (_name, path, reason) => {
    expect(() => installedLoomPackageRoot(path)).toThrow(/^the executing Loom package cannot name itself in a printed command: /);
    expect(() => installedLoomPackageRoot(path)).toThrow(reason);
  });
});
