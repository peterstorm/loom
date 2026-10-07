import { describe, expect, it } from "vitest";
import { EMISSION_TOOL_SPECS } from "../../engine/src/core/emission-tool";
import { CELL_KEYS, PILOT_CELLS, type CellKey } from "./pilot-vocabulary";

describe("required cells", () => {
  it("are exactly the AD-11 cells, each read from the frozen registry entry its key names", () => {
    expect(Object.keys(PILOT_CELLS)).toEqual([...CELL_KEYS]);
    for (const cell of CELL_KEYS) {
      const entry = PILOT_CELLS[cell];
      expect(`${entry.kind}/${entry.version}`).toBe(cell);
      const spec = EMISSION_TOOL_SPECS[entry.kind];
      const versions: Readonly<Record<string, Readonly<{ schemaBytes: string; parsePayload: unknown }>>> = spec.schemaVersions;
      expect(entry.toolName).toBe(spec.toolName);
      expect(entry.schemaBytes).toBe(versions[entry.version]?.schemaBytes);
      expect(entry.parsePayload).toBe(versions[entry.version]?.parsePayload);
    }
  });

  it("type a cell's registry entry by its key", () => {
    const judge: "judge-verdict" = PILOT_CELLS["judge-verdict/v1"].kind;
    const v3: "v3" = PILOT_CELLS["reviewer-payload/v3"].version;
    const tool: "loom_emit_refutation_verdict" = PILOT_CELLS["refutation-verdict/v1"].toolName;
    const cell: CellKey = "reviewer-payload/v2";
    expect([judge, v3, tool, PILOT_CELLS[cell].kind]).toEqual(["judge-verdict", "v3", "loom_emit_refutation_verdict", "reviewer-payload"]);
  });
});
