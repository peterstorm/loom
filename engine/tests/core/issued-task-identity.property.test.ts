/**
 * The one reader of a spawned task's authority markers, `parseIssuedTaskIdentity`,
 * against the one writer, `renderSpawnTaskText`. Claude's spawn correlator and
 * SubagentStop, Pi's spawn admission, correlator and result paths, the issued
 * emission capability and the grandfathered-model rescue all read the markers
 * through it, so these properties are the marker contract for both harnesses.
 * The rescue also reads the packet path through `parseIssuedContextPath`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseContextDigest, parseRequestId } from "../../src/core/orchestration-contract/identity";
import {
  parseIssuedContextPath,
  parseIssuedTaskIdentity,
  renderSpawnTaskText,
  type SpawnTaskFacts,
  type TaskIdentity,
} from "../../src/core/spawn-task-text";
import { agentRequestAuthority } from "../fixtures/agent-request-authority";

/** Canonical identities, generated in the grammar the branded parsers accept. */
const requestIds = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,40}$/);
const contextDigests = fc.stringMatching(/^[0-9a-f]{64}$/);

/** Instruction text that makes no authority claim of its own. */
const claimFreeLine = fc.string({ maxLength: 60 })
  .map((line) => line.replaceAll("\n", " "))
  .filter((line) => !["LOOM_REQUEST_ID:", "LOOM_CONTEXT_DIGEST:", "LOOM_CONTEXT_PATH:"].some((marker) => line.startsWith(marker)));
const instructions = fc.array(claimFreeLine, { maxLength: 4 }).map((lines) => lines.join("\n"));

const factsFor = (requestId: string, contextDigest: string, instruction: string, standalone: boolean): SpawnTaskFacts => ({
  authority: agentRequestAuthority("run.issued-task-identity", { requestId, contextDigest }),
  runDirectory: "/run/dir",
  packageRoot: "/pkg",
  standalone,
  descriptor: "",
  instruction,
  reviewer: null,
  panelViewPath: null,
});

const bound = (requestId: string, contextDigest: string) => ({ kind: "bound", requestId, contextDigest });

const renderedTask = fc.record({
  requestId: requestIds,
  contextDigest: contextDigests,
  instruction: instructions,
  standalone: fc.boolean(),
}).map(({ requestId, contextDigest, instruction, standalone }) => ({
  requestId,
  contextDigest,
  text: renderSpawnTaskText(factsFor(requestId, contextDigest, instruction, standalone)),
}));

describe("parseIssuedTaskIdentity", () => {
  it("round-trips every identity renderSpawnTaskText writes", () => {
    fc.assert(fc.property(renderedTask, ({ requestId, contextDigest, text }) => {
      expect(parseIssuedTaskIdentity(text)).toEqual(bound(requestId, contextDigest));
    }));
  });

  it("keeps an identity bound when its marker lines repeat identically (a re-render or echo)", () => {
    fc.assert(fc.property(renderedTask, fc.nat({ max: 3 }), ({ requestId, contextDigest, text }, extra) => {
      const repeated = [text, ...Array.from({ length: extra + 1 }, () => text)].join("\n");
      expect(parseIssuedTaskIdentity(repeated)).toEqual(parseIssuedTaskIdentity(text));
      expect(parseIssuedTaskIdentity(repeated)).toEqual(bound(requestId, contextDigest));
    }));
  });

  it("refuses a second, different request id rather than picking either", () => {
    fc.assert(fc.property(renderedTask, requestIds, ({ requestId, text }, other) => {
      fc.pre(other !== requestId);
      for (const task of [`${text}\nLOOM_REQUEST_ID: ${other}`, `LOOM_REQUEST_ID: ${other}\n${text}`]) {
        const identity = parseIssuedTaskIdentity(task);
        expect(identity.kind).toBe("malformed");
        if (identity.kind === "malformed") expect(identity.reason).toContain("LOOM_REQUEST_ID marker is contradictory");
      }
    }));
  });

  it("refuses a second, different context digest rather than picking either", () => {
    fc.assert(fc.property(renderedTask, contextDigests, ({ contextDigest, text }, other) => {
      fc.pre(other !== contextDigest);
      const identity = parseIssuedTaskIdentity(`${text}\nLOOM_CONTEXT_DIGEST: ${other}`);
      expect(identity.kind).toBe("malformed");
      if (identity.kind === "malformed") expect(identity.reason).toContain("LOOM_CONTEXT_DIGEST marker is contradictory");
    }));
  });

  it("refuses either marker without the other", () => {
    fc.assert(fc.property(renderedTask, fc.constantFrom("LOOM_REQUEST_ID:", "LOOM_CONTEXT_DIGEST:"), ({ text }, dropped) => {
      const kept = dropped === "LOOM_REQUEST_ID:" ? "LOOM_CONTEXT_DIGEST" : "LOOM_REQUEST_ID";
      const missing = dropped === "LOOM_REQUEST_ID:" ? "LOOM_REQUEST_ID" : "LOOM_CONTEXT_DIGEST";
      const identity = parseIssuedTaskIdentity(text.split("\n").filter((line) => !line.startsWith(dropped)).join("\n"));
      expect(identity.kind).toBe("malformed");
      if (identity.kind !== "malformed") return;
      expect(identity.reason).toContain(`${missing} marker is absent`);
      expect(identity.reason).toContain(`${kept} marker names`);
    }));
  });

  it("is unbound exactly when no line claims either marker", () => {
    fc.assert(fc.property(instructions, (text) => {
      expect(parseIssuedTaskIdentity(text)).toEqual({ kind: "unbound" });
    }));
  });

  it("is total, and binds only canonical values that the text carries as exact marker lines", () => {
    const markerish = fc.oneof(
      fc.string({ maxLength: 80 }),
      fc.tuple(fc.constantFrom("LOOM_REQUEST_ID:", "LOOM_CONTEXT_DIGEST:", "LOOM_REQUEST_ID: ", "LOOM_CONTEXT_DIGEST: "),
        fc.oneof(requestIds, contextDigests, fc.string({ maxLength: 20 }))).map(([marker, value]) => `${marker}${value}`),
    );
    fc.assert(fc.property(fc.array(markerish, { maxLength: 6 }), (lines) => {
      const text = lines.join("\n");
      const identity = parseIssuedTaskIdentity(text);
      if (identity.kind !== "bound") return;
      expect(parseRequestId(identity.requestId).ok).toBe(true);
      expect(parseContextDigest(identity.contextDigest).ok).toBe(true);
      const textLines = text.split("\n");
      expect(textLines).toContain(`LOOM_REQUEST_ID: ${identity.requestId}`);
      expect(textLines).toContain(`LOOM_CONTEXT_DIGEST: ${identity.contextDigest}`);
    }));
  });

  it.each([
    ["no space after the colon", "LOOM_REQUEST_ID:req-1", "LOOM_REQUEST_ID marker is contradictory"],
    ["trailing whitespace", "LOOM_REQUEST_ID: req-1 ", "LOOM_REQUEST_ID marker is contradictory"],
    ["an empty value", "LOOM_REQUEST_ID: ", "LOOM_REQUEST_ID marker is contradictory"],
    ["a carriage return", "LOOM_REQUEST_ID: req-1\r", "LOOM_REQUEST_ID marker is contradictory"],
    ["a non-canonical request id", "LOOM_REQUEST_ID: req/1", "task LOOM_REQUEST_ID marker is not canonical"],
  ])("refuses a request marker with %s", (_label, line, reason) => {
    const identity = parseIssuedTaskIdentity(`${line}\nLOOM_CONTEXT_DIGEST: ${"c".repeat(64)}\nGo.`);
    expect(identity.kind).toBe("malformed");
    if (identity.kind === "malformed") expect(identity.reason).toContain(reason);
  });

  it("refuses a context digest that is not a lowercase SHA-256", () => {
    const identity = parseIssuedTaskIdentity(`LOOM_REQUEST_ID: req-1\nLOOM_CONTEXT_DIGEST: ${"C".repeat(64)}`);
    expect(identity).toMatchObject({ kind: "malformed", reason: expect.stringContaining("task LOOM_CONTEXT_DIGEST marker is not canonical") });
  });

  it("ignores a marker name that is not at the start of a line, or that only shares its prefix", () => {
    expect(parseIssuedTaskIdentity("see LOOM_REQUEST_ID: req-1\nLOOM_REQUEST_IDS: x\n  LOOM_CONTEXT_DIGEST: y"))
      .toEqual({ kind: "unbound" });
  });
});

describe("parseIssuedContextPath", () => {
  /** A task's bound identity, through the production parser. */
  const identityOf = (text: string): TaskIdentity => {
    const identity = parseIssuedTaskIdentity(text);
    if (identity.kind !== "bound") throw new Error(`task must be bound: ${JSON.stringify(identity)}`);
    return { requestId: identity.requestId, contextDigest: identity.contextDigest };
  };

  it("round-trips the packet path renderSpawnTaskText writes for the bound identity", () => {
    fc.assert(fc.property(renderedTask, ({ contextDigest, text }) => {
      expect(parseIssuedContextPath(text, identityOf(text)))
        .toEqual({ ok: true, value: `/run/dir/contexts/${contextDigest}.json` });
    }));
  });

  it("refuses a second, different context path rather than picking either", () => {
    fc.assert(fc.property(renderedTask, fc.stringMatching(/^\/[a-z]{1,12}$/), ({ contextDigest, text }, otherRoot) => {
      const other = `LOOM_CONTEXT_PATH: ${otherRoot}/contexts/${contextDigest}.json`;
      for (const task of [`${text}\n${other}`, `${other}\n${text}`]) {
        expect(parseIssuedContextPath(task, identityOf(text)))
          .toEqual({ ok: false, error: "task LOOM_CONTEXT_PATH marker is contradictory" });
      }
    }));
  });

  it("refuses a path to any packet other than the one the bound digest names", () => {
    fc.assert(fc.property(renderedTask, contextDigests, ({ contextDigest, text }, other) => {
      fc.pre(other !== contextDigest);
      const rebound = identityOf(text.replace(`LOOM_CONTEXT_DIGEST: ${contextDigest}`, `LOOM_CONTEXT_DIGEST: ${other}`));
      const parsed = parseIssuedContextPath(text, rebound);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain(`not the contexts/${other}.json its LOOM_CONTEXT_DIGEST binds`);
    }));
  });

  it("refuses a bound task that names no context path", () => {
    fc.assert(fc.property(renderedTask, ({ text }) => {
      const withoutPath = text.split("\n").filter((line) => !line.startsWith("LOOM_CONTEXT_PATH:")).join("\n");
      expect(parseIssuedContextPath(withoutPath, identityOf(text)))
        .toEqual({ ok: false, error: "task LOOM_CONTEXT_PATH marker is absent" });
    }));
  });
});

describe("the lint rule that keeps the markers in one module", () => {
  const rule: unknown = JSON.parse(readFileSync(
    join(__dirname, "../../../.claude/linter/rules/inv-11-one-request-marker-parser.json"), "utf8"));
  const pattern = typeof rule === "object" && rule !== null && "pattern" in rule && typeof rule.pattern === "string"
    ? new RegExp(rule.pattern) : null;
  const spellsMarker = (line: string): boolean => pattern !== null && pattern.test(line);

  it.each([
    "const REQUEST = /^LOOM_REQUEST_ID:[ \\t]*(\\S+)$/gm;",
    "const marker = taskMarker(task, \"LOOM_CONTEXT_DIGEST\");",
    "if (task.includes(`LOOM_REQUEST_ID: ${id}`)) return;",
    "const line = 'LOOM_CONTEXT_DIGEST: ' + digest;",
  ])("refuses a module that spells a marker: %s", (line) => {
    expect(spellsMarker(line)).toBe(true);
  });

  it.each([
    " * The façade places the LOOM_REQUEST_ID marker in every prompt.",
    "// LOOM_CONTEXT_DIGEST: read by parseIssuedTaskIdentity",
    "const identity = parseIssuedTaskIdentity(prompt);",
    "const path = \"LOOM_CONTEXT_PATH: \" + contextPath;",
  ])("accepts prose and other markers: %s", (line) => {
    expect(spellsMarker(line)).toBe(false);
  });
});
