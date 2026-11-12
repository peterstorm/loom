/**
 * The PreToolUse hook payload is parsed, never asserted: `parsePreToolUseInput`
 * is the one decoder, and a payload that is valid JSON of the wrong shape takes
 * each guard's own malformed-input direction, exactly as unparseable text does.
 */

import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import fc from "fast-check";
import {
  FAIL_CLOSED_GUARDS,
  failClosedGuard,
  parsePreToolUseInput,
  type FailClosedGuard,
} from "../../../src/handlers/pre-tool-use/pre-tool-use-input";
import blockDirectEdits from "../../../src/handlers/pre-tool-use/block-direct-edits";
import enforcePhaseTools from "../../../src/handlers/pre-tool-use/enforce-phase-tools";
import { runGuardStateFile } from "../../../src/handlers/pre-tool-use/guard-state-file";
import { runGuardSubagentAuthority } from "../../../src/handlers/pre-tool-use/guard-subagent-authority";
import validateAgentModel from "../../../src/handlers/pre-tool-use/validate-agent-model";
import validateAgentSkill from "../../../src/handlers/pre-tool-use/validate-agent-skill";
import validatePhaseOrder from "../../../src/handlers/pre-tool-use/validate-phase-order";
import validateTaskExecution from "../../../src/handlers/pre-tool-use/validate-task-execution";
import validateTemplateSubstitution from "../../../src/handlers/pre-tool-use/validate-template-substitution";
import { SUBAGENT_DIR, TASK_GRAPH_PATH } from "../../../src/config";
import { bindMachineAgent, ledgerPath, machineBindingPath, unbindMachineAgent } from "../../../src/machine/ledger";
import type { HookHandler, HookResult } from "../../../src/types";
import { notAJsonObject } from "../../fixtures/json-wire";
import { agentIdOf, agentTypeOf, sessionIdOf } from "../../fixtures/machine-identities";
import { inMemorySessionRegistry } from "../../machine/fake-session-registry";

/** The one block text every fail-closed guard gives a payload it cannot parse. */
const malformedBlock = (guard: FailClosedGuard, detail: string) =>
  ({ kind: "block", message: `${guard}: malformed hook input — failing closed: ${detail}` });
const WRONG_SHAPE_DETAIL = "expected an object with tool_name and tool_input";

/** Valid JSON that is not a PreToolUse payload: no object, no string `tool_name`, or no object `tool_input`. */
const WRONG_SHAPES: readonly unknown[] = [
  null,
  [],
  "Task",
  7,
  {},
  { tool_name: "Task" },
  { tool_input: {} },
  { tool_name: 7, tool_input: {} },
  { tool_name: "Task", tool_input: null },
  { tool_name: "Task", tool_input: "prompt" },
];

const jsonValue = fc.jsonValue();
const payload = fc.record(
  {
    tool_name: fc.string(),
    tool_input: fc.dictionary(fc.string(), jsonValue),
    session_id: fc.string(),
    tool_use_id: fc.string(),
    transcript_path: fc.string(),
    cwd: fc.string(),
    agent_id: fc.string(),
  },
  { requiredKeys: ["tool_name", "tool_input", "session_id"] },
);

describe("parsePreToolUseInput", () => {
  it("round-trips every payload through its wire form", () => {
    fc.assert(fc.property(payload, (input) => {
      expect(parsePreToolUseInput(JSON.stringify(input))).toEqual(JSON.parse(JSON.stringify(input)));
    }));
  });

  it("refuses a payload whose tool_name is not a string or whose tool_input is not an object", () => {
    const notAString = jsonValue.filter((value) => typeof value !== "string");
    const notAnObject = jsonValue.filter((value) => typeof value !== "object" || value === null);
    fc.assert(fc.property(payload, notAString, notAnObject, fc.boolean(), (input, name, toolInput, breakName) => {
      const mutated = breakName ? { ...input, tool_name: name } : { ...input, tool_input: toolInput };
      expect(parsePreToolUseInput(JSON.stringify(mutated))).toBeInstanceOf(Error);
    }));
  });

  it("refuses a payload missing either required field", () => {
    fc.assert(fc.property(payload, fc.constantFrom("tool_name" as const, "tool_input" as const), (input, field) => {
      const { [field]: _dropped, ...rest } = input;
      expect(parsePreToolUseInput(JSON.stringify(rest))).toBeInstanceOf(Error);
    }));
  });

  it("refuses every JSON value that is not an object, and unparseable text", () => {
    fc.assert(fc.property(notAJsonObject, (value) => {
      expect(parsePreToolUseInput(JSON.stringify(value))).toBeInstanceOf(Error);
    }));
    expect(parsePreToolUseInput("{not json")).toBeInstanceOf(SyntaxError);
  });
});

describe("failClosedGuard", () => {
  const guard = fc.constantFrom(...FAIL_CLOSED_GUARDS);
  const ALLOW: HookResult = { kind: "allow" };

  it("hands the decision every payload as parsePreToolUseInput reads it, with the raw payload, and returns its result", async () => {
    await fc.assert(fc.asyncProperty(guard, payload, async (name, input) => {
      const stdin = JSON.stringify(input);
      const seen: Array<readonly [unknown, string]> = [];
      const result = await failClosedGuard(name, (parsed, raw) => {
        seen.push([parsed, raw]);
        return ALLOW;
      })(stdin);
      expect(result).toEqual(ALLOW);
      expect(seen).toEqual([[parsePreToolUseInput(stdin), stdin]]);
    }));
  });

  it("blocks every payload it cannot parse, naming the guard and the parse error, and never decides", async () => {
    const undecided = (name: FailClosedGuard) => failClosedGuard(name, () => {
      throw new Error("a malformed payload reached the decision");
    });
    await fc.assert(fc.asyncProperty(guard, fc.constantFrom(...WRONG_SHAPES), async (name, shape) => {
      expect(await undecided(name)(JSON.stringify(shape))).toEqual(malformedBlock(name, WRONG_SHAPE_DETAIL));
    }));
    const unparseable = parsePreToolUseInput("{not json");
    expect(unparseable).toBeInstanceOf(SyntaxError);
    await fc.assert(fc.asyncProperty(guard, async (name) => {
      expect(await undecided(name)("{not json"))
        .toEqual(malformedBlock(name, unparseable instanceof Error ? unparseable.message : ""));
    }));
  });

  it("awaits an asynchronous decision", async () => {
    expect(await failClosedGuard("guard-state-file", async () => ALLOW)(JSON.stringify({ tool_name: "Bash", tool_input: {} })))
      .toEqual(ALLOW);
  });
});

describe("a wrong-shaped PreToolUse payload takes each guard's malformed-input direction", () => {
  /** Every fail-closed guard but validate-agent-skill, which is armed only while a TaskGraph exists (below). */
  const failClosed: Readonly<Record<Exclude<FailClosedGuard, "validate-agent-skill">, HookHandler>> = {
    "block-direct-edits": blockDirectEdits,
    "guard-state-file": (stdin) => runGuardStateFile(stdin, inMemorySessionRegistry()),
    "guard-subagent-authority": (stdin) => runGuardSubagentAuthority(stdin, () => []),
    "validate-agent-model": validateAgentModel,
    "validate-phase-order": validatePhaseOrder,
    "validate-task-execution": validateTaskExecution,
    "validate-template-substitution": validateTemplateSubstitution,
  };

  for (const name of FAIL_CLOSED_GUARDS) {
    if (name === "validate-agent-skill") continue;
    const handler = failClosed[name];
    it(`${name} blocks`, async () => {
      for (const shape of WRONG_SHAPES) {
        expect(await handler(JSON.stringify(shape), []), JSON.stringify(shape)).toEqual(malformedBlock(name, WRONG_SHAPE_DETAIL));
      }
    });
  }

  it("validate-agent-skill blocks while a TaskGraph exists", async () => {
    const created = !existsSync(TASK_GRAPH_PATH);
    if (created) {
      mkdirSync(dirname(TASK_GRAPH_PATH), { recursive: true });
      writeFileSync(TASK_GRAPH_PATH, "{}");
    }
    try {
      for (const shape of WRONG_SHAPES) {
        expect(await validateAgentSkill(JSON.stringify(shape), []), JSON.stringify(shape))
          .toEqual(malformedBlock("validate-agent-skill", WRONG_SHAPE_DETAIL));
      }
    } finally {
      if (created) rmSync(TASK_GRAPH_PATH, { force: true });
    }
  });

  describe("enforce-phase-tools", () => {
    const session = sessionIdOf(`hook-input-shape-${process.pid}-${Date.now()}`);
    const agentType = agentTypeOf("code-implementer-agent");
    const agentId = agentIdOf("a-1");

    afterAll(() => {
      for (const path of [ledgerPath(session), machineBindingPath(session), `${SUBAGENT_DIR}/${session}.active`]) {
        rmSync(path, { recursive: true, force: true });
      }
    });

    it("blocks while any machine binding exists", async () => {
      await bindMachineAgent(session, agentType, agentId);
      try {
        for (const shape of WRONG_SHAPES) {
          expect(await enforcePhaseTools(JSON.stringify(shape), []), JSON.stringify(shape)).toMatchObject({
            kind: "block",
            message: expect.stringContaining("failing closed"),
          });
        }
      } finally {
        await unbindMachineAgent(session, agentType, agentId);
      }
    });
  });
});
