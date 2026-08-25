import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindSessionTaskGraphPointer,
  rollbackSessionTaskGraphPointer,
} from "../../src/machine/task-graph-pointer";
import { parseSessionId } from "../../src/machine";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "loom-task-graph-pointer-"));
  roots.push(root);
  const graphA = join(root, "graph-a.json");
  const graphB = join(root, "graph-b.json");
  const graphC = join(root, "graph-c.json");
  writeFileSync(graphA, "{}\n");
  writeFileSync(graphB, "{}\n");
  writeFileSync(graphC, "{}\n");
  const sessionId = parseSessionId("019fca39-f989-7510-8e62-50dadbcad499");
  if (sessionId === null) throw new Error("session fixture must parse");
  return { root, graphA, graphB, graphC, sessionId, pointer: join(root, `${sessionId}.task_graph`) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("shared session TaskGraph pointer binder", () => {
  it("atomically refreshes a stale pointer and returns exact rollback ownership", async () => {
    const { root, graphA, graphB, sessionId, pointer } = fixture();
    writeFileSync(pointer, graphA);

    const binding = await bindSessionTaskGraphPointer(sessionId, graphB, root);

    expect(binding).toMatchObject({ kind: "owned", previous: graphA, target: graphB });
    expect(readFileSync(pointer, "utf8")).toBe(graphB);
    expect(await rollbackSessionTaskGraphPointer(binding)).toBe("rolled-back");
    expect(readFileSync(pointer, "utf8")).toBe(graphA);
  });

  it("does not claim or clean a pointer already bound to the canonical graph", async () => {
    const { root, graphB, sessionId, pointer } = fixture();
    writeFileSync(pointer, graphB);

    const binding = await bindSessionTaskGraphPointer(sessionId, graphB, root);

    expect(binding.kind).toBe("shared");
    expect(await rollbackSessionTaskGraphPointer(binding)).toBe("not-owned");
    expect(readFileSync(pointer, "utf8")).toBe(graphB);
  });

  it("never rolls back a pointer replaced after this binding", async () => {
    const { root, graphA, graphB, graphC, sessionId, pointer } = fixture();
    writeFileSync(pointer, graphA);
    const binding = await bindSessionTaskGraphPointer(sessionId, graphB, root);
    writeFileSync(pointer, graphC);

    expect(await rollbackSessionTaskGraphPointer(binding)).toBe("ownership-lost");
    expect(readFileSync(pointer, "utf8")).toBe(graphC);
  });

  it("refuses a symlink pointer instead of following or replacing it", async () => {
    const { root, graphA, graphB, sessionId, pointer } = fixture();
    symlinkSync(graphA, pointer);

    await expect(bindSessionTaskGraphPointer(sessionId, graphB, root)).rejects.toThrow();
    expect(readFileSync(graphA, "utf8")).toBe("{}\n");
  });
});
