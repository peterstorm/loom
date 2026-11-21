/**
 * The one run-resolution rule both harnesses share (`explicitRun`,
 * `resolveIssuingRun`): an explicit run (both variables or neither) wins,
 * otherwise exactly one session binding issued every named request under the
 * exact context digest the task carries. Pure over its two reads, so every case
 * here runs on in-memory fakes; the Claude and Pi shells are covered by
 * claude-run-authority.test.ts and the Pi extension suites.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseIssuedTaskIdentity, type TaskIdentity } from "../../src/core/spawn-task-text";
import { parseRunDirectoryReference } from "../../src/orchestration/run-directory-handle";
import {
  explicitRun,
  failed,
  ok,
  resolveIssuingRun,
  type BindingResult,
  type IssuingRunReads,
  type RunLocation,
  type SessionRunBinding,
} from "../../src/orchestration/session-run-bindings";

const RUNS_ROOT = "/runs";
const digest = (fill: string): string => fill.repeat(64);

function identity(requestId: string, contextDigest: string): TaskIdentity {
  const parsed = parseIssuedTaskIdentity(`LOOM_REQUEST_ID: ${requestId}\nLOOM_CONTEXT_DIGEST: ${contextDigest}`);
  if (parsed.kind !== "bound") throw new Error(`fixture identity is not canonical: ${JSON.stringify(parsed)}`);
  return { requestId: parsed.requestId, contextDigest: parsed.contextDigest };
}

/** A bound run: its binding (request ids only, as the registry records) and what it issued. */
type FakeRun = Readonly<{ binding: SessionRunBinding; issued: readonly TaskIdentity[] }>;

function fakeRun(name: string, issued: readonly TaskIdentity[]): FakeRun {
  const reference = parseRunDirectoryReference(RUNS_ROOT, `${RUNS_ROOT}/run.${name}`);
  if (!reference.ok) throw new Error(reference.error.message);
  const binding: SessionRunBinding = Object.freeze({
    ...reference.value,
    requestIds: Object.freeze(issued.map(({ requestId }) => requestId)),
    resultDigest: null,
  });
  return { binding, issued };
}

/** Reads over in-memory runs, counting each issued-identity read by run directory. */
function reads(runs: readonly FakeRun[]): IssuingRunReads & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    bindings: () => ok(runs.map(({ binding }) => binding)),
    issuedIdentities: (run: RunLocation): BindingResult<readonly TaskIdentity[]> => {
      opened.push(run.runDirectory);
      const found = runs.find(({ binding }) => binding.runDirectory === run.runDirectory);
      return found === undefined ? failed(`no run ${run.runDirectory}`) : ok(found.issued);
    },
  };
}

const neverRead: IssuingRunReads = {
  bindings: () => { throw new Error("bindings must not be read"); },
  issuedIdentities: () => { throw new Error("issued identities must not be read"); },
};

const ALPHA = identity("request:alpha:1", digest("a"));
const ALPHA_OTHER_CONTEXT = identity("request:alpha:1", digest("b"));
const BETA = identity("request:beta:1", digest("c"));

describe("explicitRun", () => {
  it("names no run when neither variable is set", () => {
    expect(explicitRun({ runsRoot: undefined, runDirectory: undefined }, "pi")).toEqual({ ok: true, value: null });
  });

  it("names the run when both are set", () => {
    expect(explicitRun({ runsRoot: "/r", runDirectory: "/r/run.x" }, "claude-code"))
      .toEqual({ ok: true, value: { runsRoot: "/r", runDirectory: "/r/run.x" } });
  });

  it.each([
    [{ runsRoot: "/r", runDirectory: undefined }, "pi", "Pi"],
    [{ runsRoot: undefined, runDirectory: "/r/run.x" }, "claude-code", "Claude Code"],
  ] as const)("refuses half an authority %#", (environment, harness, label) => {
    expect(explicitRun(environment, harness))
      .toEqual({ ok: false, message: `${label} orchestration requires both run-root and run-directory authority` });
  });
});

describe("resolveIssuingRun", () => {
  it("returns an explicit run without reading anything", () => {
    expect(resolveIssuingRun({ runsRoot: "/r", runDirectory: "/r/run.x" }, neverRead, [ALPHA], "claude-code"))
      .toEqual({ ok: true, value: { kind: "explicit", run: { runsRoot: "/r", runDirectory: "/r/run.x" } } });
  });

  it("resolves the one binding that issued the request under its context", () => {
    const issuing = fakeRun("issuing", [ALPHA]);
    const resolved = resolveIssuingRun(null, reads([issuing, fakeRun("other", [BETA])]), [ALPHA], "pi");
    expect(resolved).toEqual({ ok: true, value: {
      kind: "session-binding",
      run: { runsRoot: issuing.binding.runsRoot, runDirectory: issuing.binding.runDirectory },
      binding: issuing.binding,
    } });
  });

  it("tells apart two bindings issuing one request id by the context digest", () => {
    const first = fakeRun("first", [ALPHA]);
    const second = fakeRun("second", [ALPHA_OTHER_CONTEXT]);
    const resolved = resolveIssuingRun(null, reads([first, second]), [ALPHA_OTHER_CONTEXT], "claude-code");
    expect(resolved).toMatchObject({ ok: true, value: { kind: "session-binding", binding: second.binding } });
  });

  it("refuses a request id its binding lists under a context digest that run never issued", () => {
    expect(resolveIssuingRun(null, reads([fakeRun("only", [ALPHA])]), [ALPHA_OTHER_CONTEXT], "claude-code")).toEqual({
      ok: false,
      message: `no Claude Code session run binding contains issued request/context authority request:alpha:1@${digest("b")}`,
    });
  });

  it("refuses several bindings that issued the same request and context", () => {
    const resolved = resolveIssuingRun(null, reads([fakeRun("a", [ALPHA]), fakeRun("b", [ALPHA])]), [ALPHA], "pi");
    expect(resolved).toEqual({
      ok: false,
      message: `multiple Pi session run bindings contain issued request/context authority request:alpha:1@${digest("a")}`,
    });
  });

  it("requires one binding to have issued every identity of a batch", () => {
    const split = reads([fakeRun("a", [ALPHA]), fakeRun("b", [BETA])]);
    expect(resolveIssuingRun(null, split, [ALPHA, BETA], "pi")).toMatchObject({
      ok: false, message: expect.stringContaining("no Pi session run binding contains"),
    });
    const together = fakeRun("both", [ALPHA, BETA]);
    expect(resolveIssuingRun(null, reads([together]), [ALPHA, BETA], "pi"))
      .toMatchObject({ ok: true, value: { binding: together.binding } });
  });

  it("opens only the runs whose binding lists every requested id", () => {
    const fake = reads([fakeRun("alpha", [ALPHA]), fakeRun("beta", [BETA])]);
    resolveIssuingRun(null, fake, [BETA], "pi");
    expect(fake.opened).toEqual([`${RUNS_ROOT}/run.beta`]);
  });

  it("refuses an empty identity list without an explicit run, reading nothing", () => {
    expect(resolveIssuingRun(null, neverRead, [], "pi"))
      .toEqual({ ok: false, message: "Pi session run resolution names no issued request" });
  });

  it("propagates an unreadable registry or run instead of treating it as no claim", () => {
    const unreadableRegistry: IssuingRunReads = { bindings: () => failed("registry is invalid JSON"), issuedIdentities: neverRead.issuedIdentities };
    expect(resolveIssuingRun(null, unreadableRegistry, [ALPHA], "pi")).toEqual({ ok: false, message: "registry is invalid JSON" });
    const run = fakeRun("broken", [ALPHA]);
    const unreadableRun: IssuingRunReads = { bindings: () => ok([run.binding]), issuedIdentities: () => failed("requests unreadable") };
    expect(resolveIssuingRun(null, unreadableRun, [ALPHA], "pi")).toEqual({ ok: false, message: "requests unreadable" });
  });

  const pool = [
    fakeRun("a", [ALPHA]),
    fakeRun("b", [ALPHA_OTHER_CONTEXT]),
    fakeRun("c", [BETA]),
    fakeRun("d", [ALPHA, BETA]),
  ];
  const batches = fc.constantFrom([ALPHA], [ALPHA_OTHER_CONTEXT], [BETA], [ALPHA, BETA], [ALPHA_OTHER_CONTEXT, BETA]);
  const runsInTwoOrders = fc.subarray(pool).chain((runs) =>
    fc.tuple(fc.constant(runs), fc.shuffledSubarray(runs, { minLength: runs.length, maxLength: runs.length })));

  it("does not depend on the order the registry lists its bindings", () => {
    fc.assert(fc.property(runsInTwoOrders, batches, ([runs, reordered], identities) => {
      expect(resolveIssuingRun(null, reads(reordered), identities, "pi"))
        .toEqual(resolveIssuingRun(null, reads(runs), identities, "pi"));
    }));
  });

  it("never resolves to a run that did not issue every identity under its exact context", () => {
    fc.assert(fc.property(fc.subarray(pool), batches, (runs, identities) => {
      const resolved = resolveIssuingRun(null, reads(runs), identities, "pi");
      if (!resolved.ok || resolved.value.kind !== "session-binding") return;
      const { binding } = resolved.value;
      const run = runs.find((candidate) => candidate.binding === binding);
      for (const wanted of identities) expect(run?.issued).toContainEqual(wanted);
    }));
  });

  it("is unchanged by adding a run that issued none of the identities", () => {
    const unrelated = fakeRun("unrelated", [identity("request:gamma:1", digest("d"))]);
    fc.assert(fc.property(fc.subarray(pool), batches, (runs, identities) => {
      expect(resolveIssuingRun(null, reads([...runs, unrelated]), identities, "pi"))
        .toEqual(resolveIssuingRun(null, reads(runs), identities, "pi"));
    }));
  });
});
