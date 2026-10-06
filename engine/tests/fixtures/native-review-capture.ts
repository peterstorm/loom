import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { capturePiSubagentResult } from "../../../pi/review-capture";
import { piSpawnRosterId } from "../../../pi/tool-input";
import type { AgentRequestAuthority } from "../../src/core/orchestration-contract";
import type { RunDirHandle } from "../../src/orchestration/run-directory-handle";
import { readSessionRunBindings, registerSessionRunBinding } from "../../src/orchestration/session-run-bindings";
import { runDispatch } from "../../src/handlers/subagent-stop/dispatch";
import { fixtureSession, withFixturePiSession } from "./pi-session";
import { frozenDiffReaderPages } from "./read-coverage";

/** Scripted fixture transport only: no model execution or authored receipt. */
export async function captureNativeReview(
  repository: string,
  handle: RunDirHandle,
  request: AgentRequestAuthority,
  harness: "claude" | "pi",
  texts: readonly string[],
  /** The reader pages the scripted reviewer received; defaults to every frozen diff page (ADR-0022). */
  toolOutputs: readonly string[] = frozenDiffReaderPages(handle, request),
): Promise<Readonly<{ captured: boolean; diagnostic: string }>> {
  return withFixturePiSession(repository, async () => {
    const session = fixtureSession(repository);
    const toolCallId = `fixture-${request.requestId}`;
    const nativeId = harness === "pi" ? piSpawnRosterId(toolCallId, 0, request.role) : toolCallId;
    const correlation = await handle.recordHarnessCorrelator({ schemaVersion: 1, harness, nativeId,
      requestId: request.requestId, role: request.role, attempt: request.attempt });
    if (!correlation.ok) throw new Error(correlation.error.message);
    if (harness === "pi") {
      // Direct program APIs bypass the CLI publisher; use the real binding persistence API.
      const registration = await registerSessionRunBinding(session.transport, session.sessionId, {
        runId: handle.runId, runsRoot: handle.identity.runsRoot, runDirectory: handle.runDirectory,
        requestIds: [request.requestId], resultDigest: null,
      }, "pi");
      if (!registration.ok) throw new Error(registration.message);
      const bindings = readSessionRunBindings(session.transport, session.sessionId, "pi");
      if (!bindings.ok) throw new Error(bindings.message);
      const binding = bindings.value.find(({ runId, requestIds }) => runId === handle.runId && requestIds.includes(request.requestId));
      if (binding === undefined) throw new Error("production fixture session binding not published");
      const reads = toolOutputs.flatMap((text, index) => [
        { role: "assistant", content: [{ type: "toolCall", id: `read-${index}`, name: "bash", arguments: { command: "read-context-packet --diff" } }] },
        { role: "toolResult", toolCallId: `read-${index}`, toolName: "bash", isError: false, content: [{ type: "text", text }] },
      ]);
      const result = await capturePiSubagentResult(toolCallId, 0, request.role,
        [...reads, { role: "assistant", content: texts.map((text) => ({ type: "text", text })) }], binding);
      return { captured: result.kind === "captured", diagnostic: JSON.stringify(result) };
    }
    const transcript = join(session.directory, "fixture-native-final.jsonl");
    writeFileSync(transcript, [
      ...toolOutputs.flatMap((text, index) => [
        JSON.stringify({ message: { role: "assistant", content: [{ type: "tool_use", id: `read-${index}`, name: "Bash", input: { command: "read-context-packet --diff" } }] } }),
        JSON.stringify({ message: { role: "user", content: [{ type: "tool_result", tool_use_id: `read-${index}`, content: text }] } }),
      ]),
      JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "Scripted earlier narrative; MUST NOT enter final evidence." }] } }),
      JSON.stringify({ message: { role: "assistant", content: texts.map((text) => ({ type: "text", text })) } }),
    ].join("\n"));
    const environment = { LOOM_ORCHESTRATION_RUNS_ROOT: handle.identity.runsRoot, LOOM_ORCHESTRATION_RUN_DIR: handle.runDirectory };
    const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
    Object.assign(process.env, environment);
    try {
      const result = await runDispatch(JSON.stringify({ session_id: session.sessionId, agent_id: nativeId,
        agent_type: request.role, agent_transcript_path: transcript }), []);
      return { captured: result.kind === "passthrough", diagnostic: JSON.stringify(result) };
    } finally {
      for (const [key, prior] of Object.entries(previous)) {
        if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
      }
    }
  });
}
