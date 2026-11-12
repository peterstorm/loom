/**
 * What the harness guards and the ledger make of the one command an
 * implementer runs for the Task mutation check (ADR-0071):
 * - `guard-subagent-authority` lets a subagent run it, and still refuses the
 *   same CLI aimed at a harness hook route and a shell write of the record;
 * - the State File guard lets it run;
 * - the ledger mints neither a test run nor a file write from it, whatever
 *   the helper printed, so the helper's own runner executions are never the
 *   Task's verification evidence;
 * - `mutation-check` is a helper route the CLI knows, outside the Pi runtime
 *   handshake.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderTaskMutationReport, taskMutationCommand, taskMutationResultOf, taskMutationUnavailable } from "../../src/core/task-mutation-check";
import { KNOWN_HANDLERS, PI_RUNTIME_HANDSHAKE_ROUTES } from "../../src/handler-routes";
import { observeSubagentAuthorityContext, subagentAuthorityBlock } from "../../src/handlers/pre-tool-use/guard-subagent-authority";
import { classifyTestCommand, extractEvidence } from "../../src/machine/extract-evidence";
import type { HarnessToolCall } from "../../src/machine/harness-tool-call-types";
import { taskMutationRecordPath } from "../../src/orchestration/task-mutation-record";
import { LOOM_PACKAGE_ROOT } from "../../src/utils/loom-package-root";
import { parseCanonicalRepositoryRoot, type CanonicalRepositoryRoot } from "../../src/utils/workspace-digest";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { guardDecision } from "../fixtures/guard-decision";
import { talliedResult } from "../fixtures/task-mutation";

const COMMANDS = [
  taskMutationCommand(LOOM_PACKAGE_ROOT, "T1"),
  taskMutationCommand("/home/o'brien/.claude/plugins/loom", "T12"),
  `cd /repo && ${taskMutationCommand(LOOM_PACKAGE_ROOT, "T1")}`,
];

const SURVIVORS = renderTaskMutationReport("T1", taskMutationResultOf([{
  mutant: {
    id: "m", path: "src/ledger.ts", line: 2, column: 3, start: 10, end: 40, operator: "guard-removal",
    original: "if (amount <= 0) throw new RangeError();", replacement: ";",
  },
  outcome: "survived",
}], 4));

const OUTPUTS = [
  SURVIVORS,
  renderTaskMutationReport("T1", talliedResult({ killed: 8, candidates: 20 })),
  renderTaskMutationReport("T1", talliedResult({ invalid: 8, candidates: 20 })),
  renderTaskMutationReport("T1", taskMutationUnavailable("the unmutated tests of src/ledger.ts fail ('debits' (src/ledger.test.ts))")),
];

function canonicalRoot(path: string): CanonicalRepositoryRoot {
  const parsed = parseCanonicalRepositoryRoot(path);
  if (!parsed.ok) throw new Error(`fixture root is not canonical: ${path}`);
  return parsed.value;
}

const bash = (command: string, stdout: string, exit: number): HarnessToolCall =>
  ({ tool: "Bash", input: { command }, outcome: { kind: "exited", exit, stdout }, callId: null, cwd: "/repo" });

let runtime: string;
let saved: string | undefined;

beforeEach(() => {
  runtime = canonicalTempDir("loom-mutation-check-authority-");
  saved = process.env.LOOM_SUBAGENT_DIR;
  process.env.LOOM_SUBAGENT_DIR = join(runtime, "subagents");
});

afterEach(() => {
  if (saved === undefined) delete process.env.LOOM_SUBAGENT_DIR;
  else process.env.LOOM_SUBAGENT_DIR = saved;
  rmSync(runtime, { recursive: true, force: true });
});

describe("the Task mutation check's command under the guards", () => {
  it.each(COMMANDS)("guard-subagent-authority lets an implementer run %s", (command) => {
    expect(subagentAuthorityBlock(command, observeSubagentAuthorityContext("/repo"))).toBeNull();
  });

  it("guard-subagent-authority still refuses the same CLI aimed at a hook route", () => {
    const forged = taskMutationCommand(LOOM_PACKAGE_ROOT, "T1").replace("helper mutation-check", "subagent-stop dispatch");
    expect(subagentAuthorityBlock(forged, observeSubagentAuthorityContext("/repo"))).not.toBeNull();
  });

  it("guard-subagent-authority refuses a shell write of the record itself", () => {
    const record = taskMutationRecordPath(canonicalRoot(runtime), "T1");
    expect(record.startsWith(join(runtime, "subagents"))).toBe(true);
    expect(subagentAuthorityBlock(`echo '{}' > ${record}`, observeSubagentAuthorityContext("/repo"))).not.toBeNull();
  });

  it.each(COMMANDS)("the State File guard lets %s run", (command) => {
    expect(guardDecision(command)).toBe("allow");
  });
});

describe("the Task mutation check's command in the ledger", () => {
  it.each(COMMANDS)("is not a test command: %s", (command) => {
    expect(classifyTestCommand(command)).toBeNull();
  });

  it("mints no test run and no file write, whatever the helper printed and however it exited", () => {
    for (const command of COMMANDS) {
      for (const stdout of OUTPUTS) {
        for (const exit of [0, 1]) {
          const minted = extractEvidence(bash(command, stdout, exit), () => { throw new Error("no report is looked up for a command that is no test run"); });
          expect(minted.filter(({ kind }) => kind === "TestRun" || kind === "FileWrite")).toEqual([]);
        }
      }
    }
  });
});

describe("the mutation-check route", () => {
  it("is a helper the CLI knows, and needs no Pi runtime handshake", () => {
    expect(KNOWN_HANDLERS.helper?.has("mutation-check")).toBe(true);
    expect([...PI_RUNTIME_HANDSHAKE_ROUTES].filter((route) => route.includes("mutation-check"))).toEqual([]);
  });
});
