/**
 * Claude Code's durable channel for stop-check notes (#121). SubagentStop
 * publishes one sidecar per agent beside the agent's other runtime files, and
 * the orchestrator's next Task/Agent PostToolUse drains every sidecar of its
 * session into the model's context. A foreground spawn's own note is waiting
 * when its call returns. A background spawn's PostToolUse fires at launch,
 * before its stop, so its note arrives with the next Task/Agent result
 * instead. An undelivered sidecar is swept with the other runtime files after
 * `STALE_SUBAGENT_TTL_MS`.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { subagentDir } from "./config";
import { parseStopCheckNote, type StopCheckNote } from "./core/stop-check-note";

/** Sidecar name suffix; the SessionStart sweep groups these files with their session. */
export const STOP_CHECK_NOTE_SUFFIX = ".stop-check-note.json";

/** A key as one file-name segment. "." is excluded, so it separates the session from the agent unambiguously. */
export const sidecarKey = (key: string): string => key.replace(/[^A-Za-z0-9_-]/g, "_");

const describe = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

const errnoCode = (error: unknown): unknown =>
  typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;

/** The session's prefix: every sidecar of the session, and only of it, starts with it. */
const sessionPrefix = (sessionId: string): string => `${sidecarKey(sessionId)}.`;

/** Where one agent's note waits: `<session>.<agent>` with this suffix, beside the agent's other runtime files. */
export function stopCheckNotePath(sessionId: string, agentId: string, directory: string = subagentDir()): string {
  return join(directory, `${sessionPrefix(sessionId)}${sidecarKey(agentId)}${STOP_CHECK_NOTE_SUFFIX}`);
}

export type PublishedNote = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>;

/** Keep the note for the orchestrator. Atomic: a drain never reads half a file. Total. */
export function publishStopCheckNote(
  sessionId: string,
  agentId: string,
  note: StopCheckNote,
  directory: string = subagentDir(),
): PublishedNote {
  const path = stopCheckNotePath(sessionId, agentId, directory);
  const staged = `${path}.${process.pid}.${randomUUID()}.staged`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(staged, JSON.stringify(note), { flag: "wx", mode: 0o600 });
    renameSync(staged, path);
    return { ok: true };
  } catch (error) {
    rmSync(staged, { force: true });
    return { ok: false, reason: `${path}: ${describe(error)}` };
  }
}

/** What one drain delivered, and each sidecar it could not read as a note. */
export type DrainedNotes = Readonly<{ notes: readonly StopCheckNote[]; faults: readonly string[] }>;

/**
 * Take every note the session's agents left, in name order, deleting each
 * one. A sidecar is claimed by an atomic rename before it is read, so two
 * concurrent drains never deliver the same note twice. Total: an unreadable
 * sidecar becomes a fault, and is removed so it is reported once.
 */
export function drainStopCheckNotes(sessionId: string, directory: string = subagentDir()): DrainedNotes {
  let names: readonly string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    return errnoCode(error) === "ENOENT"
      ? { notes: [], faults: [] }
      : { notes: [], faults: [`${directory}: ${describe(error)}`] };
  }
  const prefix = sessionPrefix(sessionId);
  const notes: StopCheckNote[] = [];
  const faults: string[] = [];
  for (const name of [...names].filter((entry) => entry.startsWith(prefix) && entry.endsWith(STOP_CHECK_NOTE_SUFFIX)).sort()) {
    const path = join(directory, name);
    const claimed = `${path}.${process.pid}.${randomUUID()}.claimed`;
    try {
      renameSync(path, claimed);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") faults.push(`${path}: ${describe(error)}`);
      continue; // ENOENT: a concurrent drain took it
    }
    try {
      const note = parseStopCheckNote(JSON.parse(readFileSync(claimed, "utf8")) as unknown);
      if (note === null) faults.push(`${path} holds no stop-check note`);
      else notes.push(note);
    } catch (error) {
      faults.push(`${path}: ${describe(error)}`);
    } finally {
      rmSync(claimed, { force: true });
    }
  }
  return { notes, faults };
}
