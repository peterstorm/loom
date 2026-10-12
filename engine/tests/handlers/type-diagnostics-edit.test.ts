/**
 * adviceForEdit: the one edit-to-advisory step both harness adapters share.
 */

import { describe, expect, it } from "vitest";
import { adviceForEdit } from "../../src/handlers/type-diagnostics-edit";
import { NO_ADVISORY } from "../../src/core/type-diagnostics";

describe("adviceForEdit", () => {
  const advised = (file: string) => Promise.resolve({ forModel: `checked ${file}`, forOperator: null });

  it("resolves a relative path against the root and an absolute one as-is", async () => {
    expect((await adviceForEdit("src/a.ts", "/repo", advised)).forModel).toBe("checked /repo/src/a.ts");
    expect((await adviceForEdit("/elsewhere/b.ts", "/repo", advised)).forModel).toBe("checked /elsewhere/b.ts");
  });

  it("keeps a relative path as given when there is no root", async () => {
    expect((await adviceForEdit("src/a.ts", null, advised)).forModel).toBe("checked src/a.ts");
  });

  it("has nothing to say without a path", async () => {
    expect(await adviceForEdit(null, "/repo", advised)).toBe(NO_ADVISORY);
  });

  it("turns a failing advisor into an operator note, never a model message", async () => {
    const advisory = await adviceForEdit("a.ts", "/repo", () => Promise.reject(new Error("boom")));
    expect(advisory).toEqual({ forModel: null, forOperator: "Loom type diagnostics could not run: boom" });
  });
});
