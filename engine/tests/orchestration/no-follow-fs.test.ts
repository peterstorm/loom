/**
 * Symlink-attack coverage for the READ and REMOVE primitives.
 *
 * The write/publish side of `no-follow-fs` has real symlink tests; the read and
 * remove side had none, even though it is the same anchor-then-`O_NOFOLLOW`
 * dance re-implemented per primitive and it backs `readAuthority`,
 * `readContext`, `readCheckpoint`, and `readReceipt`. A planted symlink at a
 * run-artifact path is precisely the attack these functions exist to refuse, so
 * dropping the flag from any one of them must fail a test rather than silently
 * start following links out of the run directory.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readRunBytesNoFollow,
  readRunFileNoFollow,
  removeRunFileNoFollow,
  writeRunFileNoFollow,
} from "../../src/orchestration/no-follow-fs";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "loom-no-follow-"));
  cleanup.push(root);
  mkdirSync(join(root, "run"), { recursive: true });
  return root;
}

/** The file an attacker wants read or deleted, outside the run directory. */
function secretOutsideTheRun(root: string): string {
  const secret = join(root, "outside-the-run.txt");
  writeFileSync(secret, "authority for another run", "utf-8");
  return secret;
}

describe("reads refuse to follow a planted symlink", () => {
  it("readRunFileNoFollow refuses a leaf symlink pointing outside the run", () => {
    const root = workspace();
    const secret = secretOutsideTheRun(root);
    symlinkSync(secret, join(root, "run", "authority.json"));

    expect(() => readRunFileNoFollow(join(root, "run", "authority.json"))).toThrow(/ELOOP|too many symbolic/i);
  });

  it("readRunBytesNoFollow refuses the same leaf symlink", () => {
    const root = workspace();
    const secret = secretOutsideTheRun(root);
    symlinkSync(secret, join(root, "run", "transcript.raw"));

    expect(() => readRunBytesNoFollow(join(root, "run", "transcript.raw"))).toThrow(/ELOOP|too many symbolic/i);
  });

  it("readRunFileNoFollow refuses a symlinked ANCESTOR, not only a symlinked leaf", () => {
    const root = workspace();
    const real = join(root, "elsewhere");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "receipt.json"), "{}", "utf-8");
    symlinkSync(real, join(root, "run", "receipts"));

    expect(() => readRunFileNoFollow(join(root, "run", "receipts", "receipt.json")))
      .toThrow(/ELOOP|too many symbolic|ENOTDIR/i);
  });

  it("still reads a real regular file at the same path", () => {
    const root = workspace();
    writeRunFileNoFollow(join(root, "run", "authority.json"), "{\"runId\":\"run.a\"}");

    expect(readRunFileNoFollow(join(root, "run", "authority.json"))).toBe("{\"runId\":\"run.a\"}");
    expect([...readRunBytesNoFollow(join(root, "run", "authority.json"))])
      .toEqual([...Buffer.from("{\"runId\":\"run.a\"}", "utf-8")]);
  });

  it("reports a missing file as ENOENT, which callers use to mean 'never written'", () => {
    const root = workspace();
    try {
      readRunFileNoFollow(join(root, "run", "absent.json"));
      throw new Error("expected the read to throw");
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });
});

describe("removal refuses to follow a planted symlink", () => {
  it("removeRunFileNoFollow unlinks the LINK, never the file it points at", () => {
    const root = workspace();
    const secret = secretOutsideTheRun(root);
    const link = join(root, "run", "checkpoint.json.staged");
    symlinkSync(secret, link);

    // `unlinkat` on a symlink removes the link itself — the point is that the
    // target survives, so a discarded staged file can never delete a real one.
    removeRunFileNoFollow(link);

    expect(readFileSync(secret, "utf-8")).toBe("authority for another run");
  });

  it("removeRunFileNoFollow refuses a path whose ANCESTOR is a symlink", () => {
    const root = workspace();
    const real = join(root, "elsewhere");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "staged.json"), "{}", "utf-8");
    symlinkSync(real, join(root, "run", "artifacts"));

    expect(() => removeRunFileNoFollow(join(root, "run", "artifacts", "staged.json")))
      .toThrow(/ELOOP|too many symbolic|ENOTDIR/i);
    // The file behind the symlinked ancestor is untouched.
    expect(readFileSync(join(real, "staged.json"), "utf-8")).toBe("{}");
  });

  it("still removes a real regular file at the same path", () => {
    const root = workspace();
    const path = join(root, "run", "staged.json");
    writeRunFileNoFollow(path, "{}");

    removeRunFileNoFollow(path);

    expect(() => readRunFileNoFollow(path)).toThrow();
  });
});
