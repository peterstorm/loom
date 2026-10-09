/**
 * Historical corpus calibration — the PURE core of the default mode of
 * `scripts/run-model-calibration.ts` (one model profile over
 * `calibration/corpus.json`). The script spawns Pi per case; everything it
 * decides about a finished run lives here: the final assistant text of Pi's
 * JSON event stream (folded by the shared `pi-json-stream.ts`), parsing the
 * (optionally fenced) findings array, and the per-case result. It shares only
 * the domain-free kernel and the Pi stream fold with the AD-11 pilot under
 * `grammar-constrained-decoding/`; neither core imports the other.
 */

import { err, errorMessage, ok, type Result } from "./kernel";
import { foldPiJsonStream, piContentText } from "./pi-json-stream";

export type CorpusCaseResult =
  | Readonly<{ case_id: string; status: "executed"; findings: unknown[] }>
  | Readonly<{ case_id: string; status: "not-executed"; reason: string }>;

/**
 * The last non-blank assistant text of a `pi --mode json` stream, or null when
 * the run produced none. A malformed stream is refused whole: a dropped event
 * could be the answer (`pi-json-stream.ts`).
 */
export function finalAssistantText(stdout: string): Result<string | null, string> {
  const messages = foldPiJsonStream(stdout);
  if (!messages.ok) return messages;
  const answers = messages.value
    .filter((entry) => entry["role"] === "assistant")
    .map((entry) => piContentText(entry["content"]))
    .filter((text) => text.trim());
  return ok(answers.at(-1) ?? null);
}

/** The findings array of a final answer, with an optional ```json fence. */
export function parseFindings(text: string): Result<unknown[], string> {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch (error) {
    return err(errorMessage(error));
  }
  return Array.isArray(parsed) ? ok(parsed) : err("model output was not a JSON array");
}

/** How one case's Pi run ended, as the shell observed it. */
export type CorpusRun =
  | Readonly<{ kind: "unlaunched"; reason: string }>
  | Readonly<{ kind: "exited"; status: number | null; stdout: string; stderr: string }>;

/** One case's result: executed with its findings, or not executed with the reason. */
export function corpusCaseResult(caseId: string, run: CorpusRun): CorpusCaseResult {
  const notExecuted = (reason: string): CorpusCaseResult => Object.freeze({ case_id: caseId, status: "not-executed" as const, reason });
  if (run.kind === "unlaunched") return notExecuted(run.reason);
  if (run.status !== 0) return notExecuted(run.stderr.trim() || `pi exited ${run.status}`);
  const text = finalAssistantText(run.stdout);
  if (!text.ok) return notExecuted(text.error);
  if (!text.value) return notExecuted("Pi produced no final assistant text");
  const findings = parseFindings(text.value);
  return findings.ok
    ? Object.freeze({ case_id: caseId, status: "executed" as const, findings: findings.value })
    : notExecuted(findings.error);
}
