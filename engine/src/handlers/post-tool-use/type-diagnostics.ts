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
 */

import { isAbsolute, resolve } from "node:path";
import type { HookHandler } from "../../types";
import { passthroughResult, postToolUseContextResult } from "../../types";
import type { TypeAdvisory } from "../../core/type-diagnostics";
import { FILE_MODIFYING_TOOLS } from "../../core/tool-vocabulary";
import { typeDiagnosticsAdvisory } from "../type-diagnostics-runner";
import { extractFilePath } from "./lint-file";

/** The advisory for one landed edit of an absolute file path. */
export type AdviseOnEdit = (file: string) => Promise<TypeAdvisory>;

type EditInput = Readonly<{ tool_name?: unknown; tool_input?: unknown; cwd?: unknown }>;

export function createTypeDiagnosticsHandler(advise: AdviseOnEdit): HookHandler {
  return async (stdin) => {
    if (!stdin || stdin.trim().length === 0) return passthroughResult();
    try {
      const input = JSON.parse(stdin) as EditInput;
      if (typeof input.tool_name !== "string" || !FILE_MODIFYING_TOOLS.has(input.tool_name)) return passthroughResult();
      const path = extractFilePath(input.tool_input as Record<string, unknown> | undefined);
      if (path === null) return passthroughResult();
      const file = isAbsolute(path) || typeof input.cwd !== "string" ? path : resolve(input.cwd, path);

      const { forModel, forOperator } = await advise(file);
      if (forModel !== null) return postToolUseContextResult(forModel, forOperator ?? undefined);
      return passthroughResult(forOperator ?? undefined);
    } catch (error: unknown) {
      return passthroughResult(`Loom type diagnostics could not run: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

const handler: HookHandler = createTypeDiagnosticsHandler((file) => typeDiagnosticsAdvisory(file));

export default handler;
