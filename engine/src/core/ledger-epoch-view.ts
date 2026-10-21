/**
 * Ledger Epoch View: the read-only rendering of one epoch's facts as I6
 * numbers them, and of a session's epoch index.
 *
 * Pure module: no I/O, no clock. The shell (`scripts/ledger-epoch.ts`) reads
 * the command line and the ledger; this module decides the query and turns
 * the parsed records into lines.
 *
 * A fact's position is its 0-based index in `eventsForEpoch(records, epoch)`,
 * the same array settlement hands `judgeRedThenGreen`, so `#N` here is the
 * position I6 evidence cites. The view folds the whole ledger itself and never
 * pre-filters, reorders or deduplicates outside that fold.
 */

import { match } from "ts-pattern";
import type { DomainResult } from "./orchestration-contract/identity";
import type { TestFileResult, TestReportSummary } from "./structured-test-report";
import {
  epochOf,
  eventsForEpoch,
  parseAgentId,
  parseAgentType,
  parseSessionId,
  type SessionId,
} from "../machine/evidence";
import type { Epoch, Evidence, EvidenceRecord } from "../machine/types";

/** What the operator asked for, parsed (never raw strings). */
export type LedgerEpochQuery =
  | Readonly<{ kind: "epoch"; session: SessionId; epoch: Epoch }>
  | Readonly<{ kind: "index"; session: SessionId }>;

/** Raw command-line facts the shell read with cli-args (null = absent or flag-valued). */
export type LedgerEpochArguments = Readonly<{
  session: string | null;
  agent: string | null;
  type: string | null;
  unconsumed: readonly string[];
}>;

/** Usage text the shell prints on a usage refusal. */
export const LEDGER_EPOCH_USAGE =
  "usage: bun scripts/ledger-epoch.ts --session <session-id> [--agent <agent-id> --type <agent-type>]";

const refuse = (error: string): DomainResult<never, string> => Object.freeze({ ok: false, error });

/** A raw value through its smart constructor, refused naming the flag it came from. */
function parseFlag<T>(flag: string, raw: string, parse: (raw: string) => T | null, what: string): DomainResult<T, string> {
  const parsed = parse(raw);
  return parsed === null
    ? refuse(`${flag} ${JSON.stringify(raw)} is not a valid ${what}`)
    : Object.freeze({ ok: true, value: parsed });
}

/**
 * The query decision. Refuses, with a one-line reason the shell follows with
 * the usage text: unconsumed tokens, a missing `--session`, exactly one of
 * `--agent` / `--type`, and any id its smart constructor rejects.
 */
export function parseLedgerEpochQuery(args: LedgerEpochArguments): DomainResult<LedgerEpochQuery, string> {
  if (args.unconsumed.length > 0) return refuse(`unexpected argument(s): ${args.unconsumed.join(" ")}`);
  if (args.session === null) return refuse("--session <session-id> is required");
  if ((args.agent === null) !== (args.type === null)) return refuse("--agent and --type must be given together");

  const session = parseFlag("--session", args.session, parseSessionId, "session id");
  if (!session.ok) return session;
  if (args.agent === null || args.type === null) {
    return Object.freeze({ ok: true, value: Object.freeze({ kind: "index", session: session.value }) });
  }
  const agentId = parseFlag("--agent", args.agent, parseAgentId, "agent id");
  if (!agentId.ok) return agentId;
  const agentType = parseFlag("--type", args.type, parseAgentType, "agent type");
  if (!agentType.ok) return agentType;
  return Object.freeze({
    ok: true,
    value: Object.freeze({ kind: "epoch", session: session.value, epoch: epochOf(agentId.value, agentType.value) }),
  });
}

/** Total over every record the ledger parser admits. */
export function renderLedgerEpochView(records: readonly EvidenceRecord[], query: LedgerEpochQuery): readonly string[] {
  return match(query)
    .with({ kind: "epoch" }, ({ epoch }) => renderEpoch(records, epoch))
    .with({ kind: "index" }, () => renderEpochIndex(records))
    .exhaustive();
}

const DETAIL = "    ";
const FILE_DETAIL = "      ";

const renderFileResult = (r: TestFileResult): string =>
  `${FILE_DETAIL}${r.file}: executed ${r.executed}, failed ${r.failed}, skipped ${r.skipped}${r.collectionError ? ", collection error" : ""}`;

function renderReport(report: TestReportSummary | null): readonly string[] {
  if (report === null) return [`${DETAIL}no structured report`];
  const summary = `${DETAIL}report ${report.source}: total ${report.total}, failed ${report.failed}`;
  const files = match(report.files)
    .with({ kind: "unrecorded" }, () => [`${FILE_DETAIL}per-file results not recorded`])
    .with({ kind: "recorded" }, ({ results }) =>
      results.length === 0 ? [`${FILE_DETAIL}no per-file results`] : results.map(renderFileResult))
    .exhaustive();
  return [summary, ...files];
}

function renderFact(event: Evidence, position: number): readonly string[] {
  return match(event)
    .with({ kind: "FileWrite" }, ({ path, via }) => [`#${position} FileWrite ${path} (via ${via})`])
    .with({ kind: "FileRead" }, ({ path }) => [`#${position} FileRead ${path}`])
    .with({ kind: "TestRun" }, ({ command, exit, report }) => [
      `#${position} TestRun ${command}`,
      `${DETAIL}exit ${exit === null ? "none recorded" : exit}`,
      ...renderReport(report),
    ])
    .exhaustive();
}

/** One epoch's facts, numbered by their position in `eventsForEpoch`; an empty epoch is stated. */
export function renderEpoch(records: readonly EvidenceRecord[], epoch: Epoch): readonly string[] {
  const events = eventsForEpoch(records, epoch);
  if (events.length === 0) return [`epoch ${epoch} holds no facts`];
  return [`epoch ${epoch} — ${events.length} fact(s)`, ...events.flatMap(renderFact)];
}

/** Every epoch in first-appearance order, counted through the same fold the epoch view uses. */
export function renderEpochIndex(records: readonly EvidenceRecord[]): readonly string[] {
  const epochs = [...new Set(records.map((r) => r.epoch))];
  if (epochs.length === 0) return ["ledger holds no epochs"];
  return [
    `${epochs.length} epoch(s)`,
    ...epochs.map((epoch) => `${epoch} — ${eventsForEpoch(records, epoch).length} fact(s)`),
  ];
}
