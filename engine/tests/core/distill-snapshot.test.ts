/**
 * The pure half of the Distill Snapshot (ADR-0068 §5): which trial settlement
 * writes the snapshot back, which settlement lets it go, and the snapshot
 * tree's wire format.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  describeDistillSnapshotFailure,
  distillRestoreOf,
  distillSnapshotRetention,
  distillSnapshotScope,
  distillTrialFailureKinds,
  parseSnapshotTree,
  restoredFilePermissions,
  settledDistillSnapshotDigests,
  snapshotEntriesUnder,
  snapshotFileMode,
  snapshotIndexInfo,
  type DistillSnapshotEntry,
  type DistillSnapshotHistory,
  type DistillTrialSettlement,
} from "../../src/core/distill-snapshot";
import { DISTILL_AGENT } from "../../src/core/model-profiles";

const implemented: DistillTrialSettlement = { kind: "applied", transition: { kind: "implemented" } };
const failing = (kind: "retry-required" | "escalation-required", failureKinds: readonly string[]): DistillTrialSettlement =>
  ({ kind: "applied", transition: { kind, receipt: { failureKinds } } });
const blocked: DistillTrialSettlement = { kind: "applied", transition: { kind: "infrastructure-blocked" } };
const ignored: DistillTrialSettlement = { kind: "ignored" };
const errored: DistillTrialSettlement = { kind: "error" };

describe("distillTrialFailureKinds", () => {
  it("names a semantic failure's receipt kinds and nothing for every other arm", () => {
    expect(distillTrialFailureKinds(implemented)).toEqual([]);
    expect(distillTrialFailureKinds(failing("retry-required", ["proof:regression-tests-failed"])))
      .toEqual(["proof:regression-tests-failed"]);
    expect(distillTrialFailureKinds(failing("escalation-required", ["proof:test-result-missing", "task-byte-scope-violation"])))
      .toEqual(["proof:test-result-missing", "task-byte-scope-violation"]);
    expect(distillTrialFailureKinds(blocked)).toEqual([]);
    expect(distillTrialFailureKinds(ignored)).toEqual([]);
    expect(distillTrialFailureKinds(errored)).toEqual([]);
  });
});

describe("distillRestoreOf", () => {
  const CHANGED = ["src/a.ts"];

  it("keeps a trial that settled implemented, changed or not", () => {
    expect(distillRestoreOf(CHANGED, implemented)).toEqual({ kind: "keep" });
    expect(distillRestoreOf([], implemented)).toEqual({ kind: "keep" });
  });

  it("restores a changed scope the trial would fail, carrying the failure kinds", () => {
    expect(distillRestoreOf(CHANGED, failing("retry-required", ["proof:regression-tests-failed"])))
      .toEqual({ kind: "restore", after: ["proof:regression-tests-failed"] });
    expect(distillRestoreOf(CHANGED, failing("escalation-required", ["task-byte-scope-violation"])))
      .toEqual({ kind: "restore", after: ["task-byte-scope-violation"] });
  });

  it("keeps an unchanged scope whatever the trial failed for: there is nothing to write back", () => {
    expect(distillRestoreOf([], failing("retry-required", ["task-byte-scope-violation"]))).toEqual({ kind: "keep" });
  });

  it("never restores for an infrastructure-blocked, ignored or error trial: none of them judged the bytes", () => {
    for (const trial of [blocked, ignored, errored]) {
      expect(distillRestoreOf(CHANGED, trial)).toEqual({ kind: "keep" });
    }
  });

  const failureKind = fc.constantFrom(
    "proof:regression-tests-failed",
    "proof:test-result-missing",
    "proof:untrusted-regression-pass",
    "proof:task-not-completed",
    "task-byte-scope-violation",
  );
  const trialArb: fc.Arbitrary<DistillTrialSettlement> = fc.oneof(
    fc.constant(implemented),
    fc.constant(blocked),
    fc.constant(ignored),
    fc.constant(errored),
    fc.tuple(
      fc.constantFrom("retry-required" as const, "escalation-required" as const),
      fc.uniqueArray(failureKind, { minLength: 1, maxLength: 4 }),
    ).map(([kind, kinds]) => failing(kind, kinds)),
  );
  const wouldNotImplement = (trial: DistillTrialSettlement): boolean =>
    trial.kind === "applied" && (trial.transition.kind === "retry-required" || trial.transition.kind === "escalation-required");

  it("property: restore iff the scope changed AND the trial settled a semantic failure", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.constantFrom("src/a.ts", "src/b.ts", "src/dir/c.ts"), { maxLength: 3 }),
      trialArb,
      (changed, trial) => {
        const decision = distillRestoreOf(changed, trial);
        expect(decision.kind === "restore").toBe(changed.length > 0 && wouldNotImplement(trial));
        if (decision.kind === "restore") expect(decision.after).toEqual(distillTrialFailureKinds(trial));
      },
    ));
  });
});

describe("distillSnapshotRetention", () => {
  it("discards after every semantic settlement and keeps otherwise", () => {
    expect(distillSnapshotRetention(implemented)).toBe("discard");
    expect(distillSnapshotRetention(failing("retry-required", ["proof:regression-tests-failed"]))).toBe("discard");
    expect(distillSnapshotRetention(failing("escalation-required", ["task-byte-scope-violation"]))).toBe("discard");
    expect(distillSnapshotRetention(blocked)).toBe("keep");
    expect(distillSnapshotRetention(ignored)).toBe("keep");
    expect(distillSnapshotRetention(errored)).toBe("keep");
  });
});

describe("settledDistillSnapshotDigests", () => {
  const history: DistillSnapshotHistory["implementation_attempt_history"] = [
    { authorityDigest: "a1", transition: "infrastructure-blocked" },
    { authorityDigest: "b2", transition: "retry-required" },
    { authorityDigest: "c3", transition: "escalation-required" },
    { authorityDigest: "c3", transition: "escalation-remediated" },
    { authorityDigest: "d4", transition: "implemented" },
  ];

  it("lists each semantically settled attempt once and never an infrastructure-blocked one", () => {
    expect(settledDistillSnapshotDigests({ agent: DISTILL_AGENT, implementation_attempt_history: history }))
      .toEqual(["b2", "c3", "d4"]);
  });

  it("is empty for a Distill Task with no history and for any other Task", () => {
    expect(settledDistillSnapshotDigests({ agent: DISTILL_AGENT })).toEqual([]);
    expect(settledDistillSnapshotDigests({ agent: "code-implementer-agent", implementation_attempt_history: history })).toEqual([]);
  });
});

describe("the snapshot scope", () => {
  it("is the attempt baseline's own artifacts, in order, and empty with no baseline", () => {
    expect(distillSnapshotScope([{ artifact: "src/b.ts" }, { artifact: "src/a.ts" }])).toEqual(["src/b.ts", "src/a.ts"]);
    expect(distillSnapshotScope(undefined)).toEqual([]);
  });
});

describe("the snapshot tree wire format", () => {
  const SHA = "a".repeat(40);
  const entries: readonly DistillSnapshotEntry[] = [
    { mode: "100644", sha: SHA, path: "src/a.ts" },
    { mode: "100755", sha: SHA, path: "bin/run with space.sh" },
    { mode: "120000", sha: SHA, path: "src/dir/link" },
  ];
  const listingOf = (listed: readonly DistillSnapshotEntry[]): string =>
    listed.map(({ mode, sha, path }) => `${mode} blob ${sha}\t${path}\0`).join("");

  it("stages one NUL-terminated record per entry", () => {
    const NUL = String.fromCharCode(0);
    expect(snapshotIndexInfo(entries)).toBe(
      [`100644 ${SHA}\tsrc/a.ts`, `100755 ${SHA}\tbin/run with space.sh`, `120000 ${SHA}\tsrc/dir/link`, ""].join(NUL),
    );
    expect(snapshotIndexInfo([])).toBe("");
  });

  it("reads an ls-tree listing back as the entries that were staged", () => {
    expect(parseSnapshotTree(listingOf(entries))).toEqual({ ok: true, value: entries });
    expect(parseSnapshotTree("")).toEqual({ ok: true, value: [] });
  });

  it("refuses a record that is no file, executable or symlink blob", () => {
    expect(parseSnapshotTree(`160000 commit ${SHA}\tvendor/sub\0`).ok).toBe(false);
    expect(parseSnapshotTree(`040000 tree ${SHA}\tsrc\0`).ok).toBe(false);
    expect(parseSnapshotTree("garbage\0").ok).toBe(false);
  });

  it("selects the entries at or below one scope path, never a sibling sharing its prefix", () => {
    const tree: readonly DistillSnapshotEntry[] = [
      { mode: "100644", sha: SHA, path: "src/a.ts" },
      { mode: "100644", sha: SHA, path: "src/a.ts.bak" },
      { mode: "100644", sha: SHA, path: "src/dir/b.ts" },
      { mode: "100644", sha: SHA, path: "src/directory/c.ts" },
    ];
    expect(snapshotEntriesUnder(tree, "src/a.ts").map(({ path }) => path)).toEqual(["src/a.ts"]);
    expect(snapshotEntriesUnder(tree, "src/dir").map(({ path }) => path)).toEqual(["src/dir/b.ts"]);
    expect(snapshotEntriesUnder(tree, "src/missing.ts")).toEqual([]);
  });

  it("property: a staged tree parses back to itself", () => {
    const pathArb = fc.array(fc.stringMatching(/^[A-Za-z0-9 ._-]{1,8}$/), { minLength: 1, maxLength: 3 }).map((parts) => parts.join("/"));
    const entryArb = fc.record({
      mode: fc.constantFrom("100644" as const, "100755" as const, "120000" as const),
      sha: fc.stringMatching(/^[0-9a-f]{40}$/),
      path: pathArb,
    });
    fc.assert(fc.property(fc.array(entryArb, { maxLength: 6 }), (listed) => {
      expect(parseSnapshotTree(listingOf(listed))).toEqual({ ok: true, value: listed });
    }));
  });
});

describe("file modes", () => {
  it("snapshots only the owner's executable bit", () => {
    expect(snapshotFileMode(0o644)).toBe("100644");
    expect(snapshotFileMode(0o755)).toBe("100755");
    expect(snapshotFileMode(0o700)).toBe("100755");
    expect(snapshotFileMode(0o654)).toBe("100644");
  });

  it("restores the executable bit wherever a read bit is, and clears every one otherwise", () => {
    expect(restoredFilePermissions(0o644, true)).toBe(0o755);
    expect(restoredFilePermissions(0o600, true)).toBe(0o700);
    expect(restoredFilePermissions(0o755, false)).toBe(0o644);
    expect(restoredFilePermissions(0o644, false)).toBe(0o644);
  });

  it("property: a restored mode snapshots as the mode it was restored to, and restoring twice changes nothing", () => {
    fc.assert(fc.property(fc.integer({ min: 0o400, max: 0o777 }).filter((mode) => (mode & 0o400) !== 0), fc.boolean(), (mode, executable) => {
      const restored = restoredFilePermissions(mode, executable);
      expect(snapshotFileMode(restored)).toBe(executable ? "100755" : "100644");
      expect(restoredFilePermissions(restored, executable)).toBe(restored);
    }));
  });
});

describe("describeDistillSnapshotFailure", () => {
  it("names each failure's own cause", () => {
    expect(describeDistillSnapshotFailure({ kind: "no-snapshot", ref: "refs/loom/distill/ab" }))
      .toBe("no distill snapshot is stored under refs/loom/distill/ab");
    expect(describeDistillSnapshotFailure({ kind: "git-failed", command: "write-tree", detail: "exited 128: fatal" }))
      .toBe("git write-tree exited 128: fatal");
    expect(describeDistillSnapshotFailure({ kind: "scope-path-failed", path: "src/a.ts", detail: "EACCES" }))
      .toBe("src/a.ts: EACCES");
  });
});
