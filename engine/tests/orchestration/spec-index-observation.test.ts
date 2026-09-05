import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeSpecIndex, projectSpecBytes } from "../../src/orchestration/spec-index-observation";
import { specIndexDigest, specIndexPath, specIndexUnavailableMessage } from "../../src/core/requirement-coverage";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

const dir = (): string => {
  const path = mkdtempSync(join(tmpdir(), "loom-spec-index-"));
  cleanup.push(path);
  return path;
};

const canonical = `# Feature: Observed

## User Scenarios

### US1: [P1] Observe

**Acceptance Scenarios:**
- AS-001: Given a spec, When it is observed, Then it projects

## Functional Requirements

- FR-001: System MUST project observed bytes

## Out of Scope

- OOS-001: Symbol-level source indexing

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Spec Index | A deterministic projection of specification entries |
`;

describe("observeSpecIndex", () => {
  it("indexes a canonical specification and names the digest of the bytes it parsed", () => {
    const root = dir();
    const path = join(root, "spec.md");
    writeFileSync(path, canonical, "utf8");
    const observed = observeSpecIndex(path);
    expect(observed.kind).toBe("indexed");
    expect(specIndexPath(observed)).toBe(path);
    // The digest must be of the parsed bytes, so the gate can prove the pairing.
    expect(specIndexDigest(observed)).toBe(createHash("sha256").update(canonical).digest("hex"));
  });

  it("distinguishes an unreadable spec from one that does not parse, and from none at all", () => {
    // Collapsing these into one reason left an operator unable to tell "the
    // file is missing" from "this project has no canonical specification".
    const root = dir();
    const missing = observeSpecIndex(join(root, "absent.md"));
    expect(missing).toMatchObject({ kind: "unavailable", reason: { kind: "unreadable" } });
    expect(specIndexUnavailableMessage(
      missing.kind === "unavailable" ? missing.reason : { kind: "no-spec-file" },
    )).toContain("could not be read");

    const bad = join(root, "bad.md");
    writeFileSync(bad, "# not a specification", "utf8");
    const unparsed = observeSpecIndex(bad);
    expect(unparsed).toMatchObject({ kind: "unavailable", reason: { kind: "unparsed", path: bad } });

    expect(observeSpecIndex(null)).toMatchObject({
      kind: "unavailable",
      reason: { kind: "no-spec-file" },
    });
  });

  it("never throws, whatever the path names", () => {
    const root = dir();
    const directory = join(root, "nested");
    mkdirSync(directory);
    // A directory read fails with EISDIR rather than ENOENT; the decompose-time
    // observer degrades on both, because a missing spec is not a decompose failure.
    expect(() => observeSpecIndex(directory)).not.toThrow();
    expect(observeSpecIndex(directory).kind).toBe("unavailable");
  });
});

describe("projectSpecBytes", () => {
  it("is the one projection both observers share, digest bound to the parsed bytes", () => {
    const projected = projectSpecBytes("spec.md", Buffer.from(canonical, "utf8"));
    expect(projected).toMatchObject({ kind: "indexed", path: "spec.md" });
    expect(specIndexDigest(projected)).toBe(createHash("sha256").update(canonical).digest("hex"));
  });

  it("reports a non-canonical document as unparsed against the path it was given", () => {
    const projected = projectSpecBytes("spec.md", Buffer.from("# nope", "utf8"));
    expect(projected).toMatchObject({ kind: "unavailable", reason: { kind: "unparsed", path: "spec.md" } });
  });
});
