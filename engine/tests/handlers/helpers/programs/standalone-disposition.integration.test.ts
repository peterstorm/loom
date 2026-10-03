import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalTempDir } from "../../../fixtures/canonical-temp-dir";
import { disposeFixturePiSessions, fixturePiEnvironment, withFixturePiSession as runInFixturePiSession } from "../../../fixtures/pi-session";
import { standaloneOriginReference, prepareStandaloneSuccessor, type StandaloneDispositionPublicationReference } from "../../../../src/core/standalone-lineage";
import { parseStandaloneDispositionStartBytes, standaloneDispositionReceipt } from "../../../../src/core/standalone-disposition-machine";
function valueOf<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>): T {
  if (!result.ok) throw Error(JSON.stringify(result));
  return result.value;
}
import type { AgentRequestAuthority } from "../../../../src/core/orchestration-contract";
import type { StandaloneDispositionRecord } from "../../../../src/core/standalone-lineage-contract";
type Action = Readonly<{ kind: string; requests: readonly { authority: AgentRequestAuthority }[];
  outcome: { publication: StandaloneDispositionPublicationReference; receipt: unknown; record: StandaloneDispositionRecord; provenance: string };
  state: { kind: string; value: string } }>;

const cli = fileURLToPath(new URL("../../../../src/cli.ts", import.meta.url));
const roots: string[] = [];
const operations = new Set<Promise<void>>();
/** Vitest timeout does not cancel async work. Keep custody through the whole operation, not just its current child. */
function withFixturePiSession<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const result = runInFixturePiSession(root, operation);
  const settled = result.then(() => undefined, () => undefined);
  operations.add(settled);
  void settled.then(() => operations.delete(settled));
  return result;
}
afterEach(async () => {
  await Promise.all([...operations]);
  disposeFixturePiSessions();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const bytes = (raw: unknown) => Buffer.from(JSON.stringify(raw));
const hash = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");
function project() {
  const root = canonicalTempDir("loom-p5-disposition-");
  roots.push(root);
  mkdirSync(join(root, "runs"));
  writeFileSync(join(root, "README.md"), "# Original\n");
  for (const args of [["init", "-q"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"],
    ["add", "README.md"], ["commit", "-qm", "fixture baseline"]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw Error(result.stderr);
  }
  writeFileSync(join(root, "README.md"), "# Reviewed\n");
  return root;
}
async function invoke(root: string, args: readonly string[], input = "", skew = false) {
  const env = fixturePiEnvironment(root);
  if (skew) env.LOOM_PI_EXTENSION_RUNTIME_REVISION = `sha256:${"0".repeat(64)}`;
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("bun", [cli, "helper", "orchestration", ...args], { cwd: root, env });
    let stdout = ""; let stderr = "";
    let failure: Error | null = null;
    child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
    child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
    child.once("error", error => { failure = error; });
    child.once("close", code => failure === null ? resolve({ code, stdout, stderr }) : reject(failure));
    child.stdin.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") failure = error; });
    child.stdin.end(input);
  });
}
async function command(root: string, args: readonly string[], raw = "") {
  const result = await invoke(root, args, raw);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Action;
}
const flags = (root: string, run: string) => ["--runs-root", join(root, "runs"), "--run", run];
async function sourceFixture(root: string) {
  const initial = await command(root, ["start", "standalone-review", ...flags(root, "source")], JSON.stringify({ kind: "simplify", files: ["README.md"], dryRun: false }));
  const requests: readonly { authority: AgentRequestAuthority }[] = initial.requests;
  for (const [index, { authority }] of requests.entries()) {
    await command(root, ["submit", ...flags(root, "source"), "--request", authority.requestId, "--slot", authority.slotId, "--attempt", "1"],
      JSON.stringify({ schemaVersion: 2, kind: "standalone-review", findings: index === 0 ? [
        { severity: "advisory", file: "README.md", line: 1, claim: "First advisory", reason: "Nonblocking clarity" },
        { severity: "advisory", file: "README.md", line: 1, claim: "Second advisory", reason: "Nonblocking organization" },
      ] : [] }));
  }
  const locator = join(root, "runs", "source");
  const source = { locator, runId: "source", resultDigest: hash(readFileSync(join(locator, "result.json"))) };
  const publisher = await import("../../../../src/handlers/helpers/programs/standalone-disposition");
  const lineage = valueOf(await publisher.readStandaloneDispositionSource(source));
  const input = valueOf(parseStandaloneDispositionStartBytes(bytes({ source, previous: null, record: { schemaVersion: 1,
    source, provenance: "DECLARED", revision: { kind: "initial" }, entries: lineage.inventory.map((row, index) => ({
      origin: standaloneOriginReference(row.origin), decision: index === 0 ? "accepted" : "deferred", reason: "  Exact declared policy\n  " })) } })));
  return { source, lineage, input, publisher };
}

describe.sequential("admitted standalone advisory publication, correction and recovery", { timeout: 60_000 }, () => {
  it("publishes advisory-only decisions without repair or successor; exact retries preserve all durable bytes and index", async () => {
    const root = project();
    await withFixturePiSession(root, async () => {
      const f = await sourceFixture(root);
      const index = readFileSync(join(root, ".git/index"));
      const done = await command(root, ["start", "standalone-disposition", ...flags(root, "policy")], JSON.stringify(f.input));
      expect(done).toMatchObject({ kind: "done", outcome: { kind: "standalone-disposition-published", provenance: "DECLARED" } });
      const path = join(root, "runs/policy");
      const before = ["program.json", "artifacts/disposition.json", "checkpoint.json"].map(name => readFileSync(join(path, name)));
      expect(JSON.parse(before[1]!.toString())).toEqual(f.input.record);
      expect(readdirSync(join(path, "requests"))).toEqual(["correlators"]);
      expect(readdirSync(join(path, "events"))).toEqual([]);
      expect(await command(root, ["resume", ...flags(root, "policy")])).toEqual(done);
      expect(await command(root, ["start", "standalone-disposition", ...flags(root, "policy")], JSON.stringify(f.input))).toEqual(done);
      for (const [i, name] of ["program.json", "artifacts/disposition.json", "checkpoint.json"].entries()) expect(readFileSync(join(path, name))).toEqual(before[i]);
      const inspected = await command(root, ["inspect", ...flags(root, "policy"), "--json"]);
      expect(inspected.state).toEqual({ kind: "observed", value: "done" });
      expect(await command(root, ["status", ...flags(root, "policy"), "--json"])).toEqual(inspected);
      const reader = await import("../../../../src/handlers/helpers/programs/standalone-disposition-source");
      expect(f.publisher.readSelectedStandaloneDisposition).toBe(reader.readSelectedStandaloneDisposition);
      const selected = valueOf(reader.readSelectedStandaloneDisposition(f.lineage, done.outcome.publication));
      expect(prepareStandaloneSuccessor(f.lineage, bytes({ runId: "successor", snapshot: [{ kind: "absent", path: "README.md" }], reviewers: f.lineage.reviewers }), { kind: "selected-record", disposition: selected }).ok).toBe(true);
      expect(readFileSync(join(root, ".git/index"))).toEqual(index);
    });
  });

  it("the downward revision reader refuses a different authentic source even with exact published policy bytes", async () => {
    const root = project();
    await withFixturePiSession(root, async () => {
      const f = await sourceFixture(root);
      const done = await command(root, ["start", "standalone-disposition", ...flags(root, "policy")], JSON.stringify(f.input));
      const other = await command(root, ["start", "standalone-review", ...flags(root, "other-source")],
        JSON.stringify({ kind: "simplify", files: ["README.md"], dryRun: false }));
      for (const { authority } of other.requests) {
        await command(root, ["submit", ...flags(root, "other-source"), "--request", authority.requestId,
          "--slot", authority.slotId, "--attempt", "1"], JSON.stringify({ schemaVersion: 2, kind: "standalone-review", findings: [] }));
      }
      const locator = join(root, "runs/other-source");
      const foreign = valueOf(await f.publisher.readStandaloneDispositionSource({ locator, runId: "other-source",
        resultDigest: hash(readFileSync(join(locator, "result.json"))) }));
      const reader = await import("../../../../src/handlers/helpers/programs/standalone-disposition-source");
      const path = join(root, "runs/policy/artifacts/disposition.json");
      const original = readFileSync(path);
      expect(reader.readSelectedStandaloneDisposition(foreign, done.outcome.publication).ok).toBe(false);
      expect(reader.readSelectedStandaloneDisposition(f.lineage, done.outcome.publication).ok).toBe(true);
      expect(readFileSync(path)).toEqual(original);
    });
  });

  it("corrects only an exact authentic published previous revision, allows explicit forks, and refuses conflicts", async () => {
    const root = project();
    await withFixturePiSession(root, async () => {
      const f = await sourceFixture(root);
      const first = await command(root, ["start", "standalone-disposition", ...flags(root, "first")], JSON.stringify(f.input));
      const original = readFileSync(join(root, "runs/first/artifacts/disposition.json"));
      const correction = { ...f.input, previous: first.outcome.publication, record: { ...f.input.record,
        revision: { kind: "correction", previousDigest: first.outcome.publication.dispositionDigest },
        entries: f.input.record.entries.map(row => ({ ...row, decision: "dismissed", reason: "Present-day policy reconsideration" })) } };
      const second = await command(root, ["start", "standalone-disposition", ...flags(root, "second")], JSON.stringify(correction));
      expect(second.outcome.publication.dispositionDigest).not.toBe(first.outcome.publication.dispositionDigest);
      expect((await command(root, ["start", "standalone-disposition", ...flags(root, "fork")], JSON.stringify(correction))).outcome.publication.runId).toBe("fork");
      expect((await invoke(root, ["start", "standalone-disposition", ...flags(root, "second")], JSON.stringify(f.input))).code).not.toBe(0);
      expect(readFileSync(join(root, "runs/first/artifacts/disposition.json"))).toEqual(original);
    });
  });

  it("rejects missing prior publication and current corruption without historical fallback", async () => {
    const root = project();
    await withFixturePiSession(root, async () => {
      const f = await sourceFixture(root);
      const first = await command(root, ["start", "standalone-disposition", ...flags(root, "first")], JSON.stringify(f.input));
      const correction = { ...f.input, previous: first.outcome.publication, record: { ...f.input.record,
        revision: { kind: "correction", previousDigest: first.outcome.publication.dispositionDigest },
        entries: f.input.record.entries.map(row => ({ ...row, decision: "dismissed", reason: "Present-day policy reconsideration" })) } };
      const second = await command(root, ["start", "standalone-disposition", ...flags(root, "second")], JSON.stringify(correction));
      const receiptPath = join(root, "runs/first/receipts", `effect:standalone-disposition:${first.outcome.publication.dispositionDigest}.json`);
      const receipt = readFileSync(receiptPath);
      unlinkSync(receiptPath);
      expect((await invoke(root, ["start", "standalone-disposition", ...flags(root, "unpublished")], JSON.stringify(correction))).code).not.toBe(0);
      expect(existsSync(join(root, "runs/unpublished"))).toBe(false);
      writeFileSync(receiptPath, receipt);
      writeFileSync(join(root, "runs/second/artifacts/disposition.json"), "{}");
      expect(f.publisher.readSelectedStandaloneDisposition(f.lineage, second.outcome.publication).ok).toBe(false);
      expect((await invoke(root, ["resume", ...flags(root, "second")])).code).not.toBe(0);
      expect((await command(root, ["inspect", ...flags(root, "second"), "--json"])).state.kind).toBe("unavailable");
    });
  });

  it.each(["registration", "artifact", "receipt", "checkpoint"] as const)("recovers actual %s/checkpoint crash windows with receipt-backed exact publication", async crash => {
    const root = project();
    await withFixturePiSession(root, async () => {
      const f = await sourceFixture(root);
      const registration = valueOf(await f.publisher.prepareStandaloneDispositionFacadeStart(f.input, join(root, "runs"), "crash"));
      const { createRunDirectory } = await import("../../../../src/orchestration/run-directory-handle");
      const handle = valueOf(createRunDirectory(join(root, "runs"), "crash"));
      let fired = false;
      const interrupted = { ...handle,
        registerProgram: async (input: unknown) => {
          const result = await handle.registerProgram(input);
          if (crash === "registration" && result.ok) {
            fired = true;
            return { ok: false as const, error: { kind: "invalid-run-directory" as const, field: "program", message: "injected after registration commit" } };
          }
          return result;
        },
        publishArtifactSet: async (...args: Parameters<typeof handle.publishArtifactSet>) => {
          const result = await handle.publishArtifactSet(...args);
          if (crash === "artifact" && result.ok) { fired = true; throw Error("injected after artifact commit"); }
          return result;
        },
        recordReceipt: async (...args: Parameters<typeof handle.recordReceipt>) => {
          const result = await handle.recordReceipt(...args);
          if (crash === "receipt" && result.ok) { fired = true; throw Error("injected after receipt commit"); }
          return result;
        },
        writeCheckpoint: async (json: string) => {
          if (crash === "checkpoint" && JSON.parse(json).kind === "done") { fired = true; throw Error("injected before done checkpoint"); }
          return handle.writeCheckpoint(json);
        },
      };
      expect((await f.publisher.startStandaloneDispositionFacade(interrupted, registration)).ok).toBe(false);
      expect(fired).toBe(true);
      const artifact = crash === "registration" ? bytes(f.input.record) : readFileSync(join(handle.runDirectory, "artifacts/disposition.json"));
      if (crash === "registration") {
        expect(existsSync(join(handle.runDirectory, "artifacts/disposition.json"))).toBe(false);
        expect(f.publisher.readSelectedStandaloneDisposition(f.lineage, { locator: handle.runDirectory, runId: handle.runId,
          dispositionDigest: standaloneDispositionReceipt(registration).artifacts[0].digest }).ok).toBe(false);
      }
      const inspection = await command(root, ["inspect", ...flags(root, "crash"), "--json"]);
      expect(inspection.state.value).toBe({ registration: "registered", artifact: "artifact-published", receipt: "done", checkpoint: "done" }[crash]);
      const done = await command(root, ["resume", ...flags(root, "crash")]);
      expect(done.kind).toBe("done");
      expect(done.outcome.receipt).toEqual(standaloneDispositionReceipt(registration));
      expect(await command(root, ["resume", ...flags(root, "crash")])).toEqual(done);
      expect(readFileSync(join(handle.runDirectory, "artifacts/disposition.json"))).toEqual(artifact);
    });
  });

  it("refuses absent/foreign source, malformed coverage, symlinked source/receipt and oversized files before destination creation", async () => {
    const root = project();
    await withFixturePiSession(root, async () => {
      const f = await sourceFixture(root);
      for (const [name, input] of [
        ["absent", { ...f.input, source: { ...f.source, locator: join(root, "runs/absent-source"), runId: "absent-source" }, record: { ...f.input.record, source: { ...f.source, locator: join(root, "runs/absent-source"), runId: "absent-source" } } }],
        ["foreign", { ...f.input, source: { ...f.source, resultDigest: "f".repeat(64) }, record: { ...f.input.record, source: { ...f.source, resultDigest: "f".repeat(64) } } }],
        ["missing-row", { ...f.input, record: { ...f.input.record, entries: [] } }],
        ["reordered", { ...f.input, record: { ...f.input.record, entries: [...f.input.record.entries].reverse() } }],
      ] as const) {
        expect((await invoke(root, ["start", "standalone-disposition", ...flags(root, name)], JSON.stringify(input))).code).not.toBe(0);
        expect(existsSync(join(root, "runs", name))).toBe(false);
      }
      const sourceCheckpoint = join(f.source.locator, "checkpoint.json");
      const checkpoint = readFileSync(sourceCheckpoint);
      unlinkSync(sourceCheckpoint);
      symlinkSync(join(f.source.locator, "result.json"), sourceCheckpoint);
      expect((await invoke(root, ["start", "standalone-disposition", ...flags(root, "unsafe")], JSON.stringify(f.input))).code).not.toBe(0);
      unlinkSync(sourceCheckpoint);
      writeFileSync(sourceCheckpoint, "{"); truncateSync(sourceCheckpoint, 1024 * 1024 * 1024);
      const oversized = await invoke(root, ["start", "standalone-disposition", ...flags(root, "oversized")], JSON.stringify(f.input));
      expect(oversized.code).not.toBe(0); expect(oversized.stderr).toContain("byte limit");
      writeFileSync(sourceCheckpoint, checkpoint);
      expect(existsSync(join(root, "runs/unsafe"))).toBe(false);
      expect(existsSync(join(root, "runs/oversized"))).toBe(false);
      const skew = await invoke(root, ["start", "standalone-disposition", ...flags(root, "skew")], JSON.stringify(f.input), true);
      expect(skew.code).not.toBe(0); expect(skew.stderr).toContain("version skew");
      expect(existsSync(join(root, "runs/skew"))).toBe(false);
    });
  });

  it("bounds current inspection/CLI ingress, rejects receipt symlinks, and never recreates missing source authority", async () => {
    const root = project();
    await withFixturePiSession(root, async () => {
      const f = await sourceFixture(root);
      const done = await command(root, ["start", "standalone-disposition", ...flags(root, "policy")], JSON.stringify(f.input));
      const directory = join(root, "runs/policy");
      const receipt = join(directory, "receipts", `effect:standalone-disposition:${done.outcome.publication.dispositionDigest}.json`);
      const receiptBytes = readFileSync(receipt);
      unlinkSync(receipt); symlinkSync(join(directory, "program.json"), receipt);
      expect(f.publisher.readSelectedStandaloneDisposition(f.lineage, done.outcome.publication).ok).toBe(false);
      expect((await invoke(root, ["resume", ...flags(root, "policy")])).code).not.toBe(0);
      unlinkSync(receipt); writeFileSync(receipt, receiptBytes);
      const checkpoint = join(directory, "checkpoint.json");
      writeFileSync(checkpoint, "{"); truncateSync(checkpoint, 1024 * 1024 * 1024);
      expect((await command(root, ["inspect", ...flags(root, "policy"), "--json"])).state.kind).toBe("unavailable");
      const runAlias = join(root, "runs/source-alias");
      const rootAlias = join(root, "root-alias");
      symlinkSync(f.source.locator, runAlias); symlinkSync(join(root, "runs"), rootAlias);
      expect((await f.publisher.readStandaloneDispositionSource({ ...f.source, locator: runAlias, runId: "source-alias" })).ok).toBe(false);
      expect((await f.publisher.readStandaloneDispositionSource({ ...f.source, locator: join(rootAlias, "source") })).ok).toBe(false);
      const sourceAuthority = join(f.source.locator, "authority.json");
      unlinkSync(sourceAuthority);
      expect((await f.publisher.readStandaloneDispositionSource(f.source)).ok).toBe(false);
      expect(existsSync(sourceAuthority)).toBe(false);
      const oversized = await invoke(root, ["start", "standalone-disposition", ...flags(root, "oversize-input")], " ".repeat(16_777_217));
      expect(oversized.code).not.toBe(0); expect(oversized.stderr).toContain("byte limit");
      expect(existsSync(join(root, "runs/oversize-input"))).toBe(false);
      const authority = join(directory, "authority.json");
      writeFileSync(authority, "{"); truncateSync(authority, 1024 * 1024 * 1024);
      const unsafeIdentity = await invoke(root, ["inspect", ...flags(root, "policy"), "--json"]);
      expect(unsafeIdentity.code).not.toBe(0); expect(unsafeIdentity.stderr).toContain("byte limit");
    });
  });

  it("authenticates an owned genuinely issued v1 source without changing its result/receipt bytes", async () => {
    const root = project();
    await withFixturePiSession(root, async () => {
      const { createRunDirectory } = await import("../../../../src/orchestration/run-directory-handle");
      const { prepareStandaloneReview } = await import("../../../../src/core/standalone-review");
      const { startStandaloneReviewMachine, reduceStandaloneReviewMachine, serializeStandaloneReviewMachineState } = await import("../../../../src/core/standalone-review-machine");
      const { resolveAgentPolicy, resolveModelProfile, lowerModelProfile } = await import("../../../../src/core/model-profiles");
      const { legacyStandaloneContext, standaloneFixtureRegistration } = await import("../../../fixtures/standalone-reviewer-protocol");
      const { publishInitialBatch } = await import("../../../../src/handlers/helpers/programs/helpers");
      const { resumeStandaloneFacade } = await import("../../../../src/handlers/helpers/programs/standalone");
      const publisher = await import("../../../../src/handlers/helpers/programs/standalone-disposition");
      const handle = valueOf(createRunDirectory(join(root, "runs"), "legacy"));
      const policy = valueOf(resolveAgentPolicy("code-reviewer"));
      const profile = valueOf(resolveModelProfile(policy.profile));
      const scope = ["README.md"];
      const attempts = ([1, 2] as const).map(attempt => {
        const identity = { runId: handle.runId, requestId: `request:legacy:${attempt}`, role: policy.agent, attempt, requiredSkill: policy.requiredSkill };
        const packet = legacyStandaloneContext(identity, scope);
        return { packet, authority: { ...identity, slotId: "slot:legacy", program: "standalone-review", modelProfile: policy.profile,
          harnessBinding: { pi: lowerModelProfile(profile, "pi"), claude: lowerModelProfile(profile, "claude-code") },
          contextDigest: packet.digest, outputSlot: `transcripts/slot:legacy/attempt-${attempt}.raw` } };
      });
      const prepared = valueOf(prepareStandaloneReview({ runId: handle.runId, explicitScope: scope,
        changedPaths: { unstaged: scope, staged: [], committed: [], base_revision: null, head_revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim() },
        reviewMetadata: { requested_kinds: ["types"], docs_only: false, source_or_test_changed: false, types_changed: false,
          comments_changed: false, additions: 1, file_count: 1, new_structure: false, languages: ["Markdown"] },
        scopeSafety: [{ path: "README.md", status: "safe" }], roster: [{ slotId: "slot:legacy", attempts: attempts.map(row => row.authority) }] }));
      const registration = standaloneFixtureRegistration(prepared.authority);
      valueOf(await handle.registerProgram(registration));
      const published = await publishInitialBatch(handle, prepared.initialRequests.map(authority => ({ authority,
        context: { digest: authority.contextDigest, slot: `contexts/${authority.contextDigest}.json` } })), attempts.map(row => row.packet), "standalone-review");
      expect(published.ok).toBe(true);
      const awaiting = valueOf(reduceStandaloneReviewMachine(startStandaloneReviewMachine(prepared.authority), { kind: "review-batch-published", runId: handle.runId }));
      await handle.writeCheckpoint(serializeStandaloneReviewMachineState(awaiting));
      valueOf(await handle.captureTranscript(prepared.initialRequests[0], [...Buffer.from("### Machine Summary\nCRITICAL_COUNT: 0\nADVISORY_COUNT: 1\nADVISORY: exact historical advisory")]));
      const completed = await resumeStandaloneFacade(handle, registration);
      expect(completed.ok && (completed.action as { kind: string }).kind).toBe("done");
      const result = readFileSync(join(handle.runDirectory, "result.json"));
      const receipts = readdirSync(join(handle.runDirectory, "receipts")).map(name => [name, readFileSync(join(handle.runDirectory, "receipts", name))] as const);
      const reference = { locator: handle.runDirectory, runId: handle.runId, resultDigest: hash(result) };
      const source = valueOf(await publisher.readStandaloneDispositionSource(reference));
      expect(source.inventory[0]?.finding).not.toHaveProperty("protocolVersion");
      const record = { schemaVersion: 1, source: reference, provenance: "DECLARED", revision: { kind: "historical-import", proseReference: "note:now", prose: "Exact original prose" },
        entries: source.inventory.map(row => ({ origin: standaloneOriginReference(row.origin), decision: "deferred", reason: "Present-day attestation" })) };
      const done = await command(root, ["start", "standalone-disposition", ...flags(root, "legacy-policy")], JSON.stringify({ source: reference, record, previous: null }));
      expect(done.kind).toBe("done");
      expect(readFileSync(join(handle.runDirectory, "result.json"))).toEqual(result);
      for (const [name, receipt] of receipts) expect(readFileSync(join(handle.runDirectory, "receipts", name))).toEqual(receipt);
    });
  });

  it("exposes authenticated source origins for policy authoring without parent-computed identities; corrections retain full history", async () => {
    const root = project();
    await withFixturePiSession(root, async () => {
      const f = await sourceFixture(root);
      const inspected = await invoke(root, ["inspect", ...flags(root, "source"), "--lineage", "--json"]);
      expect(inspected.code, inspected.stderr).toBe(0);
      const projection = JSON.parse(inspected.stdout) as {
        source: typeof f.source; snapshot: unknown; counts: unknown;
        advisoryInventory: readonly { origin: string; findingId: string }[];
      };
      expect(projection.source).toEqual(f.source);
      expect(projection.snapshot).toEqual([{ kind: "present", path: "README.md", digest: hash(Buffer.from("# Reviewed\n")), mode: null }]);
      expect(projection.counts).toEqual({ total: 2, survivingCritical: 0, refutedCritical: 0, resolved: 0, advisory: 2 });
      const firstInput = { source: projection.source, previous: null, record: { schemaVersion: 1, source: projection.source,
        provenance: "DECLARED", revision: { kind: "initial" }, entries: projection.advisoryInventory.map(({ origin }) => ({ origin,
          decision: "deferred", reason: "  First exact reason\n  " })) } };
      const first = await command(root, ["start", "standalone-disposition", ...flags(root, "policy-one")], JSON.stringify(firstInput));
      const secondInput = { ...firstInput, previous: first.outcome.publication, record: { ...firstInput.record,
        revision: { kind: "correction", previousDigest: first.outcome.publication.dispositionDigest },
        entries: firstInput.record.entries.map(row => ({ ...row, decision: "dismissed", reason: "  Second exact reason\n  " })) } };
      const second = await command(root, ["start", "standalone-disposition", ...flags(root, "policy-two")], JSON.stringify(secondInput));
      const selection = ["--disposition", second.outcome.publication.locator, "--disposition-run", second.outcome.publication.runId,
        "--disposition-digest", second.outcome.publication.dispositionDigest];
      const selected = await invoke(root, ["inspect", ...flags(root, "source"), "--lineage", ...selection]);
      expect(selected.code, selected.stderr).toBe(0);
      const model = JSON.parse(selected.stdout);
      expect(model.inventory[0].policy).toMatchObject([
        { digest: first.outcome.publication.dispositionDigest, publication: first.outcome.publication, reason: "  First exact reason\n  " },
        { digest: second.outcome.publication.dispositionDigest, publication: second.outcome.publication, reason: "  Second exact reason\n  " },
      ]);
      expect(model.disposition.disposition.history[0].record).toEqual(firstInput.record);
      writeFileSync(join(root, "README.md"), "# Mutable live source must not replace reviewed bytes\n");
      expect(valueOf(await f.publisher.readStandaloneDispositionSource(f.source)).snapshot).toEqual(projection.snapshot);
      const wrong = await invoke(root, ["inspect", ...flags(root, "source"), "--lineage", "--disposition", second.outcome.publication.locator]);
      expect(wrong.code).not.toBe(0);
      const missing = await invoke(root, ["inspect", ...flags(root, "never-created"), "--lineage"]);
      expect(missing.code).not.toBe(0);
      expect(existsSync(join(root, "runs/never-created"))).toBe(false);
      unlinkSync(join(f.source.locator, "authority.json"));
      expect((await invoke(root, ["inspect", ...flags(root, "source"), "--lineage"])).code).not.toBe(0);
      expect(existsSync(join(f.source.locator, "authority.json"))).toBe(false);
    });
  });

  it("refuses a registered source with no checkpoint before creating policy or remediation authority", async () => {
    const root = project();
    await withFixturePiSession(root, async () => {
      const f = await sourceFixture(root);
      const retained = ["authority.json", "program.json", "result.json",
        ...readdirSync(join(f.source.locator, "receipts")).map(name => `receipts/${name}`)]
        .map(name => [name, readFileSync(join(f.source.locator, name))] as const);
      const index = readFileSync(join(root, ".git/index"));
      unlinkSync(join(f.source.locator, "checkpoint.json"));
      const inputs = [
        { program: "standalone-disposition", run: "missing-checkpoint-policy", input: f.input },
        { program: "remediation", run: "missing-checkpoint-remediation", input: {
          sourceRunsRoot: join(root, "runs"), sourceRun: "source", supportPaths: [], defectFamily: { kind: "not-required" },
        } },
      ];
      for (const { program, run, input } of inputs) {
        const refused = await invoke(root, ["start", program, ...flags(root, run)], JSON.stringify(input));
        expect(refused.code).not.toBe(0);
        expect(refused.stderr.trim()).toBe("source standalone review checkpoint is missing");
        expect(refused.stdout).toBe("");
        expect(existsSync(join(root, "runs", run))).toBe(false);
      }
      expect(existsSync(join(f.source.locator, "checkpoint.json"))).toBe(false);
      for (const [name, bytes] of retained) expect(readFileSync(join(f.source.locator, name))).toEqual(bytes);
      expect(readFileSync(join(root, ".git/index"))).toEqual(index);
    });
  });

  it("retains present-day import prose without backdating or inference", async () => {
    const root = project();
    await withFixturePiSession(root, async () => {
      const f = await sourceFixture(root);
      const input = { ...f.input, record: { ...f.input.record, revision: { kind: "historical-import", proseReference: "operator-note:exact", prose: "  Original prose\nnot engine adjudication.  " } } };
      const done = await command(root, ["start", "standalone-disposition", ...flags(root, "import")], JSON.stringify(input));
      expect(done.outcome.record.revision).toEqual(input.record.revision);
      expect(done.outcome.provenance).toBe("DECLARED");
    });
  });
});
