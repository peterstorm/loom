import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  createCandidateRepositoryWitness,
  parseCandidateRepositoryWitness,
  prepareDefectFamilyAccounting,
  prepareDefectFamilyVerification,
} from "../../src/core/defect-family-accounting";
import { parseRepositorySnapshotWitness } from "../../src/core/remediation-machine";
import { VERIFICATION_MANIFEST_KIND, freezeVerificationManifest } from "../../src/core/verification-manifest";
import { standaloneFixture } from "../fixtures/standalone-remediation-authority";
import { value } from "../fixtures/parse-result";

const source = standaloneFixture(["src/main.ts", "src/property-family.ts"], true).input.standaloneResult;
const findingId = source.survivingCriticals[0]!.id;
const digest = (n: number): string => n.toString(16).padStart(64, "0").slice(-64);
const safeName = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/);
const safePath = safeName.map((name) => `src/${name}.ts`);
const checkIds = fc.uniqueArray(safeName.map((name) => `project:${name}`), { minLength: 1, maxLength: 8 });

function declarationRaw(ids: readonly string[], siblingPaths: readonly string[]) {
  return {
    kind: "declared-defect-family-accounting",
    provenance: "DECLARED",
    dispositions: [{ findingId, status: "repaired", repairGroupId: "family:property" }],
    groups: [{
      kind: "declared-repair-group",
      provenance: "DECLARED",
      repairGroupId: "family:property",
      findingIds: [findingId],
      rootCause: { provenance: "DECLARED", statement: "A generated root cause declaration." },
      invariant: { provenance: "DECLARED", statement: "A generated invariant declaration." },
      siblings: siblingPaths.length === 0
        ? { kind: "none-declared", provenance: "DECLARED", reason: "No generated sibling path." }
        : {
            kind: "declared-siblings",
            provenance: "DECLARED",
            entries: siblingPaths.map((path) => ({
              path,
              status: "checked-unmodified",
              reason: `Generated sibling declaration for ${path}.`,
            })),
          },
      checks: ids.map((checkId) => ({
        checkId,
        historicalRed: {
          kind: "historical-red",
          provenance: "DECLARED",
          statement: `The ${checkId} check distinguishes vulnerable behavior.`,
          reference: null,
        },
      })),
    }],
  };
}

function manifest(ids: readonly string[]) {
  return value(freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    kind: VERIFICATION_MANIFEST_KIND,
    checks: ids.map((id, index) => ({
      id,
      scope: "wave",
      executable: "bun",
      args: ["test", `tests/${index}.test.ts`],
      cwd: ".",
      timeoutMs: index + 1,
      report: { kind: "required-file", path: `.loom/completion-reports/${index}.json` },
    })),
  }))));
}

function rotate<T>(values: readonly T[], seed: number): readonly T[] {
  if (values.length === 0) return [];
  const offset = Math.abs(seed) % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)].reverse();
}

describe("Defect-Family Accounting properties", () => {
  it("is total over arbitrary declarations and candidate witnesses", () => {
    fc.assert(fc.property(fc.anything({ maxDepth: 5 }), (raw) => {
      expect(() => prepareDefectFamilyAccounting(source, raw)).not.toThrow();
      expect(() => parseCandidateRepositoryWitness(raw)).not.toThrow();
    }), { numRuns: 500 });
  });

  it("canonicalizes declaration, group membership, sibling, and check permutations", () => {
    fc.assert(fc.property(
      checkIds,
      fc.uniqueArray(safePath, { minLength: 0, maxLength: 8 }),
      fc.integer(),
      (ids, siblings, seed) => {
        const baseline = value(prepareDefectFamilyAccounting(source, declarationRaw(ids, siblings)));
        const raw = declarationRaw(rotate(ids, seed), rotate(siblings, ~seed));
        const permuted = value(prepareDefectFamilyAccounting(source, raw));

        expect(permuted).toEqual(baseline);
        expect(permuted.selectedCheckIds).toEqual([...ids].sort());
        expect(permuted.siblingPaths).toEqual([...siblings].sort());
        const plan = value(prepareDefectFamilyVerification(permuted, manifest(ids)));
        expect(plan.kind).toBe("selected-operator-checks");
        if (plan.kind === "selected-operator-checks") {
          expect(plan.commands.map(({ checkId }) => checkId)).toEqual([...ids].sort());
        }
      },
    ), { numRuns: 100 });
  });

  it("never admits deletion, duplication, overlap, or foreign insertion in the critical partition", () => {
    fc.assert(fc.property(checkIds, safeName, (ids, foreignSuffix) => {
      const raw = declarationRaw(ids, []);
      const group = raw.groups[0]!;
      const mutations: readonly unknown[] = [
        { ...raw, dispositions: [] },
        { ...raw, dispositions: [...raw.dispositions, raw.dispositions[0]!] },
        { ...raw, dispositions: [{ ...raw.dispositions[0], findingId: `foreign-${foreignSuffix}` }] },
        { ...raw, groups: [{ ...group, findingIds: [] }] },
        { ...raw, groups: [{ ...group, findingIds: [findingId, findingId] }] },
        { ...raw, groups: [{ ...group, findingIds: [findingId, `foreign-${foreignSuffix}`] }] },
        { ...raw, groups: [...raw.groups, { ...group, repairGroupId: "family:orphan", findingIds: [findingId] }] },
      ];
      for (const mutation of mutations) {
        expect(prepareDefectFamilyAccounting(source, mutation).ok).toBe(false);
      }
    }), { numRuns: 100 });
  });

  it("binds candidate identity to every workspace, Git, count, and exact exclusion fact", () => {
    fc.assert(fc.property(
      fc.uniqueArray(safeName, { minLength: 0, maxLength: 8 }),
      (names) => {
        const gitWitness = value(parseRepositorySnapshotWitness({
          baseTreeDigest: digest(1), indexDigest: digest(2), worktreeDigest: digest(3),
        }));
        const exclusions = names.map((name) => `.loom/completion-reports/${name}.json`);
        const left = value(createCandidateRepositoryWitness({
          kind: "candidate-repository-witness",
          repositoryRoot: "/repo",
          workspaceDigest: digest(4),
          pathCount: names.length,
          observedPaths: names.map((name) => `src/${name}.ts`),
          gitWitness,
          generatedReportExclusions: exclusions,
        }));
        const reordered = value(parseCandidateRepositoryWitness({
          ...left,
          generatedReportExclusions: [...exclusions].reverse(),
        }));
        expect(reordered).toEqual(left);

        const stale = parseCandidateRepositoryWitness({ ...left, pathCount: names.length + 1 });
        expect(stale.ok).toBe(false);
      },
    ));
  });

  it("takes immutable snapshots instead of retaining caller-owned arrays or declaration records", () => {
    fc.assert(fc.property(checkIds, fc.uniqueArray(safePath, { minLength: 1, maxLength: 8 }), (ids, siblings) => {
      const raw = declarationRaw(ids, siblings);
      const accounting = value(prepareDefectFamilyAccounting(source, raw));
      const parsed = accounting.declaration;
      const firstGroup = raw.groups[0]!;
      const firstCheckId = accounting.selectedCheckIds[0];
      const firstSibling = parsed.kind === "declared-defect-family-accounting" &&
        parsed.groups[0]?.siblings.kind === "declared-siblings"
        ? parsed.groups[0].siblings.entries[0]?.path
        : undefined;

      raw.dispositions.length = 0;
      raw.groups.length = 0;
      firstGroup.findingIds.length = 0;
      firstGroup.checks.length = 0;
      if (firstGroup.siblings.kind === "declared-siblings" && firstGroup.siblings.entries !== undefined) {
        firstGroup.siblings.entries.length = 0;
      }

      expect(accounting.selectedCheckIds[0]).toBe(firstCheckId);
      expect(accounting.siblingPaths).toEqual([...siblings].sort());
      if (parsed.kind === "declared-defect-family-accounting") {
        expect(parsed.dispositions).toHaveLength(1);
        expect(parsed.groups).toHaveLength(1);
        if (parsed.groups[0]?.siblings.kind === "declared-siblings") {
          expect(parsed.groups[0].siblings.entries[0]?.path).toBe(firstSibling);
        }
        expect(Object.isFrozen(parsed.groups[0]?.checks)).toBe(true);
      }
    }), { numRuns: 100 });
  });
});
