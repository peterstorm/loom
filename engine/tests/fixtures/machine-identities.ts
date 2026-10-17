/**
 * Ledger identities for tests, through the production parsers. A fixture
 * identity that does not parse fails the test that named it, never a silent
 * null. Every evidence and ledger suite builds its ids here.
 */

import {
  parseAgentId,
  parseAgentType,
  parseSessionId,
  type AgentId,
  type AgentType,
  type SessionId,
} from "../../src/machine";

const parsedOrThrow = <T>(parsed: T | null, what: string, raw: string): T => {
  if (parsed === null) throw new Error(`fixture ${what} ${JSON.stringify(raw)} must parse`);
  return parsed;
};

export const sessionIdOf = (raw: string): SessionId => parsedOrThrow(parseSessionId(raw), "session id", raw);

export const agentIdOf = (raw: string): AgentId => parsedOrThrow(parseAgentId(raw), "agent id", raw);

export const agentTypeOf = (raw: string): AgentType => parsedOrThrow(parseAgentType(raw), "agent type", raw);

/** The implementation agent type every implementer-ledger suite uses. */
export const IMPLEMENTER_TYPE: AgentType = agentTypeOf("code-implementer-agent");
