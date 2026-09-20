import { describe, expect, it } from "vitest";
import { observeGitProbe, type GitProbeStep } from "../../src/utils/git-probe";

const scripted = <T, E>(steps: readonly GitProbeStep<T, E>[]) => {
  let index = 0;
  return () => steps[index++] ?? steps.at(-1)!;
};

describe("observeGitProbe", () => {
  it("returns a first non-empty observation without retry", () => {
    expect(observeGitProbe(scripted([{ ok: true, value: "root" }]), (value) => value === ""))
      .toEqual({ kind: "observed", value: "root", attempts: 1 });
  });

  it("retries one empty success and returns the second non-empty value", () => {
    expect(observeGitProbe(scripted([
      { ok: true, value: "" },
      { ok: true, value: "root" },
    ]), (value) => value === "")).toEqual({ kind: "observed", value: "root", attempts: 2 });
  });

  it("retains both successful empty observations as a typed anomaly", () => {
    expect(observeGitProbe(scripted([
      { ok: true, value: "first-empty" },
      { ok: true, value: "second-empty" },
    ]), () => true)).toEqual({
      kind: "confirmed-empty",
      first: "first-empty",
      second: "second-empty",
    });
  });

  it("preserves the exact failure and attempt", () => {
    expect(observeGitProbe(scripted([{ ok: false, error: "first" }]), () => false))
      .toEqual({ kind: "failed", error: "first", attempt: 1 });
    expect(observeGitProbe(scripted([
      { ok: true, value: "" },
      { ok: false, error: "second" },
    ]), (value) => value === "")).toEqual({ kind: "failed", error: "second", attempt: 2 });
  });
});
