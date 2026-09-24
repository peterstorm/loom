/**
 * The ONE bounded thrown-cause capture (cs-6): it lives in the
 * orchestration-contract kernel and is shared by the Context Packet parsers,
 * the packet projection read-model, and the successor registration and
 * capture-witness adapters. These pins hold the shared budget/truncation
 * shape and each layer's historical fallback prose through its subject
 * phrase, so relocation cannot change any pinned refusal byte.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_THROWN_CAUSE_TEXT_LENGTH,
  boundedThrownCause,
} from "../../src/core/orchestration-contract";

describe("the shared bounded thrown-cause capture", () => {
  it("bounds long Error names and messages at the shared budget with the ellipsis marker", () => {
    const thrown = Object.assign(new Error("x".repeat(400)), { name: "T".repeat(300) });
    const cause = boundedThrownCause(thrown, "context packet");
    expect(cause.name.length).toBe(MAX_THROWN_CAUSE_TEXT_LENGTH);
    expect(cause.name.endsWith("…")).toBe(true);
    expect(cause.message.length).toBe(MAX_THROWN_CAUSE_TEXT_LENGTH);
    expect(cause.message.endsWith("…")).toBe(true);
  });

  it("keeps the packet layer's historical fallback prose", () => {
    expect(boundedThrownCause({ code: 42 }, "context packet")).toEqual({
      name: "NonErrorThrown",
      message: "context packet inspection failed with a non-Error cause",
    });
    // An Error whose `message` is not a string takes the subject-phrase
    // fallback (Error.prototype.message is the empty string, so the fallback
    // needs an explicitly undefined message property).
    const bareError = Object.create(Error.prototype) as Error;
    Object.defineProperty(bareError, "message", { value: undefined });
    expect(boundedThrownCause(bareError, "context packet")).toEqual({
      name: "Error",
      message: "context packet inspection failed",
    });
    expect(boundedThrownCause(bareError, "standalone successor context packet")).toEqual({
      name: "Error",
      message: "standalone successor context packet inspection failed",
    });
    expect(boundedThrownCause("plain thrown string", "context packet")).toEqual({
      name: "NonErrorThrown",
      message: "plain thrown string",
    });
  });

  it("keeps the successor adapter's historical fallback prose", () => {
    const bareError = Object.create(Error.prototype) as Error;
    Object.defineProperty(bareError, "message", { value: undefined });
    expect(boundedThrownCause({ code: 42 }, "successor source")).toEqual({
      name: "NonErrorThrown",
      message: "successor source inspection failed with a non-Error cause",
    });
    expect(boundedThrownCause(bareError, "successor source")).toEqual({
      name: "Error",
      message: "successor source inspection failed",
    });
    expect(boundedThrownCause(bareError, "successor standalone-registration")).toEqual({
      name: "Error",
      message: "successor standalone-registration inspection failed",
    });
    expect(boundedThrownCause(bareError, "successor standalone capture witnesses")).toEqual({
      name: "Error",
      message: "successor standalone capture witnesses inspection failed",
    });
  });

  it("survives a throwing getter on the thrown value as an uninspectable cause", () => {
    class Hostile extends Error {
      override get name(): string {
        throw new Error("name getter");
      }
    }
    expect(boundedThrownCause(new Hostile("boom"), "successor source")).toEqual({
      name: "UninspectableCause",
      message: "successor source inspection failed with an uninspectable cause",
    });
  });
});
