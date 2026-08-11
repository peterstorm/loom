import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createAtomicInitialPublicationClaimPort,
  createInitialBatchPublicationReconciler,
  createInitialPublicationEffectPort,
  prepareInitialBatchPublicationIntent,
  spawnBatchAction,
} from "../../../src/core/orchestration-contract";
import {
  bindStandaloneCaptureAuthority,
  prepareStandaloneReview,
} from "../../../src/core/standalone-review";
import { prepareStandaloneReviewHarnessCapture } from "../../../src/handlers/helpers/standalone-review";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const CLI = join(ROOT, "engine/src/cli.ts");

const cleanReviewOutput = [
  "### Machine Summary",
  "CRITICAL_COUNT: 0",
  "ADVISORY_COUNT: 1",
  "CRITICAL:",
  "ADVISORY: improve the name",
  "```findings",
  JSON.stringify([
    { severity: "advisory", file: "src/x.ts", line: 2, claim: "improve the name" },
  ]),
  "```",
].join("\n");

const reviewOutput = [
  "### Machine Summary",
  "CRITICAL_COUNT: 1",
  "ADVISORY_COUNT: 1",
  "CRITICAL: impossible failure",
  "ADVISORY: improve the name",
  "```findings",
  JSON.stringify([
    { severity: "critical", file: "src/x.ts", line: 1, claim: "impossible failure" },
    { severity: "advisory", file: "src/x.ts", line: 2, claim: "improve the name" },
  ]),
  "```",
].join("\n");

describe("standalone review helper and refutation adapter", () => {
  let tmp: string;
  let runDir: string;
  const runsRoot = ".claude/reviews/review-and-fix-runs";

  const cli = (handler: string, args: string[], stdin = "") => spawnSync(
    "bun", [CLI, "helper", handler, ...args], { cwd: tmp, input: stdin, encoding: "utf-8" },
  );

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "loom-standalone-review-"));
    runDir = join(runsRoot, "run.abcdef12");
    mkdirSync(join(tmp, runDir, "reviewers"), { recursive: true });
    writeFileSync(join(tmp, runDir, "reviewers/1-code-reviewer.md"), reviewOutput);
    writeFileSync(join(tmp, runDir, "review-input.json"), JSON.stringify({
      reviews: [{ agent: "code-reviewer", transcript: join(runDir, "reviewers/1-code-reviewer.md") }],
    }));
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const initialize = (agents: string[] = ["code-reviewer"]) => {
    writeFileSync(join(tmp, runDir, "review-plan.json"), JSON.stringify({ scope: ["src/x.ts"], expected_agents: agents }));
    const run = cli("standalone-review", ["init", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-plan.json")]);
    expect(run.status, run.stderr).toBe(0);
  };

  it("exposes request-bound direct raw capture to harness completion adapters", () => {
    const runId = "run.capture-route";
    const binding = {
      profile: "general-review",
      pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
      claude: { harness: "claude-code", model: "sonnet" },
    } as const;
    const request = {
      runId,
      requestId: "request:capture-route:1",
      slotId: "slot:capture-route",
      program: "standalone-review" as const,
      role: "code-reviewer" as const,
      attempt: 1 as const,
      modelProfile: binding.profile,
      harnessBinding: { pi: binding.pi, claude: binding.claude },
      requiredSkill: null,
      contextDigest: "1".repeat(64),
      outputSlot: "transcripts/capture-route/attempt-1.raw",
    };
    const authority = prepareStandaloneReview({
      runId,
      explicitScope: ["src/x.ts"],
      changedPaths: {
        unstaged: ["src/x.ts"], staged: [], committed: [],
        base_revision: null, head_revision: "HEAD",
      },
      reviewMetadata: {
        requested_kinds: ["comments"], docs_only: false, source_or_test_changed: false,
        types_changed: false, comments_changed: false, additions: 1, file_count: 1,
        new_structure: false, languages: ["TypeScript"],
      },
      scopeSafety: [{ path: "src/x.ts", status: "safe" }],
      roster: [{
        slotId: request.slotId,
        attempts: [request, {
          ...request,
          requestId: "request:capture-route:2",
          attempt: 2,
          contextDigest: "2".repeat(64),
          outputSlot: "transcripts/capture-route/attempt-2.raw",
        }],
      }],
    });
    expect(authority.ok).toBe(true);
    if (!authority.ok) return;
    const rawRequests = [{
      authority: authority.value.initialRequests[0],
      context: {
        digest: authority.value.initialRequests[0].contextDigest,
        slot: `contexts/${authority.value.initialRequests[0].contextDigest}.json`,
      },
    }];
    const publication = prepareInitialBatchPublicationIntent(runId, "effect:capture-route-batch", rawRequests);
    expect(publication.ok).toBe(true);
    if (!publication.ok) return;
    const receipt = {
      schemaVersion: 1 as const,
      kind: "batch-published" as const,
      effectId: publication.value.identity.effectId,
      runId: publication.value.identity.runId,
      requestIds: publication.value.requestIds,
      contextDigests: publication.value.contextDigests,
      issuedRequests: publication.value.issuedRequests,
      publicationDigest: publication.value.identity.publicationDigest,
    };
    const receiptBytes = [...new TextEncoder().encode(JSON.stringify(receipt))];
    const issuance = createInitialBatchPublicationReconciler(
      createInitialPublicationEffectPort(() => ({ ok: true, value: receiptBytes })),
      createAtomicInitialPublicationClaimPort((claim) => ({
        ok: true,
        value: {
          schemaVersion: 1,
          kind: "initial-publication-claimed",
          key: claim.key,
          identity: claim.identity,
        },
      })),
    )(publication.value);
    expect(issuance.ok).toBe(true);
    if (!issuance.ok) return;
    const action = spawnBatchAction(issuance.value, rawRequests);
    expect(action.ok).toBe(true);
    if (!action.ok) return;
    const captureAuthority = bindStandaloneCaptureAuthority(authority.value.authority, action.value.requests);
    expect(captureAuthority.ok).toBe(true);
    if (!captureAuthority.ok) return;

    const bytes = Buffer.from("exact harness completion bytes\n", "utf-8");
    const captured = prepareStandaloneReviewHarnessCapture({
      captureAuthority: captureAuthority.value,
      requestId: request.requestId,
      rawBytes: bytes,
    });
    expect(captured.ok).toBe(true);
    if (captured.ok) {
      expect(captured.value.request.requestId).toBe(request.requestId);
      expect(captured.value.intent.request.outputSlot.path).toBe(request.outputSlot);
      expect(captured.value.intent.bytes).toEqual([...bytes]);
      expect(captured.value.expectedArtifact.digest).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
    expect(prepareStandaloneReviewHarnessCapture({
      captureAuthority: captureAuthority.value,
      requestId: "request:foreign",
      rawBytes: bytes,
    }).ok).toBe(false);
  });

  it("runs end to end without creating or mutating orchestration state", () => {
    initialize();
    let run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status, run.stderr).toBe(0);
    const aggregate = JSON.parse(run.stdout);
    expect(aggregate.findings).toHaveLength(2);

    run = cli("review-panel", ["brief", "--runs-root", runsRoot, "--run-dir", runDir, "--standalone", join(runDir, "aggregate.json")]);
    expect(run.status, run.stderr).toBe(0);
    const brief = JSON.parse(run.stdout);
    expect(brief.source_kind).toBe("standalone");
    expect(brief.findings).toHaveLength(1);

    run = cli("review-panel", ["manifest", "--runs-root", runsRoot, "--run-dir", runDir]);
    expect(run.status, run.stderr).toBe(0);
    const manifest = JSON.parse(run.stdout);
    const findingId = manifest.findings[0].id;

    for (const [index, lens] of manifest.lenses.entries()) {
      const raw = JSON.stringify({
        criterion: lens,
        verdicts: [{
          finding_id: findingId,
          verdict: index < 2 ? "refuted" : "upheld",
          reasoning: index < 2 ? `refuted through ${lens}` : "claim still appears plausible",
        }],
      });
      run = cli("review-panel", ["verdict", "--lens", lens, "--runs-root", runsRoot, "--manifest", join(runDir, "manifest.json")], raw);
      expect(run.status, run.stderr).toBe(0);
      writeFileSync(join(tmp, runDir, `verdicts/verdict-${index + 1}.json`), run.stdout);
    }

    run = cli("review-panel", ["tally", "--runs-root", runsRoot, "--manifest", join(runDir, "manifest.json")]);
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(tmp, runDir, "outcomes.json"), "utf-8")).refuted).toBe(1);
    expect(() => readFileSync(join(tmp, ".claude/state/active_task_graph.json"), "utf-8")).toThrow();

    const resultPath = join(tmp, runDir, "result.json");
    const outcomesPath = join(tmp, runDir, "outcomes.json");
    const result = JSON.parse(readFileSync(resultPath, "utf-8"));
    expect(result.surviving_critical_findings).toEqual([]);
    expect(result.refuted_critical_findings).toHaveLength(1);
    expect(result.advisory_findings).toHaveLength(1);

    const published = {
      result: readFileSync(resultPath, "utf-8"),
      outcomes: readFileSync(outcomesPath, "utf-8"),
    };
    run = cli("review-panel", ["tally", "--runs-root", runsRoot, "--manifest", join(runDir, "manifest.json")]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("already been tallied");
    expect(readFileSync(resultPath, "utf-8")).toBe(published.result);
    expect(readFileSync(outcomesPath, "utf-8")).toBe(published.outcomes);

    run = cli("standalone-review", ["finalize", "--runs-root", runsRoot, "--run-dir", runDir]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("already been finalized");
  });

  it.each([
    ["duplicate", ["code-reviewer", "code-reviewer"], "must be distinct"],
    ["non-review", ["code-reviewer", "code-implementer-agent"], "non-Machine-Summary reviewer"],
  ])("rejects a %s expected_agents roster before publishing session authority", (_label, expected_agents, diagnostic) => {
    writeFileSync(
      join(tmp, runDir, "review-plan.json"),
      JSON.stringify({ scope: ["src/x.ts"], expected_agents }),
    );

    const run = cli("standalone-review", [
      "init", "--runs-root", runsRoot, "--run-dir", runDir,
      "--input", join(runDir, "review-plan.json"),
    ]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(diagnostic);
    expect(() => readFileSync(join(tmp, runDir, "session.json"), "utf-8")).toThrow();
  });

  it.each([
    ["absolute", ["/tmp/outside.ts"]],
    ["traversal", ["src/../../outside.ts"]],
    ["newline", ["src/bad\npath.ts"]],
    ["NUL", ["src/bad\0path.ts"]],
    ["normalized duplicate", ["./src/x.ts", "src/x.ts"]],
  ])("rejects %s scope before freezing session authority", (_label, scope) => {
    writeFileSync(
      join(tmp, runDir, "review-plan.json"),
      JSON.stringify({ scope, expected_agents: ["code-reviewer"] }),
    );

    const run = cli("standalone-review", [
      "init", "--runs-root", runsRoot, "--run-dir", runDir,
      "--input", join(runDir, "review-plan.json"),
    ]);

    expect(run.status).toBe(1);
    expect(() => readFileSync(join(tmp, runDir, "session.json"), "utf-8")).toThrow();
  });

  it("rejects session authority that drifts from the frozen review plan", () => {
    initialize();
    const sessionPath = join(tmp, runDir, "session.json");
    const session = JSON.parse(readFileSync(sessionPath, "utf-8"));
    session.scope = ["src/other.ts"];
    writeFileSync(sessionPath, JSON.stringify(session));

    const run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("does not match the frozen scope and expected agents");
  });

  it("tallies a brace-bearing claim and publishes the original reviewer text", () => {
    initialize();
    writeFileSync(
      join(tmp, runDir, "reviewers/1-code-reviewer.md"),
      reviewOutput.replaceAll("impossible failure", "the {config} value is unchecked"),
    );
    let run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status, run.stderr).toBe(0);
    run = cli("review-panel", ["brief", "--runs-root", runsRoot, "--run-dir", runDir, "--standalone", join(runDir, "aggregate.json")]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("the config value is unchecked");
    expect(run.stdout).not.toContain("{config}");
    run = cli("review-panel", ["manifest", "--runs-root", runsRoot, "--run-dir", runDir]);
    expect(run.status, run.stderr).toBe(0);
    const manifest = JSON.parse(run.stdout);
    for (const [index, lens] of manifest.lenses.entries()) {
      const raw = JSON.stringify({
        criterion: lens,
        verdicts: [{ finding_id: manifest.findings[0].id, verdict: "upheld", reasoning: "reachable" }],
      });
      run = cli("review-panel", ["verdict", "--lens", lens, "--runs-root", runsRoot, "--manifest", join(runDir, "manifest.json")], raw);
      expect(run.status, run.stderr).toBe(0);
      writeFileSync(join(tmp, runDir, `verdicts/verdict-${index + 1}.json`), run.stdout);
    }
    run = cli("review-panel", ["tally", "--runs-root", runsRoot, "--manifest", join(runDir, "manifest.json")]);
    expect(run.status, run.stderr).toBe(0);
    const result = JSON.parse(readFileSync(join(tmp, runDir, "result.json"), "utf-8"));
    expect(result.surviving_critical_findings[0].claim).toBe("the {config} value is unchecked");
  });

  it("requires the observed reviewer set, immutable slots, and physical files to match", () => {
    initialize(["code-reviewer", "type-design-analyzer"]);
    writeFileSync(join(tmp, runDir, "review-input.json"), JSON.stringify({
      reviews: [{ agent: "code-reviewer", transcript: join(runDir, "reviewers/1-code-reviewer.md") }],
    }));
    let run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("must match the pre-spawn session expected_agents exactly");

    const second = join(tmp, runDir, "reviewers/2-type-design-analyzer.md");
    writeFileSync(second, reviewOutput);
    writeFileSync(join(tmp, runDir, "review-input.json"), JSON.stringify({
      reviews: [
        { agent: "code-reviewer", transcript: join(runDir, "reviewers/2-type-design-analyzer.md") },
        { agent: "type-design-analyzer", transcript: join(runDir, "reviewers/1-code-reviewer.md") },
      ],
    }));
    run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("review transcript slot 1 for code-reviewer must be exactly");

    rmSync(second);
    linkSync(join(tmp, runDir, "reviewers/1-code-reviewer.md"), second);
    writeFileSync(join(tmp, runDir, "review-input.json"), JSON.stringify({
      reviews: [
        { agent: "code-reviewer", transcript: join(runDir, "reviewers/1-code-reviewer.md") },
        { agent: "type-design-analyzer", transcript: join(runDir, "reviewers/2-type-design-analyzer.md") },
      ],
    }));
    run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("assigned to more than one reviewer");
  });

  it("rejects a symlinked reviewers directory before publishing session authority", () => {
    rmSync(join(tmp, runDir, "reviewers"), { recursive: true });
    const outsideReviewers = join(tmp, "outside-reviewers");
    mkdirSync(outsideReviewers);
    symlinkSync(outsideReviewers, join(tmp, runDir, "reviewers"));
    writeFileSync(
      join(tmp, runDir, "review-plan.json"),
      JSON.stringify({ scope: ["src/x.ts"], expected_agents: ["code-reviewer"] }),
    );

    const run = cli("standalone-review", [
      "init", "--runs-root", runsRoot, "--run-dir", runDir,
      "--input", join(runDir, "review-plan.json"),
    ]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("cannot create");
    expect(() => readFileSync(join(tmp, runDir, "session.json"), "utf-8")).toThrow();
    expect(() => readFileSync(join(outsideReviewers, "session.json"), "utf-8")).toThrow();
  });

  it("rejects a symlinked reviewer transcript before publishing an aggregate", () => {
    initialize();
    const slot = join(tmp, runDir, "reviewers/1-code-reviewer.md");
    const outside = join(tmp, "outside-review.md");
    writeFileSync(outside, reviewOutput);
    rmSync(slot);
    symlinkSync(outside, slot);

    const run = cli("standalone-review", [
      "aggregate", "--runs-root", runsRoot, "--run-dir", runDir,
      "--input", join(runDir, "review-input.json"),
    ]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("non-empty regular non-symlink file");
    expect(() => readFileSync(join(tmp, runDir, "aggregate.json"), "utf-8")).toThrow();
  });

  it("reports degraded findings-block evidence during aggregation", () => {
    initialize();
    writeFileSync(join(tmp, runDir, "reviewers/1-code-reviewer.md"), [
      "### Machine Summary",
      "CRITICAL_COUNT: 0",
      "ADVISORY_COUNT: 1",
      "ADVISORY: location was lost",
      "```findings",
      "{not-json",
      "```",
    ].join("\n"));

    const run = cli("standalone-review", [
      "aggregate", "--runs-root", runsRoot, "--run-dir", runDir,
      "--input", join(runDir, "review-input.json"),
    ]);

    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain("findings block was malformed");
    expect(run.stderr).toContain("standalone:code-reviewer");
  });

  it("finalizes a zero-critical run and rejects unexpected panel outcomes", () => {
    initialize();
    writeFileSync(join(tmp, runDir, "reviewers/1-code-reviewer.md"), cleanReviewOutput);
    let run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status, run.stderr).toBe(0);

    const outcomesPath = join(tmp, runDir, "outcomes.json");
    writeFileSync(outcomesPath, JSON.stringify({ lenses: [], outcomes: [] }));
    run = cli("standalone-review", ["finalize", "--runs-root", runsRoot, "--run-dir", runDir]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("clean review unexpectedly has panel outcomes");

    rmSync(outcomesPath);
    run = cli("standalone-review", ["finalize", "--runs-root", runsRoot, "--run-dir", runDir]);
    expect(run.status, run.stderr).toBe(0);
    const result = JSON.parse(readFileSync(join(tmp, runDir, "result.json"), "utf-8"));
    expect(result.schema_version).toBeUndefined();
    expect(result.reviewer_evidence).toBeUndefined();
    expect(result.surviving_critical_findings).toEqual([]);
    expect(result.refuted_critical_findings).toEqual([]);
    expect(result.advisory_findings).toHaveLength(1);
    expect(result.panel).toBeNull();
  });

  it("refuses to mistake an incomplete staged result for a finalized run", () => {
    initialize();
    writeFileSync(join(tmp, runDir, "reviewers/1-code-reviewer.md"), cleanReviewOutput);
    let run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status, run.stderr).toBe(0);
    writeFileSync(join(tmp, runDir, ".result.pending.json"), "{\"partial\":");

    run = cli("standalone-review", ["finalize", "--runs-root", runsRoot, "--run-dir", runDir]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("incomplete prior finalization");
    expect(() => readFileSync(join(tmp, runDir, "result.json"), "utf-8")).toThrow();
  });

  it("refuses to finalize a schema-valid aggregate after its reviewer evidence is removed", () => {
    initialize();
    writeFileSync(join(tmp, runDir, "reviewers/1-code-reviewer.md"), cleanReviewOutput);
    let run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status, run.stderr).toBe(0);

    rmSync(join(tmp, runDir, "session.json"));
    rmSync(join(tmp, runDir, "review-input.json"));
    rmSync(join(tmp, runDir, "reviewers/1-code-reviewer.md"));
    run = cli("standalone-review", ["finalize", "--runs-root", runsRoot, "--run-dir", runDir]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("cannot read review session");
    expect(() => readFileSync(join(tmp, runDir, "result.json"), "utf-8")).toThrow();
  });

  it("rejects a standalone panel brief when aggregate.json drifts from the transcripts", () => {
    initialize();
    let run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status, run.stderr).toBe(0);
    const aggregatePath = join(tmp, runDir, "aggregate.json");
    const aggregate = JSON.parse(readFileSync(aggregatePath, "utf-8"));
    aggregate.findings[0].claim = "forged replacement claim";
    writeFileSync(aggregatePath, JSON.stringify(aggregate));

    run = cli("review-panel", ["brief", "--runs-root", runsRoot, "--run-dir", runDir, "--standalone", join(runDir, "aggregate.json")]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("does not match the aggregate rederived");
  });

  it("cannot turn a hand-authored outcomes file into a finalized critical review", () => {
    initialize();
    let run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status, run.stderr).toBe(0);
    writeFileSync(join(tmp, runDir, "outcomes.json"), JSON.stringify({
      lenses: ["fake"], threshold: 1, surviving: 0, refuted: 1, outcomes: [],
    }));
    run = cli("standalone-review", ["finalize", "--runs-root", runsRoot, "--run-dir", runDir]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("critical findings require review-panel tally");
    expect(() => readFileSync(join(tmp, runDir, "result.json"), "utf-8")).toThrow();
  });

  it("rejects a symlink-plus-dotdot run path instead of writing through its raw spelling", () => {
    const outsideParent = join(tmp, "outside");
    const symlinkTarget = join(outsideParent, "target");
    mkdirSync(symlinkTarget, { recursive: true });
    mkdirSync(join(outsideParent, "run.escape"), { recursive: true });
    mkdirSync(join(tmp, runsRoot, "run.escape"), { recursive: true });
    symlinkSync(symlinkTarget, join(tmp, runsRoot, "link"));
    const raw = `${runsRoot}/link/../run.escape`;
    const run = cli("standalone-review", ["finalize", "--runs-root", runsRoot, "--run-dir", raw]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("must not contain dot path segments");
  });

  it("distinguishes incomplete and corrupt prior aggregate publication", () => {
    initialize();
    const pending = join(tmp, runDir, ".aggregate.pending.json");
    writeFileSync(pending, "{\"partial\":");
    let run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("incomplete prior aggregation");

    rmSync(pending);
    writeFileSync(join(tmp, runDir, "aggregate.json"), "{\"partial\":");
    run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("corrupt prior aggregate");
    expect(run.stderr).not.toContain("already been aggregated");
  });

  it("fails closed on missing reviewer evidence and refuses a second aggregation", () => {
    initialize();
    writeFileSync(join(tmp, runDir, "reviewers/1-code-reviewer.md"), "looks fine");
    let run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("CRITICAL_COUNT marker not found");

    writeFileSync(join(tmp, runDir, "reviewers/1-code-reviewer.md"), reviewOutput);
    run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status, run.stderr).toBe(0);
    run = cli("standalone-review", ["aggregate", "--runs-root", runsRoot, "--run-dir", runDir, "--input", join(runDir, "review-input.json")]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("already been aggregated");
  });

  it("continues an in-flight historical v1 session that predates transcript_slots", () => {
    initialize();
    const sessionPath = join(tmp, runDir, "session.json");
    const historical = JSON.parse(readFileSync(sessionPath, "utf-8"));
    delete historical.transcript_slots;
    writeFileSync(sessionPath, JSON.stringify(historical));

    const run = cli("standalone-review", [
      "aggregate", "--runs-root", runsRoot, "--run-dir", runDir,
      "--input", join(runDir, "review-input.json"),
    ]);

    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout).schema_version).toBe(1);
  });

  it("publishes versioned session and aggregate reads with exact byte metadata", () => {
    initialize();
    const session = JSON.parse(readFileSync(join(tmp, runDir, "session.json"), "utf-8"));
    expect(session.schema_version).toBe(1);
    expect(session.transcript_slots).toEqual(["reviewers/1-code-reviewer.md"]);

    const bytes = Buffer.from(reviewOutput, "utf-8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(tmp, runDir, "review-input.json"), JSON.stringify({
      schema_version: 1,
      reviews: [{
        agent: "code-reviewer",
        transcript: join(runDir, "reviewers/1-code-reviewer.md"),
        byte_length: bytes.byteLength,
        sha256,
      }],
    }));

    const run = cli("standalone-review", [
      "aggregate", "--runs-root", runsRoot, "--run-dir", runDir,
      "--input", join(runDir, "review-input.json"),
    ]);
    expect(run.status, run.stderr).toBe(0);
    const aggregate = JSON.parse(run.stdout);
    expect(aggregate.schema_version).toBe(1);
    expect(aggregate.reviewer_evidence).toHaveLength(1);
    expect(aggregate.reviewer_evidence[0].artifact.byteLength).toBe(bytes.byteLength);
    expect(aggregate.reviewer_evidence[0].artifact.digest).toBe(sha256);
  });

  it("rejects invalid UTF-8 through handler aggregation without replacement decoding", () => {
    initialize();
    const transcriptPath = join(tmp, runDir, "reviewers/1-code-reviewer.md");
    const invalid = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]);
    writeFileSync(transcriptPath, invalid);
    writeFileSync(join(tmp, runDir, "review-input.json"), JSON.stringify({
      schema_version: 1,
      reviews: [{
        agent: "code-reviewer",
        transcript: join(runDir, "reviewers/1-code-reviewer.md"),
        byte_length: invalid.byteLength,
        sha256: createHash("sha256").update(invalid).digest("hex"),
      }],
    }));

    const run = cli("standalone-review", [
      "aggregate", "--runs-root", runsRoot, "--run-dir", runDir,
      "--input", join(runDir, "review-input.json"),
    ]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("exact valid UTF-8 Agent output");
    expect(run.stderr).not.toContain("�");
    expect(() => readFileSync(join(tmp, runDir, "aggregate.json"), "utf-8")).toThrow();
  });

  it("rejects stale v1 bytes and every surplus transcript before aggregation", () => {
    initialize();
    const bytes = Buffer.from(reviewOutput, "utf-8");
    writeFileSync(join(tmp, runDir, "review-input.json"), JSON.stringify({
      schema_version: 1,
      reviews: [{
        agent: "code-reviewer",
        transcript: join(runDir, "reviewers/1-code-reviewer.md"),
        byte_length: bytes.byteLength,
        sha256: "0".repeat(64),
      }],
    }));
    let run = cli("standalone-review", [
      "aggregate", "--runs-root", runsRoot, "--run-dir", runDir,
      "--input", join(runDir, "review-input.json"),
    ]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("sha256 is stale");

    writeFileSync(join(tmp, runDir, "review-input.json"), JSON.stringify({
      reviews: [{ agent: "code-reviewer", transcript: join(runDir, "reviewers/1-code-reviewer.md") }],
    }));
    writeFileSync(join(tmp, runDir, "reviewers/surplus.md"), reviewOutput);
    run = cli("standalone-review", [
      "aggregate", "--runs-root", runsRoot, "--run-dir", runDir,
      "--input", join(runDir, "review-input.json"),
    ]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("missing or surplus evidence is forbidden");
  });

  it("blocks a dangling symlink scope component instead of treating it as absent", () => {
    symlinkSync(join(tmp, "missing-target"), join(tmp, "dangling"));
    writeFileSync(join(tmp, runDir, "review-plan.json"), JSON.stringify({
      scope: ["dangling/x.ts"], expected_agents: ["code-reviewer"],
    }));

    const run = cli("standalone-review", [
      "init", "--runs-root", runsRoot, "--run-dir", runDir,
      "--input", join(runDir, "review-plan.json"),
    ]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("symlink-unsafe path component");
    expect(() => readFileSync(join(tmp, runDir, "session.json"), "utf-8")).toThrow();
  });

  it("blocks non-absence scope inspection failures", () => {
    const denied = join(tmp, "denied");
    mkdirSync(denied);
    chmodSync(denied, 0o000);
    writeFileSync(join(tmp, runDir, "review-plan.json"), JSON.stringify({
      scope: ["denied/x.ts"], expected_agents: ["code-reviewer"],
    }));
    try {
      const run = cli("standalone-review", [
        "init", "--runs-root", runsRoot, "--run-dir", runDir,
        "--input", join(runDir, "review-plan.json"),
      ]);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("cannot inspect review plan.scope path");
    } finally {
      chmodSync(denied, 0o700);
    }
  });

  it("blocks a scope whose existing path traverses a symlink", () => {
    const outside = join(tmp, "outside-src");
    mkdirSync(outside);
    symlinkSync(outside, join(tmp, "src"));
    writeFileSync(join(tmp, runDir, "review-plan.json"), JSON.stringify({
      scope: ["src/x.ts"], expected_agents: ["code-reviewer"],
    }));

    const run = cli("standalone-review", [
      "init", "--runs-root", runsRoot, "--run-dir", runDir,
      "--input", join(runDir, "review-plan.json"),
    ]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("symlink-unsafe path component");
    expect(() => readFileSync(join(tmp, runDir, "session.json"), "utf-8")).toThrow();
  });
});
