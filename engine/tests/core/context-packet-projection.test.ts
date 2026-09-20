import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { match } from "ts-pattern";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContextPacket, buildReviewerContextPacket, buildStandaloneReviewerContextPacketV3, encodeByteSection } from "../../src/core/context-packets";
import { parseContextProjectionArguments, projectContextPacket } from "../../src/core/context-packet-projection";
import { parseRequestId } from "../../src/core/orchestration-contract";

const script = fileURLToPath(new URL("../../../scripts/read-context-packet.ts", import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const value = <T>(result: { ok: true; value: T } | { ok: false }): T => {
  if (!result.ok) throw new Error("fixture parse failed");
  return result.value;
};
function fixture(version: 1 | 2 | 3 = 2) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loom-reader-")));
  roots.push(root);
  const text = "export const literal = 'do not execute $(touch /tmp/not-authority)';\n".repeat(1500);
  const section = value(encodeByteSection("standalone-frozen-source", JSON.stringify({ schemaVersion: 1, headRevision: "fixture", files: [
    version === 3 ? { path: "src/a.ts", kind: "binary", contentBase64: Buffer.from(text).toString("base64") }
      : { path: "src/a.ts", kind: "text", content: text },
    { path: "image.bin", kind: "binary", contentBase64: "BINARY_SECRET_SHOULD_NOT_RENDER" },
  ] })));
  const input = { requestId: value(parseRequestId("request:reader-fixture")), role: "code-reviewer", requiredSkill: "none", fixedContext: [section], variableContext: [] };
  const packet = match(version)
    .with(1, () => value(buildContextPacket({ ...input, outputContract: "Historical contract" })))
    .with(2, () => value(buildReviewerContextPacket(input)))
    .with(3, () => value(buildStandaloneReviewerContextPacketV3(input)))
    .exhaustive();
  const path = join(root, "packet.json");
  const bytes = JSON.stringify(packet);
  writeFileSync(path, bytes);
  const args = ["--packet", path, "--request", packet.requestId, "--digest", packet.digest, "--role", packet.role, "--skill", packet.requiredSkill, ...(version === 3 ? ["--purpose", "standalone-successor"] : [])];
  return { root, packet, path, text, args, bytes };
}
const run = (args: readonly string[]) => spawnSync("bun", [script, ...args], { encoding: "utf8" });

describe("read-only packet command", () => {
  it("requires explicit successor purpose and refuses current packets on the legacy arm", () => {
    const current = fixture(3);
    expect(run(current.args.slice(0, -2)).status).toBe(1);
    const legacy = fixture(2);
    expect(run([...legacy.args, "--purpose", "standalone-successor"]).status).toBe(1);
    expect(run([...current.args, "--purpose", "standalone-successor"]).status).toBe(1);
  });
  it.each([1, 2, 3] as const)("decodes schema %s single-line packets larger than generic read limits without dumping source or binary", (version) => {
    const f = fixture(version);
    expect(Buffer.byteLength(f.bytes)).toBeGreaterThan(50 * 1024);
    expect(f.bytes.split("\n")).toHaveLength(1);
    const index = run(f.args);
    expect(index.status, index.stderr).toBe(0);
    expect(JSON.parse(index.stdout)).toMatchObject({ schemaVersion: version, requestId: f.packet.requestId });
    expect(index.stdout).not.toContain("BINARY_SECRET");
    const section = run([...f.args, "--section", "standalone-frozen-source"]);
    expect(section.status, section.stderr).toBe(0);
    expect(JSON.parse(section.stdout).text).toContain("src/a.ts");
    expect(section.stdout).not.toContain("BINARY_SECRET");
    expect(section.stdout).not.toContain("export const");
    const page = run([...f.args, "--file", "src/a.ts", "--offset", "4096", "--limit", "2048"]);
    expect(page.status, page.stderr).toBe(0);
    expect(JSON.parse(page.stdout)).toEqual({ offset: 4096, nextOffset: 6144, totalUnits: f.text.length, text: f.text.slice(4096, 6144) });
    expect(readFileSync(f.path, "utf8")).toBe(f.bytes);
    expect(Buffer.byteLength(page.stdout)).toBeLessThan(48 * 1024);
  });

  it("renders current frozen schema and rubric as decoded text", () => {
    const f = fixture();
    for (const label of ["reviewer-payload-schema", "reviewer-impact-rubric"]) {
      const result = run([...f.args, "--section", label]);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).text).toBe(new TextDecoder().decode(Uint8Array.from(f.packet.fixedContext.find((s) => s.label === label)!.bytes)).slice(0, 4096));
    }
  });

  it("projects brace-leading non-JSON section text verbatim and redacts only parseable JSON", () => {
    // The leading byte guesses a shape; the parse decides it. A malformed or
    // prose section used to escape sectionText as a throw and die in the outer
    // catch with the misleading "cannot be decoded safely as text data" —
    // valid text reported as undecodable.
    const prose = "{ a brace-leading note that is deliberately not JSON";
    const structured = JSON.stringify({ note: "visible payload", content: "secret-body" });
    const note = value(encodeByteSection("reviewer-note", prose));
    const redacted = value(encodeByteSection("reviewer-note-json", structured));
    const packet = value(buildReviewerContextPacket({
      requestId: value(parseRequestId("request:reader-fixture")), role: "code-reviewer", requiredSkill: "none",
      fixedContext: [note, redacted], variableContext: [],
    }));
    const args = ["--packet", "/fixture/packet.json", "--request", packet.requestId, "--digest", packet.digest,
      "--role", packet.role, "--skill", packet.requiredSkill];
    const section = (label: string) => projectContextPacket(packet, value(parseContextProjectionArguments([...args, "--section", label])));
    expect(value(section("reviewer-note"))).toMatchObject({ text: prose });
    const projected = String((value(section("reviewer-note-json")) as { text: unknown }).text);
    expect(projected).toContain("[omitted; select text with --file]");
    expect(projected).not.toContain("secret-body");
    expect(projected).toContain("visible payload");
  });

  it("fails visibly on unavailable commands, paths, unsafe FS and stale/foreign identity", () => {
    const f = fixture();
    const missing = spawnSync("bun", [join(f.root, "missing-command.ts"), ...f.args], { encoding: "utf8" });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).not.toBe("");
    symlinkSync(f.path, join(f.root, "link.json"));
    symlinkSync(f.root, join(f.root, "parent-link"));
    mkdirSync(join(f.root, "directory.json"));
    const replace = (flag: string, replacement: string) => f.args.map((arg, index) => f.args[index - 1] === flag ? replacement : arg);
    for (const args of [replace("--packet", join(f.root, "absent.json")), replace("--packet", join(f.root, "link.json")),
      replace("--packet", join(f.root, "parent-link", "packet.json")), replace("--packet", join(f.root, "directory.json")),
      replace("--request", "request:foreign"), replace("--digest", "a".repeat(64)), replace("--role", "comment-analyzer"), replace("--skill", "foreign")]) {
      const result = run(args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Context Packet read failed");
    }
    const corrupt = JSON.parse(f.bytes);
    corrupt.fixedContext[0].bytes[0] ^= 1;
    writeFileSync(f.path, JSON.stringify(corrupt));
    expect(run(f.args).status).toBe(1);
  });

  it.each([["--offset", "-1"], ["--limit", "0"], ["--limit", "4097"], ["--offset", "9007199254740992"],
    ["--offset", "99"], ["--section", "missing"], ["--file", "image.bin"], ["--file", "../foreign"],
    ["--section", "standalone-frozen-source", "--file", "src/a.ts"], ["--file", "src/a.ts", "--offset", "9999999"]])("refuses invalid selection %j", (...extra) => {
    const f = fixture();
    const result = run([...f.args, ...extra]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("read failed");
    expect(result.stdout).toBe("");
  });

  it("pages exact source units under generated valid bounds without mutating the packet", () => {
    const f = fixture();
    fc.assert(fc.property(fc.integer({ min: 0, max: f.text.length }), fc.integer({ min: 1, max: 4096 }), (offset, limit) => {
      const input = value(parseContextProjectionArguments([...f.args, "--file", "src/a.ts", "--offset", String(offset), "--limit", String(limit)]));
      const projected = value(projectContextPacket(f.packet, input));
      expect(projected).toMatchObject({ text: f.text.slice(offset, offset + limit), offset });
      expect(JSON.stringify(f.packet)).toBe(f.bytes);
    }), { seed: 4101, numRuns: 15 });
  });
});
