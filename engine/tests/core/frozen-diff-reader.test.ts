import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReviewerContextPacket, encodeByteSection } from "../../src/core/context-packets";
import { parseRequestId } from "../../src/core/orchestration-contract";
import {
  FROZEN_DIFF_PAGE_UNITS, STANDALONE_FROZEN_DIFF_SECTION, freezeDiff, observeReadCoverage, readCoverageGaps,
} from "../../src/core/standalone-read-coverage";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { value } from "../fixtures/parse-result";

/**
 * The reader's --diff mode against a real v2 packet (ADR-0022): what the
 * reader prints is exactly what capture verifies, so a reviewer who runs the
 * issued command for every page is credited, and nothing else is.
 */
const script = fileURLToPath(new URL("../../../scripts/read-context-packet.ts", import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
// Quotes, backslashes and tabs are what JSON escaping inflates; a page of them must still fit one Bash output.
const HOSTILE = Array.from({ length: 4_000 }, (_, i) => `const s${i} = "\\"quoted\\" \\\\ back\\tslash";`).join("\n") + "\n";
const DIFF = freezeDiff({ baseRevision: "base", headRevision: "head", files: [
  { path: "src/big.ts", base: { kind: "absent" }, head: { kind: "text", text: HOSTILE } },
  { path: "src/small.ts", base: { kind: "text", text: "a\n" }, head: { kind: "text", text: "b\n" } },
  { path: "src/same.ts", base: { kind: "text", text: "same\n" }, head: { kind: "text", text: "same\n" } },
] });

function fixture() {
  const root = canonicalTempDir("loom-diff-reader-");
  roots.push(root);
  const source = value(encodeByteSection("standalone-frozen-source", JSON.stringify({ schemaVersion: 1, headRevision: "head", files: [] })));
  const diff = value(encodeByteSection(STANDALONE_FROZEN_DIFF_SECTION, JSON.stringify(DIFF)));
  const packet = value(buildReviewerContextPacket({ requestId: value(parseRequestId("request:diff-reader")), role: "code-reviewer",
    requiredSkill: "none", fixedContext: [source, diff], variableContext: [] }));
  const path = join(root, "packet.json");
  writeFileSync(path, JSON.stringify(packet));
  const args = ["--packet", path, "--request", packet.requestId, "--digest", packet.digest, "--role", packet.role, "--skill", "none"];
  return { packet, args };
}
const run = (args: readonly string[]) => spawnSync("bun", [script, ...args], { encoding: "utf8" });

/** Page through one file exactly as the issued task instructs, returning each raw stdout. */
function readAll(args: readonly string[], path: string): string[] {
  const outputs: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const result = run([...args, "--diff", path, "--offset", String(offset)]);
    expect(result.status, result.stderr).toBe(0);
    outputs.push(result.stdout);
    offset = (JSON.parse(result.stdout) as { nextOffset: number | null }).nextOffset;
  }
  return outputs;
}

describe("frozen diff reader pages", () => {
  it("prints pages that concatenate to the frozen diff and that capture credits in full", () => {
    const { packet, args } = fixture();
    const big = readAll(args, "src/big.ts");
    const small = readAll(args, "src/small.ts");
    const text = big.map((out) => (JSON.parse(out) as { text: string }).text).join("");
    expect(text).toBe((DIFF.files[0] as { text: string }).text);
    expect(big.length).toBe(Math.ceil(text.length / FROZEN_DIFF_PAGE_UNITS));
    const observation = observeReadCoverage(DIFF, { requestId: packet.requestId, contextDigest: packet.digest }, [...big, ...small]);
    expect(readCoverageGaps(DIFF, observation)).toEqual([]);
  });

  it("keeps every page under the 30,000-character Bash output limit even when escaping inflates it", () => {
    const { args } = fixture();
    for (const out of readAll(args, "src/big.ts")) expect(out.length).toBeLessThan(30_000);
  });

  it("bounds the page size and refuses unread-able selections", () => {
    const { args } = fixture();
    expect(run([...args, "--diff", "src/big.ts", "--limit", String(FROZEN_DIFF_PAGE_UNITS + 1)]).status).toBe(1);
    expect(run([...args, "--diff", "src/same.ts"]).status).toBe(1);
    expect(run([...args, "--diff", "src/absent.ts"]).status).toBe(1);
    expect(run([...args, "--diff", "src/big.ts", "--file", "src/big.ts"]).status).toBe(1);
    // Other selections keep their unchanged 4096-unit page.
    expect(run([...args, "--section", "standalone-frozen-source", "--limit", "4097"]).status).toBe(1);
  });

  it("indexes the frozen diff section without rendering its text", () => {
    const { args } = fixture();
    const browsed = run([...args, "--section", STANDALONE_FROZEN_DIFF_SECTION, "--limit", "4096"]);
    expect(browsed.status, browsed.stderr).toBe(0);
    const page = JSON.parse(browsed.stdout) as { text: string };
    expect(page.text).toContain("[omitted; read with --diff PATH]");
    expect(page.text).toContain("\"totalUnits\"");
    expect(page.text).not.toContain("quoted");
  });

  it("refuses --diff on a packet without a frozen diff", () => {
    const root = canonicalTempDir("loom-diff-reader-");
    roots.push(root);
    const source = value(encodeByteSection("standalone-frozen-source", JSON.stringify({ schemaVersion: 1, headRevision: "head", files: [] })));
    const packet = value(buildReviewerContextPacket({ requestId: value(parseRequestId("request:no-diff")), role: "code-reviewer",
      requiredSkill: "none", fixedContext: [source], variableContext: [] }));
    const path = join(root, "packet.json");
    writeFileSync(path, JSON.stringify(packet));
    const refused = run(["--packet", path, "--request", packet.requestId, "--digest", packet.digest, "--role", packet.role, "--skill", "none", "--diff", "src/big.ts"]);
    expect(refused.status).toBe(1);
  });
});
