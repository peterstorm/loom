/**
 * Pi post-edit composition: one tool_result handler carries both the
 * fail-closed lint verdict and the advisory type diagnostics, because Pi
 * chains handlers on a shared event — a later handler could not tell a lint
 * flag from a tool error, and a lint replacement would drop an earlier advisory.
 */

import { describe, expect, it } from "vitest";
import {
  composePostEditResult,
  piOperatorNoteSink,
  piPostEdit,
  type PiPostEditPorts,
  type PiToolResultResponse,
} from "../../src/handlers/pi-adapter";
import { NO_ADVISORY, type AdviseOnEdit } from "../../src/core/type-diagnostics";
import type { LintResult } from "../../src/linter/index";

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

describe("piPostEdit — the whole post-edit flow, behind ports", () => {
  type Seen = { linted: string[]; advised: string[]; notes: string[] };

  const ports = (
    overrides: Partial<{ lint: (file: string) => LintResult; advise: AdviseOnEdit }> = {},
  ): { ports: PiPostEditPorts; seen: Seen } => {
    const seen: Seen = { linted: [], advised: [], notes: [] };
    return {
      seen,
      ports: {
        projectRoot: "/repo",
        lint: (file) => { seen.linted.push(file); return overrides.lint?.(file) ?? { kind: "pass" }; },
        advise: async (file) => { seen.advised.push(file); return overrides.advise ? overrides.advise(file) : NO_ADVISORY; },
        notifyOperator: (note) => { seen.notes.push(note); },
      },
    };
  };

  const edit = (input: Record<string, unknown> = { path: "src/a.ts" }, overrides: Partial<{ toolName: string; isError: boolean }> = {}) =>
    ({ toolName: "edit", input, ...original, ...overrides });

  it("ignores tools that do not edit files, and edits the tool itself failed", async () => {
    const { ports: p, seen } = ports();
    expect(await piPostEdit(edit(undefined, { toolName: "read" }), p)).toBeUndefined();
    expect(await piPostEdit(edit(undefined, { isError: true }), p)).toBeUndefined();
    expect(seen).toEqual({ linted: [], advised: [], notes: [] });
  });

  it.each(["edit", "write", "multi_edit"])("checks a %s: lint the path as given, advise on it resolved against the project root", async (toolName) => {
    const { ports: p, seen } = ports();
    expect(await piPostEdit(edit({ path: "src/a.ts" }, { toolName }), p)).toBeUndefined();
    expect(seen.linted).toEqual(["src/a.ts"]);
    expect(seen.advised).toEqual(["/repo/src/a.ts"]);
  });

  it("advises on an absolute path as-is", async () => {
    const { ports: p, seen } = ports();
    await piPostEdit(edit({ path: "/elsewhere/b.ts" }), p);
    expect(seen.advised).toEqual(["/elsewhere/b.ts"]);
  });

  it("appends the model advisory without marking the result an error", async () => {
    const { ports: p } = ports({ advise: async () => ({ forModel: "⚠ TYPE DIAGNOSTICS", forOperator: null }) });
    expect(await piPostEdit(edit(), p)).toEqual({ content: [...original.content, { type: "text", text: "⚠ TYPE DIAGNOSTICS" }], isError: false });
  });

  it("keeps a lint violation's error polarity with the advisory after it", async () => {
    const { ports: p } = ports({
      lint: () => ({ kind: "error", message: "rule crashed" }),
      advise: async () => ({ forModel: "⚠ TYPE DIAGNOSTICS", forOperator: null }),
    });
    const result = await piPostEdit(edit(), p);
    expect(result!.isError).toBe(true);
    expect(result!.content.at(-1)).toEqual({ type: "text", text: "⚠ TYPE DIAGNOSTICS" });
  });

  it("routes the operator note to the operator channel only", async () => {
    const { ports: p, seen } = ports({ advise: async () => ({ forModel: null, forOperator: "tsc did not finish" }) });
    expect(await piPostEdit(edit(), p)).toBeUndefined();
    expect(seen.notes).toEqual(["tsc did not finish"]);
  });

  it("fails open on the advisory: a throwing advisor is an operator note and lint still decides", async () => {
    const { ports: p, seen } = ports({
      lint: () => ({ kind: "error", message: "rule crashed" }),
      advise: async () => { throw new Error("boom"); },
    });
    expect((await piPostEdit(edit(), p))!.isError).toBe(true);
    expect(seen.notes).toEqual(["Loom type diagnostics could not run: boom"]);
  });

  it("fails closed on lint: an edit without a path is a lint engine error, with no advisory run", async () => {
    const { ports: p, seen } = ports();
    const result = await piPostEdit(edit({}), p);
    expect(result!.isError).toBe(true);
    expect(seen.advised).toEqual([]);
  });
});

describe("piOperatorNoteSink", () => {
  it("notifies through the UI when there is one", () => {
    const notified: string[] = [];
    const stderr: string[] = [];
    piOperatorNoteSink({ hasUI: true, ui: { notify: (m) => { notified.push(m); } } }, (line) => stderr.push(line))("note");
    expect(notified).toEqual(["note"]);
    expect(stderr).toEqual([]);
  });

  it("falls back to stderr in a headless session, so the note is never dropped", () => {
    const notified: string[] = [];
    const stderr: string[] = [];
    piOperatorNoteSink({ hasUI: false, ui: { notify: (m) => { notified.push(m); } } }, (line) => stderr.push(line))("note");
    expect(notified).toEqual([]);
    expect(stderr).toEqual(["[loom] note"]);
  });
});
