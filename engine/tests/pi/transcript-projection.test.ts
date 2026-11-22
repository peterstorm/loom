/**
 * The Pi transcript projection (`piTranscriptToolCalls`) and the folds over
 * it (`piWriteTargets`, `piStructuredTestResult`): one reading of the Pi tool
 * vocabulary (`engine/src/core/harness-tool-call.ts`) for every question a
 * settlement asks of a child's transcript.
 *
 * The reference readers below are the transcript readers this projection
 * replaced, kept as test oracles only: the projection must catch every write
 * target either of them caught (security-relevant: the attributed set feeds
 * review scope and the Wave Gate lint set).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  piToolCall,
  piTranscriptTool,
  piWriteTargetPaths,
  WRITE_TARGET_KEYS,
  writeTargetPathOf,
} from "../../src/core/harness-tool-call";
import {
  piStructuredTestResult,
  piTranscriptToolCalls,
  piWriteTargets,
  type PiMessage,
  type PiTranscriptToolCall,
} from "../../../pi/transcript-adapter";

const CWD = "/repo";

type CallSpec = Readonly<{
  id: string;
  name: string;
  args: Readonly<Record<string, unknown>>;
  result: "none" | "ok" | "error";
}>;

/** A transcript of `calls`: each in its own assistant turn with its result
 *  after it, or all in one turn with the results after it (a parallel turn). */
function transcriptOf(calls: readonly CallSpec[], parallel: boolean): readonly PiMessage[] {
  const callBlock = (call: CallSpec) => ({ type: "toolCall" as const, id: call.id, name: call.name, arguments: call.args });
  const resultOf = (call: CallSpec): PiMessage[] => call.result === "none" ? [] : [{
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    isError: call.result === "error",
    content: [{ type: "text", text: `${call.name} done` }],
  }];
  return parallel
    ? [{ role: "assistant", content: calls.map(callBlock) }, ...calls.flatMap(resultOf)]
    : calls.flatMap((call): PiMessage[] => [{ role: "assistant", content: [callBlock(call)] }, ...resultOf(call)]);
}

const pathArb = fc.stringMatching(/^[a-z][a-z0-9_./-]{0,24}$/);
const keyArb = fc.constantFrom("path", "file_path", "filePath");
const resultArb = fc.constantFrom<CallSpec["result"]>("none", "ok", "error");
/** Every spelling of Pi's file tools a transcript reader has ever accepted. */
const fileToolNameArb = fc.constantFrom("write", "edit", "multi_edit", "Write", "Edit", "EDIT", "MultiEdit", "multiedit", "Multi_Edit");
const otherToolNameArb = fc.constantFrom("read", "Read", "grep", "find", "ls", "subagent", "bash", "custom_tool");

/** A file-tool call naming one target under one supported key, and the target it names. */
const fileCallArb = fc.record({ name: fileToolNameArb, key: keyArb, path: pathArb, result: resultArb });
/** A call no write target may come from, even when its input carries a path. */
const otherCallArb = fc.record({ name: otherToolNameArb, path: pathArb, result: resultArb });

type GeneratedCall =
  | Readonly<{ kind: "file"; name: string; key: string; path: string; result: CallSpec["result"] }>
  | Readonly<{ kind: "other"; name: string; path: string; result: CallSpec["result"] }>;

const callsArb = fc.array(fc.oneof(
  fileCallArb.map((call): GeneratedCall => ({ kind: "file", ...call })),
  otherCallArb.map((call): GeneratedCall => ({ kind: "other", ...call })),
), { maxLength: 12 });

const specsOf = (calls: readonly GeneratedCall[]): readonly CallSpec[] => calls.map((call, index) => ({
  id: `call-${index}`,
  name: call.name,
  args: call.kind === "file" ? { [call.key]: call.path } : { command: "ls", path: call.path },
  result: call.result,
}));

const project = (messages: readonly PiMessage[]) => piTranscriptToolCalls(messages, CWD);

// ─── The replaced readers, as oracles ─────────────────────────────────────

/** The deleted `parsePiFilesModified`: case-folded write/edit/multi_edit/multiedit, `path ?? file_path`. */
function legacyFilesModified(messages: readonly PiMessage[]): ReadonlySet<string> {
  const files = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      if (!["write", "edit", "multi_edit", "multiedit"].includes(block.name.toLowerCase())) continue;
      const path = block.arguments.path ?? block.arguments.file_path;
      if (typeof path === "string") files.add(path);
    }
  }
  return files;
}

/** The deleted `writtenPathsOf`: `write`/`Write` calls only, in order. */
function legacyWrittenPaths(messages: readonly PiMessage[]): readonly string[] {
  return messages.flatMap((message) => message.role !== "assistant" ? [] : message.content.flatMap((block) => {
    if (block.type !== "toolCall" || (block.name !== "write" && block.name !== "Write")) return [];
    const path = writeTargetPathOf(block.arguments);
    return path === null ? [] : [path];
  }));
}

const isSubsequence = (needle: readonly string[], haystack: readonly string[]): boolean => {
  let at = 0;
  for (const item of haystack) if (item === needle[at]) at += 1;
  return at === needle.length;
};

describe("piTranscriptToolCalls — the one projection", () => {
  it("projects every assistant call, in call order, through the transcript vocabulary; finished iff a result follows", () => {
    fc.assert(fc.property(callsArb, fc.boolean(), (calls, parallel) => {
      const specs = specsOf(calls);
      const projected = project(transcriptOf(specs, parallel));
      expect(projected.map((entry) => entry.kind)).toEqual(specs.map((spec) => spec.result === "none" ? "unfinished" : "finished"));
      projected.forEach((entry, index) => {
        const spec = specs[index]!;
        const request = entry.kind === "finished" ? entry.call : entry;
        expect(request.tool).toBe(piTranscriptTool(spec.name));
        expect(request.input).toEqual(spec.args);
      });
    }));
  });

  it("a finished call under Pi's own tool name is exactly what the live recorder normalizes from the same result", () => {
    fc.assert(fc.property(fc.constantFrom("read", "write", "edit", "multi_edit", "bash", "grep"), pathArb, fc.boolean(), (name, path, isError) => {
      const args = name === "bash" ? { command: `cat ${path}` } : { path };
      const content = [{ type: "text" as const, text: "output" }];
      const [entry] = project([
        { role: "assistant", content: [{ type: "toolCall", id: "c1", name, arguments: args }] },
        { role: "toolResult", toolCallId: "c1", toolName: name, isError, content },
      ]);
      expect(entry).toEqual({
        kind: "finished",
        call: piToolCall({ toolName: name, toolCallId: "c1", input: args, content, isError }, CWD),
      });
    }));
  });

  it("pairs a result only with an earlier call naming its id; a call never gets a result that precedes it", () => {
    const projected = project([
      { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [] },
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] },
      { role: "toolResult", toolCallId: "other", toolName: "bash", isError: false, content: [] },
    ]);
    expect(projected).toEqual([{ kind: "unfinished", tool: "Bash", input: { command: "ls" } }]);
  });

  it("reads no calls from user, tool-result or other roles", () => {
    expect(project([
      { role: "user", content: [{ type: "toolCall", id: "u1", name: "write", arguments: { path: "nope.ts" } }] },
      { role: "other", originalRole: "summary", content: [{ type: "toolCall", id: "o1", name: "write", arguments: { path: "nope.ts" } }] },
    ])).toEqual([]);
  });
});

describe("piWriteTargets — a fold over the projection", () => {
  it("every write/edit/multi_edit call, under any supported key, yields its target in call order — whatever its result", () => {
    fc.assert(fc.property(callsArb, fc.boolean(), (calls, parallel) => {
      const expected = calls.flatMap((call) => call.kind === "file" ? [call.path] : []);
      expect(piWriteTargets(project(transcriptOf(specsOf(calls), parallel)))).toEqual(expected);
    }));
  });

  it("depends on calls alone: dropping every result changes no target", () => {
    fc.assert(fc.property(callsArb, (calls) => {
      const specs = specsOf(calls);
      const unfinished = specs.map((spec) => ({ ...spec, result: "none" as const }));
      expect(piWriteTargets(project(transcriptOf(unfinished, false)))).toEqual(piWriteTargets(project(transcriptOf(specs, false))));
    }));
  });

  /** Inputs as adversarial as a model's tool arguments: several keys, null and
   *  non-string values, empty strings, `edits[]`. */
  const adversarialArgsArb = fc.record({
    path: fc.oneof(pathArb, fc.constant(null), fc.constant(""), fc.integer()),
    file_path: fc.oneof(pathArb, fc.constant(null), fc.constant(""), fc.integer()),
    filePath: fc.oneof(pathArb, fc.constant(null), fc.integer()),
    edits: fc.array(fc.record({ path: pathArb }), { maxLength: 3 }),
  }, { requiredKeys: [] });

  it("never misses a target either replaced reader caught (an empty-string target names no file)", () => {
    fc.assert(fc.property(
      fc.array(fc.record({ name: fc.oneof(fileToolNameArb, otherToolNameArb), args: adversarialArgsArb, result: resultArb }), { maxLength: 8 }),
      fc.boolean(),
      (raw, parallel) => {
        const messages = transcriptOf(raw.map((call, index) => ({ ...call, id: `call-${index}` })), parallel);
        const targets = piWriteTargets(project(messages));
        for (const path of legacyFilesModified(messages)) {
          if (path !== "") expect(targets).toContain(path);
        }
        expect(isSubsequence(legacyWrittenPaths(messages), targets)).toBe(true);
      },
    ));
  });

  it("reads an edits[]-only multi-edit through the write guard's vocabulary: each edit's target", () => {
    expect(piWriteTargets(project([{
      role: "assistant",
      content: [{ type: "toolCall", id: "m1", name: "multi_edit", arguments: { edits: [{ path: "a.ts" }, { file_path: "b.ts" }, { path: "a.ts" }] } }],
    }]))).toEqual(["a.ts", "b.ts"]);
  });

  it("names nothing for a call whose target cannot be proven", () => {
    expect(piWriteTargets(project([{
      role: "assistant",
      content: [
        { type: "toolCall", id: "w1", name: "write", arguments: { path: 42, file_path: "shadow.ts" } },
        { type: "toolCall", id: "w2", name: "edit", arguments: { path: "" } },
        { type: "toolCall", id: "w3", name: "write", arguments: {} },
      ],
    }]))).toEqual([]);
  });
});

describe("piStructuredTestResult — a fold over the same projection", () => {
  const testRun = (id: string, output: string, isError = false): PiMessage[] => [
    { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: "bun test" } }] },
    { role: "toolResult", toolCallId: id, toolName: "bash", isError, content: [{ type: "text", text: output }] },
  ];

  it("is unchanged by any non-Bash calls interleaved around the test run", () => {
    fc.assert(fc.property(callsArb.map((calls) => calls.filter((call) => call.name.toLowerCase() !== "bash")), fc.boolean(), (calls, isError) => {
      const run = testRun("t1", " 3 pass\n 0 fail\n", isError);
      const noise = transcriptOf(specsOf(calls), false);
      const alone = piStructuredTestResult(project(run));
      expect(piStructuredTestResult(project([...noise, ...run]))).toEqual(alone);
      expect(piStructuredTestResult(project([...run, ...noise]))).toEqual(alone);
    }));
  });

  it("takes the latest attributable run, and a killed run is a failure whose partial output is no evidence", () => {
    const killed: PiMessage[] = testRun("t2", " 3 pass\n 0 fail\nCommand timed out after 60 seconds", true);
    expect(piStructuredTestResult(project([...testRun("t1", " 3 pass\n 0 fail\n"), ...killed])))
      .toEqual({ passed: false, evidence: "" });
    expect(piStructuredTestResult(project([...killed, ...testRun("t3", " 3 pass\n 0 fail\n")])))
      .toEqual({ passed: true, evidence: "bun: 3 pass" });
  });

  it("an unfinished test call proves nothing", () => {
    const calls: readonly PiTranscriptToolCall[] = project([testRun("t1", "")[0]!]);
    expect(calls).toEqual([{ kind: "unfinished", tool: "Bash", input: { command: "bun test" } }]);
    expect(piStructuredTestResult(calls)).toBeNull();
  });
});

describe("piTranscriptTool — the transcript's reading of the Pi tool table", () => {
  it("case-folds, reads `multiedit` as multi_edit, and leaves everything else Other", () => {
    expect(["write", "Write", "EDIT", "multi_edit", "MultiEdit", "multiedit", "Bash", "read", "grep", "constructor", "multi-edit"].map(piTranscriptTool))
      .toEqual(["Write", "Write", "Edit", "MultiEdit", "MultiEdit", "MultiEdit", "Bash", "Read", "Other", "Other", "Other"]);
  });
});

describe("writeTargetPathOf — the probe order over WRITE_TARGET_KEYS", () => {
  it("a non-string winner FAILS instead of deferring to a later string key", () => {
    // `path` holds a non-nullish non-string: it wins the probe at key 1, and
    // the string test rejects it — the later `file_path` string is never
    // consulted. A defer here would silently redirect the write target the
    // guard verifies onto a path the tool did not name.
    expect(writeTargetPathOf({ path: 42, file_path: "real.md" })).toBeNull();
  });

  it("a nullish winner DEFERS to the later key, and the FIRST non-nullish string wins", () => {
    // null and undefined are the only deferring values: `null` at `path`
    // leaves the probe open, so `file_path` proves the target; a later key
    // cannot displace an earlier non-nullish one.
    expect(writeTargetPathOf({ path: null, file_path: "real.md" })).toBe("real.md");
    expect(writeTargetPathOf({ file_path: "real.md", filePath: "shadow.md" })).toBe("real.md");
  });

  it("agrees with piWriteTargetPaths on every own-target input: the two share one reading", () => {
    const keyValue = fc.option(fc.oneof(fc.string(), fc.integer(), fc.constant(null)), { nil: undefined });
    const input = fc.record({ path: keyValue, file_path: keyValue, filePath: keyValue }, { requiredKeys: [] });
    fc.assert(fc.property(input, (args) => {
      const own = writeTargetPathOf(args);
      const guarded = piWriteTargetPaths(args);
      // An input with a target key present is read by its own target alone, so
      // the guard proves exactly the path the transcript attributes, or neither does.
      if (WRITE_TARGET_KEYS.some((key) => key in args)) expect(guarded.ok ? guarded.value : null).toEqual(own === null ? null : [own]);
      else expect(own).toBeNull();
    }));
  });
});
