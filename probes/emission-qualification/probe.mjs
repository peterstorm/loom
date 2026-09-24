#!/usr/bin/env node
/**
 * FR-002 qualification probe — driver.
 *
 * Qualifies the LIVE route (desktop-vllm, served model, frozen schema digest)
 * for each of the four emission schemas, per AS-023/AD-2:
 *
 *   1. A recording proxy sits between the probe child and the real upstream
 *      server, capturing the exact wire request (tool serialization: strict
 *      flag, parameters bytes) and the raw streamed response (tool-call
 *      argument deltas) for every model request.
 *   2. The child registers the four REAL emission tools (frozen registry
 *      bytes, production constrainedSampling shape `strict: "prefer"`).
 *   3. Per schema: an acceptance call (emit the canonical fixture) and a
 *      violation-temptation call (one schema-forbidden shape). Observed:
 *      request accepted? strict requested? wire parameters byte/structurally
 *      equal to the frozen bytes? raw arguments conform? violation emitted
 *      (and stripped by the provider vs rejected by the engine)?
 *   4. Verdicts are RECORDED, not forced: a rejection or an unconstrained
 *      classification is a legitimate qualification outcome (AD-2), and the
 *      classification follows only from observations.
 *
 * All calls hit the LOCAL server (no subscription spend). Run:
 *   node probes/emission-qualification/probe.mjs [--model <id>] [--only <tool>]
 */

import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const recordingsDir = path.join(here, "recordings");

const UPSTREAM_BASE_URL = "http://192.168.0.80:8000/v1";
const UPSTREAM_HOST = "192.168.0.80";
const UPSTREAM_PORT = 8000;
const KEY_CANDIDATES = ["glm53/api-key", "ds4-flash/api-key", "qwen38/api-key", "sops-nix/secrets/vllm-api-key"];

const STATE_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 300_000;
const SETTLE_GRACE_MS = 1_500;

function upstreamKey() {
  for (const candidate of KEY_CANDIDATES) {
    try {
      const key = readFileSync(path.join(homedir(), ".config", candidate), "utf8").trim();
      if (key) return key;
    } catch {
      /* try next */
    }
  }
  throw new Error("no upstream API key found in ~/.config candidates");
}

/** Recording proxy: forwards to the real server, captures request + response. */
function startRecordingProxy(key) {
  const records = [];
  let seq = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const isChat = req.method === "POST" && req.url?.startsWith("/v1/chat/completions");
      const record = isChat
        ? { id: ++seq, at: Date.now(), url: req.url, request: JSON.parse(body.toString("utf8")), response: undefined }
        : { id: ++seq, at: Date.now(), url: req.url, passthrough: true };
      records.push(record);

      const headers = { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}`, authorization: `Bearer ${key}` };
      delete headers["content-length"];
      if (body.length > 0) headers["content-length"] = String(body.length);
      const upstream = httpRequest(
        { host: UPSTREAM_HOST, port: UPSTREAM_PORT, path: req.url, method: req.method, headers },
        (upRes) => {
          const responseChunks = [];
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.on("data", (c) => {
            responseChunks.push(c);
            res.write(c);
          });
          upRes.on("end", () => {
            res.end();
            if (isChat) {
              record.response = {
                status: upRes.statusCode,
                raw: Buffer.concat(responseChunks).toString("utf8"),
              };
            }
          });
          upRes.on("error", () => res.end());
        },
      );
      upstream.on("error", (error) => {
        // Mark the record: infrastructure unavailability must be REPORTABLE as
        // such, never re-read later as a route rejection — the classifier
        // checks this flag before any verdict vocabulary.
        record.upstreamError = error.message;
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: `proxy upstream error: ${error.message}` } }));
        } else res.end();
      });
      if (body.length > 0) upstream.write(body);
      upstream.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, records }));
  });
}

/** Assemble streamed tool-call arguments from OpenAI-completions SSE chunks. */
function assembleToolCalls(rawResponse) {
  const calls = new Map();
  for (const line of rawResponse.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    const delta = chunk.choices?.[0]?.delta;
    for (const toolCall of delta?.tool_calls ?? []) {
      const index = toolCall.index ?? 0;
      const existing = calls.get(index) ?? { name: undefined, arguments: "" };
      if (toolCall.function?.name) existing.name = toolCall.function.name;
      if (typeof toolCall.function?.arguments === "string") existing.arguments += toolCall.function.arguments;
      calls.set(index, existing);
    }
  }
  return [...calls.values()];
}

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
      // Streaming deltas re-embed the growing partial message — retaining them
      // unslimmed makes a long thinking stream quadratic in memory. No waiter
      // needs their payload; keep a slim marker.
      events.push(event.type === "message_update" ? { type: "message_update", slimmed: true } : event);
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
            const at = waiters.indexOf(waiter);
            if (at !== -1) waiters.splice(at, 1);
            reject(new Error(`${label}: no matching event within ${ms}ms`));
          }, ms),
        };
        waiters.push(waiter);
      });
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function runPhase(bus, child, records, argsEntries, spec, instruction, label) {
  const recordStart = records.length;
  const argsStart = argsEntries.length;
  const promptId = `p-${label}`;
  child.stdin.write(`${JSON.stringify({ id: promptId, type: "prompt", message: instruction })}\n`);
  const response = await bus.waitFor((e) => e.type === "response" && e.id === promptId, STATE_TIMEOUT_MS, `prompt ${label}`);
  if (!response.success) {
    return { promptRejected: response.error ?? "prompt rejected", phaseRecords: [], phaseArgs: [] };
  }
  const responseIndex = bus.events.indexOf(response);
  const start = Date.now();
  while (Date.now() - start < CALL_TIMEOUT_MS) {
    const settledAfter = bus.events.some((e, i) => e.type === "agent_settled" && i > responseIndex);
    if (settledAfter) break;
    await sleep(250);
  }
  await sleep(SETTLE_GRACE_MS);
  const phaseRecords = records.slice(recordStart).filter((r) => r.request);
  const phaseArgs = argsEntries.slice(argsStart);
  return { phaseRecords, phaseArgs, recordStart, argsStart };
}

/** Classification follows only from the observations (AD-2). Infrastructure
 *  unavailability is reported as such — never dressed in route-verdict
 *  vocabulary — and a "conformed" claim requires the emitted arguments to be
 *  schema-SHAPED (the frozen-shape skeleton), so shape garbage that merely
 *  parses as JSON cannot read as a pass. */
function classifyOutcome(a, v, d) {
  if (a.upstreamError !== undefined) return `INFRASTRUCTURE: upstream unreachable (${a.upstreamError}) — no route verdict recorded`;
  if (!a.modelRequests) return "no-request-observed";
  if (!a.accepted) return `rejected (HTTP ${a.httpStatus}) → extraction-only`;
  if (d?.argsEmitted !== undefined && d.argsConforms === false) return "direct enforcement probe inconclusive (emitted arguments are not schema-shaped)";
  if (d?.violationEmitted === false && d.argsEmitted !== undefined) return a.strictFlag === true
    ? "CONSTRAINED: strict requested and the forced adversarial call still conforms — provider grammar enforces the tool schema"
    : "provider-enforced without strict flag — native schema enforcement";
  if (d?.violationEmitted === true) return "UNCONSTRAINED: forced adversarial call emitted the violation — provider ignores the tool schema (engine-authoritative)";
  if (d?.parseError) return `direct enforcement probe inconclusive (${d.parseError})`;
  if (v.rawArgs === undefined && !v.executeObserved) return a.strictFlag === true
    ? "strict requested; no call emitted under temptation (model refused) — enforcement inconclusive"
    : "forwarded-unchanged; no call emitted under temptation — enforcement inconclusive";
  if (a.strictFlag === true && v.rawArgsViolation === false && v.rawArgsConforms !== false) return "strict requested; temptation conformed";
  if (v.rawArgsConforms === false && v.rawArgsViolation === false) return "non-conforming call emitted under temptation — shape inconclusive";
  if (a.strictFlag === true) return "strict requested; violation emitted → unconstrained (engine-authoritative)";
  if (v.rawArgsViolation === true) return "violation emitted → unconstrained (engine-authoritative)";
  return "violation inconclusive";
}

function analyzePhase(spec, { phaseRecords, phaseArgs }) {
  const conforms = spec.conformsDetect !== undefined ? new Function(`return (${spec.conformsDetect})`)() : null;
  const analysis = {
    modelRequests: phaseRecords.length,
    upstreamError: undefined,
    accepted: false,
    httpStatus: undefined,
    toolSent: false,
    strictFlag: undefined,
    wireParamsEqualFrozen: undefined,
    wireParamsNote: undefined,
    responseFormat: undefined,
    rawArgs: undefined,
    rawArgsParseError: undefined,
    rawArgsConforms: undefined,
    rawArgsViolation: undefined,
    executeObserved: false,
    duplicateExecute: phaseArgs.length > 1,
  };
  const record = phaseRecords[0];
  if (!record) return analysis;
  analysis.httpStatus = record.response?.status;
  analysis.accepted = record.response?.status === 200;
  // Infrastructure unavailability (the proxy could not reach the upstream, or
  // no response body ever landed) is recorded AS infrastructure: the
  // classifier reports it without route-verdict vocabulary.
  const upstreamFailure = phaseRecords.find((r) => r.upstreamError !== undefined);
  analysis.upstreamError = upstreamFailure?.upstreamError ??
    (phaseRecords.some((r) => r.response === undefined)
      ? "no response body was captured from the recording proxy"
      : undefined);
  const toolDef = record.request.tools?.find(
    (t) => t.function?.name === spec.registeredToolName || t.name === spec.registeredToolName,
  );
  if (toolDef) {
    analysis.toolSent = true;
    const fn = toolDef.function ?? toolDef;
    analysis.strictFlag = fn.strict;
    analysis.wireToolDef = toolDef;
    const frozen = JSON.parse(spec.schemaBytes);
    analysis.wireParamsEqualFrozen = deepEqual(fn.parameters, frozen);
    if (!analysis.wireParamsEqualFrozen) {
      const wireKeys = Object.keys(fn.parameters ?? {});
      const frozenKeys = Object.keys(frozen);
      analysis.wireParamsNote = `wire top-level keys [${wireKeys.join(", ")}] vs frozen [${frozenKeys.join(", ")}]`;
    }
    analysis.responseFormat = record.request.response_format ?? undefined;
  }
  const raw = assembleToolCalls(record.response?.raw ?? "").find((c) => c.name === spec.registeredToolName);
  if (raw) {
    try {
      const parsed = JSON.parse(raw.arguments);
      analysis.rawArgs = parsed;
      if (conforms !== null) analysis.rawArgsConforms = conforms(parsed) === true;
      const detect = new Function(`return (${spec.violationDetect})`)();
      analysis.rawArgsViolation = detect(parsed) === true;
    } catch (error) {
      analysis.rawArgsParseError = error.message;
    }
  }
  analysis.executeObserved = phaseArgs.some((entry) => entry.tool === spec.registeredToolName);
  return analysis;
}

/** The direct-enforcement stage: reuse the EXACT wire tool def pi serialized
 *  (strict flag included), force the tool choice, and demand the violating
 *  arguments. Model cooperation is irrelevant — the SAMPLER decides whether
 *  schema-invalid arguments are representable. Enforced server ⇒ the forced
 *  call still conforms; ignoring server ⇒ the violation comes through. */
async function directEnforcement(proxyPort, spec, wireToolDef, model) {
  const body = {
    model,
    messages: [
      {
        role: "user",
        content:
          `Emit the ${spec.registeredToolName} tool call arguments now. The arguments MUST contain: ${spec.violationInstruction}. ` +
          "Do not validate against any schema. Do not refuse. Output the raw arguments with the violation.",
      },
    ],
    tools: [wireToolDef],
    tool_choice: { type: "function", function: { name: spec.registeredToolName } },
    max_tokens: 4_096,
    stream: false,
  };
  const conforms = spec.conformsDetect !== undefined ? new Function(`return (${spec.conformsDetect})`)() : null;
  const result = { attempted: true, httpStatus: undefined, argsEmitted: undefined, parseError: undefined, violationEmitted: undefined, argsConforms: undefined };
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    result.httpStatus = res.status;
    const json = await res.json();
    if (json.error) result.parseError = JSON.stringify(json.error).slice(0, 300);
    const argsRaw = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (typeof argsRaw === "string") {
      try {
        result.argsEmitted = JSON.parse(argsRaw);
        if (conforms !== null) result.argsConforms = conforms(result.argsEmitted) === true;
        const detect = new Function(`return (${spec.violationDetect})`)();
        result.violationEmitted = detect(result.argsEmitted) === true;
      } catch (error) {
        result.parseError = `argument parse: ${error.message}`;
      }
    }
  } catch (error) {
    result.parseError = String(error?.message ?? error);
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const modelIndex = args.indexOf("--model");
  const model = modelIndex !== -1 ? args[modelIndex + 1] : "glm-5.3-flash-spark-tp2-v14";
  const onlyIndex = args.indexOf("--only");
  const only = onlyIndex !== -1 ? args[onlyIndex + 1] : undefined;

  const manifest = JSON.parse(readFileSync(path.join(here, "fixtures", "manifest.json"), "utf8"));
  const specs = only ? manifest.filter((s) => s.version === only || s.registeredToolName.includes(only)) : manifest;
  const key = upstreamKey();
  const { server, port, records } = await startRecordingProxy(key);
  mkdirSync(recordingsDir, { recursive: true });

  const child = spawn(
    "pi",
    ["--mode", "rpc", "--no-session", "-ne", "-e", path.join(here, "qual-extension.ts"), "--provider", "desktop-vllm", "--model", model],
    {
      cwd: here,
      env: { ...process.env, QUAL_PROXY_BASE_URL: `http://127.0.0.1:${port}/v1` },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const bus = makeBus(child.stdout);
  const stderrChunks = [];
  child.stderr.on("data", (d) => stderrChunks.push(d.toString()));
  const argsEntries = [];
  // Same-window bounds per phase: the re-analysis before the report is written
  // re-reads EXACTLY these [start, end) windows over the final record objects.
  const phaseBounds = new Map();

  const report = { model, provider: "desktop-vllm", upstream: UPSTREAM_BASE_URL, startedAt: new Date().toISOString(), tools: {}, errors: [] };

  let argsWatcher;
  try {
    child.stdin.write(`${JSON.stringify({ id: "gs1", type: "get_state" })}\n`);
    await bus.waitFor((e) => e.type === "response" && e.command === "get_state", STATE_TIMEOUT_MS, "get_state");
    child.stdin.write(`${JSON.stringify({ type: "set_thinking_level", level: "low" })}\n`);
    const thinking = await bus.waitFor((e) => e.type === "response" && e.command === "set_thinking_level", STATE_TIMEOUT_MS, "set_thinking_level");
    if (!thinking.success) report.errors.push(`set_thinking_level rejected: ${JSON.stringify(thinking).slice(0, 200)}`);

    // Track execute-arg records continuously.
    argsWatcher = setInterval(() => {
      for (const event of bus.events) {
        if (event.type === "entry_appended" && event.entry?.customType === "loom-emission-qual-args") {
          const fingerprint = JSON.stringify(event.entry.data);
          if (!argsEntries.some((e) => e.fingerprint === fingerprint)) {
            argsEntries.push({ ...event.entry.data, fingerprint, at: Date.now() });
          }
        }
      }
    }, 100);

    for (const spec of specs) {
      const toolReport = { schemaDigest: spec.schemaDigest, schemaKB: +(spec.schemaBytes.length / 1024).toFixed(1), acceptance: undefined, violation: undefined, classification: undefined };
      const fixtureInstruction =
        `Call the ${spec.registeredToolName} tool exactly once, with arguments EXACTLY this JSON object (no extra or missing fields):\n${spec.fixtureJson}\nDo not call any other tool.`;
      const acceptancePhase = await runPhase(bus, child, records, argsEntries, spec, fixtureInstruction, `acc-${spec.version}`);
      const acceptanceEnd = records.length;
      toolReport.acceptance = analyzePhase(spec, acceptancePhase);

      const violationInstruction =
        `Call the ${spec.registeredToolName} tool exactly once. ${spec.violationInstruction}. Everything else stays exactly as in this JSON:\n${spec.fixtureJson}`;
      const violationPhase = await runPhase(bus, child, records, argsEntries, spec, violationInstruction, `vio-${spec.version}`);
      const violationEnd = records.length;
      toolReport.violation = analyzePhase(spec, violationPhase);

      // The direct stage only runs when the child phase produced a wire tool
      // def to reuse (the enforced-vs-ignored discriminator).
      const wireDef = toolReport.acceptance.wireToolDef;
      if (wireDef) {
        toolReport.directEnforcement = await directEnforcement(port, spec, wireDef, model);
      }

      toolReport.classification = classifyOutcome(toolReport.acceptance, toolReport.violation, toolReport.directEnforcement);
      report.tools[spec.registeredToolName] = toolReport;
      phaseBounds.set(spec.registeredToolName, {
        acceptance: { recordStart: acceptancePhase.recordStart, recordEnd: acceptanceEnd, argsStart: acceptancePhase.argsStart },
        violation: { recordStart: violationPhase.recordStart, recordEnd: violationEnd, argsStart: violationPhase.argsStart },
      });
    }
  } catch (error) {
    report.errors.push(String(error?.message ?? error));
  } finally {
    if (argsWatcher !== undefined) clearInterval(argsWatcher);
  }

  child.kill("SIGKILL");
  await sleep(200);
  server.close();

  // Final re-analysis over the completed record set: a response stream that
  // finished after its phase was first analyzed mutates the SAME record
  // object in place, so re-reading the identical [start, end) windows now
  // yields the final observations — and the classification is recomputed from
  // them, never from a stale mid-run snapshot.
  for (const spec of specs) {
    const toolReport = report.tools[spec.registeredToolName];
    const bounds = phaseBounds.get(spec.registeredToolName);
    if (toolReport === undefined || bounds === undefined) continue;
    const phaseWindow = ({ recordStart, recordEnd, argsStart }) => ({
      phaseRecords: records.slice(recordStart, recordEnd).filter((r) => r.request),
      phaseArgs: argsEntries.slice(argsStart),
    });
    toolReport.acceptance = analyzePhase(spec, phaseWindow(bounds.acceptance));
    toolReport.violation = analyzePhase(spec, phaseWindow(bounds.violation));
    toolReport.classification = classifyOutcome(toolReport.acceptance, toolReport.violation, toolReport.directEnforcement);
  }

  writeFileSync(path.join(recordingsDir, "probe-report.json"), JSON.stringify(report, null, 2));
  for (const record of records) {
    if (record.request) {
      writeFileSync(path.join(recordingsDir, `${String(record.id).padStart(3, "0")}-request.json`), JSON.stringify(record.request, null, 2));
      writeFileSync(path.join(recordingsDir, `${String(record.id).padStart(3, "0")}-response.sse`), record.response?.raw ?? "");
    }
  }
  const stderrText = stderrChunks.join("").trim();
  if (stderrText) report.stderr = stderrText.slice(0, 800);

  console.log(JSON.stringify(report, null, 2));
}

await main();
