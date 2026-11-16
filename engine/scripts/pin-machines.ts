/**
 * Pin the shipped Guarded Skill Machines (ADR-0076).
 *
 * Observes every `machines/<agent-type>.machine.json` Loom ships
 * (`observeMachinePins`, which refuses a definition the loader would not
 * accept) and renders `engine/src/core/machine-pins.ts`: the SHA-256 of each
 * definition's exact bytes. The loader admits a shipped definition only when
 * its bytes match its pin, so a change to `machines/` takes effect once it is
 * re-pinned:
 *
 *   cd engine && npm run pin-machines             # write the pins
 *   cd engine && npm run pin-machines -- --check  # exit 1 when they drifted
 *
 * Either mode exits 2, writing nothing, when a definition cannot be pinned: a
 * file name that is not an agent type, a file that does not parse as a
 * machine, or a machine whose `agent` differs from its file name.
 *
 * The drift test (`tests/machine/machine-pins.test.ts`) runs the same
 * observation, so the suite fails when a machine changes without its pin.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SHIPPED_MACHINES_DIR } from "../src/config";
import { PIN_MACHINES_COMMAND, renderMachinePinsModule } from "../src/core/machine-integrity";
import { observeMachinePins } from "../src/machine";

const MACHINE_PINS_MODULE = fileURLToPath(new URL("../src/core/machine-pins.ts", import.meta.url));

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
  const observed = observeMachinePins(SHIPPED_MACHINES_DIR);
  if (!observed.ok) {
    process.stderr.write(`pin-machines: refusing to pin ${SHIPPED_MACHINES_DIR}: ${observed.error}\n`);
    process.exitCode = 2;
  } else {
    const rendered = renderMachinePinsModule(observed.value);
    if (readCurrentPins() === rendered) {
      process.stdout.write(`pin-machines: ${MACHINE_PINS_MODULE} matches ${SHIPPED_MACHINES_DIR}\n`);
    } else if (check) {
      process.stderr.write(`pin-machines: ${MACHINE_PINS_MODULE} is out of date with ${SHIPPED_MACHINES_DIR}; run \`${PIN_MACHINES_COMMAND}\`\n`);
      process.exitCode = 1;
    } else {
      writeFileSync(MACHINE_PINS_MODULE, rendered);
      process.stdout.write(`pin-machines: wrote ${MACHINE_PINS_MODULE}\n`);
    }
  }
}
