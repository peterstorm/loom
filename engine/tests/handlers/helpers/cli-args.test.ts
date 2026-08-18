/**
 * The one CLI flag reader (round-41 A14).
 *
 * Five copies of this logic had accumulated across the helper shell and they
 * did not agree: `model-profiles`'s accepted an EMPTY value the others
 * rejected, and only `orchestration`'s refused a value that is itself a flag.
 * Argument parsing that differs per helper is silent — the wrong copy simply
 * reads a different command line than the operator typed.
 *
 * These pin the union of the guards the copies used to hold between them.
 */

import { describe, expect, it } from "vitest";
import { argumentValue, hasFlag } from "../../../src/handlers/helpers/cli-args";

describe("argumentValue", () => {
  it("reads the value that follows the flag", () => {
    expect(argumentValue(["--run", "run.abc"], "--run")).toBe("run.abc");
  });

  it("reads the value when the flag is not first", () => {
    expect(argumentValue(["--runs-root", "r", "--run", "run.abc"], "--run")).toBe("run.abc");
  });

  it("is null when the flag is absent", () => {
    expect(argumentValue(["--runs-root", "r"], "--run")).toBeNull();
  });

  it("is null when the flag is last and has no value", () => {
    expect(argumentValue(["--runs-root", "r", "--run"], "--run")).toBeNull();
  });

  it("is null for an EMPTY value — `model-profiles`'s copy used to accept it", () => {
    expect(argumentValue(["--agent", ""], "--agent")).toBeNull();
  });

  it("is null when the next token is itself a flag — a missing value, not `--json`", () => {
    // Only `orchestration`'s copy held this guard. Without it, `--run --json`
    // reads as run = "--json" and the run id is silently wrong.
    expect(argumentValue(["--run", "--json"], "--run")).toBeNull();
  });

  it("reads the FIRST occurrence when a flag is repeated", () => {
    expect(argumentValue(["--run", "first", "--run", "second"], "--run")).toBe("first");
  });

  it("does not match a flag by prefix", () => {
    expect(argumentValue(["--runs-root", "r"], "--run")).toBeNull();
  });

  it("accepts a value containing a single dash", () => {
    expect(argumentValue(["--run", "run-abc"], "--run")).toBe("run-abc");
  });

  it("accepts a path value", () => {
    expect(argumentValue(["--runs-root", ".claude/reviews/runs"], "--runs-root"))
      .toBe(".claude/reviews/runs");
  });

  it("is null on empty argv", () => {
    expect(argumentValue([], "--run")).toBeNull();
  });
});

describe("hasFlag", () => {
  it("is true when the bare switch is present", () => {
    expect(hasFlag(["--json"], "--json")).toBe(true);
  });

  it("is false when absent", () => {
    expect(hasFlag(["--run", "r"], "--json")).toBe(false);
  });

  it("does not match by prefix", () => {
    expect(hasFlag(["--jsonl"], "--json")).toBe(false);
  });

  it("is true when the switch appears as another flag's position but on its own", () => {
    expect(hasFlag(["--run", "r", "--json"], "--json")).toBe(true);
  });
});
