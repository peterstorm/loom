#!/usr/bin/env node
/**
 * FR-008 feasibility probe — driver.
 *
 * Proves the launcher readiness gate end-to-end against the installed pi
 * (0.83.0) and a counting provider substitute (a local HTTP server that
 * counts and rejects model requests — no real model involved):
 *
 *   matching      — readiness matches the issued expectation → the gate sends
 *                   the prompt → the counting server receives ≥ 1 request,
 *                   and the first request lands AFTER the readiness
 *                   observation.
 *   contradictory — readiness carries a wrong schema digest → the gate never
 *                   prompts → 0 model requests.
 *   missing       — no readiness within the bounded window → the gate never
 *                   prompts and kills the child → 0 model requests. Also the
 *                   shape of the stale/absent-extension case: no loom
 *                   extension, no signal.
 *   held          — matching readiness, then the child's before_agent_start
 *                   hold keeps the first model request waiting until the hold
 *                   resolves (the awaited-hook gate, defense-in-depth layer).
 *
 * AS-020's negative controls (missing, stale, contradictory, wrong-request)
 * all reduce to "0 model requests" here: stale/absent extension = no readiness
 * signal; wrong-request = the launcher-side expectation comparison refusing
 * the child's otherwise-valid readiness. The gate is bounded
 * (READY_TIMEOUT_MS) and cleanup kills only this probe's child.
 *
 * Run: node probes/emission-readiness/probe.mjs [--variant <name>] (default: all four)
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const READY_TIMEOUT_MS = 15_000;
const STATE_TIMEOUT_MS = 10_000;
const FIRST_REQUEST_TIMEOUT_MS = 30_000;
const HOLD_MS = 2_000;
const REFUSE_GRACE_MS = 1_000;
const HOLD_ORDERING_SLACK_MS = 250;

/** The frozen probe schema — one small stand-in for the real per-kind bytes.
 *  Kept byte-identical with probe-extension.mjs: the launcher's expectation is
 *  the digest of the SAME bytes the child registered. */
const probeSchema = {
  type: "object",
  properties: {
    claim: { type: "string", minLength: 1 },
    severity: { type: "string", enum: ["critical", "advisory"] },
  },
  required: ["claim", "severity"],
  additionalProperties: false,
};
const probeDigest = "sha256-" + createHash("sha256").update(JSON.stringify(probeSchema)).digest("hex");

const EXPECTED = Object.freeze({
  tool: "loom_emit_probe_payload",
  digest: probeDigest,
  revision: "probe-rev-001",
  readinessCommand: "probe-readiness",
});

/** One counting provider substitute: counts /v1/chat/completions POSTs and
 *  rejects them. The count is the evidence; the rejection bounds the run. */
function startCountingServer() {
  const hits = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.method === "POST" && req.url?.startsWith("/v1/chat/completions")) {
        hits.push({ at: Date.now(), url: req.url, bytes: body.length });
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "counting substitute: rejected" } }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, hits });
    });
  });
}

/** RPC framing: strict JSONL, split on \n only. */
function makeBus(stdout) {
  const events = [];
  const waiters = [];
  let buffer = "";
  stdout.on("data", (data) => {
    buffer += data.toString();
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        events.push({ type: "__non_json__", line: line.slice(0, 120) });
        continue;
      }
      events.push(event);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i];
        if (waiter.predicate(event)) {
          waiters.splice(i, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(event);
        }
      }
    }
  });
  return {
    events,
    waitFor(predicate, ms, label) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index !== -1) waiters.splice(index, 1);
            reject(new Error(`${label}: no matching event within ${ms}ms`));
          }, ms),
        };
        waiters.push(waiter);
      });
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runVariant(variant) {
  const { server, port, hits } = await startCountingServer();
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  const tmp = await mkdtemp(path.join(tmpdir(), "loom-emission-probe-"));
  const extPath = path.join(tmp, "probe-extension.mjs");
  await copyFile(path.join(here, "probe-extension.mjs"), extPath);

  const child = spawn(
    "pi",
    [
      "--mode", "rpc",
      "--no-session",
      "-ne", // no extension discovery — only the probe extension loads
      "-e", extPath,
      "--tools", EXPECTED.tool,
    ],
    {
      cwd: tmp,
      env: {
        ...process.env,
        PROBE_VARIANT: variant,
        PROBE_COUNT_BASE_URL: baseUrl,
        PROBE_HOLD_MS: String(HOLD_MS),
        PROBE_REVISION: EXPECTED.revision,
        PROBE_COUNT_KEY: "probe-key",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const result = {
    variant,
    rpcAlive: false,
    readinessCommandRegistered: false,
    modelSet: false,
    readinessObserved: false,
    readinessTimedOut: false,
    readiness: undefined,
    readinessRefusedReason: undefined,
    prompted: false,
    firstRequestAt: undefined,
    requestCount: 0,
    holdResolvedAt: undefined,
    failures: [],
  };

  const bus = makeBus(child.stdout);
  const stderrChunks = [];
  child.stderr.on("data", (d) => stderrChunks.push(d.toString()));
  child.on("error", (error) => result.failures.push(`spawn error: ${error.message}`));

  try {
    // 1. The RPC channel itself must answer before any readiness expectation —
    //    this distinguishes "child up, readiness missing" (a readiness
    //    refusal) from "child never came up" (infrastructure failure).
    child.stdin.write(`${JSON.stringify({ id: "gs1", type: "get_state" })}\n`);
    await bus.waitFor((e) => e.type === "response" && e.command === "get_state", STATE_TIMEOUT_MS, "get_state");
    result.rpcAlive = true;

    // 2. The readiness command must be REGISTERED before it is invoked — an
    //    unknown "/command" would fall through to a normal user prompt and
    //    trigger a real model request, which is exactly what the gate must
    //    never do. The command list is the launcher-side discovery surface.
    child.stdin.write(`${JSON.stringify({ id: "gc1", type: "get_commands" })}\n`);
    const commands = await bus.waitFor((e) => e.type === "response" && e.command === "get_commands", STATE_TIMEOUT_MS, "get_commands");
    const readinessCommand = EXPECTED.readinessCommand;
    const listed = (commands.data?.commands ?? []).some((c) => c.name === readinessCommand && c.source === "extension");
    result.readinessCommandRegistered = listed;

    if (listed) {
      // 3. Invoke readiness: the extension command executes immediately —
      //    preflight succeeds without a model request — and its
      //    entry_appended readiness lands on the subscribed stdout.
      child.stdin.write(`${JSON.stringify({ id: "rr1", type: "prompt", message: `/${readinessCommand}` })}\n`);
      const invocation = await bus.waitFor((e) => e.type === "response" && e.id === "rr1", STATE_TIMEOUT_MS, "readiness invocation");
      if (!invocation.success) result.failures.push(`readiness invocation failed: ${JSON.stringify(invocation).slice(0, 200)}`);

      // 4. The bounded readiness wait.
      const readinessEvent = await bus.waitFor(
        (e) => e.type === "entry_appended" && e.entry?.customType === "loom-emission-readiness",
        READY_TIMEOUT_MS,
        "readiness",
      );
      result.readinessObserved = true;
      result.readinessObservedAt = Date.now();
      result.readiness = readinessEvent.entry?.data;
    }
  } catch (error) {
    const message = String(error?.message ?? error);
    if (message.startsWith("readiness:")) result.readinessTimedOut = true;
    else result.failures.push(message);
  }

  // 4. The gate decision — pure comparison of the child's readiness payload
  //    against the issued expectation. Wrong digest / wrong revision / wrong
  //    tool / inactive tool all refuse; a refused gate never prompts.
  try {
    if (result.readinessObserved) {
      const readiness = result.readiness ?? {};
      const mismatches = [];
      if (readiness.tool !== EXPECTED.tool) mismatches.push("tool");
      if (readiness.digest !== EXPECTED.digest) mismatches.push("digest");
      if (readiness.revision !== EXPECTED.revision) mismatches.push("revision");
      if (readiness.active !== true) mismatches.push("active");
      if (mismatches.length > 0) result.readinessRefusedReason = mismatches.join(",");
    }

    const gateOpens =
      (variant === "matching" || variant === "held") &&
      result.readinessObserved &&
      result.readinessRefusedReason === undefined;
    if (gateOpens) {
      // Model selection happens at gate time: the readiness command registered
      // the probe provider, so set_model now resolves against it. The gate is
      // fail-closed on model identity too — a prompt that slips past a failed
      // selection would fall through to the child's DEFAULT (real) provider,
      // which is exactly the under-capability class the gate exists to
      // prevent. No set_model success, no prompt.
      child.stdin.write(`${JSON.stringify({ id: "sm1", type: "set_model", provider: "probe", modelId: "probe-model" })}\n`);
      const setModel = await bus.waitFor((e) => e.type === "response" && e.command === "set_model", STATE_TIMEOUT_MS, "set_model");
      if (!setModel.success) {
        result.failures.push(`set_model failed: ${JSON.stringify(setModel).slice(0, 200)}`);
      } else {
        const model = setModel.data ?? {};
        if (model.provider !== "probe" || model.id !== "probe-model") {
          result.failures.push(`set_model selected an unexpected route: ${JSON.stringify(model).slice(0, 200)}`);
        } else {
          result.modelSet = true;
          result.selectedModel = { provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl };
          child.stdin.write(`${JSON.stringify({ type: "set_auto_retry", enabled: false })}\n`);
          child.stdin.write(
            `${JSON.stringify({ id: "p1", type: "prompt", message: "Emit the probe payload with claim 'gate open' and severity 'advisory'." })}\n`,
          );
          const promptResponse = await bus.waitFor((e) => e.type === "response" && e.id === "p1", STATE_TIMEOUT_MS, "prompt");
          if (!promptResponse.success) result.failures.push(`prompt preflight failed: ${JSON.stringify(promptResponse).slice(0, 200)}`);
          result.prompted = true;
        }
      }
    }
  } catch (error) {
    result.failures.push(String(error?.message ?? error));
  }

  // 5. Bounded settle: prompted variants wait for the first counted request;
  //    refused/timed-out variants get a short grace to prove nothing arrives.
  //    The held variant first waits for the child's hold-resolution marker so
  //    the ordering assertion compares the marker's arrival against the first
  //    counted request (both observed by this driver).
  if (variant === "held" && result.prompted) {
    try {
      await bus.waitFor(
        (e) => e.type === "entry_appended" && e.entry?.customType === "loom-emission-probe-hold" && e.entry?.data?.phase === "resolved",
        FIRST_REQUEST_TIMEOUT_MS,
        "hold resolution",
      );
      result.holdResolvedAt = Date.now();
    } catch (error) {
      result.failures.push(String(error?.message ?? error));
    }
  }
  if (result.prompted) {
    const start = Date.now();
    while (hits.length === 0 && Date.now() - start < FIRST_REQUEST_TIMEOUT_MS) {
      await sleep(50);
    }
    if (hits.length > 0) result.firstRequestAt = hits[0].at;
    else result.failures.push("no request reached the counting server within the bound");
  } else {
    await sleep(REFUSE_GRACE_MS);
  }

  // 6. Cleanup kills only this probe's child.
  child.kill("SIGKILL");
  await sleep(100);
  server.close();
  result.requestCount = hits.length;
  result.firstRequestAt ??= hits[0]?.at;
  const stderrText = stderrChunks.join("").trim();
  if (stderrText) result.stderr = stderrText.slice(0, 400);

  // 7. Variant assertions.
  if (variant === "matching") {
    if (!result.rpcAlive) result.failures.push("rpc channel never answered get_state");
    if (!result.readinessObserved) result.failures.push("readiness never observed");
    if (result.readinessRefusedReason) result.failures.push(`gate refused a matching readiness: ${result.readinessRefusedReason}`);
    if (!result.prompted) result.failures.push("gate never prompted on matching readiness");
    else if (!result.modelSet) result.failures.push("prompted without a verified probe model selection");
    if (result.firstRequestAt !== undefined && result.firstRequestAt < result.readinessObservedAt) {
      result.failures.push("first model request preceded the readiness observation");
    }
  }
  if (variant === "held") {
    if (!result.prompted) result.failures.push("gate never prompted on held-variant readiness");
    if (result.requestCount < 1) result.failures.push("no model request after the hold resolved");
    if (result.holdResolvedAt !== undefined && result.firstRequestAt !== undefined && result.firstRequestAt < result.holdResolvedAt - HOLD_ORDERING_SLACK_MS) {
      result.failures.push("first model request preceded the before_agent_start hold resolution beyond slack");
    }
  }
  if (variant === "contradictory") {
    if (!result.readinessObserved) result.failures.push("contradictory readiness was not observed (probe bug)");
    if (!result.readinessRefusedReason?.includes("digest")) result.failures.push("gate did not refuse on wrong digest");
    if (result.prompted) result.failures.push("gate prompted despite refused readiness");
    if (result.requestCount !== 0) result.failures.push(`model requests occurred despite refusal: ${result.requestCount}`);
  }
  if (variant === "missing") {
    if (!result.rpcAlive) result.failures.push("rpc channel never answered get_state (cannot distinguish missing readiness from dead child)");
    if (result.readinessCommandRegistered) result.failures.push("readiness command was listed despite the missing variant (probe bug)");
    if (result.readinessObserved) result.failures.push("readiness was observed despite the missing variant (probe bug)");
    if (result.prompted) result.failures.push("gate prompted despite missing readiness command");
    if (result.requestCount !== 0) result.failures.push(`model requests occurred despite missing readiness: ${result.requestCount}`);
  }

  result.pass = result.failures.length === 0;
  await rm(tmp, { recursive: true, force: true });
  return result;
}

const args = process.argv.slice(2);
const variantIndex = args.indexOf("--variant");
const requested = variantIndex !== -1 ? [args[variantIndex + 1]] : ["matching", "contradictory", "missing", "held"];

const results = [];
for (const variant of requested) {
  results.push(await runVariant(variant));
}

for (const result of results) {
  console.log(JSON.stringify(result, null, 2));
}
const failed = results.filter((r) => !r.pass);
console.log(failed.length === 0 ? "PROBE PASS" : `PROBE FAIL (${failed.length}/${results.length} variants failed)`);
process.exit(failed.length === 0 ? 0 : 1);
