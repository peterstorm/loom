/**
 * The shipped machine pins (ADR-0076): the generated module matches the
 * shipped machines byte for byte, so a machine changed without its pin fails
 * here and in CI, and the shipped directory, under any spelling, is the one
 * the pins govern.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { machineSource, SHIPPED_MACHINE_PIN_SET, SHIPPED_MACHINES_DIR } from "../../src/config";
import { loadMachine, parseAgentType, type AgentType } from "../../src/machine";
import { MACHINE_PINS_MODULE, observeMachinePins, renderShippedMachinePins } from "../../scripts/pin-machines";

const ENGINE_DIR = fileURLToPath(new URL("../..", import.meta.url));
const saved = process.env.LOOM_MACHINES_DIR;
const scratch: string[] = [];

afterEach(() => {
  if (saved === undefined) delete process.env.LOOM_MACHINES_DIR;
  else process.env.LOOM_MACHINES_DIR = saved;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-machine-pins-"));
  scratch.push(dir);
  return dir;
}

function agentType(raw: string): AgentType {
  const parsed = parseAgentType(raw);
  if (parsed === null) throw new Error(`test fixture: invalid agent type ${JSON.stringify(raw)}`);
  return parsed;
}

const shippedAgentTypes = (): readonly string[] =>
  readdirSync(SHIPPED_MACHINES_DIR)
    .filter((name) => name.endsWith(".machine.json"))
    .map((name) => name.slice(0, -".machine.json".length))
    .sort();

describe("the generated pins match the shipped machines", () => {
  it("the pin module on disk is exactly what `npm run pin-machines` would write", () => {
    const rendered = renderShippedMachinePins();
    if (!rendered.ok) throw new Error(rendered.error);
    expect(readFileSync(MACHINE_PINS_MODULE, "utf-8")).toBe(rendered.value);
  });

  it("pins exactly the shipped agent types: none missing, none extra", () => {
    expect([...SHIPPED_MACHINE_PIN_SET.keys()].sort()).toEqual(shippedAgentTypes());
  });

  it("every shipped machine loads through its pin", () => {
    delete process.env.LOOM_MACHINES_DIR;
    for (const type of shippedAgentTypes()) {
      expect(loadMachine(machineSource(), agentType(type)), type).toMatchObject({ kind: "machine", machine: { agent: type } });
    }
  });

  it("`pin-machines --check` passes on the shipped tree", () => {
    const run = spawnSync("bun", ["scripts/pin-machines.ts", "--check"], { cwd: ENGINE_DIR, encoding: "utf-8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("matches");
  });
});

describe("observeMachinePins refuses what the loader would refuse", () => {
  const machine = (agent: string): string => JSON.stringify({
    agent,
    enforcedTools: ["Edit"],
    phases: [
      { id: "a", allowedTools: [], advance: { event: "FileRead" } },
      { id: "z", terminal: true, allowedTools: ["Edit"], requires: [] },
    ],
  });

  it("pins a valid definition by the digest of its bytes", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "good-agent.machine.json"), machine("good-agent"));
    const observed = observeMachinePins(dir);
    expect(observed.ok && observed.value.map((pin) => pin.agentType)).toEqual(["good-agent"]);
  });

  it.each([
    ["a file that does not parse", "bad-agent.machine.json", "{broken"],
    ["a machine for another agent", "mismatch-agent.machine.json", machine("other-agent")],
    ["a file name that is not an agent type", "a b.machine.json", machine("a b")],
  ])("refuses %s", (_label, name, text) => {
    const dir = tempDir();
    writeFileSync(join(dir, name), text);
    expect(observeMachinePins(dir)).toMatchObject({ ok: false, error: expect.stringContaining(name) });
  });
});

describe("machineSource: which directory the pins govern", () => {
  it("the shipped directory is pinned", () => {
    delete process.env.LOOM_MACHINES_DIR;
    expect(machineSource()).toEqual({
      directory: SHIPPED_MACHINES_DIR,
      trust: { kind: "pinned", pins: SHIPPED_MACHINE_PIN_SET },
    });
  });

  it("another spelling of the shipped directory is still pinned: a symlink, a trailing segment", () => {
    const link = join(tempDir(), "machines-link");
    symlinkSync(SHIPPED_MACHINES_DIR, link);
    for (const spelling of [link, `${SHIPPED_MACHINES_DIR}/`, join(SHIPPED_MACHINES_DIR, "..", "machines")]) {
      process.env.LOOM_MACHINES_DIR = spelling;
      expect(machineSource().trust.kind, spelling).toBe("pinned");
    }
  });

  it("a directory elsewhere is the operator's own", () => {
    const dir = tempDir();
    process.env.LOOM_MACHINES_DIR = dir;
    expect(machineSource()).toEqual({ directory: dir, trust: { kind: "operator-directory" } });
  });

  it("a configured directory that does not exist is the operator's own, never the shipped one", () => {
    process.env.LOOM_MACHINES_DIR = join(tempDir(), "missing");
    expect(machineSource().trust.kind).toBe("operator-directory");
  });
});
