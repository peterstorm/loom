import { afterEach, describe, expect, it } from "vitest";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import fc from "fast-check";
import { match } from "ts-pattern";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync, symlinkSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Bytes } from "../../src/core/digest";
import { buildContextPacket, buildReviewerContextPacket, buildStandaloneReviewerContextPacketV3, contextPacketDigest, encodeByteSection } from "../../src/core/context-packets";
import { parseContextProjectionArguments, parseContextSectionArguments, projectContextPacket } from "../../src/core/context-packet-projection";
import { parseArtifactDigest, parseRequestId } from "../../src/core/orchestration-contract";
import { waveFrozenSource, WAVE_FROZEN_SOURCE_SECTION } from "../../src/core/wave-frozen-source";
import { observedWorkspace } from "../fixtures/reviewed-workspace";

const script = fileURLToPath(new URL("../../../scripts/read-context-packet.ts", import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const value = <T>(result: { ok: true; value: T } | { ok: false }): T => {
  if (!result.ok) throw new Error("fixture parse failed");
  return result.value;
};
function fixture(version: 1 | 2 | 3 = 2) {
  const root = canonicalTempDir("loom-reader-");
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

  it("reads exact Wave text while section browsing exposes only binary/absent metadata", () => {
    const root = canonicalTempDir("loom-wave-reader-");
    roots.push(root);
    const text = "export const dirty = 'exact workspace bytes';\n";
    const snapshot = observedWorkspace("T1", ["absent.ts", "binary.bin", "src/a.ts"], [
      { path: "src/a.ts", bytes: Buffer.from(text) },
      { path: "binary.bin", bytes: Uint8Array.from([0xff, 0x00, 0x61]) },
      { path: "absent.ts", bytes: null },
    ]);
    const source = value(encodeByteSection(WAVE_FROZEN_SOURCE_SECTION, JSON.stringify(waveFrozenSource(snapshot))));
    const packet = value(buildReviewerContextPacket({
      requestId: value(parseRequestId("request:wave-reader")), role: "code-reviewer", requiredSkill: "none",
      fixedContext: [source], variableContext: [],
    }));
    const path = join(root, "packet.json");
    writeFileSync(path, JSON.stringify(packet));
    const args = ["--packet", path, "--request", packet.requestId, "--digest", packet.digest,
      "--role", packet.role, "--skill", packet.requiredSkill];

    const section = run([...args, "--section", WAVE_FROZEN_SOURCE_SECTION]);
    expect(section.status, section.stderr).toBe(0);
    const metadata = JSON.parse(section.stdout).text as string;
    expect(metadata).toContain("binary.bin");
    expect(metadata).toContain("absent.ts");
    expect(metadata).toContain("[omitted; select text with --file]");
    expect(metadata).not.toContain("exact workspace bytes");
    expect(metadata).not.toContain(Buffer.from([0xff, 0x00, 0x61]).toString("base64"));

    const selected = run([...args, "--file", "src/a.ts"]);
    expect(selected.status, selected.stderr).toBe(0);
    expect(JSON.parse(selected.stdout).text).toBe(text);
    for (const path of ["binary.bin", "absent.ts", "foreign.ts"]) {
      const refused = run([...args, "--file", path]);
      expect(refused.status).toBe(1);
      expect(refused.stdout).toBe("");
    }
  });

  it("refuses ambiguous Wave paths and a Wave source whose bytes disagree with workspaceHeadSha", () => {
    const requestId = value(parseRequestId("request:wave-reader-ambiguity"));
    const source = observedWorkspace("T1", ["src/a.ts"], [
      { path: "src/a.ts", bytes: Buffer.from("exact") },
    ]);
    const wire = waveFrozenSource(source);
    const mutations = [
      { ...wire, files: [...wire.files, wire.files[0]!] },
      { ...wire, files: [{ ...wire.files[0]!, content: "drifted" }] },
    ];
    for (const [index, mutation] of mutations.entries()) {
      const section = value(encodeByteSection(WAVE_FROZEN_SOURCE_SECTION, JSON.stringify(mutation)));
      const packet = value(buildReviewerContextPacket({ requestId, role: "code-reviewer", requiredSkill: "none",
        fixedContext: [section], variableContext: [] }));
      const input = value(parseContextProjectionArguments([
        "--packet", "/fixture/packet.json", "--request", packet.requestId, "--digest", packet.digest,
        "--role", packet.role, "--skill", packet.requiredSkill, "--file", "src/a.ts",
      ]));
      const projected = projectContextPacket(packet, input);
      expect(projected.ok, `mutation ${index} must refuse`).toBe(false);
      if (!projected.ok) expect(projected.error).toMatch(/duplicate path|differs from its digest or length/);
    }
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

  it("attributes projection refusals to the failing operation and the selection kind", () => {
    // sfh-2: every refusal stays fail-closed, but the cause, the operation,
    // and the selection kind are now named — a --file failure is never
    // reported as a section decode problem, and triage does not need a
    // debugger.
    const requestId = value(parseRequestId("request:reader-fixture"));

    // Valid UTF-8 but not JSON: the frozen-source INDEX parse fails, not the
    // text decode.
    const nonJson = value(encodeByteSection("standalone-frozen-source", "definitely not json"));
    const v1 = value(buildContextPacket({
      requestId, role: "code-reviewer", requiredSkill: "none", outputContract: "Historical contract",
      fixedContext: [nonJson], variableContext: [],
    }));
    const fileArgs = ["--packet", "/fixture/packet.json", "--request", v1.requestId, "--digest", v1.digest,
      "--role", v1.role, "--skill", v1.requiredSkill, "--file", "src/a.ts"];
    const indexRefusal = projectContextPacket(v1, value(parseContextProjectionArguments(fileArgs)));
    expect(indexRefusal.ok).toBe(false);
    if (!indexRefusal.ok) {
      expect(indexRefusal.error).toContain("source file src/a.ts cannot be decoded safely as text data");
      expect(indexRefusal.error).toContain("frozen source index could not be parsed");
      expect(indexRefusal.error).not.toContain("selected section");
    }

    // Malformed base64 payload in a binary source file: the base64 decode
    // names itself.
    const badBase64Section = value(encodeByteSection("standalone-frozen-source", JSON.stringify({
      schemaVersion: 1, headRevision: "fixture", files: [{ path: "src/bad.ts", kind: "binary", contentBase64: "!!!" }],
    })));
    const v3 = value(buildStandaloneReviewerContextPacketV3({
      requestId, role: "code-reviewer", requiredSkill: "none", fixedContext: [badBase64Section], variableContext: [],
    }));
    const base64Refusal = projectContextPacket(v3, value(parseContextProjectionArguments([
      "--packet", "/fixture/packet.json", "--request", v3.requestId, "--digest", v3.digest,
      "--role", v3.role, "--skill", v3.requiredSkill, "--purpose", "standalone-successor", "--file", "src/bad.ts",
    ])));
    expect(base64Refusal).toMatchObject({ ok: false });
    if (!base64Refusal.ok) {
      expect(base64Refusal.error).toContain("base64 payload");
      expect(base64Refusal.error).toContain("source file src/bad.ts");
    }

    // Section bytes that are not valid UTF-8: the fatal text decode reaches
    // the outer catch, which now carries the bounded cause and names the
    // section.
    const hostileBytes = [0xff, 0xfe];
    const hostileDigest = value(parseArtifactDigest(sha256Bytes(Uint8Array.from(hostileBytes))));
    const identity = {
      schemaVersion: 1 as const,
      requestId,
      role: "code-reviewer",
      requiredSkill: "none",
      outputContract: "Historical contract",
      fixedContext: [{ label: "hostile-utf8", bytes: hostileBytes, digest: hostileDigest, byteLength: 2 }],
      variableContext: [],
    } as const;
    // The digest helper is typed over the PARSED packet shape; the fixture is
    // deliberately the untrusted wire form, whose branded fields exist only
    // after parsing.
    const identityForDigest = identity as unknown as Parameters<typeof contextPacketDigest>[0];
    const hostile = { ...identity, digest: contextPacketDigest(identityForDigest) };
    const sectionRefusal = projectContextPacket(hostile, value(parseContextProjectionArguments([
      "--packet", "/fixture/packet.json", "--request", identity.requestId, "--digest", hostile.digest,
      "--role", identity.role, "--skill", identity.requiredSkill, "--section", "hostile-utf8",
    ])));
    expect(sectionRefusal).toMatchObject({ ok: false });
    if (!sectionRefusal.ok) {
      expect(sectionRefusal.error).toContain("selected section hostile-utf8 cannot be decoded safely as text data (");
      expect(sectionRefusal.error).toContain("The encoded data was not valid");
    }

    // The same hostile bytes as the frozen-source INDEX: the UTF-8 decode of
    // the index names itself, beneath the selected file's subject.
    const hostileIndex = {
      ...identity,
      fixedContext: [{ label: "standalone-frozen-source", bytes: hostileBytes, digest: hostileDigest, byteLength: 2 }],
    } as const;
    const hostileIndexPacket = { ...hostileIndex, digest: contextPacketDigest(hostileIndex as unknown as Parameters<typeof contextPacketDigest>[0]) };
    const utf8IndexRefusal = projectContextPacket(hostileIndexPacket, value(parseContextProjectionArguments([
      "--packet", "/fixture/packet.json", "--request", identity.requestId, "--digest", hostileIndexPacket.digest,
      "--role", identity.role, "--skill", identity.requiredSkill, "--file", "src/a.ts",
    ])));
    expect(utf8IndexRefusal).toMatchObject({ ok: false });
    if (!utf8IndexRefusal.ok) {
      expect(utf8IndexRefusal.error).toContain("source file src/a.ts cannot be decoded safely as text data (");
      expect(utf8IndexRefusal.error).toContain("frozen source index could not be decoded as UTF-8");
    }
  });

  it("carries the parser's field-level diagnostic in the packet-integrity refusal", () => {
    // code-reviewer-2 / pr-test-analyzer-2: the sfh-1 enrichment is pinned —
    // flipping a section byte rehashes to a different section digest, and the
    // refusal must name the failing field and rule instead of the old generic
    // sentence. A revert to the generic sentence turns this red.
    const f = fixture();
    const corrupt = JSON.parse(f.bytes);
    corrupt.fixedContext[0].bytes[0] ^= 1;
    const refused = projectContextPacket(corrupt, value(parseContextProjectionArguments(f.args)));
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error).toContain("packet integrity or supported contract check failed " +
        "(fixedContext[0].digest: a context section digest must cover its exact bytes)");
    }
  });

  it("bounds hostile packet keys in the packet-integrity refusal", () => {
    // architecture-tech-lead-3: the parser's field and message can embed raw
    // undeclared object keys of arbitrary size from a hostile packet file; the
    // read boundary interpolates them through the kernel's diagnostic bound so
    // the refusal stays a bounded string.
    const hostileKey = "k".repeat(10_000);
    const hostile = { schemaVersion: 1, [hostileKey]: true };
    const args = ["--packet", "/fixture/packet.json", "--request", "request:reader-fixture",
      "--digest", "a".repeat(64), "--role", "code-reviewer", "--skill", "none"];
    const refused = projectContextPacket(hostile, value(parseContextProjectionArguments(args)));
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.startsWith("packet integrity or supported contract check failed (packet.")).toBe(true);
      expect(refused.error).toContain("…[truncated]");
      expect(refused.error).not.toContain(hostileKey);
    }
  });

  it("refuses a flag-shaped token as a flag's value at the argument boundary", () => {
    // tda-2: the shared cli-args grammar — a `--`-prefixed token is a flag,
    // never a value — so a mis-sequenced invocation is refused with its actual
    // cause instead of silently consuming the intended value.
    const args = ["--packet", "/fixture/packet.json", "--request", "request:reader-fixture",
      "--digest", "a".repeat(64), "--role", "code-reviewer", "--skill", "none"];
    for (const extra of [["--file", "--offset"], ["--file", "--offset", "123"], ["--offset", "--limit", "4096"]]) {
      const refused = parseContextProjectionArguments([...args, ...extra]);
      expect(refused).toMatchObject({ ok: false });
      if (!refused.ok) expect(refused.error).toContain("looks like another flag");
    }
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

describe("whole-section reader arguments", () => {
  const args = ["--packet", "/run/contexts/p.json", "--digest", "a".repeat(64), "--section", "wave-review-authority"];

  it("reads each flag's value in any order, at its first occurrence", () => {
    const expected = { ok: true, value: { path: "/run/contexts/p.json", digest: "a".repeat(64), label: "wave-review-authority" } };
    expect(parseContextSectionArguments(args)).toEqual(expected);
    expect(parseContextSectionArguments([...args.slice(4), ...args.slice(0, 4)])).toEqual(expected);
    expect(parseContextSectionArguments([...args, "--section", "other"])).toEqual(expected);
  });

  it("refuses an absent, empty or flag-shaped value, and a relative packet path", () => {
    expect(parseContextSectionArguments(args.slice(2))).toEqual({ ok: false, error: "--packet requires a value" });
    expect(parseContextSectionArguments(["--packet", "/p.json", "--digest", "", "--section", "s"])).toEqual({ ok: false, error: "--digest requires a value" });
    expect(parseContextSectionArguments(["--packet", "/p.json", "--digest", "d", "--section", "--packet"])).toEqual({ ok: false, error: "--section requires a value" });
    expect(parseContextSectionArguments(["--packet", "contexts/p.json", "--digest", "d", "--section", "s"])).toEqual({ ok: false, error: "--packet must be an absolute path" });
  });
});
