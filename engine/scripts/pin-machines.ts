/**
 * Pin the shipped Guarded Skill Machines (ADR-0076).
 *
 * Reads every `machines/<agent-type>.machine.json` Loom ships, refuses one
 * that does not parse as a machine for the agent type its file name names, and
 * renders `engine/src/core/machine-pins.ts`: the SHA-256 of each definition's
 * exact bytes. The loader admits a shipped definition only when its bytes
 * match its pin, so a change to `machines/` takes effect once it is re-pinned:
 *
 *   cd engine && npm run pin-machines          # write the pins
 *   cd engine && npm run pin-machines -- --check  # exit 1 when they drifted
 *
 * The drift test (`tests/machine/machine-pins.test.ts`) runs the same
 * observation, so the suite fails when a machine changes without its pin.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SHIPPED_MACHINES_DIR } from "../src/config";
import { artifactDigestOfBytes } from "../src/core/digest";
import { PIN_MACHINES_COMMAND, renderMachinePinsModule, type MachinePinEntry, type MachineSource } from "../src/core/machine-integrity";
import { failure, success, type DomainResult } from "../src/core/orchestration-contract/identity";
import { loadMachine, parseAgentType } from "../src/machine";

/** The generated pin module. */
export const MACHINE_PINS_MODULE = fileURLToPath(new URL("../src/core/machine-pins.ts", import.meta.url));

const MACHINE_FILE_SUFFIX = ".machine.json";

/** The directory read as it stands: what is being pinned cannot already be judged by its pins. */
const unpinnedSource = (directory: string): MachineSource => ({ directory, trust: { kind: "operator-directory" } });

/**
 * One pin per machine definition in `directory`. A file whose name is not an
 * agent type, that does not parse as a machine, or whose `agent` differs from
 * its file name is refused: only a definition the loader would accept is pinned.
 */
export function observeMachinePins(directory: string = SHIPPED_MACHINES_DIR): DomainResult<readonly MachinePinEntry[], string> {
  const entries: MachinePinEntry[] = [];
  const names = readdirSync(directory).filter((name) => name.endsWith(MACHINE_FILE_SUFFIX)).sort();
  for (const name of names) {
    const agentType = parseAgentType(name.slice(0, -MACHINE_FILE_SUFFIX.length));
    if (agentType === null) return failure(`${name}: the file name is not an agent type`);
    const loaded = loadMachine(unpinnedSource(directory), agentType);
    if (loaded.kind !== "machine") return failure(`${name}: ${loaded.kind === "invalid" ? loaded.error : "vanished while pinning"}`);
    entries.push(Object.freeze({ agentType, digest: artifactDigestOfBytes(readFileSync(join(directory, name))) }));
  }
  return success(Object.freeze(entries));
}

/** The pin module the shipped machines render to, or why they cannot be pinned. */
export function renderShippedMachinePins(directory: string = SHIPPED_MACHINES_DIR): DomainResult<string, string> {
  const entries = observeMachinePins(directory);
  return entries.ok ? success(renderMachinePinsModule(entries.value)) : entries;
}

function readCurrentPins(): string | null {
  try {
    return readFileSync(MACHINE_PINS_MODULE, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const rendered = renderShippedMachinePins();
  if (!rendered.ok) {
    process.stderr.write(`pin-machines: refusing to pin ${SHIPPED_MACHINES_DIR}: ${rendered.error}\n`);
    process.exitCode = 2;
  } else if (readCurrentPins() === rendered.value) {
    process.stdout.write(`pin-machines: ${MACHINE_PINS_MODULE} matches ${SHIPPED_MACHINES_DIR}\n`);
  } else if (check) {
    process.stderr.write(`pin-machines: ${MACHINE_PINS_MODULE} is out of date with ${SHIPPED_MACHINES_DIR}; run \`${PIN_MACHINES_COMMAND}\`\n`);
    process.exitCode = 1;
  } else {
    writeFileSync(MACHINE_PINS_MODULE, rendered.value);
    process.stdout.write(`pin-machines: wrote ${MACHINE_PINS_MODULE}\n`);
  }
}
