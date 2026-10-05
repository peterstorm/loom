import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "./canonical-temp-dir";
import { git } from "./git-repository";
import { captureStandaloneCliEvidence as capture } from "./standalone-cli-capture";
import type { AgentRequestAuthority } from "../../src/core/orchestration-contract";
import type { RunDirHandle } from "../../src/orchestration/run-directory-handle";
import type { StandaloneReviewerPayloadV3 } from "../../src/core/standalone-lineage-contract";

export const CHECK_ID = "project:repair-regression";
export const REPORT_PATH = ".loom/completion-reports/repair.xml";
export const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function value<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  if (!result.ok) throw Error(JSON.stringify(result));
  return result.value;
}

/** Same enrolled fixed command as the existing P3 fixture; never edits the project manifest. */
export function successorRemediationRepository(): string {
  const root = canonicalTempDir("loom-p5-p3-");
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, ".loom/completion-reports"), { recursive: true });
  mkdirSync(join(root, ".claude/reviews/runs"), { recursive: true });
  writeFileSync(join(root, "src/repair.mjs"), "export const repaired = () => false;\n");
  writeFileSync(join(root, ".gitignore"), `${REPORT_PATH}\n.claude/reviews/\n`);
  writeFileSync(join(root, ".loom/verification-manifest.json"), JSON.stringify({
    schemaVersion: 1, kind: "loom-verification-manifest", checks: [{
      id: CHECK_ID, scope: "wave", executable: "node",
      args: ["--test", "--test-reporter=junit", `--test-reporter-destination=${REPORT_PATH}`, "tests/repair.test.mjs"],
      cwd: ".", timeoutMs: 15_000, report: { kind: "required-file", path: REPORT_PATH },
    }],
  }, null, 2));
  for (const args of [["init", "-q"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"],
    ["add", ".gitignore", ".loom/verification-manifest.json", "src/repair.mjs"], ["commit", "-qm", "owned vulnerable baseline"]]) git(root, args);
  writeFileSync(join(root, "src/repair.mjs"), "export const repaired = () => false; // reviewed\n");
  return root;
}

export function repairDeclaration(findings: string | readonly string[]) {
  const findingIds = typeof findings === "string" ? [findings] : findings;
  return { kind: "declared-defect-family-accounting", provenance: "DECLARED",
    dispositions: findingIds.map(findingId => ({ findingId, status: "repaired", repairGroupId: "group.predicate" })),
    groups: [{ kind: "declared-repair-group", provenance: "DECLARED", repairGroupId: "group.predicate", findingIds,
      rootCause: { provenance: "DECLARED", statement: "Vulnerable constant." },
      invariant: { provenance: "DECLARED", statement: "The repaired predicate returns true." },
      siblings: { kind: "none-declared", provenance: "DECLARED", reason: "No sibling implementation paths in this fixture." },
      checks: [{ checkId: CHECK_ID, historicalRed: { kind: "historical-red", provenance: "DECLARED",
        statement: "The assertion fails against the vulnerable constant.", reference: null } }],
    }],
  };
}

type Action = { kind: string; requests: readonly { authority: AgentRequestAuthority; task: string }[] };
export type SuccessorFixtureCapture = (handle: RunDirHandle, requests: Action["requests"], payload: StandaloneReviewerPayloadV3) => Promise<void>;

async function publishOriginalReview(runsRoot: string) {
  const handles = await import("../../src/orchestration/run-directory-handle");
  const standalone = await import("../../src/handlers/helpers/programs/standalone");
  const helpers = await import("../../src/handlers/helpers/programs/registration");
  const publisher = await import("../../src/handlers/helpers/programs/standalone-disposition");
  const { REVIEWER_PAYLOAD_EXAMPLE_V2 } = await import("../../src/core/reviewer-contract");
  const source = value(handles.createRunDirectory(runsRoot, "source"));
  const started = await standalone.startStandaloneFacade(source, { kind: "types", files: ["src/repair.mjs"], dryRun: false });
  if (!started.ok) throw Error(started.message);
  const critical = { ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!, file: "src/repair.mjs", line: 1 };
  for (const [index, { authority }] of (started.action as Action).requests.entries()) {
    await capture(source, authority, { schemaVersion: 2, kind: "standalone-review", findings: index === 0 ? [
      { ...critical, claim: "Original surviving assertion" }, { ...critical, claim: "Original refuted assertion" },
      { ...critical, claim: "Original subsequently resolved assertion" },
      { severity: "advisory", file: "src/repair.mjs", line: 1, claim: "Original advisory", reason: "Naming clarity" },
    ] : [] });
  }
  const sourceRegistration = value(helpers.parseRegistration(value(source.readProgramRegistration())));
  const panel = await standalone.resumeStandaloneFacade(source, sourceRegistration);
  if (!panel.ok || (panel.action as Action).kind !== "spawn-batch") throw Error(JSON.stringify(panel));
  for (const { authority } of (panel.action as Action).requests) {
    const packet = value(source.readContext(authority.contextDigest));
    const context = JSON.parse(Buffer.from(packet.fixedContext[0]!.bytes).toString());
    await capture(source, authority, { criterion: context.lens, verdicts: context.findings.map((finding: { id: string; claim: string }) => ({
      finding_id: finding.id, verdict: finding.claim === "Original refuted assertion" ? "refuted" : "upheld", reasoning: `Exact original ${context.lens} reason`,
    })) });
  }
  const originalDone = await standalone.resumeStandaloneFacade(source, sourceRegistration);
  if (!originalDone.ok || (originalDone.action as Action).kind !== "done") throw Error(JSON.stringify(originalDone));
  const originalBytes = readFileSync(join(source.runDirectory, "result.json"));
  const reference = { locator: source.runDirectory, runId: source.runId, resultDigest: hash(originalBytes) };
  const originalLineage = value(await publisher.readStandaloneDispositionSource(reference));
  return { handles, standalone, helpers, publisher, runsRoot, source, originalBytes, reference, originalLineage };
}

/** Invoke only INSIDE a whole-operation owned Pi session, before importing any shell. */
export async function publishedSuccessorForRemediation(root: string, mode: "complete" | "active" | "limited",
  nativeCapture?: SuccessorFixtureCapture, additionalScope: readonly string[] = []) {
  const { handles, standalone, helpers, publisher, runsRoot, source, originalBytes, reference, originalLineage } = await publishOriginalReview(join(root, nativeCapture === undefined ? ".claude/reviews/runs" : ".claude/reviews/review-and-fix-runs"));
  const sourceReader = await import("../../src/handlers/helpers/programs/standalone-source");
  const remediation = await import("../../src/handlers/helpers/programs/remediation");
  const accounting = await import("../../src/core/defect-family-accounting");
  const lineage = await import("../../src/core/standalone-finding-origin");
  const { parseStandaloneDispositionStartBytes } = await import("../../src/core/standalone-disposition-machine");
  const dispositionInput = value(parseStandaloneDispositionStartBytes(Buffer.from(JSON.stringify({ source: reference, previous: null,
    record: { schemaVersion: 1, source: reference, provenance: "DECLARED", revision: { kind: "initial" },
      entries: originalLineage.inventory.filter(row => ("draft" in row.finding ? row.finding.draft.severity : row.finding.severity) === "advisory")
        .map(row => ({ origin: lineage.standaloneOriginReference(row.origin), decision: "deferred", reason: "Nonblocking parent policy" })),
    } }))));
  const preparedPolicy = value(await publisher.prepareStandaloneDispositionFacadeStart(dispositionInput, runsRoot, "policy"));
  const policy = value(handles.createRunDirectory(runsRoot, "policy"));
  const publishedPolicy = await publisher.startStandaloneDispositionFacade(policy, preparedPolicy);
  if (!publishedPolicy.ok) throw Error(publishedPolicy.message);
  const publication = (publishedPolicy.action as { outcome: { publication: { locator: string; runId: string; dispositionDigest: string } } }).outcome.publication;
  writeFileSync(join(root, "src/repair.mjs"), "export const repaired = () => true;\n");
  const input = value(helpers.parseStandaloneStartInput({ schemaVersion: 3, kind: nativeCapture === undefined ? "types" : "all",
    files: nativeCapture === undefined ? ["src/repair.mjs"] : ["src/repair.mjs", "src/types.ts", "README.md", ...additionalScope], dryRun: false,
    successor: { source: reference, disposition: { kind: "selected-record", publication } } }));
  if (!("schemaVersion" in input)) throw Error("explicit successor required");
  const prepared = value(await standalone.prepareStandaloneSuccessorFacadeStart(runsRoot, "successor", input));
  const successor = value(handles.createRunDirectory(runsRoot, "successor"));
  const issued = await standalone.startPreparedStandaloneSuccessor(successor, prepared);
  if (!issued.ok) throw Error(issued.message);
  const requests = (issued.action as Action).requests;
  const packet = value(successor.readStandaloneSuccessorContext(requests[0]!.authority.contextDigest));
  const visible = JSON.parse(Buffer.from(packet.fixedContext.find(row => row.label === "standalone-lineage")!.bytes).toString());
  const payload: StandaloneReviewerPayloadV3 = { schemaVersion: 3, kind: "standalone-successor-review",
    lineageDigest: visible.lineageDigest, snapshotDigest: visible.snapshotDigest, findings: [],
    priorAssessments: originalLineage.inventory.map((row, index) => {
      const origin = lineage.standaloneOriginReference(row.origin);
      if (index === 1) return mode === "limited" ? { origin, verdict: "not-assessable", reason: "Current applicability unavailable" }
        : { origin, verdict: "retained", decisionDigest: lineage.standaloneDecisionReference(row.history.at(-1)!), reason: "Original refutation still applies" };
      if (index === 3 || (index === 0 && mode === "active")) return { origin, verdict: "still-present", reason: "Original assertion remains applicable" };
      return { origin, verdict: "repaired", reason: "Verified relevant changed implementation", change: { path: "src/repair.mjs", description: "Predicate now returns true" } };
    }),
  };
  if (nativeCapture === undefined) for (const { authority } of requests) await capture(successor, authority, payload);
  else await nativeCapture(successor, requests, payload);
  const registration = value(helpers.parseRegistration(value(successor.readProgramRegistration())));
  const done = await standalone.resumeStandaloneFacade(successor, registration);
  if (!done.ok || (done.action as Action).kind !== "done") throw Error(JSON.stringify(done));
  const bytes = readFileSync(join(successor.runDirectory, "result.json"));
  return { root, runsRoot, source, originalBytes, originalLineage, successor, registration, bytes, handles, standalone,
    sourceReader, remediation, accounting, requests };
}

export function addRepairTest(root: string): void {
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "tests/repair.test.mjs"), [
    'import test from "node:test";', 'import assert from "node:assert/strict";',
    'import { repaired } from "../src/repair.mjs";', 'test("repair predicate", () => assert.equal(repaired(), true));', "",
  ].join("\n"));
}
