/**
 * The Claude Code agent-type rule (#117): Claude Code registers a plugin's
 * agents only under the plugin namespace, so a Loom Agent is spawnable there
 * exactly as `loom:<agent>`. A bare or foreign-namespaced Loom name passed the
 * spawn gates, reserved Task authority, and was then rejected by the harness,
 * stranding the Task as executing with no agent.
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_POLICIES,
  LOOM_AGENT_NAMESPACE,
  claudeAgentType,
  claudeAgentTypeRefusal,
} from "../../src/core/model-profiles";

describe("claudeAgentType", () => {
  it("names every catalog Agent under the plugin namespace", () => {
    expect(LOOM_AGENT_NAMESPACE).toBe("loom");
    for (const { agent } of AGENT_POLICIES) expect(claudeAgentType(agent)).toBe(`loom:${agent}`);
  });
});

describe("claudeAgentTypeRefusal", () => {
  it("admits exactly the plugin-namespaced name of every catalog Agent", () => {
    for (const { agent } of AGENT_POLICIES) expect(claudeAgentTypeRefusal(claudeAgentType(agent))).toBeNull();
  });

  it.each([
    ["the bare catalog name", "code-implementer-agent"],
    ["a foreign namespace", "other:code-implementer-agent"],
    ["a doubled namespace", "loom:loom:code-implementer-agent"],
  ])("refuses %s, naming the exact spawnable name", (_label, raw) => {
    const refusal = claudeAgentTypeRefusal(raw);
    expect(refusal).toContain('"loom:code-implementer-agent"');
    expect(refusal).toContain(JSON.stringify(raw));
  });

  it.each([
    ["a non-Loom agent", "general-purpose"],
    ["a foreign plugin's agent", "impeccable:impeccable-manual-edit-applier"],
    ["a non-string", undefined],
    ["a non-string number", 7],
  ])("leaves %s to the other gates", (_label, raw) => {
    expect(claudeAgentTypeRefusal(raw)).toBeNull();
  });
});
