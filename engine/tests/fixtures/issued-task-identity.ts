/**
 * The canonical issued `TaskIdentity` fixture: a request id and context digest
 * carried by the two authority markers `renderSpawnTaskText` writes, parsed
 * back through the production marker parser.
 *
 * `resolve-issuing-run.test.ts` and `claude-run-authority.test.ts` each built
 * the same marked prompt, parsed it with `parseIssuedTaskIdentity` and threw
 * unless the result was bound. One builder keeps the marker shape in one place
 * and guarantees every fixture identity is one the engine would itself accept.
 */

import { parseIssuedTaskIdentity, type TaskIdentity } from "../../src/core/spawn-task-text";

/** The authority markers `renderSpawnTaskText` writes, then the instruction body. */
export function authorityMarkedPrompt(requestId: string, contextDigest: string, body = "Review."): string {
  return `LOOM_REQUEST_ID: ${requestId}\nLOOM_CONTEXT_DIGEST: ${contextDigest}\n${body}`;
}

/** A canonical identity, parsed through the production marker parser; throws when the markers are not canonical. */
export function canonicalTaskIdentity(requestId: string, contextDigest: string): TaskIdentity {
  const parsed = parseIssuedTaskIdentity(authorityMarkedPrompt(requestId, contextDigest));
  if (parsed.kind !== "bound") throw new Error(`fixture identity is not canonical: ${JSON.stringify(parsed)}`);
  return { requestId: parsed.requestId, contextDigest: parsed.contextDigest };
}
