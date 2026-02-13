/**
 * Extract task ID from text.
 * Usage: bun cli.ts helper extract-task-id
 * Reads text from stdin, outputs task ID to stdout.
 */

import type { HookHandler } from "../../types";
import { extractTaskId } from "../../utils/extract-task-id";

const handler: HookHandler = async (stdin) => {
  const taskId = extractTaskId(stdin);
  if (taskId) {
    process.stdout.write(taskId);
  }
  return { kind: "passthrough" };
};

export default handler;
