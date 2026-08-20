#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateTaskProof } from "../engine/src/core/proof-obligations";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "engine", "src", "cli.ts");
const temporaryRoots: string[] = [];

process.on("exit", () => {
  for (const path of temporaryRoots) rmSync(path, { recursive: true, force: true });
});

type Authority = Readonly<{
  requestId: string;
  slotId: string;
  attempt: 1 | 2;
  role: string;
  contextDigest: string;
}>;

/** `task` is the spawn prompt the engine renders; the retry assertions below
 *  read it, so it belongs in the type rather than behind a `!`. */
type SpawnRequest = Readonly<{ authority: Authority; task: string }>;
type SpawnBatch = Readonly<{ kind: "spawn-batch"; requests: readonly SpawnRequest[] }>;
type AwaitUser = Readonly<{
  kind: "await-user";
  request: Readonly<{
    requestId: string;
    context: Readonly<{ digest: string; slot: Readonly<{ path: string }> }>;
    advisories: readonly Readonly<{ slot: Readonly<{ path: string }>; digest: string; byteLength: number }>[];
  }>;
}>;
type Done = Readonly<{ kind: "done"; outcome: unknown }>;

type CliResult = Readonly<{ status: number; stdout: string; stderr: string }>;

function fail(message: string): never {
  throw new Error(`smoke-orchestration-facades: ${message}`);
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  check(typeof value === "object" && value !== null && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

function invokeOrchestrationCli(cwd: string, args: readonly string[], stdin: string): CliResult {
  // Every call starts a fresh CLI process. No in-memory program state can cross
  // this boundary; progress must be recovered from the immutable run directory.
  return spawnSync("bun", [CLI, "helper", "orchestration", ...args], {
    cwd,
    input: stdin,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, LOOM_STATE_PATH: join(cwd, ".claude", "state", "active_task_graph.json") },
  }) as CliResult;
}

function run(cwd: string, args: readonly string[], stdin = ""): unknown {
  const result = invokeOrchestrationCli(cwd, args, stdin);
  check(result.status === 0, `CLI failed (${args.join(" ")}): ${result.stderr || result.stdout}`);
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return fail(`CLI emitted invalid JSON (${args.join(" ")}): ${result.stdout}`);
  }
}

function runFailure(cwd: string, args: readonly string[], stdin = ""): CliResult {
  const result = invokeOrchestrationCli(cwd, args, stdin);
  check(result.status !== 0, `CLI unexpectedly accepted invalid input (${args.join(" ")})`);
  return result;
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  check(result.status === 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function repository(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `loom-facade-smoke-${label}-`));
  temporaryRoots.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "loom@example.test"]);
  git(root, ["config", "user.name", "Loom Smoke"]);
  return root;
}

function asSpawnBatch(value: unknown, label: string): SpawnBatch {
  const action = record(value, label);
  check(action.kind === "spawn-batch", `${label} must be spawn-batch, got ${JSON.stringify(action)}`);
  check(Array.isArray(action.requests) && action.requests.length > 0, `${label} must contain requests`);
  for (const [index, candidate] of action.requests.entries()) {
    const request = record(candidate, `${label}.requests[${index}]`);
    const authority = record(request.authority, `${label}.requests[${index}].authority`);
    check(typeof authority.requestId === "string", `${label} requestId is missing`);
    check(typeof authority.slotId === "string", `${label} slotId is missing`);
    check(authority.attempt === 1 || authority.attempt === 2, `${label} attempt is invalid`);
    check(typeof authority.role === "string", `${label} role is missing`);
    check(typeof authority.contextDigest === "string", `${label} contextDigest is missing`);
    check(typeof request.task === "string" && request.task.includes(`LOOM_REQUEST_ID: ${authority.requestId}`),
      `${label} request task is missing its request marker`);
    check(request.task.includes(`LOOM_CONTEXT_DIGEST: ${authority.contextDigest}`),
      `${label} request task is missing its context marker`);
  }
  return action as unknown as SpawnBatch;
}

function asAwaitUser(value: unknown, label: string): AwaitUser {
  const action = record(value, label);
  check(action.kind === "await-user", `${label} must be await-user, got ${JSON.stringify(action)}`);
  const request = record(action.request, `${label}.request`);
  check(typeof request.requestId === "string", `${label} requestId is missing`);
  const context = record(request.context, `${label}.request.context`);
  const contextSlot = record(context.slot, `${label}.request.context.slot`);
  check(typeof context.digest === "string" && typeof contextSlot.path === "string",
    `${label} context reference is incomplete`);
  check(Array.isArray(request.advisories) && request.advisories.length > 0,
    `${label} advisory artifacts must be non-empty`);
  for (const [index, candidate] of request.advisories.entries()) {
    const advisory = record(candidate, `${label}.request.advisories[${index}]`);
    const slot = record(advisory.slot, `${label}.request.advisories[${index}].slot`);
    check(typeof slot.path === "string" && typeof advisory.digest === "string" &&
      typeof advisory.byteLength === "number" && advisory.byteLength > 0,
    `${label} advisory artifact ${index} is incomplete`);
  }
  return action as unknown as AwaitUser;
}

function asDone(value: unknown, label: string): Done {
  const action = record(value, label);
  check(action.kind === "done", `${label} must be done, got ${JSON.stringify(action)}`);
  return action as unknown as Done;
}

function requestIds(batch: SpawnBatch): readonly string[] {
  return batch.requests.map(({ authority }) => authority.requestId).sort();
}

function assertBatchReplay(cwd: string, runsRoot: string, runDir: string, expected: SpawnBatch, label: string): void {
  const replay = asSpawnBatch(run(cwd, ["resume", "--runs-root", runsRoot, "--run", runDir]), `${label} resume`);
  check(JSON.stringify(requestIds(replay)) === JSON.stringify(requestIds(expected)), `${label} resume changed pending request authority`);
}

function submit(cwd: string, runsRoot: string, runDir: string, request: SpawnRequest, output: string): unknown {
  const { authority } = request;
  return run(cwd, [
    "submit", "--runs-root", runsRoot, "--run", runDir,
    "--request", authority.requestId, "--slot", authority.slotId, "--attempt", String(authority.attempt),
  ], output);
}

function reviewerOutput(
  severity: "clean" | "critical" | "advisory",
  path: string,
  binding: Readonly<{ packetId: string; generation: number }> | null = null,
): string {
  const findings = severity === "clean" ? [] : [{
    severity,
    file: path,
    line: 1,
    claim: severity === "critical" ? "the guarded failure remains reachable" : "prefer a narrower public name",
  }];
  return [
    "### Machine Summary",
    ...(binding === null ? [] : [`REVIEW_GENERATION: ${binding.generation}`, `REVIEW_PACKET_ID: ${binding.packetId}`]),
    `CRITICAL_COUNT: ${severity === "critical" ? 1 : 0}`,
    `ADVISORY_COUNT: ${severity === "advisory" ? 1 : 0}`,
    ...(severity === "critical" ? ["CRITICAL: the guarded failure remains reachable"] : []),
    ...(severity === "advisory" ? ["ADVISORY: prefer a narrower public name"] : []),
    "```findings",
    JSON.stringify(findings),
    "```",
    ...(binding === null ? [] : ["```review_lifecycle", JSON.stringify({ prior_findings: [] }), "```"]),
  ].join("\n");
}

function refutationOutput(runDir: string, request: SpawnRequest): string {
  const contextPath = join(runDir, "contexts", `${request.authority.contextDigest}.json`);
  const packet = record(JSON.parse(readFileSync(contextPath, "utf8")) as unknown, "refutation context packet");
  check(Array.isArray(packet.fixedContext), "refutation context has no fixedContext");
  const section = packet.fixedContext
    .map((candidate, index) => record(candidate, `fixedContext[${index}]`))
    .find((candidate) => candidate.label === "refutation-authority" || candidate.label === "wave-refutation-authority");
  check(section !== undefined && Array.isArray(section.bytes), "refutation authority section is missing");
  const authority = record(JSON.parse(Buffer.from(section.bytes as number[]).toString("utf8")) as unknown, "refutation authority");
  check(typeof authority.lens === "string", "refutation lens is missing");
  check(Array.isArray(authority.findings) && authority.findings.length > 0, "refutation findings are missing");
  const verdicts = authority.findings.map((candidate, index) => {
    const finding = record(candidate, `refutation finding[${index}]`);
    check(typeof finding.id === "string", "refutation finding id is missing");
    return { finding_id: finding.id, verdict: "refuted", reasoning: `refuted through ${authority.lens}` };
  });
  return JSON.stringify({ criterion: authority.lens, verdicts });
}

function standaloneAndRemediationSmoke(): void {
  const cwd = repository("standalone");
  const changedPath = "src/target.ts";
  mkdirSync(dirname(join(cwd, changedPath)), { recursive: true });
  writeFileSync(join(cwd, changedPath), "export const value = 1;\n");
  git(cwd, ["add", changedPath]);
  git(cwd, ["commit", "-qm", "baseline"]);
  writeFileSync(join(cwd, changedPath), "export const value = 2;\n");

  // Run evidence lives outside the repository so remediation's dirty-set audit
  // observes only product changes, exactly as a real review-and-fix run does.
  const runsRoot = mkdtempSync(join(tmpdir(), "loom-facade-smoke-runs-"));
  temporaryRoots.push(runsRoot);
  const reviewRun = join(runsRoot, "run.standalone-critical");
  mkdirSync(reviewRun, { recursive: true });
  const initial = asSpawnBatch(run(cwd, [
    "start", "standalone-review", "--runs-root", runsRoot, "--run", reviewRun,
  ], JSON.stringify({ kind: "comments", files: [changedPath], dryRun: false })), "standalone start");
  assertBatchReplay(cwd, runsRoot, reviewRun, initial, "standalone initial batch");

  let next: unknown = initial;
  for (const request of initial.requests) {
    next = submit(cwd, runsRoot, reviewRun, request, reviewerOutput("critical", changedPath));
  }
  const panel = asSpawnBatch(next, "automatic standalone refutation");
  check(panel.requests.every(({ authority }) => authority.role === "review-verifier-agent"), "standalone criticals did not route to verifier agents");
  assertBatchReplay(cwd, runsRoot, reviewRun, panel, "standalone refutation batch");

  for (const request of panel.requests) next = submit(cwd, runsRoot, reviewRun, request, refutationOutput(reviewRun, request));
  asDone(next, "standalone adjudication");
  asDone(run(cwd, ["resume", "--runs-root", runsRoot, "--run", reviewRun]), "standalone terminal replay");

  const result = record(JSON.parse(readFileSync(join(reviewRun, "result.json"), "utf8")) as unknown, "standalone result");
  check(Array.isArray(result.surviving_critical_findings) && result.surviving_critical_findings.length === 0,
    "standalone result retained a refuted critical");
  check(Array.isArray(result.refuted_critical_findings) && result.refuted_critical_findings.length > 0,
    "standalone result did not preserve refuted critical evidence");

  const remediationRun = join(runsRoot, "run.remediation");
  mkdirSync(remediationRun, { recursive: true });
  asDone(run(cwd, ["start", "remediation", "--runs-root", runsRoot, "--run", remediationRun], JSON.stringify({
    sourceRunsRoot: runsRoot,
    sourceRun: reviewRun,
    supportPaths: [],
  })), "remediation start");
  asDone(run(cwd, ["resume", "--runs-root", runsRoot, "--run", remediationRun]), "remediation terminal replay");
  check(git(cwd, ["diff", "--cached", "--name-only"]) === changedPath, "remediation installed a non-authoritative staged set");
  process.stdout.write("  ✓ standalone critical → automatic refutation → durable done\n");
  process.stdout.write("  ✓ remediation authoritative result → verified real Git index installation\n");
}

/**
 * A standalone reviewer whose transcript violates the frozen scope must be
 * rejected at the slot level and retried at attempt 2 — never allowed to
 * dead-end the whole run at aggregation (the pre-retry engine behavior).
 */
function standaloneReviewerRetrySmoke(): void {
  const cwd = repository("standalone-retry");
  const changedPath = "src/target.ts";
  mkdirSync(dirname(join(cwd, changedPath)), { recursive: true });
  writeFileSync(join(cwd, changedPath), "export const value = 1;\n");
  git(cwd, ["add", changedPath]);
  git(cwd, ["commit", "-qm", "baseline"]);
  writeFileSync(join(cwd, changedPath), "export const value = 2;\n");

  const runsRoot = mkdtempSync(join(tmpdir(), "loom-facade-smoke-runs-"));
  temporaryRoots.push(runsRoot);
  const reviewRun = join(runsRoot, "run.standalone-retry");
  mkdirSync(reviewRun, { recursive: true });
  const initial = asSpawnBatch(run(cwd, [
    "start", "standalone-review", "--runs-root", runsRoot, "--run", reviewRun,
  ], JSON.stringify({ kind: "all", files: [changedPath], dryRun: false })), "standalone retry start");
  check(initial.requests.length >= 2, "standalone retry start must spawn at least two reviewers");

  // The first reviewer strays outside the frozen scope: its finding file is
  // not among the review scope paths, so the engine's frozen-scope validator
  // must reject that ONE slot and issue its attempt-2 retry instead of aborting
  // the run at aggregation with no recovery path.
  const first = initial.requests[0]!;
  const retryBatch = asSpawnBatch(
    submit(cwd, runsRoot, reviewRun, first, reviewerOutput("advisory", "src/outside.ts")),
    "standalone retry batch after out-of-scope finding",
  );
  const retry = retryBatch.requests.find(({ authority }) => authority.slotId === first.authority.slotId);
  check(retry !== undefined, "retry batch dropped the rejected reviewer slot");
  check(retry.authority.attempt === 2, "rejected reviewer slot did not advance to attempt 2");
  check(retry.task.includes("rejected by the engine's admission check"),
    "retry task lacks the rejection diagnostic");
  check(retry.task.includes("outside the frozen review scope") || retry.task.includes("src/outside.ts"),
    "retry task must quote the engine's own diagnostic, not a generic reminder");

  // Regression: the diagnostic used to live only in the pass-local rejected set,
  // so a LATER resume re-issued this same retry with a generic message that
  // named the wrong admission rule. It must be durable across resumes.
  const replayedRetry = asSpawnBatch(
    run(cwd, ["resume", "--runs-root", runsRoot, "--run", reviewRun]),
    "standalone retry resume replay",
  ).requests.find(({ authority }) => authority.slotId === first.authority.slotId);
  check(replayedRetry !== undefined && replayedRetry.authority.attempt === 2,
    "resume replay dropped the retried reviewer slot");
  check(replayedRetry.task === retry.task,
    "resume replay lost the durable rejection diagnostic from the attempt-2 task");
  check(retryBatch.requests.some(({ authority }) =>
    authority.slotId !== first.authority.slotId && authority.attempt === 1),
  "retry batch must also carry the still-pending sibling attempt-1 requests");

  // Answer every request (retried slot at attempt 2, siblings at attempt 1)
  // with clean, in-scope reviewer output and require the run to reach done.
  let next: unknown = retryBatch;
  for (const request of retryBatch.requests) {
    next = submit(cwd, runsRoot, reviewRun, request, reviewerOutput("clean", changedPath));
  }
  asDone(next, "standalone retry adjudication");
  asDone(run(cwd, ["resume", "--runs-root", runsRoot, "--run", reviewRun]), "standalone retry terminal replay");

  const result = record(JSON.parse(readFileSync(join(reviewRun, "result.json"), "utf8")) as unknown, "standalone retry result");
  check(Array.isArray(result.surviving_critical_findings) && result.surviving_critical_findings.length === 0,
    "standalone retry result retained criticals");
  process.stdout.write("  ✓ standalone out-of-scope reviewer transcript → attempt-2 retry → clean adjudication\n");
}

/**
 * A retried reviewer whose attempt-2 transcript STILL violates the frozen scope
 * must terminal-block the run (LC-2: attempt 2 is final) with a durable
 * blocked action — never loop or silently accept.
 */
function standaloneRetryTerminalBlockSmoke(): void {
  const cwd = repository("standalone-retry-block");
  const changedPath = "src/target.ts";
  mkdirSync(dirname(join(cwd, changedPath)), { recursive: true });
  writeFileSync(join(cwd, changedPath), "export const value = 1;\n");
  git(cwd, ["add", changedPath]);
  git(cwd, ["commit", "-qm", "baseline"]);
  writeFileSync(join(cwd, changedPath), "export const value = 2;\n");

  const runsRoot = mkdtempSync(join(tmpdir(), "loom-facade-smoke-runs-"));
  temporaryRoots.push(runsRoot);
  const reviewRun = join(runsRoot, "run.standalone-retry-block");
  mkdirSync(reviewRun, { recursive: true });
  const initial = asSpawnBatch(run(cwd, [
    "start", "standalone-review", "--runs-root", runsRoot, "--run", reviewRun,
  ], JSON.stringify({ kind: "all", files: [changedPath], dryRun: false })), "standalone retry-block start");

  const first = initial.requests[0]!;
  const retryBatch = asSpawnBatch(
    submit(cwd, runsRoot, reviewRun, first, reviewerOutput("advisory", "src/outside.ts")),
    "retry-block attempt-1 rejection",
  );
  const retry = retryBatch.requests.find(({ authority }) => authority.slotId === first.authority.slotId);
  check(retry !== undefined && retry!.authority.attempt === 2, "retry-block slot did not advance to attempt 2");

  // The retry repeats the same scope violation: the second and final attempt
  // must terminal-block the run.
  const blocked = record(
    submit(cwd, runsRoot, reviewRun, retry!, reviewerOutput("advisory", "src/outside.ts")),
    "retry-block final outcome",
  );
  check(blocked.kind === "blocked", `retry-block must block, got ${blocked.kind}`);
  const replay = record(
    run(cwd, ["resume", "--runs-root", runsRoot, "--run", reviewRun]),
    "retry-block terminal replay",
  );
  check(replay.kind === "blocked", "retry-block terminal replay must stay blocked");
  check(!existsSync(join(reviewRun, "result.json")), "retry-block must not publish a result");
  process.stdout.write("  ✓ standalone attempt-2 scope violation → durable terminal block\n");
}

function waveState(): Record<string, unknown> {
  const proof = evaluateTaskProof(
    { newTestsRequired: true, declaredArtifacts: ["src/x.ts"] },
    { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: ["src/x.ts"], newTestsWritten: true },
  );
  check(proof.state === "satisfied", "Wave fixture proof is not satisfied");
  return {
    current_phase: "execute",
    current_wave: 1,
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    tasks: [{
      id: "T1",
      description: "exercise the orchestration façade",
      agent: "code-implementer-agent",
      wave: 1,
      status: "implemented",
      proof,
      depends_on: [],
      file_list: ["src/x.ts"],
      files_modified: ["src/x.ts"],
      test_result: { verdict: "trusted-pass" },
      test_evidence: "facade smoke: passed",
      new_tests_written: true,
      new_test_evidence: "facade smoke exists",
      review_status: "passed",
      review_generation: 0,
      critical_findings: [],
      advisory_findings: [],
    }],
    wave_gates: {},
  };
}

function waveGateCriticalRefutationSmoke(): void {
  const cwd = repository("wave-critical");
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "x.ts"), "export const x = 1;\n");
  git(cwd, ["add", "src/x.ts"]);
  git(cwd, ["commit", "-qm", "baseline"]);
  const statePath = join(cwd, ".claude", "state", "active_task_graph.json");
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(waveState()));

  const runsRoot = join(cwd, ".claude", "reviews", "facade-smoke-runs");
  const runDir = join(runsRoot, "run.wave-critical");
  mkdirSync(runDir, { recursive: true });
  const initial = asSpawnBatch(run(cwd, [
    "start", "wave-gate", "--runs-root", runsRoot, "--run", runDir,
  ], JSON.stringify({ wave: 1 })), "critical Wave Gate start");
  const registeredState = record(JSON.parse(readFileSync(statePath, "utf8")) as unknown, "critical Wave state");
  check(Array.isArray(registeredState.tasks), "critical Wave state has no tasks");
  const reviewRun = record(record(registeredState.tasks[0], "critical Wave task").review_run, "critical Wave review run");
  check(typeof reviewRun.packet_id === "string" && typeof reviewRun.generation === "number",
    "critical Wave review binding is incomplete");
  const reviewBinding = { packetId: reviewRun.packet_id, generation: reviewRun.generation } as {
    packetId: string;
    generation: number;
  };

  let next: unknown = initial;
  for (const request of initial.requests) {
    const output = request.authority.role === "spec-check-invoker"
      ? ["SPEC_CHECK_WAVE: 1", "SPEC_CHECK_CRITICAL_COUNT: 0", "SPEC_CHECK_HIGH_COUNT: 0", "SPEC_CHECK_VERDICT: PASSED"].join("\n")
      : reviewerOutput("critical", "src/x.ts", reviewBinding);
    next = submit(cwd, runsRoot, runDir, request, output);
  }

  const panel = asSpawnBatch(next, "automatic Wave refutation");
  check(panel.requests.every(({ authority }) => authority.slotId.startsWith("refutation-slot:") &&
    authority.requestId.startsWith("refutation-request:")), "Wave verifier authority is not canonical");
  assertBatchReplay(cwd, runsRoot, runDir, panel, "Wave refutation batch");
  for (const request of panel.requests) next = submit(cwd, runsRoot, runDir, request, refutationOutput(runDir, request));
  asDone(next, "critical Wave adjudication");
  asDone(run(cwd, ["resume", "--runs-root", runsRoot, "--run", runDir]), "critical Wave terminal replay");
  process.stdout.write("  ✓ Wave Gate criticals → canonical refutation authority → atomic completion\n");
}

function waveGateSmoke(): void {
  const cwd = repository("wave");
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "x.ts"), "export const x = 1;\n");
  git(cwd, ["add", "src/x.ts"]);
  git(cwd, ["commit", "-qm", "baseline"]);
  const statePath = join(cwd, ".claude", "state", "active_task_graph.json");
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(waveState()));

  const runsRoot = join(cwd, ".claude", "reviews", "facade-smoke-runs");
  const runDir = join(runsRoot, "run.wave-gate");
  mkdirSync(runDir, { recursive: true });
  const initial = asSpawnBatch(run(cwd, [
    "start", "wave-gate", "--runs-root", runsRoot, "--run", runDir,
  ], JSON.stringify({ wave: 1 })), "Wave Gate start");
  check(initial.requests.some(({ authority }) => authority.role === "spec-check-invoker"), "Wave Gate omitted spec-check authority");
  assertBatchReplay(cwd, runsRoot, runDir, initial, "Wave Gate initial batch");

  const registeredState = record(JSON.parse(readFileSync(statePath, "utf8")) as unknown, "registered Wave state");
  check(Array.isArray(registeredState.tasks), "registered Wave state has no tasks");
  const registeredTask = record(registeredState.tasks[0], "registered Wave task");
  const reviewRun = record(registeredTask.review_run, "registered Wave review run");
  check(typeof reviewRun.packet_id === "string", "registered Wave packet id is missing");
  check(typeof reviewRun.generation === "number", "registered Wave generation is missing");
  const reviewBinding = { packetId: reviewRun.packet_id, generation: reviewRun.generation };

  let next: unknown = initial;
  for (const request of initial.requests) {
    const output = request.authority.role === "spec-check-invoker"
      ? ["SPEC_CHECK_WAVE: 1", "SPEC_CHECK_CRITICAL_COUNT: 0", "SPEC_CHECK_HIGH_COUNT: 0", "SPEC_CHECK_VERDICT: PASSED"].join("\n")
      : reviewerOutput("advisory", "src/x.ts", reviewBinding);
    next = submit(cwd, runsRoot, runDir, request, output);
  }

  const suspended = asAwaitUser(next, "Wave Gate advisory suspension");
  check(existsSync(join(runDir, suspended.request.context.slot.path)),
    "Wave Gate advisory context reference was not published");
  for (const advisory of suspended.request.advisories) {
    const path = join(runDir, advisory.slot.path);
    check(existsSync(path), `Wave Gate advisory artifact was not published: ${advisory.slot.path}`);
    check(readFileSync(path).byteLength === advisory.byteLength,
      `Wave Gate advisory artifact byte length drifted: ${advisory.slot.path}`);
  }
  const resumedSuspension = asAwaitUser(run(cwd, ["resume", "--runs-root", runsRoot, "--run", runDir]), "Wave Gate suspended replay");
  check(resumedSuspension.request.requestId === suspended.request.requestId, "Wave Gate resume changed advisory decision authority");
  const staleDecision = runFailure(cwd, [
    "decide", "--runs-root", runsRoot, "--run", runDir, "--request", `wave-advisory:${runDir}:stale`,
  ], JSON.stringify({ kind: "approve" }));
  check(staleDecision.stderr.includes("not the exact pending advisory request"), "Wave Gate accepted stale advisory authority");
  const malformedDecision = runFailure(cwd, [
    "decide", "--runs-root", runsRoot, "--run", runDir, "--request", suspended.request.requestId,
  ], JSON.stringify({ kind: "approve", extra: true }));
  check(malformedDecision.stderr.includes("must be exactly"), "Wave Gate accepted malformed advisory disposition");
  run(cwd, [
    "decide", "--runs-root", runsRoot, "--run", runDir, "--request", suspended.request.requestId,
  ], JSON.stringify({ kind: "approve" }));
  asDone(run(cwd, ["resume", "--runs-root", runsRoot, "--run", runDir]), "Wave Gate completion");
  asDone(run(cwd, ["resume", "--runs-root", runsRoot, "--run", runDir]), "Wave Gate terminal replay");

  const finalState = record(JSON.parse(readFileSync(statePath, "utf8")) as unknown, "completed Wave state");
  const tasks = finalState.tasks;
  check(Array.isArray(tasks) && record(tasks[0], "completed task").status === "completed", "Wave Gate did not atomically complete the task");
  process.stdout.write("  ✓ Wave Gate review → advisory suspension/resume → atomic completion\n");
}

process.stdout.write("Orchestration façade smoke test (fresh CLI process at every boundary)\n");
standaloneAndRemediationSmoke();
standaloneReviewerRetrySmoke();
standaloneRetryTerminalBlockSmoke();
waveGateCriticalRefutationSmoke();
waveGateSmoke();
process.stdout.write("smoke-orchestration-facades: PASS\n");
