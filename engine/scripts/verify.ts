/**
 * `npm run verify`: run the Verify Slice `LOOM_VERIFY_SLICE` names (the whole
 * command when unset) as npm scripts in order, stopping at the first failure.
 * The plan is the pure `verifySteps`; this shell only spawns it.
 */
import { spawnSync } from "node:child_process";
import { parseVerifySlice, VERIFY_SLICE_VARIABLE, verifySteps } from "../src/core/verify-slice";

const slice = parseVerifySlice(process.env[VERIFY_SLICE_VARIABLE]);
if (!slice.ok) {
  process.stderr.write(`verify: ${slice.error}\n`);
  process.exit(2);
}

// Every tier runs outside an ambient Pi session, as the per-script `env -u` did.
const { PI_CODING_AGENT: _ambientPi, ...env } = process.env;
for (const { script, args } of verifySteps(slice.value)) {
  const argv = ["run", script, ...(args.length === 0 ? [] : ["--", ...args])];
  process.stdout.write(`verify: npm ${argv.join(" ")}\n`);
  const result = spawnSync("npm", argv, { stdio: "inherit", env });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
