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

  it("returns the second observation when one empty success recovers", () => {
    expect(observeGitProbe(scripted([
      { ok: true, value: "" },
      { ok: true, value: "root" },
    ]), (value) => value === "")).toEqual({ kind: "observed", value: "root", attempts: 2 });
  });

  it("returns the third observation when two empty successes recover", () => {
    expect(observeGitProbe(scripted([
      { ok: true, value: "" },
      { ok: true, value: "" },
      { ok: true, value: "root" },
    ]), (value) => value === "")).toEqual({ kind: "observed", value: "root", attempts: 3 });
  });

  it("retains all successful empty observations as a typed anomaly", () => {
    expect(observeGitProbe(scripted([
      { ok: true, value: "first-empty" },
      { ok: true, value: "second-empty" },
      { ok: true, value: "third-empty" },
    ]), () => true)).toEqual({
      kind: "confirmed-empty",
      first: "first-empty",
      second: "second-empty",
      third: "third-empty",
    });
  });

  it("preserves the exact failure and attempt", () => {
    expect(observeGitProbe(scripted([{ ok: false, error: "first" }]), () => false))
      .toEqual({ kind: "failed", error: "first", attempt: 1 });
    expect(observeGitProbe(scripted([
      { ok: true, value: "" },
      { ok: false, error: "second" },
    ]), (value) => value === "")).toEqual({ kind: "failed", error: "second", attempt: 2 });
    expect(observeGitProbe(scripted([
      { ok: true, value: "" },
      { ok: true, value: "" },
      { ok: false, error: "third" },
    ]), (value) => value === "")).toEqual({ kind: "failed", error: "third", attempt: 3 });
  });
});
