import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { capturePiSubagentResult, piSpawnRosterId } from "../../../pi/extension";
import type { AgentRequestAuthority } from "../../src/core/orchestration-contract";
import type { RunDirHandle } from "../../src/orchestration/run-directory-handle";
import { readSessionRunBindings, registerSessionRunBinding } from "../../src/orchestration/session-run-bindings";
import { runDispatch } from "../../src/handlers/subagent-stop/dispatch";
import { fixtureSession, withFixturePiSession } from "./pi-session";

/** Scripted fixture transport only: no model execution or authored receipt. */
export async function captureNativeReview(
  repository: string,
  handle: RunDirHandle,
  request: AgentRequestAuthority,
  harness: "claude" | "pi",
  texts: readonly string[],
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
      const result = await capturePiSubagentResult(toolCallId, 0, request.role,
        [{ role: "assistant", content: texts.map((text) => ({ type: "text", text })) }], binding);
      return { captured: result.kind === "captured", diagnostic: JSON.stringify(result) };
    }
    const transcript = join(session.directory, "fixture-native-final.jsonl");
    writeFileSync(transcript, [
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
