/**
 * Historical corpus calibration — the PURE core of the default mode of
 * `scripts/run-model-calibration.ts` (one model profile over
 * `calibration/corpus.json`). The script spawns Pi per case; everything it
 * decides about a finished run lives here: folding Pi's JSON event stream to
 * the final assistant text, parsing the (optionally fenced) findings array,
 * and the per-case result. Unrelated to the AD-11 pilot under
 * `grammar-constrained-decoding/`.
 */

export type Result<T, E> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: E }>;

const ok = <T>(value: T): Result<T, never> => Object.freeze({ ok: true as const, value });
const err = <E>(error: E): Result<never, E> => Object.freeze({ ok: false as const, error });

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export type CorpusCaseResult =
  | Readonly<{ case_id: string; status: "executed"; findings: unknown[] }>
  | Readonly<{ case_id: string; status: "not-executed"; reason: string }>;

type PiEvent = Readonly<{ type?: string; message?: Readonly<{ role?: string; content?: ReadonlyArray<Readonly<{ type?: string; text?: string }>> }> }>;

/**
 * The last non-blank assistant text of a `pi --mode json` stream, or null when
 * the run produced none. Any malformed line refuses the whole stream: a
 * dropped event could be the answer.
 */
export function finalAssistantText(stdout: string): Result<string | null, string> {
  let answer: string | null = null;
  const malformed: string[] = [];
  for (const [index, line] of stdout.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as PiEvent;
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const text = event.message.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("") ?? "";
        if (text.trim()) answer = text;
      }
    } catch (error) {
      malformed.push(`line ${index + 1}: ${message(error)}`);
    }
  }
  return malformed.length > 0
    ? err(`Pi JSON stream contained ${malformed.length} malformed line(s): ${malformed.join("; ")}`)
    : ok(answer);
}

/** The findings array of a final answer, with an optional ```json fence. */
export function parseFindings(text: string): Result<unknown[], string> {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch (error) {
    return err(message(error));
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
