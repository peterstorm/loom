/**
 * PostToolUse handler: type-diagnostics
 *
 * After an Edit/Write/MultiEdit lands on a TypeScript source, run the
 * project's incremental type check and hand the implementing model what no
 * longer typechecks, with remedies, as `additionalContext`. Advisory only:
 * the edit already landed and this hook never blocks it.
 *
 * Fail-OPEN, unlike lint-file: a diagnostic aid that cannot run is an
 * operator note, never a veto. Its own shim runs under a longer budget than
 * the 5s immediate lint tier, because a cold incremental build of a large
 * project takes tens of seconds (see handlers/type-diagnostics-runner.ts).
 *
 * The edit-to-advisory step is the core's `adviceForEdit`, shared with Pi;
 * this handler only reads Claude Code's input and renders its channels.
 */

import type { HookHandler } from "../../types";
import { passthroughResult, postToolUseContextResult } from "../../types";
import { adviceForEdit, couldNotRun, type AdviseOnEdit } from "../../core/type-diagnostics";
import { FILE_MODIFYING_TOOLS } from "../../core/tool-vocabulary";
import { typeDiagnosticsAdvisory } from "../type-diagnostics-runner";
import { extractFilePath } from "./lint-file";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function createTypeDiagnosticsHandler(advise: AdviseOnEdit): HookHandler {
  return async (stdin) => {
    if (!stdin || stdin.trim().length === 0) return passthroughResult();
    try {
      const input: unknown = JSON.parse(stdin);
      if (!isRecord(input) || typeof input.tool_name !== "string" || !FILE_MODIFYING_TOOLS.has(input.tool_name)) return passthroughResult();
      const path = extractFilePath(isRecord(input.tool_input) ? input.tool_input : undefined);
      if (path === null) return passthroughResult();

      const { forModel, forOperator } = await adviceForEdit(path, typeof input.cwd === "string" ? input.cwd : null, advise);
      const systemMessage = forOperator ?? undefined;
      return forModel === null ? passthroughResult(systemMessage) : postToolUseContextResult(forModel, systemMessage);
    } catch (error: unknown) {
      return passthroughResult(couldNotRun(error).forOperator);
    }
  };
}

const handler: HookHandler = createTypeDiagnosticsHandler((file) => typeDiagnosticsAdvisory(file));

export default handler;
