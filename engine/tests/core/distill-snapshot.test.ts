/**
 * The pure half of the Distill Snapshot (ADR-0068 §5): what a settlement
 * means for the attempt's bytes and for its snapshot, and the snapshot tree's
 * wire format.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  describeDistillSnapshotFailure,
  distillSettlementOutcome,
  distillSnapshotScope,
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

describe("distillSettlementOutcome", () => {
  const CHANGED = ["src/a.ts"];
  const KEEP = { kind: "keep" };

  it("keeps the bytes of a settlement that settled implemented, changed or not, and lets its snapshot go", () => {
    expect(distillSettlementOutcome(CHANGED, implemented)).toEqual({ restore: KEEP, retention: "discard" });
    expect(distillSettlementOutcome([], implemented)).toEqual({ restore: KEEP, retention: "discard" });
  });

  it("restores a changed scope a semantic failure would settle, carrying every failure kind, and lets the snapshot go", () => {
    expect(distillSettlementOutcome(CHANGED, failing("retry-required", ["proof:regression-tests-failed"])))
      .toEqual({ restore: { kind: "restore", after: ["proof:regression-tests-failed"] }, retention: "discard" });
    expect(distillSettlementOutcome(CHANGED, failing("escalation-required", ["proof:test-result-missing", "task-byte-scope-violation"])))
      .toEqual({ restore: { kind: "restore", after: ["proof:test-result-missing", "task-byte-scope-violation"] }, retention: "discard" });
  });

  it("keeps an unchanged scope whatever the settlement failed for: there is nothing to write back", () => {
    expect(distillSettlementOutcome([], failing("retry-required", ["task-byte-scope-violation"])))
      .toEqual({ restore: KEEP, retention: "discard" });
  });

  it("keeps a changed scope whose semantic failure names no failure kind: a restore needs a reason", () => {
    expect(distillSettlementOutcome(CHANGED, failing("retry-required", []))).toEqual({ restore: KEEP, retention: "discard" });
  });

  it("neither restores nor lets the snapshot go for an infrastructure-blocked, ignored or error settlement: none judged the bytes", () => {
    for (const settlement of [blocked, ignored, errored]) {
      expect(distillSettlementOutcome(CHANGED, settlement)).toEqual({ restore: KEEP, retention: "keep" });
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
  const semanticFailureKinds = (settlement: DistillTrialSettlement): readonly string[] | null =>
    settlement.kind === "applied" && (settlement.transition.kind === "retry-required" || settlement.transition.kind === "escalation-required")
      ? settlement.transition.receipt.failureKinds
      : null;

  it("property: restore iff the scope changed AND the settlement is a semantic failure; retention never reads the scope", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.constantFrom("src/a.ts", "src/b.ts", "src/dir/c.ts"), { maxLength: 3 }),
      trialArb,
      (changed, settlement) => {
        const { restore, retention } = distillSettlementOutcome(changed, settlement);
        const failureKinds = semanticFailureKinds(settlement);
        expect(restore.kind === "restore").toBe(changed.length > 0 && failureKinds !== null);
        if (restore.kind === "restore") expect(restore.after).toEqual(failureKinds);
        expect(retention).toBe(distillSettlementOutcome([], settlement).retention);
        // A settlement that restores always lets its snapshot go once persisted.
        if (restore.kind === "restore") expect(retention).toBe("discard");
      },
    ));
  });

  it("property: registration drops exactly the attempts whose persisted settlement let the snapshot go", () => {
    const applied = fc.constantFrom(implemented, blocked, failing("retry-required", ["proof:regression-tests-failed"]), failing("escalation-required", ["task-byte-scope-violation"]));
    fc.assert(fc.property(fc.array(applied, { maxLength: 6 }), (settlements) => {
      const history = settlements.flatMap((settlement, index) =>
        settlement.kind === "applied" ? [{ authorityDigest: `digest-${index}`, transition: settlement.transition.kind }] : []);
      const released = history
        .filter((_, index) => distillSettlementOutcome([], settlements[index]!).retention === "discard")
        .map(({ authorityDigest }) => authorityDigest);
      expect(settledDistillSnapshotDigests({ agent: DISTILL_AGENT, implementation_attempt_history: history })).toEqual(released);
    }));
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
