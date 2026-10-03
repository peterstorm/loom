import { closeSync, existsSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { disposeFixturePiSessions, fixturePiEnvironment, withFixturePiSession } from "../../../fixtures/pi-session";
import { nativeSuccessorCapture } from "../../../fixtures/standalone-native-capture";
import { representativeNativeWorkload } from "../../../fixtures/standalone-native-workload";
import { addRepairTest, git, hash, publishedSuccessorForRemediation, repairDeclaration, successorRemediationRepository, value } from "../../../fixtures/standalone-successor-remediation";
import type { AgentRequestAuthority } from "../../../../src/core/orchestration-contract";
import type { RunDirHandle } from "../../../../src/orchestration/run-directory-handle";

type Requests = readonly { authority: AgentRequestAuthority; task: string }[];
const roots: string[] = [];
const operations = new Set<Promise<void>>();
function owned(operation: (root: string) => Promise<void>) {
  const root = successorRemediationRepository(); roots.push(root);
  mkdirSync(join(root, ".claude/reviews/review-and-fix-runs"));
  writeFileSync(join(root, "src/types.ts"), "export type Repaired = true;\n");
  writeFileSync(join(root, "README.md"), "# Exact native successor scope\n");
  const pending = withFixturePiSession(root, async () => { vi.resetModules(); await operation(root); });
  const settled = pending.then(() => undefined, () => undefined);
  operations.add(settled); void settled.then(() => operations.delete(settled));
  return pending;
}
afterEach(async () => { await Promise.all([...operations]); disposeFixturePiSessions(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function readCommand(task: string, extra = "") {
  const command = /^LOOM_CONTEXT_READ_COMMAND: (.+)$/m.exec(task)?.[1];
  if (command === undefined) throw Error("no executable issued reader");
  const read = spawnSync("bash", ["-c", command + extra], { encoding: "utf8" });
  expect(read.status, read.stderr).toBe(0);
  expect(Buffer.byteLength(read.stdout)).toBeLessThan(48 * 1024);
  return JSON.parse(read.stdout);
}

describe("owned native v3 → canonical replay → authentic guarded P3", { timeout: 60_000 }, () => {
  it("retains distinct issued-request and captured-attempt roster diagnostics", async () => {
    const { readStandaloneCaptureWitnesses } = await import("../../../../src/handlers/helpers/programs/standalone-evidence");
    const handle = (issued: ReturnType<RunDirHandle["readIssuedRequests"]>,
      captured: ReturnType<RunDirHandle["readCapturedAttempts"]>) => ({
      readAuthority: () => ({ ok: true, value: {} }),
      readIssuedRequests: () => issued,
      readCapturedAttempts: () => captured,
    }) as unknown as RunDirHandle;
    const emptyIssued: ReturnType<RunDirHandle["readIssuedRequests"]> = { ok: true, value: [] };
    const emptyCaptured: ReturnType<RunDirHandle["readCapturedAttempts"]> = { ok: true, value: new Set() };
    expect(readStandaloneCaptureWitnesses(handle(
      { ok: false, error: { kind: "invalid-run-directory", field: "requests", message: "issued journal corrupt" } }, emptyCaptured,
    ))).toEqual({ ok: false, message: "issued reviewer roster is unavailable: issued journal corrupt" });
    expect(readStandaloneCaptureWitnesses(handle(
      emptyIssued, { ok: false, error: { kind: "invalid-run-directory", field: "captures", message: "captured index unreadable" } },
    ))).toEqual({ ok: false, message: "captured reviewer roster is unavailable: captured index unreadable" });
  });

  it("bounds current Pi transcript work before copying while conserving exact final strings", () => owned(async () => {
    const { piResultFinalPayloadCandidates } = await import("../../../../../pi/transcript-adapter");
    fc.assert(fc.property(fc.string(), text => {
      const messages = [{ role: "assistant", content: [{ type: "text", text }] }];
      expect(piResultFinalPayloadCandidates(messages, "standalone-successor")).toEqual(piResultFinalPayloadCandidates(messages));
    }));
    expect(piResultFinalPayloadCandidates(new Array(65_537), "standalone-successor").ok).toBe(false);
    expect(piResultFinalPayloadCandidates([{ role: "assistant", content: "x".repeat(16_777_217) }], "standalone-successor").ok).toBe(false);
    let touched = false;
    const accessor = { role: "assistant", get content() { touched = true; return "not allowed"; } };
    expect(piResultFinalPayloadCandidates([accessor], "standalone-successor").ok).toBe(false);
    expect(touched).toBe(false);
  }));

  it.each(["claude", "pi"] as const)("%s refuses transcript observation until current registration is readable", harness => owned(async root => {
    const native = await nativeSuccessorCapture(root, harness);
    try {
      await publishedSuccessorForRemediation(root, "complete", async (handle, requests, payload) => {
        const programPath = join(handle.runDirectory, "program.json");
        const registration = readFileSync(programPath);
        const first = requests[0]!.authority;
        if (harness === "pi") {
          const extension = await import("../../../../../pi/extension");
          const toolCallId = "registration-unavailable";
          value(await handle.recordHarnessCorrelator({ schemaVersion: 1, harness,
            nativeId: extension.piSpawnRosterId(toolCallId, 0, first.role), requestId: first.requestId,
            role: first.role, attempt: first.attempt }));
          const binding = Object.freeze({ ...handle.identity,
            requestIds: Object.freeze(requests.map(({ authority }) => authority.requestId)), resultDigest: null });
          try {
            for (const corrupt of ["{", "{}"] as const) {
              writeFileSync(programPath, corrupt);
              const refused = await extension.capturePiSubagentResult(toolCallId, 0, first.role,
                [{ get role() { throw new Error("transcript was observed"); } }], binding);
              expect(refused).toMatchObject({ kind: "retriable-failure", reason: "program-registration",
                message: expect.stringContaining("program registration is unavailable") });
              expect(value(handle.readCapturedAttempts())).toEqual(new Set());
              expect(value(handle.readCaptureRejection(first))).toBeNull();
            }
          } finally {
            writeFileSync(programPath, registration);
          }
          expect(await extension.capturePiSubagentResult(toolCallId, 0, first.role,
            [{ role: "assistant", content: [{ type: "text", text: JSON.stringify(payload) }] }], binding))
            .toMatchObject({ kind: "captured" });
          await native.capture(handle, requests.slice(1), requests.slice(1).map(() => [JSON.stringify(payload)]));
          return;
        }
        try {
          for (const corrupt of ["{", "{}"] as const) {
            writeFileSync(programPath, corrupt);
            const refused = await native.capture(handle, requests.slice(0, 1), [["must not be observed"]]);
            expect(JSON.stringify(refused)).toContain("program registration is unavailable");
            expect(value(handle.readCapturedAttempts())).toEqual(new Set());
            expect(value(handle.readCaptureRejection(first))).toBeNull();
          }
        } finally {
          writeFileSync(programPath, registration);
        }
        await native.capture(handle, requests, requests.map(() => [JSON.stringify(payload)]));
      });
    } finally { await native.close(); }
  }));

  it.each(["claude", "pi"] as const)("%s bounds missing-registration capture before parsing without unbounded transcript work", harness => owned(async root => {
    const native = await nativeSuccessorCapture(root, harness);
    try {
      const f = await publishedSuccessorForRemediation(root, "complete", async (handle, requests, payload) => {
        const helpers = await import("../../../../src/handlers/helpers/programs/helpers");
        const standalone = await import("../../../../src/handlers/helpers/programs/standalone");
        const first = requests[0]!.authority;
        const programPath = join(handle.runDirectory, "program.json");
        const registrationBytes = readFileSync(programPath);
        if (harness === "pi") {
          const extension = await import("../../../../../pi/extension");
          const toolCallId = "missing-registration";
          value(await handle.recordHarnessCorrelator({ schemaVersion: 1, harness: "pi",
            nativeId: extension.piSpawnRosterId(toolCallId, 0, first.role), requestId: first.requestId,
            role: first.role, attempt: first.attempt }));
          const binding = Object.freeze({ ...handle.identity,
            requestIds: Object.freeze(requests.map(({ authority }) => authority.requestId)), resultDigest: null });
          unlinkSync(programPath);
          const refused = await extension.capturePiSubagentResult(toolCallId, 0, first.role,
            [{ get role() { throw new Error("transcript was observed"); } }], binding);
          expect(refused).toMatchObject({ kind: "terminal-rejection", reason: "transcript-shape",
            message: expect.stringContaining("only own data") });
          expect(JSON.stringify(refused)).not.toContain("transcript was observed");
          expect(value(handle.readCaptureRejection(first))).not.toBeNull();
          writeFileSync(programPath, registrationBytes);
          const retry = await standalone.resumeStandaloneFacade(handle,
            value(helpers.parseRegistration(JSON.parse(registrationBytes.toString()))));
          if (!retry.ok) throw Error(retry.message);
          const retried = (retry.action as { requests: Requests }).requests;
          expect(retried).toHaveLength(7);
          expect(retried.filter(row => row.authority.attempt === 2)).toHaveLength(1);
          await native.capture(handle, retried, retried.map(() => [JSON.stringify(payload)]));
          return;
        }
        unlinkSync(programPath);
        const refused = await native.capture(handle, requests.slice(0, 1), [["x".repeat(16_777_217)]]);
        expect(JSON.stringify(refused)).toContain("transcript-read");
        expect(value(handle.readCapturedAttempts())).toEqual(new Set());
        expect(value(handle.readCaptureRejection(first))).toBeNull();
        writeFileSync(programPath, registrationBytes);
        await native.capture(handle, requests, requests.map(() => [JSON.stringify(payload)]));
      });
      expect(JSON.parse(f.bytes.toString()).schema_version).toBe(3);
    } finally { await native.close(); }
  }));

  it.each(["claude", "pi"] as const)("%s refuses foreign capture receipts and changed current protocol/request/context/result authority", harness => owned(async root => {
    const native = await nativeSuccessorCapture(root, harness);
    try {
      const f = await publishedSuccessorForRemediation(root, "complete", async (handle, requests, payload) => {
        await native.capture(handle, requests, requests.map(() => [JSON.stringify(payload)]));
      });
      const first = f.requests[0]!.authority;
      const receiptDirectory = join(f.successor.runDirectory, "receipts");
      const capture = readdirSync(receiptDirectory).find(name => name.startsWith("effect:capture:"))!;
      const publication = readdirSync(receiptDirectory).find(name => name.startsWith("effect:standalone-result:")) ?? readdirSync(receiptDirectory).find(name => JSON.parse(readFileSync(join(receiptDirectory, name), "utf8")).kind === "artifact-set-published")!;
      const files = [join(receiptDirectory, capture), join(receiptDirectory, publication),
        join(f.successor.runDirectory, "program.json"), join(f.successor.runDirectory, "requests", `${first.requestId}.json`),
        join(f.successor.runDirectory, "contexts", `${first.contextDigest}.json`), join(f.successor.runDirectory, first.outputSlot.path),
        join(f.successor.runDirectory, "authority.json")];
      const checkpoint = readFileSync(join(f.successor.runDirectory, "checkpoint.json"));
      for (const [index, path] of files.entries()) {
        const original = readFileSync(path);
        try {
          if (index < 2) { const receipt = JSON.parse(original.toString()); receipt.runId = "foreign-run"; writeFileSync(path, JSON.stringify(receipt)); }
          else writeFileSync(path, "{}");
          expect((await f.sourceReader.readAuthenticatedStandaloneSource(f.runsRoot, f.successor.runId)).ok, path).toBe(false);
          expect((await f.standalone.resumeStandaloneFacade(f.successor, f.registration)).ok, path).toBe(false);
          expect((await f.standalone.inspectStandaloneFacade(f.successor, f.registration)).ok, path).toBe(false);
          expect(readFileSync(join(f.successor.runDirectory, "checkpoint.json"))).toEqual(checkpoint);
          if (harness === "pi") await expect(native.verify()).rejects.toThrow();
        } finally { writeFileSync(path, original); }
      }
      const authorityPath = join(f.successor.runDirectory, "authority.json");
      const authorityBytes = readFileSync(authorityPath);
      unlinkSync(authorityPath);
      try {
        if (harness === "pi") await expect(native.capture(f.successor, f.requests.slice(0, 1), [["duplicate"]])).rejects.toThrow();
        else expect(await native.capture(f.successor, f.requests.slice(0, 1), [["duplicate"]])).toMatchObject([{ kind: "error" }]);
        expect((await f.standalone.resumeStandaloneFacade(f.successor, f.registration)).ok).toBe(false);
        expect(existsSync(authorityPath)).toBe(false);
      } finally { writeFileSync(authorityPath, authorityBytes); }
      expect(readFileSync(join(f.successor.runDirectory, "result.json"))).toEqual(f.bytes);
      expect(readFileSync(join(f.source.runDirectory, "result.json"))).toEqual(f.originalBytes);
    } finally { await native.close(); }
  }));
  it.each(["claude", "pi"] as const)("%s recaptures the SAME native final at attempt 1 after a real durable receipt-write failure", harness => owned(async root => {
    const native = await nativeSuccessorCapture(root, harness);
    try {
      const f = await publishedSuccessorForRemediation(root, "complete", async (handle, requests, payload) => {
        const { parseEffectId } = await import("../../../../src/core/orchestration-contract");
        const helpers = await import("../../../../src/handlers/helpers/programs/helpers");
        const standalone = await import("../../../../src/handlers/helpers/programs/standalone");
        const first = requests[0]!.authority;
        const effect = value(parseEffectId(`effect:capture:${hash(Buffer.from(`${first.requestId}:${first.attempt}`))}`));
        const receipts = openSync(join(handle.runDirectory, "receipts"), "r");
        const mode = fstatSync(receipts).mode;
        try {
          fchmodSync(receipts, 0o500);
          if (harness === "pi") expect(await native.capture(handle, requests.slice(0, 1), [[JSON.stringify(payload)]])).toMatchObject([undefined, { isError: true, content: [{ text: expect.stringContaining("durable receipt unavailable") }] }]);
          else expect(await native.capture(handle, requests.slice(0, 1), [[JSON.stringify(payload)]])).toMatchObject([{ kind: "error", message: expect.stringContaining("durable receipt unavailable") }]);
        } finally { fchmodSync(receipts, mode); closeSync(receipts); }
        const path = join(handle.runDirectory, first.outputSlot.path);
        const raw = readFileSync(path);
        const before = statSync(path);
        expect(raw.toString()).toBe(JSON.stringify(payload));
        expect(value(handle.readReceipt(effect))).toBeNull();
        expect(value(handle.readCaptureRejection(first))).toBeNull();
        const registration = value(helpers.parseRegistration(value(handle.readProgramRegistration())));
        expect((await standalone.resumeStandaloneFacade(handle, registration)).ok).toBe(false);
        expect((await standalone.replayStandaloneCapturedEvidence(handle, registration)).ok).toBe(false);
        expect(value(handle.readReceipt(effect))).toBeNull();
        const recapture = native.retainFinalObservation();
        const refused = async (operation: () => Promise<unknown>, reason: string) => {
          const diagnostic = await operation().then(result => JSON.stringify(result), cause => String(cause));
          expect(diagnostic).toContain(reason);
          expect(readFileSync(path)).toEqual(raw);
          expect(value(handle.readCaptureRejection(first))).toBeNull();
        };
        await refused(() => recapture([[JSON.stringify(payload) + " "]]), "original request/context/correlator observation");
        // A newly issued native correlator for the SAME request is not the native final
        // that wrote these bytes. The retained delivery below still names the original.
        await refused(() => native.capture(handle, requests.slice(0, 1), [[JSON.stringify(payload)]]),
          harness === "pi" ? "unavailable for Pi spawn item" : "original request/context/correlator observation");
        const observationPath = join(handle.runDirectory, "artifacts/native-capture-observations", `${first.requestId}.json`);
        const observationBytes = readFileSync(observationPath);
        const receiptPath = join(handle.runDirectory, "receipts", `${effect}.json`);
        const contextPath = join(handle.runDirectory, "contexts", `${first.contextDigest}.json`);
        const requestPath = join(handle.runDirectory, "requests", `${first.requestId}.json`);
        const expectedReceipt = { kind: "raw-transcript-captured", effectId: effect, runId: handle.runId, requestId: first.requestId,
          artifact: { runId: handle.runId, slot: first.outputSlot, digest: hash(raw), byteLength: raw.length } };
        const controls = [
          { path: observationPath, bytes: null },
          { path: observationPath, bytes: Buffer.from("{}") },
          { path: observationPath, bytes: Buffer.from(observationBytes.toString().replace(first.contextDigest, "0".repeat(64))) },
          { path: contextPath, bytes: Buffer.from("{}") },
          { path: requestPath, bytes: Buffer.from(JSON.stringify({ ...first, contextDigest: requests[1]!.authority.contextDigest })) },
          { path: receiptPath, bytes: Buffer.from("{") },
          { path: receiptPath, bytes: Buffer.from(JSON.stringify({ ...expectedReceipt, runId: "foreign-run" })) },
          { path: receiptPath, bytes: Buffer.from(JSON.stringify({ ...expectedReceipt, requestId: requests[1]!.authority.requestId })) },
          { path: receiptPath, bytes: Buffer.from(JSON.stringify({ ...expectedReceipt, artifact: { ...expectedReceipt.artifact, digest: "0".repeat(64) } })) },
        ];
        for (const control of controls) {
          const original = existsSync(control.path) ? readFileSync(control.path) : null;
          try {
            if (control.bytes === null) unlinkSync(control.path); else writeFileSync(control.path, control.bytes);
            await refused(() => recapture(), harness === "pi" ? "capture" : "error");
            if (control.bytes !== null) expect(readFileSync(control.path)).toEqual(control.bytes);
            else expect(existsSync(control.path)).toBe(false);
          } finally { if (original === null) unlinkSync(control.path); else writeFileSync(control.path, original); }
        }
        const wrongBytes = Buffer.from(raw); wrongBytes[0] = 0;
        writeFileSync(path, wrongBytes);
        try {
          const diagnostic = await recapture().then(result => JSON.stringify(result), cause => String(cause));
          expect(diagnostic).toContain("already-written transcript bytes");
          expect(readFileSync(path)).toEqual(wrongBytes);
          expect(value(handle.readReceipt(effect))).toBeNull();
        } finally { writeFileSync(path, raw); }
        // Record stability after the intentional fixture tamper/restore, not its old mtime.
        const recaptureStat = statSync(path);
        const recovered = await recapture();
        expect(recovered.every(result => harness === "pi" ? result === undefined : (result as { kind: string }).kind === "passthrough"), JSON.stringify(recovered)).toBe(true);
        expect(readFileSync(path)).toEqual(raw);
        expect(statSync(path).ino).toBe(before.ino);
        expect(statSync(path).mtimeMs).toBe(recaptureStat.mtimeMs);
        expect(value(handle.readReceipt(effect))).toMatchObject({ kind: "raw-transcript-captured", effectId: effect,
          runId: handle.runId, requestId: first.requestId, artifact: { runId: handle.runId, slot: first.outputSlot,
            digest: hash(raw), byteLength: raw.length } });
        expect(value(handle.readIssuedRequests()).every(request => request.attempt === 1)).toBe(true);
        const actualReceipt = readFileSync(receiptPath);
        await refused(() => recapture(), "duplicate-capture");
        expect(readFileSync(receiptPath)).toEqual(actualReceipt);
        await native.capture(handle, requests.slice(1), requests.slice(1).map(() => [JSON.stringify(payload)]));
      });
      unlinkSync(join(f.successor.runDirectory, "checkpoint.json"));
      expect(await f.standalone.replayStandaloneCapturedEvidence(f.successor, f.registration)).toMatchObject({ ok: true, json: f.bytes.toString(), digest: hash(f.bytes) });
      if (harness === "pi") expect(await native.verify()).toMatchObject({ resultDigest: hash(f.bytes) });
    } finally { await native.close(); }
  }));

  it("publishes an actual seven-role representative production workload from staged and clean committed source bytes", () => owned(async root => {
    const packageRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
    const source = representativeNativeWorkload(packageRoot);
    const scope = source.map(({ path, bytes }) => {
      const target = join(root, "scope", path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes);
      return `scope/${path}`;
    });
    // Only this disposable repository's scope is staged/committed. Both states defeat
    // the old diff-plus-untracked recipe; neither changes this explicit source roster.
    git(root, ["add", "--", "scope"]);
    expect(git(root, ["diff", "--name-only", "--", "scope"])).toBe("");
    expect(git(root, ["ls-files", "--others", "--exclude-standard", "--", "scope"])).toBe("");
    const staged = representativeNativeWorkload(join(root, "scope"));
    expect(staged.map(file => file.path)).toEqual(source.map(file => file.path));
    expect(staged.every((file, index) => file.bytes.equals(source[index]!.bytes))).toBe(true);
    git(root, ["commit", "-qm", "owned representative production workload"]);
    expect(git(root, ["status", "--porcelain", "--", "scope"])).toBe("");
    const workload = representativeNativeWorkload(join(root, "scope"));
    expect(workload.map(file => file.path)).toEqual(source.map(file => file.path));
    expect(workload.every((file, index) => file.bytes.equals(source[index]!.bytes))).toBe(true);
    const byteLength = workload.reduce((total, file) => total + file.bytes.length, 0);
    expect(byteLength).toBeGreaterThanOrEqual(1_500_000);
    expect(byteLength).toBeLessThan(1_750_000);
    const native = await nativeSuccessorCapture(root, "claude");
    try {
      const f = await publishedSuccessorForRemediation(root, "complete", async (handle, requests, payload) => {
        expect(requests).toHaveLength(7);
        const packet = value(handle.readStandaloneSuccessorContext(requests[0]!.authority.contextDigest));
        const frozen = JSON.parse(Buffer.from(packet.variableContext.find(row => row.label === "standalone-frozen-source")!.bytes).toString());
        for (const { path, bytes } of workload) {
          expect(frozen.files.find((file: { path: string }) => file.path === `scope/${path}`)).toMatchObject({
            digest: hash(bytes), byteLength: bytes.length, contentBase64: bytes.toString("base64"), mode: "100644",
          });
        }
        const captured = await native.capture(handle, requests, requests.map(() => [JSON.stringify(payload)]));
        expect(captured).toEqual(requests.map(() => ({ kind: "passthrough" })));
        for (const { authority } of requests) expect(Buffer.from(value(handle.readTranscriptBytes(authority))).toString()).toBe(JSON.stringify(payload));
      }, scope);
      expect(JSON.parse(f.bytes.toString()).scope).toEqual(["src/repair.mjs", "src/types.ts", "README.md", ...scope]);
      process.stdout.write(`SUPPORTED_NATIVE_WORKLOAD ${JSON.stringify({ files: scope.length + 3, productionBytes: byteLength,
        packetBytes: readFileSync(join(f.successor.runDirectory, "contexts", `${f.requests[0]!.authority.contextDigest}.json`)).length,
        registrationBytes: readFileSync(join(f.successor.runDirectory, "program.json")).length, resultBytes: f.bytes.length, resultDigest: hash(f.bytes) })}\n`);
    } finally { await native.close(); }
  }));
  it.each((["claude", "pi"] as const).flatMap(harness => ([1, 2] as const).map(version => ({ harness, version }))))("$harness preserves v$version native initial/resume/new retry/already-published retry and witness bytes", ({ harness, version }) => owned(async root => {
    const native = await nativeSuccessorCapture(root, harness);
    try {
      const handles = await import("../../../../src/orchestration/run-directory-handle");
      const standalone = await import("../../../../src/handlers/helpers/programs/standalone");
      const helpers = await import("../../../../src/handlers/helpers/programs/helpers");
      const handle = value(handles.createRunDirectory(join(root, ".claude/reviews/review-and-fix-runs"), "v2-native"));
      const initial = version === 1 ? await (await import("../../../fixtures/standalone-native-history")).startNativeLegacyReview(handle)
        : await standalone.startStandaloneFacade(handle, { kind: "all", files: ["src/repair.mjs", "src/types.ts", "README.md"], dryRun: false });
      if (!initial.ok) throw Error(initial.message);
      const requests = (initial.action as { requests: Requests }).requests;
      expect(requests).toHaveLength(7);
      expect(readCommand(requests[0]!.task).schemaVersion).toBe(version);
      const registration = value(helpers.parseRegistration(value(handle.readProgramRegistration())));
      expect(registration.schemaVersion).toBe(version);
      const resumed = await standalone.resumeStandaloneFacade(handle, registration);
      if (!resumed.ok) throw Error(resumed.message);
      expect((resumed.action as { requests: Requests }).requests.map(row => row.authority)).toEqual(requests.map(row => row.authority));
      const empty = version === 1 ? "### Machine Summary\nCRITICAL_COUNT: 0\nADVISORY_COUNT: 0\n\n```findings\n[]\n```"
        : JSON.stringify({ schemaVersion: 2, kind: "standalone-review", findings: [] });
      await native.capture(handle, requests, requests.map((_, index) => [index === 0 ? "{}" : empty]));
      const retried = await standalone.resumeStandaloneFacade(handle, registration);
      if (!retried.ok) throw Error(retried.message);
      const retry = (retried.action as { requests: Requests }).requests;
      expect(retry).toHaveLength(1); expect(retry[0]!.authority.attempt).toBe(2);
      expect(await standalone.resumeStandaloneFacade(handle, registration)).toEqual(retried);
      expect(retry[0]!.task).not.toContain("standalone-successor");
      await native.capture(handle, retry, [[empty]]);
      const legacyRaw = readFileSync(join(handle.runDirectory, retry[0]!.authority.outputSlot.path));
      const duplicate = await native.retainFinalObservation()();
      expect(JSON.stringify(duplicate)).toContain("duplicate-capture");
      expect(readFileSync(join(handle.runDirectory, retry[0]!.authority.outputSlot.path))).toEqual(legacyRaw);
      expect(existsSync(join(handle.runDirectory, "artifacts/native-capture-observations"))).toBe(false);
      const done = await standalone.resumeStandaloneFacade(handle, registration);
      expect(done).toMatchObject({ ok: true, action: { kind: "done" } });
      expect(await standalone.resumeStandaloneFacade(handle, registration)).toEqual(done);
      const bytes = readFileSync(join(handle.runDirectory, "result.json"));
      expect(JSON.parse(bytes.toString()).schema_version).toBe(version);
      unlinkSync(join(handle.runDirectory, "checkpoint.json"));
      if (harness === "pi") expect(await native.verify()).toMatchObject({ resultDigest: hash(bytes) });
      expect(readFileSync(join(handle.runDirectory, "result.json"))).toEqual(bytes);
    } finally { await native.close(); }
  }));

  it.each(["claude", "pi"] as const)("%s installs native not-required and preserves exact historical source and current result bytes", harness => owned(async root => {
    const native = await nativeSuccessorCapture(root, harness);
    try {
      const f = await publishedSuccessorForRemediation(root, "complete", async (handle, requests, payload) => {
        await native.capture(handle, requests, requests.map(() => [JSON.stringify(payload)]));
      });
      const cli = fileURLToPath(new URL("../../../../src/cli.ts", import.meta.url));
      const inspected = spawnSync("bun", [cli, "helper", "orchestration", "inspect", "--runs-root", f.runsRoot, "--run", f.successor.runId], {
        cwd: root, env: fixturePiEnvironment(root), encoding: "utf8",
      });
      expect(inspected.status, inspected.stderr).toBe(0);
      expect(inspected.stdout).toContain("Standalone successor: 0 new; 4 inherited; 4 total Findings.");
      expect(inspected.stdout).toContain("0 surviving critical; 1 refuted critical; 2 resolved; 1 advisory");
      expect(inspected.stdout).toContain("Original subsequently resolved assertion");
      expect(inspected.stdout).toContain("DECLARED");
      unlinkSync(join(f.successor.runDirectory, "checkpoint.json"));
      const prepared = value(await f.remediation.prepareRemediationFacadeStart({ input: { sourceRunsRoot: f.runsRoot,
        sourceRun: f.successor.runId, supportPaths: [], defectFamily: { kind: "not-required" } },
        repositoryStartPath: root, remediationRunsRoot: f.runsRoot, remediationRun: "native-not-required" }));
      expect(prepared.registration.source.inventory.sourceResultJson).toBe(f.bytes.toString());
      const handle = value(f.handles.createRunDirectory(f.runsRoot, "native-not-required"));
      const done = await f.remediation.startRemediationFacade(handle, prepared.registration);
      expect(done).toMatchObject({ ok: true, action: { kind: "done", outcome: { installation: { kind: "verified-index-installed" }, defectFamilyAssessment: { status: "not-required" } } } });
      expect(await handle.readEvents()).toEqual([]);
      const index = readFileSync(join(root, ".git/index"));
      expect(await f.remediation.resumeRemediationFacade(handle, prepared.registration)).toEqual(done);
      expect(readFileSync(join(root, ".git/index"))).toEqual(index);
      expect(readFileSync(join(f.source.runDirectory, "result.json"))).toEqual(f.originalBytes);
      expect(readFileSync(join(f.successor.runDirectory, "result.json"))).toEqual(f.bytes);
    } finally { await native.close(); }
  }));

  it.each(["claude", "pi"] as const)("%s captures a complete fresh reopening panel and native ambiguous-final retry without rewriting old votes", harness => owned(async root => {
    const native = await nativeSuccessorCapture(root, harness);
    try {
      const f = await publishedSuccessorForRemediation(root, "active", async (handle, requests, payload) => {
        const { REVIEWER_PAYLOAD_EXAMPLE_V2 } = await import("../../../../src/core/reviewer-contract");
        const helpers = await import("../../../../src/handlers/helpers/programs/helpers");
        const standalone = await import("../../../../src/handlers/helpers/programs/standalone");
        const retained = payload.priorAssessments[1]!;
        if (retained.verdict !== "retained") throw Error("exact old refutation required");
        const critical = REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!;
        if (critical.basis === undefined) throw Error("complete basis required");
        const report = { ...payload, priorAssessments: payload.priorAssessments.map((row, index) => index !== 1 ? row : {
          origin: row.origin, verdict: "reopen", reason: "New evidence contradicts prior applicability", proposal: {
            decisionDigest: retained.decisionDigest, evidence: critical.basis!.evidence,
            changedConditions: "Supported precondition changed", currentApplicability: "The original assertion now applies", evidenceLimits: "Scripted static trace, not executed",
          } }) };
        await native.capture(handle, requests, requests.map((_, index) => [JSON.stringify({ ...report,
          findings: index === 0 ? [{ draft: { ...critical, file: "src/repair.mjs", line: 1, claim: "Genuinely new native assertion" }, relation: { kind: "independent" } }] : [] })]));
        const registration = value(helpers.parseRegistration(value(handle.readProgramRegistration())));
        const panel = await standalone.resumeStandaloneFacade(handle, registration);
        if (!panel.ok) throw Error(panel.message);
        const panelRequests = (panel.action as { requests: Requests }).requests;
        expect(panelRequests).toHaveLength(3);
        const verdict = (request: Requests[number]) => {
          const packet = value(handle.readContext(request.authority.contextDigest));
          const context = JSON.parse(Buffer.from(packet.fixedContext[0]!.bytes).toString());
          expect(context.successorEvidence.reports).toHaveLength(7);
          expect(context.findings.map((row: { id: string }) => row.id)).toEqual(["standalone-review:code-reviewer-2", "standalone-review:code-reviewer-5"]);
          return JSON.stringify({ criterion: context.lens, verdicts: context.findings.map((row: { id: string }) => ({ finding_id: row.id, verdict: "refuted", reasoning: `Fresh exact ${context.lens} reason` })) });
        };
        const verdicts = panelRequests.map(verdict);
        const viewPath = /^LOOM_CONTEXT_VIEW_PATH: (.+)$/m.exec(panelRequests[0]!.task)?.[1];
        if (viewPath === undefined) throw Error("native panel needs a view readable with its actual tools");
        const view = readFileSync(viewPath);
        expect(view.toString()).toContain("export const repaired = () => true;");
        expect(view.toString()).toContain("export const repaired = () => false; // reviewed");
        expect(view.toString()).toContain("New evidence contradicts prior applicability");
        expect(view.toString().split("\n").every(line => line.length <= 4096)).toBe(true);
        writeFileSync(viewPath, "corrupted current view");
        try {
          if (harness === "pi") await expect(native.capture(handle, panelRequests.slice(0, 1), [[verdicts[0]!]])).rejects.toThrow("panel view differs");
          else expect(await native.capture(handle, panelRequests.slice(0, 1), [[verdicts[0]!]])).toMatchObject([{ kind: "error" }]);
          expect(existsSync(join(handle.runDirectory, panelRequests[0]!.authority.outputSlot.path))).toBe(false);
          expect(value(handle.readCaptureRejection(panelRequests[0]!.authority))).toBeNull();
        } finally { writeFileSync(viewPath, view); }
        await native.capture(handle, panelRequests, verdicts.map((text, index) => index === 0 ? [text, text] : [text]));
        const retried = await standalone.resumeStandaloneFacade(handle, registration);
        if (!retried.ok) throw Error(retried.message);
        const retry = (retried.action as { requests: Requests }).requests;
        expect(retry).toHaveLength(1); expect(retry[0]!.authority.attempt).toBe(2);
        await native.capture(handle, retry, [[verdict(retry[0]!)]]);
      });
      const result = JSON.parse(f.bytes.toString());
      expect(result.lineage.inventory[1].history[0]).toEqual(f.originalLineage.inventory[1]!.history[0]);
      expect(result.lineage.inventory[1].history).toHaveLength(2);
      expect(result.lineage.inventory[1].history[1].refutations).toHaveLength(3);
      unlinkSync(join(f.successor.runDirectory, "checkpoint.json"));
      expect(await f.standalone.replayStandaloneCapturedEvidence(f.successor, f.registration)).toMatchObject({ ok: true, json: f.bytes.toString() });
      if (harness === "pi") expect(await native.verify()).toMatchObject({ resultDigest: hash(f.bytes) });
    } finally { await native.close(); }
  }));

  it("Pi rejects the newest incomplete witness without falling back or altering the actually installed index, then prunes on shutdown", () => owned(async root => {
    const native = await nativeSuccessorCapture(root, "pi");
    try {
      const f = await publishedSuccessorForRemediation(root, "active", async (handle, requests, payload) => {
        expect(requests).toHaveLength(7);
        await native.capture(handle, requests, requests.map(() => [JSON.stringify(payload)]));
      });
      expect(await native.verify()).toMatchObject({ runId: f.successor.runId, resultDigest: hash(f.bytes) });
      addRepairTest(root);
      const prepared = value(await f.remediation.prepareRemediationFacadeStart({ input: { sourceRunsRoot: f.runsRoot, sourceRun: f.successor.runId,
        supportPaths: ["tests/repair.test.mjs"], defectFamily: repairDeclaration(f.originalLineage.inventory[0]!.finding.id) },
        repositoryStartPath: root, remediationRunsRoot: f.runsRoot, remediationRun: "current-witness-installed" }));
      const handle = value(f.handles.createRunDirectory(f.runsRoot, "current-witness-installed"));
      expect(await f.remediation.startRemediationFacade(handle, prepared.registration)).toMatchObject({ ok: true, action: { kind: "done", outcome: {
        installation: { kind: "verified-index-installed" }, defectFamilyAssessment: { status: "repair-checked" } } } });
      const staged = git(root, ["ls-files", "--stage", "-z"]);
      if (f.registration.schemaVersion !== 3) throw Error("successor required");
      const later = value(await f.standalone.prepareStandaloneSuccessorFacadeStart(f.runsRoot, "later", f.registration.input));
      // pta-4 pin of the minted-once seam: registration must publish exactly
      // JSON.parse(prepared.registrationWire) — a second live-object stringify
      // would dissolve the 16MB preflight byte budget without any test failing.
      const wireWrites: string[] = [];
      const underlyingHandle = value(f.handles.createRunDirectory(f.runsRoot, "later"));
      const handleRecord = Object.fromEntries(Object.getOwnPropertyNames(underlyingHandle).map((name) => {
        const member = Reflect.get(underlyingHandle as unknown as object, name, underlyingHandle);
        return [name, typeof member === "function" ? (member as (...args: unknown[]) => unknown).bind(underlyingHandle) : member];
      })) as Record<string, unknown> & { registerProgram: (raw: unknown) => Promise<unknown> };
      const registeredProgram = handleRecord.registerProgram;
      handleRecord.registerProgram = async (raw: unknown) => {
        wireWrites.push(JSON.stringify(raw));
        return registeredProgram(raw);
      };
      const laterHandle = Object.freeze(handleRecord) as unknown as RunDirHandle;
      const started = await f.standalone.startPreparedStandaloneSuccessor(laterHandle, later);
      if (!started.ok) throw Error(started.message);
      // JSON.stringify(JSON.parse(wire)) is byte-identical to the wire: the
      // wire was itself produced by JSON.stringify, so key order and number
      // formatting round-trip exactly.
      expect(wireWrites).toEqual([later.registrationWire]);
      const one = (started.action as { requests: Requests }).requests.slice(0, 1);
      await native.capture(laterHandle, one, [["invalid current JSON"]]);
      await expect(native.verify()).rejects.toThrow("current witnessed Standalone Review rejected: later:");
      expect(git(root, ["ls-files", "--stage", "-z"])).toBe(staged);
      expect(git(root, ["diff", "--cached", "--name-only"]).trim().split("\n")).toEqual(["README.md", "src/repair.mjs", "src/types.ts", "tests/repair.test.mjs"]);
      await native.emit("session_shutdown", { reason: "quit" });
      await expect(native.verify()).rejects.toThrow("no request-bound Loom captures were witnessed");
    } finally { await native.close(); }
  }));

  it.each(["claude", "pi"] as const)("%s captures seven roles, retries exact priors, witnesses current bytes and installs original-ID repair accounting", harness => owned(async root => {
    const native = await nativeSuccessorCapture(root, harness);
    try {
      const f = await publishedSuccessorForRemediation(root, "active", async (handle, requests, payload) => {
        expect(requests).toHaveLength(7);
        for (const request of requests) expect(readCommand(request.task)).toMatchObject({ schemaVersion: 3, requestId: request.authority.requestId });
        const task = requests[0]!.task;
        expect(readCommand(task, " --file src/repair.mjs").text).toBe("export const repaired = () => true;\n");
        expect(readCommand(task, " --section standalone-lineage").text).toContain("Original surviving assertion");
        expect(readCommand(task, " --archive predecessor-context:code-reviewer --archive-purpose v1-v2")).toMatchObject({ schemaVersion: 2 });
        const texts = requests.map((_, index) => [JSON.stringify(index === 0 ? { ...payload, priorAssessments: [] } : payload)]);
        const captured = await native.capture(handle, requests, texts);
        expect(captured.every(result => harness === "pi" ? result === undefined : (result as { kind: string }).kind === "passthrough"), JSON.stringify(captured)).toBe(true);
        const helpers = await import("../../../../src/handlers/helpers/programs/helpers");
        const standalone = await import("../../../../src/handlers/helpers/programs/standalone");
        const registration = value(helpers.parseRegistration(value(handle.readProgramRegistration())));
        const retry = await standalone.resumeStandaloneFacade(handle, registration);
        if (!retry.ok) throw Error(retry.message);
        const retried = (retry.action as { requests: Requests }).requests;
        expect(retried).toHaveLength(1); expect(retried[0]!.authority.attempt).toBe(2);
        const alreadyPublished = await standalone.resumeStandaloneFacade(handle, registration);
        expect(alreadyPublished).toEqual(retry);
        await native.capture(handle, retried, [[JSON.stringify(payload)]]);
      });
      const result = JSON.parse(f.bytes.toString());
      expect(result.lineage.counts).toMatchObject({ inherited: 4, new: 0, survivingCritical: 1, resolved: 1 });
      expect(result.lineage.inventory[0]).toEqual(f.originalLineage.inventory[0]);
      unlinkSync(join(f.successor.runDirectory, "checkpoint.json"));
      const replay = await f.standalone.replayStandaloneCapturedEvidence(f.successor, f.registration);
      expect(replay).toMatchObject({ ok: true, json: f.bytes.toString(), digest: hash(f.bytes) });
      if (harness === "pi") {
        const receipt = await native.verify();
        expect(receipt).toMatchObject({ runId: f.successor.runId, resultDigest: hash(f.bytes), requestIds: expect.any(Array) });
        expect(await native.verify()).toEqual(receipt);
      }
      addRepairTest(root);
      const prepared = value(await f.remediation.prepareRemediationFacadeStart({ input: { sourceRunsRoot: f.runsRoot, sourceRun: f.successor.runId,
        supportPaths: ["tests/repair.test.mjs"], defectFamily: repairDeclaration(f.originalLineage.inventory[0]!.finding.id) },
        repositoryStartPath: root, remediationRunsRoot: f.runsRoot, remediationRun: "native-install" }));
      expect(prepared.registration.source.inventory.sourceResultJson).toBe(f.bytes.toString());
      const handle = value(f.handles.createRunDirectory(f.runsRoot, "native-install"));
      const done = await f.remediation.startRemediationFacade(handle, prepared.registration);
      expect(done).toMatchObject({ ok: true, action: { kind: "done", outcome: { installation: { kind: "verified-index-installed" }, defectFamilyAssessment: { status: "repair-checked" } } } });
      expect(git(root, ["diff", "--cached", "--name-only"]).trim().split("\n")).toEqual(["README.md", "src/repair.mjs", "src/types.ts", "tests/repair.test.mjs"]);
      const index = readFileSync(join(root, ".git/index"));
      expect(await f.remediation.resumeRemediationFacade(handle, prepared.registration)).toEqual(done);
      expect(readFileSync(join(root, ".git/index"))).toEqual(index);
      expect(readFileSync(join(f.source.runDirectory, "result.json"))).toEqual(f.originalBytes);
      expect(readFileSync(join(f.successor.runDirectory, "result.json"))).toEqual(f.bytes);
      expect(existsSync(join(f.successor.runDirectory, "checkpoint.json"))).toBe(false);
      const receiptPath = join(f.successor.runDirectory, "receipts", readdirSync(join(f.successor.runDirectory, "receipts")).find(name => name.startsWith("effect:capture:"))!);
      const receiptBytes = readFileSync(receiptPath);
      unlinkSync(receiptPath);
      expect((await f.sourceReader.readAuthenticatedStandaloneSource(f.runsRoot, f.successor.runId)).ok).toBe(false);
      if (harness === "pi") await expect(native.verify()).rejects.toThrow("durable capture receipt unavailable");
      writeFileSync(receiptPath, receiptBytes);
      expect(readFileSync(join(root, ".git/index"))).toEqual(index);
      expect(git(root, ["diff", "--cached", "--name-only"]).trim().split("\n")).toEqual(["README.md", "src/repair.mjs", "src/types.ts", "tests/repair.test.mjs"]);
    } finally { await native.close(); }
  }));
});
