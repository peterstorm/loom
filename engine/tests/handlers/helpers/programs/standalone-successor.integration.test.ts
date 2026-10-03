import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync, truncateSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalTempDir } from "../../../fixtures/canonical-temp-dir";
import { captureStandaloneCliEvidence } from "../../../fixtures/standalone-cli-capture";
import { disposeFixturePiSessions, fixturePiEnvironment, withFixturePiSession } from "../../../fixtures/pi-session";
import type { AgentRequestAuthority } from "../../../../src/core/orchestration-contract";
import { standaloneOriginReference, standaloneDecisionReference, type PreparedStandaloneSuccessor } from "../../../../src/core/standalone-lineage";
import { REVIEWER_PAYLOAD_EXAMPLE_V2 } from "../../../../src/core/reviewer-contract";
import type { StandaloneReviewerPayloadV3 } from "../../../../src/core/standalone-lineage-contract";

const cli = fileURLToPath(new URL("../../../../src/cli.ts", import.meta.url));
const roots: string[] = [];
const operations = new Set<Promise<void>>();
function ownedSession<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const result = withFixturePiSession(root, operation);
  const settled = result.then(() => undefined, () => undefined);
  operations.add(settled); void settled.then(() => operations.delete(settled)); return result;
}
afterEach(async () => { await Promise.all([...operations]); disposeFixturePiSessions(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function value<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>): T {
  if (!result.ok) throw Error(JSON.stringify(result)); return result.value;
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const json = (raw: unknown) => JSON.stringify(raw);
const flags = (root: string, run: string) => ["--runs-root", join(root, "runs"), "--run", run];
type Action = { kind: string; requests: { authority: AgentRequestAuthority; task: string }[]; digest: string; json: string };
function project() {
  const root = canonicalTempDir("loom-p5-successor-"); roots.push(root);
  mkdirSync(join(root, "runs")); writeFileSync(join(root, "a.ts"), "export const value = 0;\n");
  for (const args of [["init", "-q"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"],
    ["add", "a.ts"], ["commit", "-qm", "fixture baseline"]]) {
    const p = spawnSync("git", args, { cwd: root, encoding: "utf8" }); if (p.status !== 0) throw Error(p.stderr);
  }
  writeFileSync(join(root, "a.ts"), "export const value = 1;\n"); return root;
}
async function invoke(root: string, args: readonly string[], input = "") {
  const env = fixturePiEnvironment(root);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("bun", [cli, "helper", "orchestration", ...args], { cwd: root, env });
    let stdout = ""; let stderr = ""; let failure: Error | null = null;
    child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
    child.once("error", error => { failure = error; });
    child.once("close", code => failure === null ? resolve({ code, stdout, stderr }) : reject(failure));
    child.stdin.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") failure = error; });
    child.stdin.end(input);
  });
}
async function command(root: string, args: readonly string[], input = ""): Promise<Action> {
  const result = await invoke(root, args, input); expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
async function submit(root: string, run: string, request: AgentRequestAuthority, raw: unknown) {
  return command(root, ["submit", ...flags(root, run), "--request", request.requestId, "--slot", request.slotId, "--attempt", String(request.attempt)], json(raw));
}
const critical = { ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!, file: "a.ts" };
async function predecessor(root: string, criticalHistory = false) {
  // Runtime/session/cwd/transport ownership precedes every shell import and operation.
  const handles = await import("../../../../src/orchestration/run-directory-handle");
  const shell = await import("../../../../src/handlers/helpers/programs/standalone");
  const helpers = await import("../../../../src/handlers/helpers/programs/helpers");
  const handle = value(handles.createRunDirectory(join(root, "runs"), "source"));
  const started = await shell.startStandaloneFacade(handle, { kind: "types", files: ["a.ts"], dryRun: false });
  if (!started.ok) throw Error(started.message);
  const action = started.action as Action;
  for (const [index, { authority }] of action.requests.entries()) value(await handle.captureTranscript(authority, [...Buffer.from(json({ schemaVersion: 2, kind: "standalone-review",
    findings: index === 0 ? criticalHistory ? [critical, { ...critical, claim: "Unchanged upheld blocker" }]
      : [{ severity: "advisory", file: "a.ts", line: 1, claim: "Original assertion", reason: "Clarity" }] : [] }))]));
  const registration = value(helpers.parseRegistration(value(handle.readProgramRegistration())));
  let completed = await shell.resumeStandaloneFacade(handle, registration); if (!completed.ok) throw Error(completed.message);
  if (criticalHistory) {
    for (const { authority } of (completed.action as Action).requests) {
      const packet = value(handle.readContext(authority.contextDigest));
      const context = JSON.parse(Buffer.from(packet.fixedContext[0]!.bytes).toString());
      value(await handle.captureTranscript(authority, [...Buffer.from(json({ criterion: context.lens,
        verdicts: context.findings.map((finding: { id: string }, index: number) => ({ finding_id: finding.id,
          verdict: index === 0 ? "refuted" : "upheld", reasoning: `Original ${context.lens} exact reasoning` })) }))]));
    }
    completed = await shell.resumeStandaloneFacade(handle, registration); if (!completed.ok) throw Error(completed.message);
  }
  expect((completed.action as Action).kind).toBe("done");
  const publisher = await import("../../../../src/handlers/helpers/programs/standalone-disposition");
  return { handles, shell, helpers, publisher };
}
async function policy(root: string, run: string, name: string, publisher: Awaited<ReturnType<typeof predecessor>>["publisher"]) {
  const source = { locator: join(root, "runs", run), runId: run, resultDigest: hash(readFileSync(join(root, "runs", run, "result.json"))) };
  const lineage = value(await publisher.readStandaloneDispositionSource(source));
  const { parseStandaloneDispositionStartBytes } = await import("../../../../src/core/standalone-disposition-machine");
  const input = value(parseStandaloneDispositionStartBytes(Buffer.from(json({ source, previous: null, record: { schemaVersion: 1, source,
    provenance: "DECLARED", revision: { kind: "initial" }, entries: lineage.inventory.filter(row => "draft" in row.finding ? row.finding.draft.severity === "advisory" : row.finding.severity === "advisory")
      .map(row => ({ origin: standaloneOriginReference(row.origin), decision: "accepted", reason: "Exact current policy" })) } }))));
  const prepared = value(await publisher.prepareStandaloneDispositionFacadeStart(input, join(root, "runs"), name));
  const { createRunDirectory } = await import("../../../../src/orchestration/run-directory-handle");
  const handle = value(createRunDirectory(join(root, "runs"), name));
  const published = await publisher.startStandaloneDispositionFacade(handle, prepared); if (!published.ok) throw Error(published.message);
  const outcome = published.action as { outcome: { publication: { locator: string; runId: string; dispositionDigest: string } } };
  return { source, lineage, publication: outcome.outcome.publication };
}
function input(p: Awaited<ReturnType<typeof policy>>) {
  return { schemaVersion: 3, kind: "types", files: ["a.ts"], dryRun: false,
    successor: { source: p.source, disposition: { kind: "selected-record", publication: p.publication } } };
}
async function successor(root: string, run: string, p: Awaited<ReturnType<typeof policy>>, f: Awaited<ReturnType<typeof predecessor>>) {
  const started = await command(root, ["start", "standalone-review", ...flags(root, run)], json(input(p)));
  expect(started.requests.map(row => row.authority.role)).toEqual(["code-reviewer", "type-design-analyzer"]);
  const handle = value(f.handles.openRegisteredRunDirectory(join(root, "runs"), run));
  const registration = value(f.helpers.parseRegistration(value(handle.readProgramRegistration())));
  if (registration.schemaVersion !== 3) throw Error("not successor registration");
  const authority = registration.authority as { roster: { attempts: AgentRequestAuthority[] }[] };
  const priorHandle = value(f.handles.openRegisteredRunDirectory(join(root, "runs"), p.source.runId));
  const priorRequests = value(priorHandle.readIssuedRequests());
  const previousLabels = p.lineage.reviewers.flatMap((role, index) => [
    `predecessor-context:${role}`, ...(index === 0 ? ["predecessor-frozen-source"] : []),
    ...(priorRequests.some(request => request.program === "standalone-review" && request.role === role && request.attempt === 2) ? [`predecessor-context:${role}:attempt-2`] : []),
  ]);
  for (const slot of authority.roster) for (const request of slot.attempts) {
    const packet = value(handle.readStandaloneSuccessorContext(request.contextDigest));
    expect(packet.schemaVersion).toBe(3);
    expect(packet.variableContext.map(section => section.label)).toEqual(["standalone-frozen-source", ...previousLabels]);
    expect(handle.readContext(request.contextDigest).ok).toBe(false); // Legacy reader never guesses a successor purpose
  }
  const first = value(handle.readStandaloneSuccessorContext(started.requests[0]!.authority.contextDigest));
  for (const section of first.variableContext.filter(section => section.label.startsWith("predecessor-context:"))) {
    const archive = JSON.parse(Buffer.from(section.bytes).toString());
    expect(archive.encoding).toBe("published-packet-reference");
    expect(archive.path.startsWith(`${p.source.locator}/contexts/`)).toBe(true);
    const bytes = readFileSync(archive.path);
    expect(bytes.length).toBe(archive.byteLength); expect(hash(bytes)).toBe(archive.digest);
    const original = JSON.parse(bytes.toString());
    expect(bytes).toEqual(readFileSync(join(p.source.locator, "contexts", `${original.digest}.json`)));
  }
  const section = first.fixedContext.find(section => section.label === "standalone-lineage")!;
  // Reviewer-visible data only; never passed back as nominal core authority.
  const prepared = JSON.parse(Buffer.from(section.bytes).toString()) as Pick<PreparedStandaloneSuccessor, "inventory" | "lineageDigest" | "snapshotDigest">;
  return { started, handle, registration, prepared };
}
function payload(s: Awaited<ReturnType<typeof successor>>, verdict: "repaired" | "still-present" | "not-assessable" = "still-present"): StandaloneReviewerPayloadV3 {
  return { schemaVersion: 3, kind: "standalone-successor-review", lineageDigest: s.prepared.lineageDigest, snapshotDigest: s.prepared.snapshotDigest,
    priorAssessments: s.prepared.inventory.map(row => verdict === "repaired"
      ? { origin: standaloneOriginReference(row.origin), verdict, reason: "Current source assessment", change: { path: "a.ts", description: "Relevant current implementation change" } }
      : { origin: standaloneOriginReference(row.origin), verdict, reason: "Current source assessment" }), findings: [] };
}

describe.sequential("actual standalone successor CLI lifecycle", { timeout: 60_000 }, () => {
  it("fails bounded source/current-policy preflight without creating a new Run or substituting historical absence", async () => {
    const root = project(); await ownedSession(root, async () => {
      const f = await predecessor(root); const p = await policy(root, "source", "policy-zero", f.publisher);
      const base = input(p);
      const missing = { ...base, successor: { ...base.successor, source: { ...p.source, locator: join(root, "runs/missing"), runId: "missing" } } };
      expect((await invoke(root, ["start", "standalone-review", ...flags(root, "refused-missing")], json(missing))).code).not.toBe(0);
      expect(existsSync(join(root, "runs/refused-missing"))).toBe(false);
      const currentPolicy = join(p.publication.locator, "artifacts/disposition.json");
      const policyBytes = readFileSync(currentPolicy); writeFileSync(currentPolicy, "{}");
      expect((await invoke(root, ["start", "standalone-review", ...flags(root, "refused-policy")], json(base))).code).not.toBe(0);
      expect(existsSync(join(root, "runs/refused-policy"))).toBe(false); writeFileSync(currentPolicy, policyBytes);
      writeFileSync(join(root, "a.ts"), "{"); truncateSync(join(root, "a.ts"), 1024 * 1024 * 1024);
      const oversized = await invoke(root, ["start", "standalone-review", ...flags(root, "refused-source-budget")], json(base));
      expect(oversized.code).not.toBe(0); expect(oversized.stderr).toContain("byte limit");
      expect(existsSync(join(root, "runs/refused-source-budget"))).toBe(false);
      writeFileSync(join(root, "a.ts"), "export const value = 1;\n");
      const parse = value(f.helpers.parseStandaloneStartInput({ ...base, files: ["other.ts"] }));
      if (!("schemaVersion" in parse)) throw Error("successor expected");
      const narrowed = await f.shell.prepareStandaloneSuccessorFacadeStart(join(root, "runs"), "narrowed", parse);
      expect(narrowed.ok).toBe(false); expect(existsSync(join(root, "runs/narrowed"))).toBe(false);
      const dropped = value(f.helpers.parseStandaloneStartInput({ ...base, kind: "comments" }));
      if (!("schemaVersion" in dropped)) throw Error("successor expected");
      expect((await f.shell.prepareStandaloneSuccessorFacadeStart(join(root, "runs"), "dropped-role", dropped)).ok).toBe(false);
      expect(existsSync(join(root, "runs/dropped-role"))).toBe(false);
      const sourceProgram = join(p.source.locator, "program.json");
      const original = readFileSync(sourceProgram); writeFileSync(sourceProgram, "{}");
      const validInput = value(f.helpers.parseStandaloneStartInput(base));
      if (!("schemaVersion" in validInput)) throw Error("successor expected");

      const originalHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
      const committed = spawnSync("git", ["commit", "--allow-empty", "-qm", "concurrent head"], { cwd: root, encoding: "utf8" });
      expect(committed.status, committed.stderr).toBe(0);
      const concurrentHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
      expect(spawnSync("git", ["update-ref", "HEAD", originalHead], { cwd: root }).status).toBe(0);
      const shim = join(root, "git-shim"); mkdirSync(shim);
      const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
      const marker = join(shim, "advanced");
      writeFileSync(join(shim, "git"), `#!/bin/sh\nif [ "$1" = rev-parse ] && [ "$2" = HEAD ] && [ ! -e "$LOOM_GIT_MARKER" ]; then\n  "$LOOM_REAL_GIT" "$@"\n  status=$?\n  : > "$LOOM_GIT_MARKER"\n  "$LOOM_REAL_GIT" update-ref HEAD "$LOOM_CONCURRENT_HEAD"\n  exit $status\nfi\nexec "$LOOM_REAL_GIT" "$@"\n`);
      chmodSync(join(shim, "git"), 0o755);
      const previousPath = process.env.PATH;
      Object.assign(process.env, { PATH: `${shim}:${previousPath ?? ""}`, LOOM_REAL_GIT: realGit,
        LOOM_GIT_MARKER: marker, LOOM_CONCURRENT_HEAD: concurrentHead });
      try {
        const drifting = await f.shell.prepareStandaloneSuccessorFacadeStart(join(root, "runs"), "head-drift", validInput);
        expect(drifting).toEqual({ ok: false,
          message: "successor source unavailable: successor Git/reviewer authority changed during observation" });
        expect(existsSync(join(root, "runs/head-drift"))).toBe(false);
      } finally {
        if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
        delete process.env.LOOM_REAL_GIT; delete process.env.LOOM_GIT_MARKER; delete process.env.LOOM_CONCURRENT_HEAD;
        expect(spawnSync("git", ["update-ref", "HEAD", originalHead], { cwd: root }).status).toBe(0);
      }

      expect((await f.shell.prepareStandaloneSuccessorFacadeStart(join(root, "runs"), "corrupt", validInput)).ok).toBe(false);
      expect(existsSync(join(root, "runs/corrupt"))).toBe(false); writeFileSync(sourceProgram, original);
    });
  });

  it("refuses three empty-success Git status witnesses before registering a successor", async () => {
    const root = project(); await ownedSession(root, async () => {
      const f = await predecessor(root); const p = await policy(root, "source", "policy-zero", f.publisher);
      const shim = join(root, "empty-status-git"); mkdirSync(shim);
      const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
      const trace = join(root, "status-attempts");
      writeFileSync(join(shim, "git"), `#!/bin/sh\nif [ "$1" = status ] && [ "$2" = --porcelain=v2 ]; then\n  echo attempt >> "$LOOM_STATUS_TRACE"\n  exit 0\nfi\nexec "$LOOM_REAL_GIT" "$@"\n`);
      chmodSync(join(shim, "git"), 0o755);
      const previousPath = process.env.PATH;
      Object.assign(process.env, { PATH: `${shim}:${previousPath ?? ""}`, LOOM_REAL_GIT: realGit, LOOM_STATUS_TRACE: trace });
      try {
        const refused = await invoke(root, ["start", "standalone-review", ...flags(root, "empty-status")], json(input(p)));
        expect(refused.code).not.toBe(0);
        expect(refused.stderr).toContain("git status --porcelain=v2 --branch -z --untracked-files=all returned empty output after bounded retries");
        expect(readFileSync(trace, "utf8").trim().split("\n")).toHaveLength(3);
        expect(existsSync(join(root, "runs", "empty-status"))).toBe(false);
      } finally {
        if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
        delete process.env.LOOM_REAL_GIT; delete process.env.LOOM_STATUS_TRACE;
      }
    });
  });

  it("refuses orchestration submit above the raw 16 MiB capture bound before touching the pending attempt", async () => {
    const root = project(); await ownedSession(root, async () => {
      const f = await predecessor(root); const p = await policy(root, "source", "policy-zero", f.publisher);
      const s = await successor(root, "bounded-submit", p, f);
      const first = s.started.requests[0]!.authority;
      const refused = await invoke(root, ["submit", ...flags(root, s.handle.runId), "--request", first.requestId,
        "--slot", first.slotId, "--attempt", "1"], " ".repeat(16_777_217));
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("orchestration input exceeds 16777216 byte limit");
      expect(existsSync(join(s.handle.runDirectory, first.outputSlot.path))).toBe(false);
      expect(value(s.handle.readCaptureRejection(first))).toBeNull();
      const reissued = await command(root, ["resume", ...flags(root, s.handle.runId)]);
      expect(reissued.requests.map(({ authority }) => authority.requestId))
        .toEqual(s.started.requests.map(({ authority }) => authority.requestId));
    });
  });

  it("recovers a registered v3 successor before its initial batch receipt or checkpoint exists", async () => {
    const root = project(); await ownedSession(root, async () => {
      const f = await predecessor(root); const p = await policy(root, "source", "policy-zero", f.publisher);
      const parsed = value(f.helpers.parseStandaloneStartInput(input(p)));
      if (!("schemaVersion" in parsed)) throw Error("successor expected");
      const prepared = await f.shell.prepareStandaloneSuccessorFacadeStart(join(root, "runs"), "registration-only", parsed);
      if (!prepared.ok) throw Error(prepared.message);
      const handle = value(f.handles.createRunDirectory(join(root, "runs"), "registration-only"));
      value(await handle.registerProgram(JSON.parse(JSON.stringify(prepared.value.registration))));
      expect(await handle.readCheckpoint()).toBeNull();
      expect(value(handle.readIssuedRequests())).toEqual([]);

      const resumed = await command(root, ["resume", ...flags(root, handle.runId)]);
      const expected = prepared.value.authority.roster.orderedSlots.map(slot => slot.attempts[0].requestId);
      expect(resumed.kind).toBe("spawn-batch");
      expect(resumed.requests.map(({ authority }) => authority.requestId)).toEqual(expected);
      expect(value(handle.readIssuedRequests()).map(request => request.requestId).sort()).toEqual([...expected].sort());
      expect(await handle.readCheckpoint()).not.toBeNull();

      const repeated = await command(root, ["resume", ...flags(root, handle.runId)]);
      expect(repeated.requests.map(({ authority }) => authority.requestId)).toEqual(expected);
    });
  });

  it("rejects explicit predecessor cycles and the 64-Run traversal bound without creating a successor", async () => {
    const root = project(); await ownedSession(root, async () => {
      const f = await predecessor(root); const p = await policy(root, "source", "policy-zero", f.publisher);
      const s = await successor(root, "cycle", p, f);
      const cyclic = { ...s.registration, input: { ...s.registration.input, successor: { ...s.registration.input.successor,
        source: { locator: s.handle.runDirectory, runId: s.handle.runId, resultDigest: "a".repeat(64) } } } };
      writeFileSync(join(s.handle.runDirectory, "program.json"), json(cyclic));
      const attempted = { ...input(p), successor: { source: cyclic.input.successor.source, disposition: { kind: "historical-decision-unavailable" } } };
      const refused = await invoke(root, ["start", "standalone-review", ...flags(root, "cycle-refused")], json(attempted));
      expect(refused.code).not.toBe(0); expect(refused.stderr).toContain("cyclic");
      expect(existsSync(join(root, "runs/cycle-refused"))).toBe(false);
      const source = await import("../../../../src/handlers/helpers/programs/standalone-source");
      const bounded = await source.readAuthenticatedStandaloneLineageSource(join(root, "runs"), "source",
        { visited: Array.from({ length: 64 }, (_, i) => `/owned/ancestor-${i}`), remaining: 64 * 1024 * 1024 });
      expect(bounded.ok).toBe(false); if (!bounded.ok) expect(bounded.message).toContain("64 Runs");
    });
  });

  it("consumes genuine owned v1 issuance with honest unknown historical bytes/modes, while current modes and full fresh roster are frozen", async () => {
    const root = project(); await ownedSession(root, async () => {
      const handles = await import("../../../../src/orchestration/run-directory-handle");
      const shell = await import("../../../../src/handlers/helpers/programs/standalone");
      const helpers = await import("../../../../src/handlers/helpers/programs/helpers");
      const publisher = await import("../../../../src/handlers/helpers/programs/standalone-disposition");
      const { legacyStandaloneContext, standaloneFixtureRegistration } = await import("../../../fixtures/standalone-reviewer-protocol");
      const { prepareStandaloneReview } = await import("../../../../src/core/standalone-review");
      const machine = await import("../../../../src/core/standalone-review-machine");
      const { resolveAgentPolicy, resolveModelProfile, lowerModelProfile } = await import("../../../../src/core/model-profiles");
      const handle = value(handles.createRunDirectory(join(root, "runs"), "source"));
      const agent = value(resolveAgentPolicy("code-reviewer")); const profile = value(resolveModelProfile(agent.profile));
      const attempts = ([1, 2] as const).map(attempt => {
        const identity = { runId: handle.runId, requestId: `request:legacy:${attempt}`, role: agent.agent, attempt, requiredSkill: agent.requiredSkill };
        const packet = legacyStandaloneContext(identity, ["a.ts"]);
        return { packet, authority: { ...identity, slotId: "slot:legacy", program: "standalone-review", modelProfile: agent.profile,
          harnessBinding: { pi: lowerModelProfile(profile, "pi"), claude: lowerModelProfile(profile, "claude-code") },
          contextDigest: packet.digest, outputSlot: `transcripts/slot:legacy/attempt-${attempt}.raw` } };
      });
      const prepared = value(prepareStandaloneReview({ runId: handle.runId, explicitScope: ["a.ts"],
        changedPaths: { unstaged: ["a.ts"], staged: [], committed: [], base_revision: null,
          head_revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim() },
        reviewMetadata: { requested_kinds: ["types"], docs_only: false, source_or_test_changed: false, types_changed: false,
          comments_changed: false, additions: 1, file_count: 1, new_structure: false, languages: ["TypeScript"] },
        scopeSafety: [{ path: "a.ts", status: "safe" }], roster: [{ slotId: "slot:legacy", attempts: attempts.map(row => row.authority) }] }));
      const registration = standaloneFixtureRegistration(prepared.authority); value(await handle.registerProgram(registration));
      const batch = await helpers.publishInitialBatch(handle, prepared.initialRequests.map(authority => ({ authority,
        context: { digest: authority.contextDigest, slot: `contexts/${authority.contextDigest}.json` } })), attempts.map(row => row.packet), "standalone-review");
      expect(batch.ok).toBe(true);
      const awaiting = value(machine.reduceStandaloneReviewMachine(machine.startStandaloneReviewMachine(prepared.authority), { kind: "review-batch-published", runId: handle.runId }));
      await handle.writeCheckpoint(machine.serializeStandaloneReviewMachineState(awaiting));
      value(await handle.captureTranscript(prepared.initialRequests[0], [...Buffer.from("Missing historical required markers")]));
      const retried = await shell.resumeStandaloneFacade(handle, registration);
      if (!retried.ok) throw Error(retried.message);
      const retry = (retried.action as Action).requests[0]!.authority;
      expect(retry.attempt).toBe(2);
      value(await handle.captureTranscript(retry, [...Buffer.from("### Machine Summary\nCRITICAL_COUNT: 0\nADVISORY_COUNT: 1\nADVISORY: exact original v1 assertion")]));
      expect((await shell.resumeStandaloneFacade(handle, registration)).ok).toBe(true);
      const before = readFileSync(join(handle.runDirectory, "result.json"));
      const p = await policy(root, "source", "policy-zero", publisher);
      expect(p.lineage.snapshot).toEqual([{ kind: "historical-unknown", path: "a.ts" }]);
      chmodSync(join(root, "a.ts"), 0o755);
      const s = await successor(root, "from-v1", p, { handles, shell, helpers, publisher });
      for (const { authority } of s.started.requests) await submit(root, s.handle.runId, authority, payload(s, "repaired"));
      const result = JSON.parse(readFileSync(join(s.handle.runDirectory, "result.json"), "utf8"));
      expect(result.successor.previousSnapshot).toEqual(p.lineage.snapshot); expect(result.successor.snapshot[0].mode).toBe("100755");
      expect(result.lineage.inventory[0].finding).not.toHaveProperty("protocolVersion");
      expect(result.lineage.inventory[0].origin.requestId).toBe(retry.requestId);
      expect(result.lineage.inventory[0].history[0].assessments).toHaveLength(2);
      expect(result.lineage.inventory[0].history[0].assessments.every((row: { changedInput: string }) => row.changedInput === "historical-unknown")).toBe(true);
      expect(readFileSync(join(handle.runDirectory, "result.json"))).toEqual(before);
    });
  });

  it.each(["missing", "duplicate", "foreign"] as const)("rejects the entire %s prior response, retries once, then terminal-blocks without a synthetic Finding", async mode => {
    const root = project(); await ownedSession(root, async () => {
      const f = await predecessor(root); const p = await policy(root, "source", "policy-zero", f.publisher);
      const s = await successor(root, "retry-terminal", p, f);
      const [first, sibling] = s.started.requests;
      const siblingReport = payload(s, "not-assessable");
      await submit(root, s.handle.runId, sibling!.authority, siblingReport);
      const originalSibling = value(s.handle.readTranscriptBytes(sibling!.authority));
      const report = payload(s);
      const bad = { ...report, priorAssessments: mode === "missing" ? [] : mode === "duplicate"
        ? [report.priorAssessments[0], report.priorAssessments[0]] : [{ ...report.priorAssessments[0], origin: "f".repeat(64) }] };
      const retry = await submit(root, s.handle.runId, first!.authority, bad);
      expect(retry.requests).toHaveLength(1); expect(retry.requests[0]!.authority.attempt).toBe(2);
      expect(retry.requests[0]!.task).toContain("final attempt"); expect(retry.requests[0]!.task).not.toContain("Machine Summary");
      const terminal = await submit(root, s.handle.runId, retry.requests[0]!.authority, bad);
      expect(terminal.kind).toBe("blocked");
      expect(JSON.parse(readFileSync(join(s.handle.runDirectory, "checkpoint.json"), "utf8")).kind).toBe("terminal-blocked");
      expect(existsSync(join(s.handle.runDirectory, "result.json"))).toBe(false);
      expect(value(s.handle.readTranscriptBytes(sibling!.authority))).toEqual(originalSibling);
    });
  });

  it("rebuilds both frozen attempts without live bytes; disagreement/not-assessable remain valid, and CLI replay ignores own corrupt projections", async () => {
    const root = project(); await ownedSession(root, async () => {
      const f = await predecessor(root); const p = await policy(root, "source", "policy-zero", f.publisher);
      writeFileSync(join(root, "a.ts"), "export const value = 2;\n");
      const s = await successor(root, "retry-valid", p, f);
      const roster = (s.registration.authority as { roster: { attempts: AgentRequestAuthority[] }[] }).roster;
      const packets = roster.flatMap(slot => slot.attempts).map(request => {
        const path = join(s.handle.runDirectory, "contexts", `${request.contextDigest}.json`); return { path, bytes: readFileSync(path) };
      });
      const [first, sibling] = s.started.requests;
      await submit(root, s.handle.runId, sibling!.authority, payload(s, "not-assessable"));
      for (const packet of packets) unlinkSync(packet.path);
      writeFileSync(join(root, "a.ts"), "MUTABLE LIVE BYTES MUST NOT ENTER RETRY\n");
      const retry = await submit(root, s.handle.runId, first!.authority, { ...payload(s), priorAssessments: [] });
      expect(retry.requests[0]!.authority.attempt).toBe(2);
      for (const packet of packets) expect(readFileSync(packet.path)).toEqual(packet.bytes);
      expect((await submit(root, s.handle.runId, retry.requests[0]!.authority, payload(s, "repaired"))).kind).toBe("done");
      const bytes = readFileSync(join(s.handle.runDirectory, "result.json"));
      const result = JSON.parse(bytes.toString());
      expect(result.lineage.counts.resolved).toBe(0); expect(result.lineage.assessments[0].state).toBe("coverage-limited");
      expect(result.reviewer_evidence.map((entry: { attempt: number }) => entry.attempt)).toEqual([2, 1]);
      const inspected = await command(root, ["inspect", ...flags(root, s.handle.runId), "--json"]);
      expect(inspected).toMatchObject({ state: { kind: "observed", value: "done" } });
      writeFileSync(join(s.handle.runDirectory, "checkpoint.json"), "{broken"); writeFileSync(join(s.handle.runDirectory, "result.json"), "{broken");
      const replay = await command(root, ["inspect", ...flags(root, s.handle.runId), "--replay"]);
      expect(Buffer.from(replay.json)).toEqual(bytes); expect(replay.digest).toBe(hash(bytes));
      const evidence = await import("../../../../src/handlers/helpers/programs/standalone-evidence");
      const source = await import("../../../../src/handlers/helpers/programs/standalone-source");
      expect(f.shell.replayStandaloneCliCaptures).toBe(evidence.replayStandaloneCliCaptures);
      // Lower replay cannot promote structurally parsed registration into predecessor authority.
      expect(evidence.replayStandaloneCliCaptures(s.handle, s.registration).ok).toBe(false);
      const authenticated = value(await source.readStandaloneSuccessorAuthority(s.handle, s.registration));
      const independent = evidence.replayStandaloneCliCaptures(s.handle, s.registration, authenticated.prepared);
      expect(independent).toMatchObject({ ok: true, json: bytes.toString(), digest: hash(bytes) });
      expect(readFileSync(join(s.handle.runDirectory, "checkpoint.json"), "utf8")).toBe("{broken");
      expect(readFileSync(join(s.handle.runDirectory, "result.json"), "utf8")).toBe("{broken");
      const raw = value(s.handle.readTranscriptBytes(retry.requests[0]!.authority));
      writeFileSync(join(s.handle.runDirectory, retry.requests[0]!.authority.outputSlot.path), Buffer.from(" ".repeat(raw.length)));
      expect((await f.shell.replayStandaloneCapturedEvidence(s.handle, s.registration)).ok).toBe(false);
      expect(evidence.replayStandaloneCliCaptures(s.handle, s.registration, authenticated.prepared).ok).toBe(false);
    });
  });

  it("binds reopening evidence to a fresh full strict-majority panel for only reopening and new criticals", async () => {
    const root = project(); await ownedSession(root, async () => {
      const f = await predecessor(root, true); const p = await policy(root, "source", "policy-zero", f.publisher);
      const s = await successor(root, "reopening", p, f);
      const original = s.prepared.inventory[0]!;
      const report = { ...payload(s), priorAssessments: [
        { origin: standaloneOriginReference(original.origin), verdict: "reopen", reason: "New contradictory execution evidence",
          proposal: { decisionDigest: standaloneDecisionReference(original.history[0]!), evidence: critical.basis!.evidence,
            changedConditions: "Current precondition is now supported", currentApplicability: "Exact original assertion applies", evidenceLimits: "Static trace, not executed" } },
        payload(s).priorAssessments[1],
      ] };
      let panel: Action | undefined;
      for (const [index, request] of s.started.requests.entries()) panel = await submit(root, s.handle.runId, request.authority, { ...report,
        findings: index === 0 ? [{ draft: { ...critical, claim: "A genuinely new critical" }, relation: { kind: "independent" } }] : [] });
      expect(panel?.kind).toBe("spawn-batch"); expect(panel?.requests).toHaveLength(3);
      const checkpoint = JSON.parse(readFileSync(join(s.handle.runDirectory, "checkpoint.json"), "utf8"));
      expect(checkpoint.panelAuthority.threshold).toBe(2);
      for (const [index, { authority }] of panel!.requests.entries()) {
        const packet = value(s.handle.readContext(authority.contextDigest));
        const context = JSON.parse(Buffer.from(packet.fixedContext[0]!.bytes).toString());
        expect(context.findings.map((finding: { id: string }) => finding.id)).toEqual(["standalone-review:code-reviewer-1", "standalone-review:code-reviewer-3"]);
        expect(context.successorEvidence).toEqual(checkpoint.panelAuthority.successorEvidence);
        expect(context.successorEvidence.reports).toHaveLength(2);
        expect(context.successorEvidence.reports[0].payload.priorAssessments[0]).toEqual(report.priorAssessments[0]);
        const action = await submit(root, s.handle.runId, authority, { criterion: context.lens,
          verdicts: context.findings.map((finding: { id: string }, row: number) => ({ finding_id: finding.id,
            verdict: row === 0 && index < 2 ? "refuted" : "upheld", reasoning: `Fresh ${context.lens} reason` })) });
        expect(action.kind).toBe(index === 2 ? "done" : "spawn-batch");
      }
      const bytes = readFileSync(join(s.handle.runDirectory, "result.json")); const result = JSON.parse(bytes.toString());
      expect(result.lineage.inventory[0].history[0]).toEqual(original.history[0]);
      expect(result.lineage.inventory[0].history).toHaveLength(2);
      expect(result.lineage.inventory[0].history[1].refutations).toHaveLength(2);
      expect(result.lineage.inventory[1].history).toEqual(s.prepared.inventory[1]!.history);
      expect(result.lineage.counts).toMatchObject({ new: 1, inherited: 2, survivingCritical: 2, refutedCritical: 1 });
      unlinkSync(join(s.handle.runDirectory, "checkpoint.json"));
      const replay = await f.shell.replayStandaloneCapturedEvidence(s.handle, s.registration);
      if (!replay.ok) throw Error(replay.message); expect(Buffer.from(replay.json)).toEqual(bytes);
    });
  });

  it("accepts explicit repaired/still-present disagreement without consuming semantic retry or resolving the origin", async () => {
    const root = project(); await ownedSession(root, async () => {
      const f = await predecessor(root); const p = await policy(root, "source", "policy-zero", f.publisher);
      writeFileSync(join(root, "a.ts"), "export const value = 2;\n");
      const s = await successor(root, "disagreement", p, f);
      for (const [index, { authority }] of s.started.requests.entries()) {
        const action = await submit(root, s.handle.runId, authority, payload(s, index === 0 ? "repaired" : "still-present"));
        expect(action.kind).toBe(index === 0 ? "spawn-batch" : "done");
      }
      const result = JSON.parse(readFileSync(join(s.handle.runDirectory, "result.json"), "utf8"));
      expect(result.lineage.assessments[0].state).toBe("active"); expect(result.lineage.counts.resolved).toBe(0);
      expect(value(s.handle.readIssuedRequests()).every(request => request.attempt === 1)).toBe(true);
    });
  });

  it("does not re-adjudicate old upheld blockers; valid current critical coverage limitations remain explicit", async () => {
    const root = project(); await ownedSession(root, async () => {
      const f = await predecessor(root, true); const p = await policy(root, "source", "policy-zero", f.publisher);
      const s = await successor(root, "unchanged", p, f);
      for (const [index, { authority }] of s.started.requests.entries()) {
        const report = payload(s);
        const original = s.prepared.inventory[0]!;
        const first = index === 0 ? { origin: standaloneOriginReference(original.origin), verdict: "not-assessable", reason: "Unavailable semantic applicability" }
          : { origin: standaloneOriginReference(original.origin), verdict: "retained", decisionDigest: standaloneDecisionReference(original.history[0]!), reason: "Prior reason still applies" };
        const action = await submit(root, s.handle.runId, authority, { ...report, priorAssessments: [first, report.priorAssessments[1]] });
        expect(action.kind).toBe(index === 0 ? "spawn-batch" : "done");
      }
      const result = JSON.parse(readFileSync(join(s.handle.runDirectory, "result.json"), "utf8"));
      expect(result.panel).toBeNull();
      expect(result.lineage.currentCriticalCoverage).toEqual({ kind: "limited", origins: [standaloneOriginReference(s.prepared.inventory[0]!.origin)] });
      expect(result.lineage.counts).toMatchObject({ survivingCritical: 1, currentCriticalCoverageLimited: 1 });
      expect(value(s.handle.readIssuedRequests()).every(request => request.program === "standalone-review")).toBe(true);
      const source = await import("../../../../src/handlers/helpers/programs/standalone-source");
      const authenticated = value(await source.readAuthenticatedStandaloneSource(join(root, "runs"), s.handle.runId));
      const { prepareDefectFamilyAccounting } = await import("../../../../src/core/defect-family-accounting");
      expect(prepareDefectFamilyAccounting(authenticated.result, { kind: "not-required" }).ok).toBe(false);
    });
  });
  it("publishes two owned CLI-issued successors with receipt-backed roster collection and independently replays original identity/history/high-water", async () => {
    const root = project(); await ownedSession(root, async () => {
      const f = await predecessor(root); const p = await policy(root, "source", "policy-zero", f.publisher);
      writeFileSync(join(root, "a.ts"), "export const value = 2;\n");
      const one = await successor(root, "one", p, f);
      // Collect the complete roster before driving once, using submit's actual
      // receipt-producing runner. Other cases exercise per-submission CLI resume.
      for (const [index, { authority }] of one.started.requests.entries()) {
        const report = payload(one, "repaired");
        await captureStandaloneCliEvidence(one.handle, authority, { ...report, findings: index === 0 ? [{ draft: { severity: "advisory", file: "a.ts", line: 1, claim: "Second assertion", reason: "Nonblocking" }, relation: { kind: "independent" } }] : [] });
      }
      expect(await f.shell.resumeStandaloneFacade(one.handle, one.registration)).toMatchObject({ ok: true, action: { kind: "done" } });
      const bytesOne = readFileSync(join(one.handle.runDirectory, "result.json"));
      const p1 = await policy(root, "one", "policy-one", f.publisher);
      writeFileSync(join(root, "a.ts"), "export const value = 3;\n");
      const two = await successor(root, "two", p1, f);
      for (const [index, { authority }] of two.started.requests.entries()) {
        const report = payload(two);
        const priorAssessments = report.priorAssessments.map((row, i) => i === 0 ? { origin: row.origin, verdict: "retained", reason: "Resolution still applies",
          decisionDigest: standaloneDecisionReference(two.prepared.inventory[0]!.history.at(-1)!) } : row);
        await captureStandaloneCliEvidence(two.handle, authority, { ...report, priorAssessments, findings: index === 0 ? [{ draft: { severity: "advisory", file: "a.ts", line: 1, claim: "Third assertion", reason: "Nonblocking" }, relation: { kind: "independent" } }] : [] });
      }
      expect(await f.shell.resumeStandaloneFacade(two.handle, two.registration)).toMatchObject({ ok: true, action: { kind: "done" } });
      const bytesTwo = readFileSync(join(two.handle.runDirectory, "result.json"));
      const result = JSON.parse(bytesTwo.toString());
      expect(result.lineage.inventory.map((row: { finding: { id: string } }) => row.finding.id)).toEqual(["code-reviewer-1", "code-reviewer-2", "code-reviewer-3"]);
      expect(result.lineage.inventory[0].origin).toEqual(p.lineage.inventory[0]!.origin);
      expect(result.lineage.inventory[1].origin).toMatchObject({ kind: "published-successor", runId: "one",
        publication: { locator: one.handle.runDirectory, runId: "one", resultDigest: hash(bytesOne) } });
      expect(result.lineage.inventory[2].origin.kind).toBe("current");
      expect(result.lineage.inventory[2].origin).not.toHaveProperty("publication");
      expect(result.successor.reviewHistory).toHaveLength(1);
      expect(result.successor.reviewHistory[0].reports).toHaveLength(2);
      expect(result.lineage.inventory[0].history[0].kind).toBe("successor-resolution");
      expect(result.lineage.inventory[0].history[0].assessments).toHaveLength(2);
      // Replay the second while its predecessor remains available, then the first; own projections are absent.
      for (const [s, bytes] of [[two, bytesTwo], [one, bytesOne]] as const) {
        unlinkSync(join(s.handle.runDirectory, "checkpoint.json")); unlinkSync(join(s.handle.runDirectory, "result.json"));
        const replay = await f.shell.replayStandaloneCapturedEvidence(s.handle, s.registration);
        if (!replay.ok) throw Error(replay.message);
        expect(Buffer.from(replay.json)).toEqual(bytes); expect(replay.digest).toBe(hash(bytes));
        expect(existsSync(join(s.handle.runDirectory, "checkpoint.json"))).toBe(false);
      }
    });
  });
});
