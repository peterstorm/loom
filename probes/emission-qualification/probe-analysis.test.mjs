import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzePhase, assembleToolCalls, classifyOutcome, probeExitCode, streamErrors } from "./probe-analysis.mjs";

/**
 * The probe's pure analysis, without the network: the recorded wire evidence
 * under `recordings/` (read, never written) and synthetic streams.
 */

const here = dirname(fileURLToPath(import.meta.url));
const recording = (name) => readFileSync(join(here, "recordings", name), "utf8");
const manifest = JSON.parse(readFileSync(join(here, "fixtures", "manifest.json"), "utf8"));
const judgeSpec = manifest.find((spec) => spec.kind === "judge-verdict");

const sse = (...chunks) => chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
const argsDelta = (name, fragment, index = 0) => ({ choices: [{ delta: { tool_calls: [{ index, function: { ...(name ? { name } : {}), arguments: fragment } }] } }] });

const fixture = JSON.parse(judgeSpec.fixtureJson);
const violated = { ...fixture, rankings: [{ ...fixture.rankings[0], score: 12 }] };
/** One captured phase: the request pi sent (with the wire tool def) and the streamed response. */
const phase = (raw, toolDef = { type: "function", function: { name: judgeSpec.registeredToolName, strict: true, parameters: JSON.parse(judgeSpec.schemaBytes) } }) => ({
  phaseRecords: [{ request: { tools: [toolDef] }, response: { status: 200, raw } }],
  phaseArgs: [],
});
const streamOf = (args, split = 7) => {
  const text = JSON.stringify(args);
  return [argsDelta(judgeSpec.registeredToolName, text.slice(0, split)), argsDelta(undefined, text.slice(split))];
};

describe("assembleToolCalls", () => {
  it("reconstructs the recorded wire arguments exactly, with no malformed chunk in any recording", () => {
    const first = assembleToolCalls(recording("001-response.sse"));
    expect(first.calls.map((call) => call.name)).toEqual(["loom_emit_reviewer_payload_v2"]);
    expect(JSON.parse(first.calls[0].arguments)).toEqual(JSON.parse(recording("001-emitted-args.json")));
    for (const name of readdirSync(join(here, "recordings")).filter((entry) => entry.endsWith(".sse"))) {
      expect(assembleToolCalls(recording(name)).malformed, name).toEqual([]);
    }
  });

  it("records a malformed data chunk with its line instead of skipping it", () => {
    const raw = sse(argsDelta("tool", '{"a":'), '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1', argsDelta(undefined, "}"));
    const assembled = assembleToolCalls(raw);
    expect(assembled.calls).toEqual([{ name: "tool", arguments: '{"a":}' }]);
    expect(assembled.malformed).toEqual([{ line: 3, excerpt: expect.stringContaining('"arguments":"1'), error: expect.any(String) }]);
  });
});

describe("analyzePhase and classifyOutcome", () => {
  it("classifies a forced violation that comes through as unconstrained", () => {
    const acceptance = analyzePhase(judgeSpec, phase(sse(...streamOf(fixture))));
    const violation = analyzePhase(judgeSpec, phase(sse(...streamOf(violated))));
    expect(acceptance).toMatchObject({ accepted: true, strictFlag: true, wireParamsEqualFrozen: true, rawArgsConforms: true, rawArgsViolation: false, streamMalformedChunks: [] });
    expect(violation.rawArgsViolation).toBe(true);
    expect(classifyOutcome(acceptance, violation, { argsEmitted: violated, argsConforms: true, violationEmitted: true }))
      .toMatch(/^UNCONSTRAINED: /);
  });

  it("draws no raw-argument conclusion from a stream with a malformed chunk", () => {
    const acceptance = analyzePhase(judgeSpec, phase(sse(...streamOf(fixture))));
    const [head, tail] = streamOf(violated);
    const truncated = analyzePhase(judgeSpec, phase(sse(head, "{not json", tail)));
    expect(truncated.streamMalformedChunks).toHaveLength(1);
    expect(classifyOutcome(acceptance, truncated, undefined)).toBe("stream incomplete (1 malformed SSE chunk(s)) — raw-argument observations inconclusive");
    expect(classifyOutcome(acceptance, analyzePhase(judgeSpec, phase(sse(head, tail))), undefined)).toBe("strict requested; violation emitted → unconstrained (engine-authoritative)");
  });

  it("reports infrastructure unavailability without route-verdict vocabulary", () => {
    const down = analyzePhase(judgeSpec, { phaseRecords: [{ request: { tools: [] }, upstreamError: "ECONNREFUSED", response: undefined }], phaseArgs: [] });
    expect(classifyOutcome(down, down, undefined)).toBe("INFRASTRUCTURE: upstream unreachable (ECONNREFUSED) — no route verdict recorded");
  });
});

describe("run status", () => {
  it("turns every malformed recorded stream into a report error", () => {
    const clean = analyzePhase(judgeSpec, phase(sse(...streamOf(fixture))));
    const broken = analyzePhase(judgeSpec, phase(sse("{oops", ...streamOf(fixture))));
    const report = { tools: { [judgeSpec.registeredToolName]: { acceptance: clean, violation: broken } }, errors: [] };
    expect(streamErrors(report)).toEqual([
      `${judgeSpec.registeredToolName} violation: 1 malformed SSE chunk(s) in the recorded response stream (first at line 1: ${broken.streamMalformedChunks[0].error})`,
    ]);
    expect(streamErrors({ tools: { x: { acceptance: clean, violation: clean } } })).toEqual([]);
  });

  it("exits nonzero exactly when the report recorded an error", () => {
    expect(probeExitCode({ errors: [] })).toBe(0);
    expect(probeExitCode({ errors: ["get_state: no matching event within 10000ms"] })).toBe(1);
  });
});
