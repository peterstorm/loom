/**
 * The plan design review end to end (ADR-0070): a `plan-design` Standalone
 * Review of the architecture plan, the helper that accepts its published
 * result into the State File, and the decompose gate that reads the record.
 * Real Git, real Run Directories and the real State File; reviewers are
 * scripted through the engine's own capture seam.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Bytes } from "../../../src/core/digest";
import type { AgentRequestAuthority } from "../../../src/core/orchestration-contract";
import { PLAN_DESIGN_LENS_SECTION, PLAN_DESIGN_REVIEWERS, renderPlanDesignLens } from "../../../src/core/plan-design-review";
import { REVIEWER_PAYLOAD_EXAMPLE_V2 } from "../../../src/core/reviewer-contract";
import { parseStandaloneDispositionStartBytes } from "../../../src/core/standalone-disposition-machine";
import { standaloneOriginReference } from "../../../src/core/standalone-finding-origin";
import { STANDALONE_FROZEN_DIFF_SECTION, parseFrozenDiff } from "../../../src/core/standalone-read-coverage";
import type { StandaloneReviewKind } from "../../../src/core/standalone-review-scope";
import { unifiedDiff } from "../../../src/core/unified-diff";
import { checkArtifacts } from "../../../src/core/validate-phase-order";
import acceptPlanDesignReview from "../../../src/handlers/helpers/accept-plan-design-review";
import { parseRegistration } from "../../../src/handlers/helpers/programs/registration";
import { resumeStandaloneFacade, startStandaloneFacade } from "../../../src/handlers/helpers/programs/standalone";
import {
  prepareStandaloneDispositionFacadeStart, readStandaloneDispositionSource, startStandaloneDispositionFacade,
} from "../../../src/handlers/helpers/programs/standalone-disposition";
import { WHOLE_DOCUMENT_BASE } from "../../../src/handlers/helpers/programs/standalone-requests";
import { realArtifactProbe } from "../../../src/handlers/pre-tool-use/validate-phase-order";
import { createRunDirectory, type RunDirHandle } from "../../../src/orchestration/run-directory-handle";
import { resolveInitialState } from "../../../src/phase-init";
import { StateManager } from "../../../src/state-manager";
import type { HookResult } from "../../../src/types";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { git } from "../../fixtures/git-repository";
import { value } from "../../fixtures/parse-result";
import { disposeFixturePiSessions, withFixturePiSession as inDirectory } from "../../fixtures/pi-session";
import { captureReviewedTranscript } from "../../fixtures/read-coverage";

const PLAN = ".claude/plans/feature.md";
const PLAN_TEXT = "# Feature plan\n\n## Types\n\n`Order = draft | submitted`\n\n## Modules\n\nA pure core and a thin shell.\n";
const STATE = ".claude/state/active_task_graph.json";

type Requests = readonly Readonly<{ authority: AgentRequestAuthority; task: string }>[];
type ScriptedFinding = Readonly<{ severity: "advisory" | "critical"; file: string; line: number; claim: string }> & Readonly<Record<string, unknown>>;
type Verdict = "upheld" | "refuted";

const roots: string[] = [];
afterEach(() => {
  disposeFixturePiSessions();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A repository whose orchestration has reached plan-alignment with `PLAN`
 * recorded. `committed` puts the plan in the baseline commit; otherwise it is
 * an untracked file, as an architecture agent leaves it.
 */
function project(options: Readonly<{ committed?: boolean; skipPlanDesignReview?: boolean }> = {}): string {
  const root = canonicalTempDir("loom-plan-design-");
  roots.push(root);
  for (const directory of ["runs", ".claude/plans", ".claude/state"]) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Fixture\n");
  writeFileSync(join(root, PLAN), PLAN_TEXT);
  for (const args of [["init", "-q"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"],
    ["add", "README.md", ...(options.committed ? [PLAN] : [])], ["commit", "-qm", "fixture baseline"]]) git(root, args);
  writeFileSync(join(root, STATE), JSON.stringify({
    ...resolveInitialState({ skipPlanAlignment: true, skipPlanDesignReview: options.skipPlanDesignReview }, ".claude/specs/feature"),
    current_phase: "decompose",
    plan_file: PLAN,
  }));
  return root;
}

async function start(root: string, run: string, kind: StandaloneReviewKind = "plan-design", files: readonly string[] = [PLAN]) {
  const handle = value(createRunDirectory(join(root, "runs"), run));
  const started = await inDirectory(root, () => startStandaloneFacade(handle, { kind, files, dryRun: false }));
  if (!started.ok) throw new Error(started.message);
  return { handle, requests: (started.action as { requests: Requests }).requests };
}

/** One Refutation Panel verifier's answer: `verdict` on every finding its brief names. */
function panelAnswer(handle: RunDirHandle, authority: AgentRequestAuthority, verdict: Verdict): string {
  const section = value(handle.readContext(authority.contextDigest)).fixedContext.find(({ label }) => label === "refutation-authority")!;
  const brief = JSON.parse(Buffer.from(section.bytes).toString("utf8")) as { lens: string; findings: readonly { id: string }[] };
  return JSON.stringify({
    criterion: brief.lens,
    verdicts: brief.findings.map(({ id }) => ({ finding_id: id, verdict, reasoning: `The frozen plan shows the claim is ${verdict}.` })),
  });
}

/**
 * Every reviewer reads its whole frozen diff and returns `findings` (the first
 * reviewer) or nothing; a Refutation Panel, when criticals call one, answers
 * `panel` on each. The review is published.
 */
async function review(
  root: string, handle: RunDirHandle, requests: Requests, findings: readonly ScriptedFinding[] = [], panel: Verdict = "upheld",
) {
  const resume = () => inDirectory(root, () =>
    resumeStandaloneFacade(handle, value(parseRegistration(value(handle.readProgramRegistration())))));
  for (const [index, { authority }] of requests.entries()) {
    const payload = { schemaVersion: 2, kind: "standalone-review", findings: index === 0 ? findings : [] };
    value(await captureReviewedTranscript(handle, authority, [...Buffer.from(JSON.stringify(payload))]));
  }
  let next = await resume();
  if (next.ok && next.action.kind === "spawn-batch") {
    for (const { authority } of (next.action as { requests: Requests }).requests) {
      value(await captureReviewedTranscript(handle, authority, [...Buffer.from(panelAnswer(handle, authority, panel))]));
    }
    next = await resume();
  }
  expect(next).toMatchObject({ ok: true, action: { kind: "done" } });
}

const accept = (root: string, run: string, extra: readonly string[] = []): Promise<HookResult> =>
  inDirectory(root, () => acceptPlanDesignReview("", ["--runs-root", join(root, "runs"), "--run", run, ...extra]));

const recorded = (root: string) =>
  inDirectory(root, async () => StateManager.fromPath(STATE)!.load().plan_design_review);

const decomposeGate = (root: string) =>
  inDirectory(root, async () => checkArtifacts("decompose", StateManager.fromPath(STATE)!.load(), realArtifactProbe));

/** Publish a disposition deferring every advisory of the review at `run`; returns its reference flags. */
async function publishDisposition(root: string, run: string, policyRun: string): Promise<readonly string[]> {
  const locator = join(root, "runs", run);
  const source = { locator, runId: run, resultDigest: sha256Bytes(readFileSync(join(locator, "result.json"))) };
  return inDirectory(root, async () => {
    const lineage = value(await readStandaloneDispositionSource(source));
    const input = value(parseStandaloneDispositionStartBytes(Buffer.from(JSON.stringify({ source, previous: null, record: {
      schemaVersion: 1, source, provenance: "DECLARED", revision: { kind: "initial" },
      entries: lineage.inventory.map((row) => ({ origin: standaloneOriginReference(row.origin), decision: "deferred", reason: "Tracked for the implementation" })),
    } }))));
    const registration = value(await prepareStandaloneDispositionFacadeStart(input, join(root, "runs"), policyRun));
    const published = await startStandaloneDispositionFacade(value(createRunDirectory(join(root, "runs"), policyRun)), registration);
    const outcome = published.ok && published.action.kind === "done" ? published.action.outcome : null;
    if (outcome === null || typeof outcome !== "object" || !("publication" in outcome)) throw new Error(`disposition was not published: ${JSON.stringify(published)}`);
    const { publication } = outcome;
    return ["--disposition", publication.locator, "--disposition-run", publication.runId, "--disposition-digest", publication.dispositionDigest];
  });
}

const ADVISORY: ScriptedFinding = {
  severity: "advisory", file: PLAN, line: 5, claim: "Order could carry its submit time", reason: "A later state will need it",
};
const CRITICAL: ScriptedFinding = {
  ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0], severity: "critical", file: PLAN, line: 5, claim: "Order has no state for a failed payment",
};

describe.sequential("plan design review", { timeout: 60_000 }, () => {
  it.each([
    ["an untracked plan", false],
    ["a plan already committed at the review baseline", true],
  ])("issues the fixed roster, each role's lens and the whole plan as the read obligation for %s", async (_label, committed) => {
    const root = project({ committed });
    const { handle, requests } = await start(root, "design");
    expect(requests.map(({ authority }) => authority.role)).toEqual(PLAN_DESIGN_REVIEWERS);
    for (const { authority, task } of requests) {
      const packet = value(handle.readContext(authority.contextDigest));
      const section = (label: string) =>
        Buffer.from(packet.fixedContext.find((entry) => entry.label === label)!.bytes).toString("utf8");
      expect(section(PLAN_DESIGN_LENS_SECTION)).toBe(renderPlanDesignLens(authority.role as (typeof PLAN_DESIGN_REVIEWERS)[number]));
      const diff = value(parseFrozenDiff(JSON.parse(section(STANDALONE_FROZEN_DIFF_SECTION))));
      expect(diff.baseRevision).toBe(WHOLE_DOCUMENT_BASE);
      expect(diff.files).toEqual([expect.objectContaining({ path: PLAN, kind: "text-diff", text: unifiedDiff(PLAN, null, PLAN_TEXT) })]);
      expect(task).toContain("LOOM_READ_COVERAGE: every-frozen-diff-unit");
    }
  });

  it("accepts a clean review, opens decompose, and closes it again when the plan is edited", async () => {
    const root = project();
    expect(await decomposeGate(root)).toContain("has no accepted design review");
    const { handle, requests } = await start(root, "design");
    await review(root, handle, requests);
    expect(await accept(root, "design")).toEqual({ kind: "allow" });
    expect(await recorded(root)).toEqual({
      status: "accepted",
      planSha256: sha256Bytes(Buffer.from(PLAN_TEXT)),
      runId: "design",
      resultDigest: sha256Bytes(readFileSync(join(handle.runDirectory, "result.json"))),
    });
    expect(await decomposeGate(root)).toBeNull();
    // Accepting the same review again records the same acceptance.
    expect(await accept(root, "design")).toEqual({ kind: "allow" });

    writeFileSync(join(root, PLAN), `${PLAN_TEXT}\n## Added after review\n`);
    expect(await decomposeGate(root)).toContain("changed after its design review was accepted");
    expect(await accept(root, "design")).toMatchObject({ kind: "error", message: expect.stringContaining("the plan changed after it was reviewed") });

    const again = await start(root, "design-2");
    await review(root, again.handle, again.requests);
    expect(await accept(root, "design-2")).toEqual({ kind: "allow" });
    expect(await decomposeGate(root)).toBeNull();
  });

  it("needs a published disposition of this review before advisories are accepted", async () => {
    const root = project();
    const { handle, requests } = await start(root, "design");
    await review(root, handle, requests, [ADVISORY]);
    expect(await accept(root, "design")).toMatchObject({ kind: "error", message: expect.stringContaining("1 advisory finding(s) have no published disposition") });
    expect(await recorded(root)).toEqual({ status: "required" });

    const other = await start(root, "other");
    await review(root, other.handle, other.requests, [ADVISORY]);
    const foreign = await publishDisposition(root, "other", "other-policy");
    expect(await accept(root, "design", foreign)).toMatchObject({ kind: "error", message: expect.stringContaining("not a published disposition of this review") });
    expect(await accept(root, "design", foreign.slice(0, 2))).toMatchObject({ kind: "error", message: expect.stringContaining("together") });
    expect(await recorded(root)).toEqual({ status: "required" });

    expect(await accept(root, "design", await publishDisposition(root, "design", "policy"))).toEqual({ kind: "allow" });
    expect(await decomposeGate(root)).toBeNull();
  });

  it("never accepts a review whose critical survived refutation; the edited plan is reviewed afresh", async () => {
    const root = project();
    const { handle, requests } = await start(root, "design");
    await review(root, handle, requests, [CRITICAL], "upheld");
    const refused = await accept(root, "design");
    expect(refused).toMatchObject({ kind: "error", message: expect.stringContaining("1 critical finding(s) survived refutation (code-reviewer-1)") });
    expect(refused).toMatchObject({ message: expect.stringContaining("edit the plan to resolve them") });
    expect(await recorded(root)).toEqual({ status: "required" });
    expect(await decomposeGate(root)).toContain("has no accepted design review");

    writeFileSync(join(root, PLAN), `${PLAN_TEXT}\n\`Order = draft | submitted | payment-failed\`\n`);
    const again = await start(root, "design-2");
    await review(root, again.handle, again.requests);
    expect(await accept(root, "design-2")).toEqual({ kind: "allow" });
    expect(await decomposeGate(root)).toBeNull();
  });

  it("accepts a review whose only critical the Refutation Panel refuted", async () => {
    const root = project();
    const { handle, requests } = await start(root, "design");
    await review(root, handle, requests, [CRITICAL], "refuted");
    expect(await accept(root, "design")).toEqual({ kind: "allow" });
    expect(await decomposeGate(root)).toBeNull();
  });

  it("refuses a review of the plan under another kind, and a review that is not finished", async () => {
    const root = project();
    const architecture = await start(root, "architecture", "architecture");
    await review(root, architecture.handle, architecture.requests);
    expect(await accept(root, "architecture")).toMatchObject({ kind: "error", message: expect.stringContaining('not exactly ["plan-design"]') });

    await start(root, "unfinished");
    expect(await accept(root, "unfinished")).toMatchObject({ kind: "error", message: expect.stringContaining("accept-plan-design-review:") });
    expect((await accept(root, "never-started")).kind).toBe("error");
    expect((await inDirectory(root, () => acceptPlanDesignReview("", ["--run", "design"]))))
      .toMatchObject({ kind: "error", message: expect.stringContaining("Usage: helper accept-plan-design-review") });
    expect(await recorded(root)).toEqual({ status: "required" });
  });

  it("refuses a plan-design review whose one file is not the plan this orchestration names", async () => {
    const root = project();
    writeFileSync(join(root, ".claude/plans/other.md"), "# Another plan\n");
    const { handle, requests } = await start(root, "other-plan", "plan-design", [".claude/plans/other.md"]);
    await review(root, handle, requests);
    expect(await accept(root, "other-plan")).toMatchObject({ kind: "error", message: expect.stringContaining(`not exactly the plan ["${PLAN}"]`) });
  });

  it("leaves decompose open when the review was skipped at init, and still records an acceptance on request", async () => {
    const root = project({ skipPlanDesignReview: true });
    expect(await decomposeGate(root)).toBeNull();
    const { handle, requests } = await start(root, "design");
    await review(root, handle, requests);
    expect(await accept(root, "design")).toEqual({ kind: "allow" });
    expect(await recorded(root)).toMatchObject({ status: "accepted", runId: "design" });
  });
});
