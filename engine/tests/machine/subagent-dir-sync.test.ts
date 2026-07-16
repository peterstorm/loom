/**
 * SUBAGENT_DIR default ↔ hook scripts sync — enforced by test, not by a
 * comment. The default `${LOOM_SUBAGENT_DIR:-/tmp/claude-subagents}` is
 * duplicated across five hook scripts and engine/src/config.ts; if one drifts,
 * a hook that shells out to spawn the guard/recorder would target a different
 * directory than the engine guards, silently FAILING OPEN (the guard/recorder
 * never sees the write). This test reads every source of that default and
 * asserts they all agree, so a drift fails the wave gate instead of the guard.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPTS_DIR = join(__dirname, "../../../hooks/scripts");
const CONFIG_PATH = join(__dirname, "../../src/config.ts");

/** The five hook scripts that hardcode the `LOOM_SUBAGENT_DIR:-<default>`. */
const HOOK_SCRIPTS = [
  "guard-state-file.sh",
  "record-evidence.sh",
  "dispatch.sh",
  "enforce-phase-tools.sh",
  "cleanup-stale-subagents.sh",
] as const;

/** Extract the `LOOM_SUBAGENT_DIR:-<default>` parameter-expansion default from a
 *  shell script body, or null when the pattern is absent (a drift in itself). */
function shellDefault(body: string): string | null {
  const m = body.match(/LOOM_SUBAGENT_DIR:-([^}"]+)}/);
  return m ? m[1] : null;
}

/** Extract config.ts's SUBAGENT_DIR default (the `?? "<default>"` fallback). */
function configDefault(body: string): string | null {
  const m = body.match(/LOOM_SUBAGENT_DIR\s*\?\?\s*"([^"]+)"/);
  return m ? m[1] : null;
}

describe("SUBAGENT_DIR default ↔ hook scripts sync", () => {
  const config = readFileSync(CONFIG_PATH, "utf-8");
  const expected = configDefault(config);

  it("config.ts declares a SUBAGENT_DIR default (the single source of truth)", () => {
    expect(
      expected,
      "config.ts no longer matches `LOOM_SUBAGENT_DIR ?? \"…\"` — update this test if the shape changed",
    ).not.toBeNull();
  });

  for (const script of HOOK_SCRIPTS) {
    it(`${script}'s LOOM_SUBAGENT_DIR default equals config.ts's SUBAGENT_DIR default`, () => {
      const body = readFileSync(join(SCRIPTS_DIR, script), "utf-8");
      const scriptDefault = shellDefault(body);
      expect(
        scriptDefault,
        `${script} no longer contains a \`\${LOOM_SUBAGENT_DIR:-…}\` default — a hook that spawns the guard/recorder would target an unguarded dir`,
      ).not.toBeNull();
      expect(
        scriptDefault,
        `${script}'s subagent-dir default "${scriptDefault}" drifted from config.ts's "${expected}" — hooks would spawn against a directory the engine does not guard (fail-open)`,
      ).toBe(expected);
    });
  }
});
