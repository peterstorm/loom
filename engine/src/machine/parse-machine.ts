/**
 * Parse a machine definition JSON into a MachineDef, or fail with a
 * precise error. Invalid machines are rejected before any agent runs —
 * a MachineDef that exists is structurally valid by construction.
 */

import {
  EVENT_TOKENS,
  GATE_WIRED_TOOLS,
  type EventToken,
  type MachineDef,
  type PhaseDef,
  type Requirement,
  type ParseResult,
  parseOk,
  parseErr,
} from "./types";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim() !== "");
}

function parseRequirement(v: unknown, ctx: string): ParseResult<Requirement> {
  if (!isRecord(v)) return parseErr(`${ctx}: requirement must be an object`);
  const event = v.event;
  if (typeof event !== "string" || !(EVENT_TOKENS as readonly string[]).includes(event)) {
    return parseErr(`${ctx}: event must be one of ${EVENT_TOKENS.join(", ")} (got ${JSON.stringify(event)})`);
  }
  const min = v.min ?? 1;
  if (typeof min !== "number" || !Number.isInteger(min) || min < 1) {
    return parseErr(`${ctx}: min must be a positive integer (got ${JSON.stringify(min)})`);
  }
  return parseOk({ event: event as EventToken, min });
}

function parsePhase(v: unknown, index: number, isLast: boolean): ParseResult<PhaseDef> {
  const ctx = `phases[${index}]`;
  if (!isRecord(v)) return parseErr(`${ctx}: must be an object`);

  const id = v.id;
  if (typeof id !== "string" || id.trim() === "") return parseErr(`${ctx}: id must be a non-empty string`);

  const terminal = v.terminal === true;
  if (terminal && !isLast) return parseErr(`${ctx} ("${id}"): terminal phase must be the last phase`);
  if (!terminal && isLast) return parseErr(`${ctx} ("${id}"): last phase must be terminal: true`);

  const allowedTools = v.allowedTools ?? [];
  if (!isStringArray(allowedTools)) return parseErr(`${ctx} ("${id}"): allowedTools must be an array of tool names`);

  let advance: Requirement | null = null;
  if (terminal) {
    if (v.advance !== undefined) return parseErr(`${ctx} ("${id}"): terminal phase cannot have advance`);
  } else {
    if (v.advance === undefined) return parseErr(`${ctx} ("${id}"): non-terminal phase requires advance`);
    const parsed = parseRequirement(v.advance, `${ctx} ("${id}").advance`);
    if (!parsed.ok) return parsed;
    advance = parsed.value;
  }

  const requiresRaw = v.requires ?? [];
  if (!terminal && Array.isArray(requiresRaw) && requiresRaw.length > 0) {
    return parseErr(`${ctx} ("${id}"): requires is only valid on the terminal phase`);
  }
  if (!Array.isArray(requiresRaw)) return parseErr(`${ctx} ("${id}"): requires must be an array`);
  const requires: Requirement[] = [];
  for (let i = 0; i < requiresRaw.length; i++) {
    const parsed = parseRequirement(requiresRaw[i], `${ctx} ("${id}").requires[${i}]`);
    if (!parsed.ok) return parsed;
    requires.push(parsed.value);
  }

  return parseOk({ id, allowedTools, advance, terminal, requires });
}

export function parseMachine(raw: unknown): ParseResult<MachineDef> {
  if (!isRecord(raw)) return parseErr("machine: must be a JSON object");

  const agent = raw.agent;
  if (typeof agent !== "string" || agent.trim() === "") {
    return parseErr("machine: agent must be a non-empty string");
  }

  const enforcedTools = raw.enforcedTools;
  if (!isStringArray(enforcedTools) || enforcedTools.length === 0) {
    return parseErr("machine: enforcedTools must be a non-empty array of tool names");
  }
  // Every enforced tool must be one the PreToolUse hook actually intercepts —
  // enforcing a tool the gate never sees is a guarantee that cannot be kept.
  for (const tool of enforcedTools) {
    if (!(GATE_WIRED_TOOLS as readonly string[]).includes(tool)) {
      return parseErr(
        `machine: enforcedTools contains "${tool}" — the PreToolUse gate is only wired for ${GATE_WIRED_TOOLS.join(", ")} (hooks/hooks.json)`,
      );
    }
  }

  const phasesRaw = raw.phases;
  if (!Array.isArray(phasesRaw) || phasesRaw.length < 2) {
    return parseErr("machine: phases must be an array with at least 2 phases (one working, one terminal)");
  }

  const phases: PhaseDef[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < phasesRaw.length; i++) {
    const parsed = parsePhase(phasesRaw[i], i, i === phasesRaw.length - 1);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.value.id)) return parseErr(`phases[${i}]: duplicate phase id "${parsed.value.id}"`);
    seen.add(parsed.value.id);
    phases.push(parsed.value);
  }

  // Every allowedTool must be within the machine's jurisdiction — a tool
  // listed but not enforced is a config lie the gate would silently ignore.
  const enforced = new Set(enforcedTools);
  for (const phase of phases) {
    for (const tool of phase.allowedTools) {
      if (!enforced.has(tool)) {
        return parseErr(`phase "${phase.id}": allowedTools contains "${tool}" which is not in enforcedTools`);
      }
    }
  }

  return parseOk({ agent, enforcedTools, phases });
}

export function parseMachineJson(json: string): ParseResult<MachineDef> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return parseErr(`machine: invalid JSON — ${(e as Error).message}`);
  }
  return parseMachine(raw);
}
