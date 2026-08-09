import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expectedPiAgentDefinition,
  renderPiAgentDefinition,
  validatePiAgentDefinitionFile,
} from "../../src/utils/render-pi-agent";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("exact Pi agent rendering", () => {
  it("preloads file-backed and command-backed declared skills", () => {
    const implementer = expectedPiAgentDefinition("code-implementer-agent", ROOT);
    expect(implementer).toContain("<!-- LOOM_PI_AGENT_ID:code-implementer-agent -->");
    expect(implementer).toContain("## Preloaded Loom Skill: code-implementer");
    expect(implementer).toContain(`${ROOT}/rules/architecture.md`);

    const specify = expectedPiAgentDefinition("specify-agent", ROOT);
    expect(specify).toContain("## Preloaded Loom Skill: specify");
    expect(specify).toContain("# Specify - Requirements Before Design");
  });

  it("is deterministic and changes for any source-body change", () => {
    const source = readFileSync(join(ROOT, "agents", "code-reviewer.md"), "utf-8");
    const expected = renderPiAgentDefinition(source, "code-reviewer", ROOT);
    expect(renderPiAgentDefinition(source, "code-reviewer", ROOT)).toBe(expected);
    expect(renderPiAgentDefinition(source + "\nchanged\n", "code-reviewer", ROOT)).not.toBe(expected);
    expect(expected).toMatch(/^loom-agent-digest: [a-f0-9]{64}$/m);
  });

  it("validates the exact file Pi executes and rejects any stale body", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-agent-definition-"));
    try {
      const path = join(dir, "code-reviewer.md");
      writeFileSync(path, expectedPiAgentDefinition("code-reviewer", ROOT));
      expect(validatePiAgentDefinitionFile(path, "code-reviewer", ROOT)).toEqual({ ok: true });
      writeFileSync(path, readFileSync(path, "utf-8") + "\nstale\n");
      expect(validatePiAgentDefinitionFile(path, "code-reviewer", ROOT)).toMatchObject({
        ok: false,
        error: expect.stringContaining("differs from active package"),
      });
      writeFileSync(path, Buffer.from([0xff, 0xfe, 0xfd]));
      expect(validatePiAgentDefinitionFile(path, "code-reviewer", ROOT)).toMatchObject({
        ok: false,
        error: expect.stringContaining("differs from active package"),
      });
      expect(validatePiAgentDefinitionFile(join(dir, "missing.md"), "code-reviewer", ROOT))
        .toMatchObject({ ok: false, error: expect.stringContaining("cannot read generated agent") });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
