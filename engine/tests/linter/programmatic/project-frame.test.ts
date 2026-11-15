/**
 * The project frame: a lint target's path from the project root, and the
 * spelling of a target that reaches the project through a symlink.
 */
import { describe, expect, it } from "vitest";
import { inProjectFrame, projectRelative, spelledUnderRoot } from "../../../src/linter/programmatic/baseline";

describe("inProjectFrame", () => {
  it("is the path from the root for a target inside the project", () => {
    expect(inProjectFrame("/work/shop/src/order.ts", "/work/shop")).toBe("src/order.ts");
    expect(inProjectFrame("C:\\work\\shop\\src\\order.ts", "C:\\work\\shop\\")).toBe("src/order.ts");
  });

  it("takes a relative target as project-relative, with or without a root", () => {
    expect(inProjectFrame("src\\order.ts", "/work/shop")).toBe("src/order.ts");
    expect(inProjectFrame("src/order.ts", null)).toBe("src/order.ts");
  });

  it("is null for an absolute target outside the root or with no root", () => {
    expect(inProjectFrame("/work/shop-old/src/order.ts", "/work/shop")).toBeNull();
    expect(inProjectFrame("/work/shop/src/order.ts", null)).toBeNull();
    expect(inProjectFrame("D:/work/shop/a.ts", "C:/work/shop")).toBeNull();
  });
});

describe("projectRelative", () => {
  it("strips the project root from an absolute path inside it", () => {
    expect(projectRelative("/work/shop/src/order.ts", "/work/shop")).toBe("src/order.ts");
    expect(projectRelative("/work/shop/src/order.ts", "/work/shop/")).toBe("src/order.ts");
    expect(projectRelative("C:\\work\\shop\\src\\order.ts", "C:\\work\\shop")).toBe("src/order.ts");
  });

  it("takes a path already relative as project-relative", () => {
    expect(projectRelative("src/order.ts", "/work/shop")).toBe("src/order.ts");
    expect(projectRelative("src\\order.ts", null)).toBe("src/order.ts");
  });

  it("leaves a path outside the root, or with no root, as given", () => {
    expect(projectRelative("/work/shop-old/src/order.ts", "/work/shop")).toBe("/work/shop-old/src/order.ts");
    expect(projectRelative("/work/shop/src/order.ts", null)).toBe("/work/shop/src/order.ts");
  });
});

describe("spelledUnderRoot", () => {
  it("spells a file beneath the project root when its real path is beneath the root's", () => {
    expect(spelledUnderRoot({ file: "/private/tmp/shop/src/order.ts", root: "/private/tmp/shop" }, "/tmp/shop"))
      .toBe("/tmp/shop/src/order.ts");
  });

  it("keeps the root's own spelling, without a doubled or trailing separator", () => {
    expect(spelledUnderRoot({ file: "/real/shop/a.ts", root: "/real/shop" }, "/link/shop/")).toBe("/link/shop/a.ts");
    expect(spelledUnderRoot({ file: "D:\\real\\shop\\a.ts", root: "D:\\real\\shop" }, "C:\\link\\shop")).toBe("C:/link/shop/a.ts");
  });

  it("is null for a file whose real path is outside the root's", () => {
    expect(spelledUnderRoot({ file: "/private/tmp/other/a.ts", root: "/private/tmp/shop" }, "/tmp/shop")).toBeNull();
    expect(spelledUnderRoot({ file: "/private/tmp/shop-old/a.ts", root: "/private/tmp/shop" }, "/tmp/shop")).toBeNull();
  });

  it("the result is always inside the project root it was spelled under", () => {
    const spelled = spelledUnderRoot({ file: "/real/shop/src/deep/a.ts", root: "/real/shop" }, "/link/shop");
    expect(spelled).not.toBeNull();
    expect(projectRelative(spelled ?? "", "/link/shop")).toBe("src/deep/a.ts");
  });
});
