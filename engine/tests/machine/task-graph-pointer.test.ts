import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindSessionTaskGraphPointer,
  parseAgentId,
  parseCanonicalTaskGraphPointer,
  parseSessionId,
  parseSessionTaskGraphPointerLeaseRegistry,
  persistSessionTaskGraphPointerBinding,
  releasePersistedSessionTaskGraphPointerBinding,
  rollbackSessionTaskGraphPointer,
  TASK_GRAPH_POINTER_BINDING_SUFFIX,
  TASK_GRAPH_POINTER_LEASES_SUFFIX,
} from "../../src/machine";

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
  return {
    root,
    graphA,
    graphB,
    graphC,
    sessionId,
    pointer: join(root, `${sessionId}.task_graph`),
    registry: join(root, `${sessionId}${TASK_GRAPH_POINTER_LEASES_SUFFIX}`),
  };
}

function registry(path: string) {
  const parsed = parseSessionTaskGraphPointerLeaseRegistry(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("shared session TaskGraph pointer lease registry", () => {
  it.each([
    ["empty", ""],
    ["relative", "graph.json"],
    ["whitespace-padded", "/repo/graph.json\n"],
    ["non-normalized", "/repo/./graph.json"],
  ])("rejects %s pointer bytes at the shared parse boundary", (_label, raw) => {
    expect(parseCanonicalTaskGraphPointer(raw)).toMatchObject({ ok: false });
  });

  it("refuses malformed existing pointer bytes before acquiring a lease", async () => {
    const { root, graphA, sessionId, pointer, registry: registryPath } = fixture();
    writeFileSync(pointer, `${graphA}\n`);

    await expect(bindSessionTaskGraphPointer(sessionId, graphA, root))
      .rejects.toThrow(/TaskGraph pointer .* is malformed/i);
    expect(readFileSync(pointer, "utf8")).toBe(`${graphA}\n`);
    expect(existsSync(registryPath)).toBe(false);
  });

  it("refuses malformed live pointer bytes before releasing a lease", async () => {
    const { root, graphA, sessionId, pointer, registry: registryPath } = fixture();
    const binding = await bindSessionTaskGraphPointer(sessionId, graphA, root);
    writeFileSync(pointer, `${graphA}\n`);

    await expect(rollbackSessionTaskGraphPointer(binding))
      .rejects.toThrow(/TaskGraph pointer .* is malformed/i);
    expect(registry(registryPath).leases).toEqual([binding.leaseId]);
    expect(readFileSync(pointer, "utf8")).toBe(`${graphA}\n`);
  });

  it("atomically refreshes a stale pointer and restores it after the final lease", async () => {
    const { root, graphA, graphB, sessionId, pointer, registry: registryPath } = fixture();
    writeFileSync(pointer, graphA);

    const binding = await bindSessionTaskGraphPointer(sessionId, graphB, root);

    expect(binding).toMatchObject({ target: graphB });
    expect(readFileSync(pointer, "utf8")).toBe(graphB);
    expect(registry(registryPath)).toMatchObject({ target: graphB, previous: graphA, leases: [binding.leaseId] });
    expect(await rollbackSessionTaskGraphPointer(binding)).toBe("rolled-back");
    expect(readFileSync(pointer, "utf8")).toBe(graphA);
    expect(existsSync(registryPath)).toBe(false);
  });

  it("does not restore stale state while a same-target shared lease remains", async () => {
    const { root, graphA, graphB, sessionId, pointer, registry: registryPath } = fixture();
    writeFileSync(pointer, graphA);
    const first = await bindSessionTaskGraphPointer(sessionId, graphB, root);
    const shared = await bindSessionTaskGraphPointer(sessionId, graphB, root);

    expect(registry(registryPath).leases).toEqual([first.leaseId, shared.leaseId]);
    expect(await rollbackSessionTaskGraphPointer(first)).toBe("rolled-back");
    expect(readFileSync(pointer, "utf8")).toBe(graphB);
    expect(registry(registryPath).leases).toEqual([shared.leaseId]);

    expect(await rollbackSessionTaskGraphPointer(shared)).toBe("rolled-back");
    expect(readFileSync(pointer, "utf8")).toBe(graphA);
    expect(existsSync(registryPath)).toBe(false);
  });

  it("persists Claude cleanup authority, releases the exact final lease, and permits a new target", async () => {
    const { root, graphA, graphB, graphC, sessionId, pointer, registry: registryPath } = fixture();
    const agentId = parseAgentId("claude-agent-1");
    if (agentId === null) throw new Error("agent fixture must parse");
    writeFileSync(pointer, graphA);
    const binding = await bindSessionTaskGraphPointer(sessionId, graphB, root);
    const sidecar = join(
      root,
      `${sessionId}.${Buffer.from(agentId, "utf8").toString("hex")}${TASK_GRAPH_POINTER_BINDING_SUFFIX}`,
    );

    persistSessionTaskGraphPointerBinding(sessionId, agentId, binding);

    expect(existsSync(sidecar)).toBe(true);
    expect(await releasePersistedSessionTaskGraphPointerBinding(sessionId, agentId, root)).toBe("rolled-back");
    expect(readFileSync(pointer, "utf8")).toBe(graphA);
    expect(existsSync(registryPath)).toBe(false);
    expect(existsSync(sidecar)).toBe(false);
    expect(await releasePersistedSessionTaskGraphPointerBinding(sessionId, agentId, root)).toBe("binding-missing");

    const nextTarget = await bindSessionTaskGraphPointer(sessionId, graphC, root);
    expect(readFileSync(pointer, "utf8")).toBe(graphC);
    expect(await rollbackSessionTaskGraphPointer(nextTarget)).toBe("rolled-back");
  });

  it("fails closed on a malformed persisted cleanup sidecar without releasing its lease", async () => {
    const { root, graphA, sessionId, pointer, registry: registryPath } = fixture();
    const agentId = parseAgentId("claude-agent-malformed");
    if (agentId === null) throw new Error("agent fixture must parse");
    const binding = await bindSessionTaskGraphPointer(sessionId, graphA, root);
    persistSessionTaskGraphPointerBinding(sessionId, agentId, binding);
    const sidecar = join(
      root,
      `${sessionId}.${Buffer.from(agentId, "utf8").toString("hex")}${TASK_GRAPH_POINTER_BINDING_SUFFIX}`,
    );
    writeFileSync(sidecar, "{broken\n");

    await expect(releasePersistedSessionTaskGraphPointerBinding(sessionId, agentId, root))
      .rejects.toThrow(/malformed JSON/);
    expect(readFileSync(pointer, "utf8")).toBe(graphA);
    expect(registry(registryPath).leases).toEqual([binding.leaseId]);
  });

  it("retains persisted cleanup authority when its lease registry is missing", async () => {
    const { root, graphA, sessionId, pointer, registry: registryPath } = fixture();
    const agentId = parseAgentId("claude-agent-missing-registry");
    if (agentId === null) throw new Error("agent fixture must parse");
    const binding = await bindSessionTaskGraphPointer(sessionId, graphA, root);
    persistSessionTaskGraphPointerBinding(sessionId, agentId, binding);
    const sidecar = join(
      root,
      `${sessionId}.${Buffer.from(agentId, "utf8").toString("hex")}${TASK_GRAPH_POINTER_BINDING_SUFFIX}`,
    );
    rmSync(registryPath);

    await expect(releasePersistedSessionTaskGraphPointerBinding(sessionId, agentId, root))
      .rejects.toThrow(/no longer owns its exact lease.*retaining cleanup authority/i);
    expect(readFileSync(pointer, "utf8")).toBe(graphA);
    expect(existsSync(sidecar)).toBe(true);
  });

  it("retains persisted cleanup authority when pointer ownership is lost", async () => {
    const { root, graphA, graphB, sessionId, pointer } = fixture();
    const agentId = parseAgentId("claude-agent-2");
    if (agentId === null) throw new Error("agent fixture must parse");
    const binding = await bindSessionTaskGraphPointer(sessionId, graphA, root);
    persistSessionTaskGraphPointerBinding(sessionId, agentId, binding);
    writeFileSync(pointer, graphB);

    expect(await releasePersistedSessionTaskGraphPointerBinding(sessionId, agentId, root)).toBe("ownership-lost");
    const sidecar = join(
      root,
      `${sessionId}.${Buffer.from(agentId, "utf8").toString("hex")}${TASK_GRAPH_POINTER_BINDING_SUFFIX}`,
    );
    expect(existsSync(sidecar)).toBe(true);
  });

  it("removes only the exact lease and makes repeated release idempotent", async () => {
    const { root, graphB, sessionId, pointer } = fixture();
    const first = await bindSessionTaskGraphPointer(sessionId, graphB, root);
    const second = await bindSessionTaskGraphPointer(sessionId, graphB, root);

    expect(await rollbackSessionTaskGraphPointer(second)).toBe("rolled-back");
    expect(await rollbackSessionTaskGraphPointer(second)).toBe("not-owned");
    expect(readFileSync(pointer, "utf8")).toBe(graphB);
    expect(await rollbackSessionTaskGraphPointer(first)).toBe("rolled-back");
    expect(existsSync(pointer)).toBe(false);
  });

  it("fails closed when a different target is requested under live leases", async () => {
    const { root, graphA, graphB, sessionId, pointer } = fixture();
    const binding = await bindSessionTaskGraphPointer(sessionId, graphA, root);

    await expect(bindSessionTaskGraphPointer(sessionId, graphB, root))
      .rejects.toThrow(/live pointer lease.*refusing target/);
    expect(readFileSync(pointer, "utf8")).toBe(graphA);
    expect(await rollbackSessionTaskGraphPointer(binding)).toBe("rolled-back");
  });

  it("fails closed on a crash-state pointer/registry mismatch and preserves both", async () => {
    const { root, graphA, graphB, sessionId, pointer, registry: registryPath } = fixture();
    const binding = await bindSessionTaskGraphPointer(sessionId, graphA, root);
    const beforeRegistry = readFileSync(registryPath, "utf8");
    writeFileSync(pointer, graphB);

    await expect(bindSessionTaskGraphPointer(sessionId, graphA, root))
      .rejects.toThrow(/disagrees.*refusing crash-state recovery/);
    expect(await rollbackSessionTaskGraphPointer(binding)).toBe("ownership-lost");
    expect(readFileSync(pointer, "utf8")).toBe(graphB);
    expect(readFileSync(registryPath, "utf8")).toBe(beforeRegistry);
  });

  it("fails closed on malformed registry JSON without changing the pointer", async () => {
    const { root, graphA, graphB, sessionId, pointer, registry: registryPath } = fixture();
    writeFileSync(pointer, graphA);
    writeFileSync(registryPath, "{not-json");

    await expect(bindSessionTaskGraphPointer(sessionId, graphB, root))
      .rejects.toThrow(/registry.*malformed JSON/);
    expect(readFileSync(pointer, "utf8")).toBe(graphA);
    expect(readFileSync(registryPath, "utf8")).toBe("{not-json");
  });

  it("parses only the exact registry shape into recursively immutable state", async () => {
    const { root, graphB, sessionId, registry: registryPath } = fixture();
    const binding = await bindSessionTaskGraphPointer(sessionId, graphB, root);
    const raw = JSON.parse(readFileSync(registryPath, "utf8"));
    const parsed = parseSessionTaskGraphPointerLeaseRegistry(raw);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && Object.isFrozen(parsed.value)).toBe(true);
    expect(parsed.ok && Object.isFrozen(parsed.value.leases)).toBe(true);
    expect(parseSessionTaskGraphPointerLeaseRegistry({ ...raw, surplus: true }).ok).toBe(false);
    expect(parseSessionTaskGraphPointerLeaseRegistry({ ...raw, leases: [] }).ok).toBe(false);
    expect(parseSessionTaskGraphPointerLeaseRegistry({ ...raw, leases: [binding.leaseId, binding.leaseId] }).ok).toBe(false);
    await rollbackSessionTaskGraphPointer(binding);
  });

  it("refuses a symlink pointer instead of following or replacing it", async () => {
    const { root, graphA, graphB, sessionId, pointer } = fixture();
    symlinkSync(graphA, pointer);

    await expect(bindSessionTaskGraphPointer(sessionId, graphB, root)).rejects.toThrow();
    expect(readFileSync(graphA, "utf8")).toBe("{}\n");
  });
});
