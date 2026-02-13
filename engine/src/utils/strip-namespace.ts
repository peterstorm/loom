/**
 * Strip plugin namespace prefix from agent type strings.
 * "loom:brainstorm-agent" → "brainstorm-agent"
 * "brainstorm-agent" → "brainstorm-agent" (no-op)
 */
export function stripNamespace(agentType: string): string {
  const colonIdx = agentType.indexOf(":");
  return colonIdx >= 0 ? agentType.slice(colonIdx + 1) : agentType;
}

/**
 * Extract namespace from prefixed agent type.
 * "loom:brainstorm-agent" → "loom"
 * "brainstorm-agent" → null
 */
export function extractNamespace(agentType: string): string | null {
  const colonIdx = agentType.indexOf(":");
  return colonIdx >= 0 ? agentType.slice(0, colonIdx) : null;
}
