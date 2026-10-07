/**
 * The pure spawn task text: every marker, delivery bootstrap and instruction an
 * engine-issued spawn carries, rendered from plain facts with no run directory.
 * The shell's observation and refusals are covered by spawn-admission.test.ts.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AgentRequestAuthority } from "../../src/core/orchestration-contract";
import {
  archivedReviewerInstructionPaths,
  contextPacketReaderPath,
  renderSpawnTaskText,
  requiredSkillMarker,
  type SpawnTaskFacts,
} from "../../src/core/spawn-task-text";
import { FROZEN_DIFF_PAGE_UNITS, type FrozenDiff } from "../../src/core/standalone-read-coverage";

const DIGEST = "c".repeat(64);
const authority = (overrides: Partial<AgentRequestAuthority> = {}): AgentRequestAuthority => ({
  requestId: "req-1",
  contextDigest: DIGEST,
  role: "code-reviewer",
  requiredSkill: null,
  program: "standalone-review",
  ...overrides,
}) as unknown as AgentRequestAuthority;

const facts = (overrides: Partial<SpawnTaskFacts> = {}): SpawnTaskFacts => ({
  authority: authority(),
  runDirectory: "/run/dir",
  packageRoot: "/pkg",
  standalone: false,
  descriptor: "",
  instruction: "Complete the request.",
  reviewer: null,
  panelViewPath: null,
  ...overrides,
});

describe("renderSpawnTaskText", () => {
  it("renders the shared marker block then the instruction for a plain request", () => {
    expect(renderSpawnTaskText(facts())).toBe(
      "LOOM_REQUEST_ID: req-1\n" +
      `LOOM_CONTEXT_DIGEST: ${DIGEST}\n` +
      `LOOM_CONTEXT_PATH: /run/dir/contexts/${DIGEST}.json\n` +
      "Complete the request.",
    );
  });

  it("prefixes the standalone marker and names the required Skill", () => {
    const text = renderSpawnTaskText(facts({ standalone: true, authority: authority({ requiredSkill: "distill" }) }));
    expect(text.startsWith("LOOM_REVIEW_CONTEXT: standalone\nLOOM_REQUEST_ID: req-1\n")).toBe(true);
    expect(text).toContain(requiredSkillMarker("distill"));
    expect(requiredSkillMarker(null)).toBe("");
  });

  it("delivers the spec-check section command only to the spec-check invoker", () => {
    const specCheck = renderSpawnTaskText(facts({ authority: authority({ role: "spec-check-invoker" }) }));
    expect(specCheck).toContain(
      `LOOM_CONTEXT_SECTION_COMMAND: 'bun' '/pkg/scripts/read-context-section.ts' '--packet' '/run/dir/contexts/${DIGEST}.json' '--digest' '${DIGEST}'\n`);
    expect(renderSpawnTaskText(facts())).not.toContain("LOOM_CONTEXT_SECTION_COMMAND");
  });

  it("places the descriptor before the reviewer delivery and the instruction last", () => {
    const text = renderSpawnTaskText(facts({
      descriptor: "LOOM_EMISSION_TOOL: x\n",
      reviewer: { version: 2, readObligation: null },
      instruction: "tool-primary instruction",
    }));
    const descriptor = text.indexOf("LOOM_EMISSION_TOOL: x");
    const reader = text.indexOf("LOOM_CONTEXT_READ_COMMAND:");
    expect(descriptor).toBeGreaterThan(0);
    expect(reader).toBeGreaterThan(descriptor);
    expect(text).toContain(`'bun' '${contextPacketReaderPath("/pkg")}' '--packet' '/run/dir/contexts/${DIGEST}.json' '--request' 'req-1'`);
    expect(text).toContain("'--skill' 'none'");
    expect(text).toContain("its frozen schema and rubric govern your final output.\n");
    expect(text.endsWith("tool-primary instruction")).toBe(true);
  });

  it("names the archived v1 instructions and the successor purpose by version", () => {
    const archived = archivedReviewerInstructionPaths("/pkg", "code-reviewer");
    const v1 = renderSpawnTaskText(facts({ reviewer: { version: 1, ...archived } }));
    expect(v1).toContain(`Load the archived role instructions at ${JSON.stringify(archived.rolePath)}`);
    expect(v1).toContain("This is an issued schema-1 reviewer request.");
    const v3 = renderSpawnTaskText(facts({ reviewer: { version: 3 } }));
    expect(v3).toContain("'--purpose' 'standalone-successor'");
    expect(v3).toContain("This is an explicitly issued standalone successor v3 request.");
    expect(v1).not.toContain("--purpose");
  });

  it("lists exactly the text-diff files of a read obligation with their page counts", () => {
    const diff = {
      files: [
        { kind: "text-diff", path: "src/a.ts", totalUnits: FROZEN_DIFF_PAGE_UNITS + 1 },
        { kind: "binary", path: "img.png" },
      ],
    } as unknown as FrozenDiff;
    const text = renderSpawnTaskText(facts({ reviewer: { version: 2, readObligation: diff } }));
    expect(text).toContain("LOOM_READ_COVERAGE: every-frozen-diff-unit\n");
    expect(text).toContain(`Frozen diff to read (1 file(s)):\n- src/a.ts: ${FROZEN_DIFF_PAGE_UNITS + 1} units, 2 page(s)\n`);
    expect(text).not.toContain("img.png");
    const empty = renderSpawnTaskText(facts({ reviewer: { version: 2, readObligation: { files: [] } as unknown as FrozenDiff } }));
    expect(empty).toContain("No scoped file has a text diff; there is nothing to read.\n");
  });

  it("delivers the verified panel view path to a successor panel verifier", () => {
    const text = renderSpawnTaskText(facts({ panelViewPath: "/run/dir/views/v.txt" }));
    expect(text).toContain("LOOM_CONTEXT_VIEW_PATH: /run/dir/views/v.txt\n");
    expect(renderSpawnTaskText(facts())).not.toContain("LOOM_CONTEXT_VIEW_PATH");
  });

  it("property: shell-quoted command words survive any request id and Skill text", () => {
    fc.assert(fc.property(fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 }), (requestId, skill) => {
      const text = renderSpawnTaskText(facts({
        authority: authority({ requestId: requestId as AgentRequestAuthority["requestId"], requiredSkill: skill === "" ? null : skill }),
        reviewer: { version: 2, readObligation: null },
      }));
      const quoted = `'${requestId.replaceAll("'", "'\\''")}'`;
      expect(text).toContain(`'--request' ${quoted} `);
    }), { numRuns: 100 });
  });
});
