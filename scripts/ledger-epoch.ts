#!/usr/bin/env bun
/**
 * Print one epoch of a session's evidence ledger, numbered exactly as I6
 * settlement cites positions, or, without an agent, the session's epochs.
 *
 * Usage: bun scripts/ledger-epoch.ts --session <session-id> [--agent <agent-id> --type <agent-type>]
 *
 * Read-only: it locates the ledger with the engine's `ledgerPath` (which
 * follows LOOM_SUBAGENT_DIR) and reads it with `readEvidence`; it never
 * writes, truncates or creates a file or directory. The query decision and
 * the rendering are the pure core `engine/src/core/ledger-epoch-view`.
 *
 * Exit codes: 0 a rendered view (an empty epoch and a ledger with no epochs
 * included); 1 a ledger refusal (no ledger file, naming the path looked for,
 * or a corrupt or unreadable one, relaying the engine's message naming the
 * line); 2 a usage refusal, with the reason and the usage on stderr. stdout
 * stays empty on every refusal.
 */
import { existsSync } from "node:fs";
import { argumentValue, unconsumedValueArguments } from "../engine/src/handlers/helpers/cli-args";
import { ledgerPath, readEvidence } from "../engine/src/machine/ledger";
import type { EvidenceRecord } from "../engine/src/machine/types";
import { failure, success, type DomainResult } from "../engine/src/core/orchestration-contract/identity";
import {
  LEDGER_EPOCH_USAGE,
  parseLedgerEpochQuery,
  renderLedgerEpochView,
  type LedgerEpochQuery,
} from "../engine/src/core/ledger-epoch-view";

const VALUE_FLAGS: ReadonlySet<string> = new Set(["--session", "--agent", "--type"]);

/** Argv to a query, or the one-line reason followed by the usage. */
function readQuery(argv: readonly string[]): DomainResult<LedgerEpochQuery, string> {
  const query = parseLedgerEpochQuery({
    session: argumentValue(argv, "--session"),
    agent: argumentValue(argv, "--agent"),
    type: argumentValue(argv, "--type"),
    unconsumed: unconsumedValueArguments(argv, VALUE_FLAGS),
  });
  return query.ok ? query : failure(`${query.error}\n${LEDGER_EPOCH_USAGE}`);
}

/** The session's parsed records, or a refusal naming the missing path or the corrupt line. */
function readLedger(query: LedgerEpochQuery): DomainResult<readonly EvidenceRecord[], string> {
  const path = ledgerPath(query.session);
  if (!existsSync(path)) return failure(`ledger-epoch: no evidence ledger at ${path}`);
  try {
    return success(readEvidence(query.session));
  } catch (cause) {
    return failure(`ledger-epoch: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function main(argv: readonly string[]): void {
  const query = readQuery(argv);
  if (!query.ok) {
    process.stderr.write(`${query.error}\n`);
    process.exitCode = 2;
    return;
  }
  const records = readLedger(query.value);
  if (!records.ok) {
    process.stderr.write(`${records.error}\n`);
    process.exitCode = 1;
    return;
  }
  // Outside the try: a renderer defect crashes loudly instead of reading as a refusal.
  process.stdout.write(`${renderLedgerEpochView(records.value, query.value).join("\n")}\n`);
}

main(process.argv.slice(2));
