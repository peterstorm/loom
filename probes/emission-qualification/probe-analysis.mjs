/**
 * FR-002 qualification probe — the PURE analysis behind `probe.mjs`: no
 * network, no process, no filesystem. The driver captures the wire; these
 * functions turn what it captured into observations, a classification and the
 * run's exit status, and are unit-tested over recorded and synthetic streams
 * (`probe-analysis.test.mjs`).
 */

/**
 * Assemble streamed tool-call arguments from OpenAI-completions SSE chunks.
 * A `data:` line that is not JSON is RECORDED, never skipped: a dropped chunk
 * can be a dropped argument fragment, so a stream with malformed chunks can
 * never read as a clean observation.
 *
 * @param {string} rawResponse
 * @returns {{ calls: { name: string | undefined, arguments: string }[], malformed: { line: number, excerpt: string, error: string }[] }}
 */
export function assembleToolCalls(rawResponse) {
  const calls = new Map();
  const malformed = [];
  for (const [index, line] of rawResponse.split("\n").entries()) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch (error) {
      malformed.push({ line: index + 1, excerpt: payload.slice(0, 120), error: String(error?.message ?? error) });
      continue;
    }
    const delta = chunk.choices?.[0]?.delta;
    for (const toolCall of delta?.tool_calls ?? []) {
      const callIndex = toolCall.index ?? 0;
      const existing = calls.get(callIndex) ?? { name: undefined, arguments: "" };
      if (toolCall.function?.name) existing.name = toolCall.function.name;
      if (typeof toolCall.function?.arguments === "string") existing.arguments += toolCall.function.arguments;
      calls.set(callIndex, existing);
    }
  }
  return { calls: [...calls.values()], malformed };
}

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A manifest detector source (`conformsDetect` / `violationDetect`) as a function. */
export const detector = (source) => new Function(`return (${source})`)();

/** Classification follows only from the observations (AD-2). Infrastructure
 *  unavailability is reported as such — never dressed in route-verdict
 *  vocabulary — and a "conformed" claim requires the emitted arguments to be
 *  schema-SHAPED (the frozen-shape skeleton), so shape garbage that merely
 *  parses as JSON cannot read as a pass. A streamed phase with malformed SSE
 *  chunks may have lost an argument fragment, so no raw-argument conclusion
 *  is drawn from it. */
export function classifyOutcome(a, v, d) {
  if (a.upstreamError !== undefined) return `INFRASTRUCTURE: upstream unreachable (${a.upstreamError}) — no route verdict recorded`;
  if (a.promptRejected !== undefined) return `prompt rejected (${a.promptRejected}) — no route verdict recorded`;
  if (!a.modelRequests) return "no-request-observed";
  if (!a.accepted) return `rejected (HTTP ${a.httpStatus}) → extraction-only`;
  if (d?.argsEmitted !== undefined && d.argsConforms === false) return "direct enforcement probe inconclusive (emitted arguments are not schema-shaped)";
  if (d?.violationEmitted === false && d.argsEmitted !== undefined) return a.strictFlag === true
    ? "CONSTRAINED: strict requested and the forced adversarial call still conforms — provider grammar enforces the tool schema"
    : "provider-enforced without strict flag — native schema enforcement";
  if (d?.violationEmitted === true) return "UNCONSTRAINED: forced adversarial call emitted the violation — provider ignores the tool schema (engine-authoritative)";
  if (d?.parseError) return `direct enforcement probe inconclusive (${d.parseError})`;
  const malformed = (a.streamMalformedChunks?.length ?? 0) + (v.streamMalformedChunks?.length ?? 0);
  if (malformed > 0) return `stream incomplete (${malformed} malformed SSE chunk(s)) — raw-argument observations inconclusive`;
  if (v.rawArgs === undefined && !v.executeObserved) return a.strictFlag === true
    ? "strict requested; no call emitted under temptation (model refused) — enforcement inconclusive"
    : "forwarded-unchanged; no call emitted under temptation — enforcement inconclusive";
  if (a.strictFlag === true && v.rawArgsViolation === false && v.rawArgsConforms !== false) return "strict requested; temptation conformed";
  if (v.rawArgsConforms === false && v.rawArgsViolation === false) return "non-conforming call emitted under temptation — shape inconclusive";
  if (a.strictFlag === true) return "strict requested; violation emitted → unconstrained (engine-authoritative)";
  if (v.rawArgsViolation === true) return "violation emitted → unconstrained (engine-authoritative)";
  return "violation inconclusive";
}

/** One phase's observations from its captured proxy records and execute-arg entries. */
export function analyzePhase(spec, { phaseRecords, phaseArgs, promptRejected }) {
  const conforms = spec.conformsDetect !== undefined ? detector(spec.conformsDetect) : null;
  const analysis = {
    modelRequests: phaseRecords.length,
    upstreamError: undefined,
    promptRejected: promptRejected ?? undefined,
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
    streamMalformedChunks: [],
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
  const stream = assembleToolCalls(record.response?.raw ?? "");
  analysis.streamMalformedChunks = stream.malformed;
  const raw = stream.calls.find((c) => c.name === spec.registeredToolName);
  if (raw) {
    try {
      const parsed = JSON.parse(raw.arguments);
      analysis.rawArgs = parsed;
      if (conforms !== null) analysis.rawArgsConforms = conforms(parsed) === true;
      analysis.rawArgsViolation = detector(spec.violationDetect)(parsed) === true;
    } catch (error) {
      analysis.rawArgsParseError = error.message;
    }
  }
  analysis.executeObserved = phaseArgs.some((entry) => entry.tool === spec.registeredToolName);
  return analysis;
}

/** Every malformed recorded stream in a report, as report errors. */
export function streamErrors(report) {
  return Object.entries(report.tools).flatMap(([tool, toolReport]) =>
    ["acceptance", "violation"].flatMap((phase) => {
      const malformed = toolReport[phase]?.streamMalformedChunks ?? [];
      return malformed.length > 0
        ? [`${tool} ${phase}: ${malformed.length} malformed SSE chunk(s) in the recorded response stream (first at line ${malformed[0].line}: ${malformed[0].error})`]
        : [];
    }));
}

/** A run that recorded any error is not a clean run: a wrapper that checks only the exit status must see it. */
export const probeExitCode = (report) => (report.errors.length > 0 ? 1 : 0);
