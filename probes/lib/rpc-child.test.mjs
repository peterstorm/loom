import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterAll, describe, expect, it } from "vitest";
import { makeBus, responseTo, spawnRpcChild } from "./rpc-child.mjs";

/**
 * The shared probe RPC-child seam, without Pi: the bus over a plain stream,
 * and the whole spawn/request/stderr/kill lifecycle against a fake `pi`
 * executable that speaks the same JSONL framing.
 */

const line = (event) => `${JSON.stringify(event)}\n`;
/** A synchronous stand-in for a child stdout: each write is one `data` chunk. */
const stdoutStream = () => Object.assign(new EventEmitter(), { write(text) { this.emit("data", Buffer.from(text)); } });

describe("makeBus", () => {
  it("frames strict JSONL across chunk boundaries and retains a non-JSON line as a marker", () => {
    const stdout = stdoutStream();
    const bus = makeBus(stdout);
    const event = line({ type: "response", id: "a", success: true });
    stdout.write(event.slice(0, 9));
    expect(bus.events).toEqual([]);
    stdout.write(event.slice(9) + "\n   \nnot json at all\n");
    expect(bus.events).toEqual([{ type: "response", id: "a", success: true }, { type: "__non_json__", line: "not json at all" }]);
  });

  it("resolves a wait from retained history or from a future event, and rejects naming its label at the bound", async () => {
    const stdout = stdoutStream();
    const bus = makeBus(stdout);
    stdout.write(line({ type: "response", command: "get_state" }));
    await expect(bus.waitFor(responseTo.command("get_state"), 10, "state")).resolves.toEqual({ type: "response", command: "get_state" });
    const future = bus.waitFor(responseTo.id("p1"), 1_000, "prompt");
    stdout.write(line({ type: "response", id: "p1", success: false }));
    await expect(future).resolves.toEqual({ type: "response", id: "p1", success: false });
    await expect(bus.waitFor(responseTo.id("never"), 20, "absent")).rejects.toThrow("absent: no matching event within 20ms");
  });

  it("skips retained events before `since`, so an earlier event never satisfies a later wait", async () => {
    const stdout = stdoutStream();
    const bus = makeBus(stdout);
    stdout.write(line({ type: "agent_settled", n: 1 }) + line({ type: "response", id: "p2" }));
    const settled = (e) => e.type === "agent_settled";
    await expect(bus.waitFor(settled, 20, "stale", 1)).rejects.toThrow("stale: no matching event within 20ms");
    const next = bus.waitFor(settled, 1_000, "settle", 2);
    stdout.write(line({ type: "agent_settled", n: 2 }));
    await expect(next).resolves.toEqual({ type: "agent_settled", n: 2 });
  });

  it("resolves the cursor past a matched event, from history or the future, and counts non-JSON markers", async () => {
    const stdout = stdoutStream();
    const bus = makeBus(stdout);
    expect(bus.cursor()).toBe(0);
    stdout.write("noise\n" + line({ type: "response", id: "r1" }));
    expect(bus.cursor()).toBe(2);
    await expect(bus.next(responseTo.id("r1"), 10, "history")).resolves.toEqual({ event: { type: "response", id: "r1" }, cursor: 2 });
    const future = bus.next(responseTo.id("r2"), 1_000, "future");
    stdout.write(line({ type: "agent_settled" }) + line({ type: "response", id: "r2" }));
    await expect(future).resolves.toEqual({ event: { type: "response", id: "r2" }, cursor: 4 });
  });

  it("bounds a later wait by a response's cursor even when `retain` reshapes the retained response", async () => {
    // Identity-based ordering (indexOf the waiter's full event in the
    // retained history) finds nothing here and falls back to the start, so an
    // earlier phase's settle would satisfy the wait. The cursor does not.
    const stdout = stdoutStream();
    const bus = makeBus(stdout, { retain: (e) => (e.type === "response" ? { type: "response", id: e.id, slimmed: true } : e) });
    stdout.write(line({ type: "agent_settled", n: 1 }));
    const prompted = bus.next(responseTo.id("p2"), 1_000, "prompt");
    stdout.write(line({ type: "response", id: "p2", success: true }));
    const { event, cursor } = await prompted;
    expect(event).toEqual({ type: "response", id: "p2", success: true });
    expect(bus.events.indexOf(event)).toBe(-1);
    const settled = (e) => e.type === "agent_settled";
    await expect(bus.waitFor(settled, 20, "stale", cursor)).rejects.toThrow("stale: no matching event within 20ms");
    const fresh = bus.waitFor(settled, 1_000, "settle", cursor);
    stdout.write(line({ type: "agent_settled", n: 2 }));
    await expect(fresh).resolves.toEqual({ type: "agent_settled", n: 2 });
  });

  it("retains what `retain` returns while waiters and listeners see the full event", async () => {
    const stdout = stdoutStream();
    const bus = makeBus(stdout, { retain: (e) => (e.type === "message_update" ? { type: "message_update", slimmed: true } : e) });
    const seen = [];
    const stop = bus.onEvent((e) => seen.push(e));
    const full = { type: "message_update", message: { content: "x".repeat(64) } };
    const waited = bus.waitFor((e) => e.type === "message_update", 1_000, "delta");
    stdout.write(line(full));
    await expect(waited).resolves.toEqual(full);
    expect(bus.events).toEqual([{ type: "message_update", slimmed: true }]);
    stop();
    stdout.write(line({ type: "agent_settled" }));
    expect(seen).toEqual([full]);
  });
});

describe("spawnRpcChild", () => {
  const root = mkdtempSync(path.join(tmpdir(), "loom-rpc-child-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  // A fake `pi`: refuses anything but `--mode rpc`, answers each command line
  // with a response naming its command, id and argv, and logs to stderr.
  const fakePi = path.join(root, "fake-pi");
  writeFileSync(fakePi, `#!${process.execPath}
const argv = process.argv.slice(2);
if (argv[0] !== "--mode" || argv[1] !== "rpc") { process.stderr.write("not rpc mode"); process.exit(2); }
process.stderr.write("fake pi up\\n");
let buffer = "";
process.stdin.on("data", (data) => {
  buffer += data;
  let index;
  while ((index = buffer.indexOf("\\n")) !== -1) {
    const command = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    process.stdout.write(JSON.stringify({ type: "response", command: command.type, id: command.id, success: true,
      data: { argv: argv.slice(2), probe: process.env.FAKE_PI_PROBE } }) + "\\n");
  }
});
`);
  chmodSync(fakePi, 0o755);

  it("spawns `--mode rpc` with the given arguments and environment, answers requests, captures stderr and kills only its child", async () => {
    const rpc = spawnRpcChild(["--no-session", "-ne"], { cwd: root, env: { ...process.env, FAKE_PI_PROBE: "on" }, executable: fakePi });
    const state = await rpc.request({ id: "gs1", type: "get_state" }, responseTo.command("get_state"), 10_000, "get_state");
    expect(state).toMatchObject({ id: "gs1", success: true, data: { argv: ["--no-session", "-ne"], probe: "on" } });
    rpc.send({ type: "set_auto_retry", enabled: false });
    const { response: prompt, cursor } = await rpc.exchange({ id: "p1", type: "prompt", message: "hi" }, responseTo.id("p1"), 10_000, "prompt");
    expect(prompt).toMatchObject({ command: "prompt", success: true });
    expect(cursor).toBe(3);
    expect(rpc.bus.events.map((e) => e.command)).toEqual(["get_state", "set_auto_retry", "prompt"]);
    expect(rpc.stderr()).toBe("fake pi up");
    const exited = new Promise((resolve) => rpc.child.on("exit", (_code, signal) => resolve(signal)));
    await rpc.kill(0);
    await expect(exited).resolves.toBe("SIGKILL");
  });
});
