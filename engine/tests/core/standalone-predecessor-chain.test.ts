import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { publishedPacketReference } from "../../src/core/predecessor-archive";
import {
  PREDECESSOR_TRAVERSAL_LIMITS, admitAnchoredRunAuthority, chargePredecessorBytes, enterPredecessorRun, predecessorAttemptRoster,
  predecessorContextLabel, predecessorFrozenSourceText, predecessorReadBound, predecessorTraversal, resumeAfterChildWalk,
} from "../../src/core/standalone-predecessor-chain";
import type { StandalonePreviousSnapshot } from "../../src/core/standalone-lineage-contract";

const MiB64 = 64 * 1024 * 1024;

describe("predecessor traversal: Run bound and cycles", () => {
  it("starts with the carried 64 MiB budget and clamps any larger caller budget", () => {
    expect(predecessorTraversal()).toEqual({ visited: [], remaining: MiB64 });
    expect(predecessorTraversal(["/a"], MiB64 * 4).remaining).toBe(MiB64);
    expect(predecessorTraversal([], -1).remaining).toBe(0);
    expect(Object.isFrozen(predecessorTraversal(["/a"]).visited)).toBe(true);
  });

  it("enters distinct Runs up to the 64-Run bound and refuses the next", () => {
    let walk = predecessorTraversal();
    for (let index = 0; index < PREDECESSOR_TRAVERSAL_LIMITS.runs; index++) {
      const entered = enterPredecessorRun(walk, `/runs/r${index}`);
      if (!entered.ok) throw Error(entered.error);
      walk = entered.value;
    }
    expect(walk.visited).toHaveLength(64);
    expect(enterPredecessorRun(walk, "/runs/next")).toEqual({ ok: false, error: "predecessor traversal is cyclic or exceeds 64 Runs" });
  });

  it("refuses re-entering any visited Run, and never mutates the walk it was given", () => {
    fc.assert(fc.property(fc.uniqueArray(fc.stringMatching(/^\/r[0-9a-z]{1,8}$/), { minLength: 1, maxLength: 20 }), fc.nat(), (dirs, pick) => {
      const walk = predecessorTraversal(dirs, 1024);
      const before = JSON.stringify(walk);
      expect(enterPredecessorRun(walk, dirs[pick % dirs.length]!).ok).toBe(false);
      const fresh = enterPredecessorRun(walk, "/fresh");
      expect(fresh.ok && fresh.value.visited).toEqual([...dirs, "/fresh"]);
      expect(fresh.ok && fresh.value.remaining).toBe(1024);
      expect(JSON.stringify(walk)).toBe(before);
    }));
  });
});

describe("predecessor traversal: observed-byte budget", () => {
  it("charges exactly what was observed until the budget is spent, then refuses", () => {
    fc.assert(fc.property(fc.array(fc.nat({ max: 4096 }), { maxLength: 30 }), fc.nat({ max: 65536 }), (reads, budget) => {
      let walk = predecessorTraversal([], budget);
      let spent = 0;
      for (const observed of reads) {
        const charged = chargePredecessorBytes(walk, observed, "read");
        if (spent + observed > budget) {
          expect(charged).toEqual({ ok: false, error: "read exceeds the traversal byte budget" });
          return;
        }
        if (!charged.ok) throw Error(charged.error);
        spent += observed;
        walk = charged.value;
        expect(walk.remaining).toBe(budget - spent);
      }
    }));
  });

  it("refuses a non-integral or negative observation", () => {
    expect(chargePredecessorBytes(predecessorTraversal(), -1, "read").ok).toBe(false);
    expect(chargePredecessorBytes(predecessorTraversal(), 0.5, "read").ok).toBe(false);
  });

  it("bounds a single read by the remaining budget", () => {
    expect(predecessorReadBound(predecessorTraversal([], 10), 16_777_216)).toBe(10);
    expect(predecessorReadBound(predecessorTraversal([], MiB64), 16_777_216)).toBe(16_777_216);
  });

  it("returns a child walk's remaining budget to the parent's own visited chain", () => {
    const parent = predecessorTraversal(["/p"], 1000);
    const child = enterPredecessorRun(parent, "/c");
    if (!child.ok) throw Error(child.error);
    const spent = chargePredecessorBytes(child.value, 300, "read");
    if (!spent.ok) throw Error(spent.error);
    expect(resumeAfterChildWalk(parent, spent.value)).toEqual({ visited: ["/p"], remaining: 700 });
  });
});

describe("predecessor issued attempt roster", () => {
  const request = (role: string, attempt: number, program = "standalone-review") => ({ program, role, attempt, id: `${role}#${attempt}` });

  it("orders each role's attempt 1, then an optional attempt 2", () => {
    const roster = predecessorAttemptRoster([request("b", 2), request("a", 1), request("b", 1), request("a", 1, "wave-gate")], ["a", "b"]);
    expect(roster.ok && roster.value.map(row => [row.role, row.attempts.map(item => item.id)])).toEqual([["a", ["a#1"]], ["b", ["b#1", "b#2"]]]);
  });

  it.each([
    ["no issued attempt", [], ["a"]],
    ["only a retry", [request("a", 2)], ["a"]],
    ["a third attempt", [request("a", 1), request("a", 2), request("a", 3)], ["a"]],
    ["a duplicated first attempt", [request("a", 1), request("a", 1)], ["a"]],
    ["an attempt from another program only", [request("a", 1, "wave-gate")], ["a"]],
  ])("refuses %s", (_name, requests, roles) => {
    expect(predecessorAttemptRoster(requests, roles)).toEqual({ ok: false, error: "predecessor context requires exact issued attempt roster" });
  });

  it("labels attempt 1 by role and attempt 2 with its suffix", () => {
    expect(predecessorContextLabel("code-reviewer", 1)).toBe("predecessor-context:code-reviewer");
    expect(predecessorContextLabel("code-reviewer", 2)).toBe("predecessor-context:code-reviewer:attempt-2");
  });
});

describe("predecessor frozen-source projection", () => {
  const snapshot: StandalonePreviousSnapshot = [{ kind: "historical-unknown", path: "src/a.ts" }];
  const bytes = new Uint8Array(Buffer.from("{}"));
  const gzip = { encoding: "gzip-base64", byteLength: 2, digest: publishedPacketReference(bytes, "/a", "v1-v2").digest, compressed: new Uint8Array() } as const;

  it("points a published reference's reader at the archive and original source", () => {
    const text = predecessorFrozenSourceText(publishedPacketReference(bytes, "/a", "v1-v2"), [], snapshot, "predecessor-context:r", "v1-v2");
    expect(JSON.parse(text)).toEqual({ kind: "published-source-reference", snapshot, archive: "predecessor-context:r", purpose: "v1-v2",
      usage: "Use --archive with this label and --archive-purpose, then --file EXACT_PATH to read original source." });
  });

  it("keeps an inline archive's exact frozen source, or honest historical absence", () => {
    expect(predecessorFrozenSourceText(gzip, [new Uint8Array(Buffer.from("SOURCE"))], snapshot, "l", "v1-v2")).toBe("SOURCE");
    expect(JSON.parse(predecessorFrozenSourceText(gzip, [], snapshot, "l", "v1-v2"))).toEqual({ kind: "historical-unknown", snapshot });
  });
});

describe("anchored source Run authority", () => {
  const anchored = { runId: "run-1", runsRoot: "/runs", runDirectory: "/runs/run-1" };

  it("admits exactly the anchored authority record", () => {
    expect(admitAnchoredRunAuthority({ schemaVersion: 1, ...anchored }, anchored)).toEqual({ ok: true, value: true });
  });

  it.each([
    ["another Run", { schemaVersion: 1, ...anchored, runId: "run-2" }],
    ["an extra field", { schemaVersion: 1, ...anchored, moved: true }],
    ["another schema", { schemaVersion: 2, ...anchored }],
  ])("refuses %s", (_name, observed) => {
    expect(admitAnchoredRunAuthority(observed, anchored)).toEqual({ ok: false, error: "source Run authority changed during authentication" });
  });
});
