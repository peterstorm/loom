/**
 * Pi post-edit composition: one tool_result handler carries both the
 * fail-closed lint verdict and the advisory type diagnostics, because Pi
 * chains handlers on a shared event — a later handler could not tell a lint
 * flag from a tool error, and a lint replacement would drop an earlier advisory.
 */

import { describe, expect, it } from "vitest";
import { composePostEditResult, type PiToolResultResponse } from "../../src/handlers/pi-adapter";

const original = { content: [{ type: "text" as const, text: "Edited src/a.ts" }], isError: false };
const lintFlag: PiToolResultResponse = { content: [{ type: "text", text: "❌ LINT: no-any-type" }], isError: true };

describe("composePostEditResult", () => {
  it("leaves the tool result untouched when neither lint nor types have anything to say", () => {
    expect(composePostEditResult(original, undefined, null)).toBeUndefined();
  });

  it("returns the lint verdict as before when types are clean", () => {
    expect(composePostEditResult(original, lintFlag, null)).toEqual({ content: lintFlag.content, isError: true });
  });

  it("appends the type advisory to the tool's own output without marking it an error", () => {
    expect(composePostEditResult(original, undefined, "⚠ TYPE DIAGNOSTICS")).toEqual({
      content: [...original.content, { type: "text", text: "⚠ TYPE DIAGNOSTICS" }],
      isError: false,
    });
  });

  it("keeps the lint verdict's error polarity and appends the advisory after it", () => {
    expect(composePostEditResult(original, lintFlag, "⚠ TYPE DIAGNOSTICS")).toEqual({
      content: [...lintFlag.content, { type: "text", text: "⚠ TYPE DIAGNOSTICS" }],
      isError: true,
    });
  });

  it("preserves non-text content of the original result", () => {
    const withImage = { content: [{ type: "image" as const, data: "x", mimeType: "image/png" }], isError: false };
    expect(composePostEditResult(withImage, undefined, "t")!.content).toEqual([...withImage.content, { type: "text", text: "t" }]);
  });
});
