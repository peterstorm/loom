import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireLock, releaseLock, isStaleLock } from "../../src/utils/lock";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("lock", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("acquires and releases lock", async () => {
    tmpDir = makeTmpDir();
    const lockFile = join(tmpDir, "test");

    await acquireLock(lockFile);
    expect(existsSync(`${lockFile}.lock`)).toBe(true);

    releaseLock(lockFile);
    expect(existsSync(`${lockFile}.lock`)).toBe(false);
  });

  it("recovers stale lock from dead process", async () => {
    tmpDir = makeTmpDir();
    const lockFile = join(tmpDir, "stale");
    const lockDir = `${lockFile}.lock`;

    // Simulate stale lock with dead PID
    mkdirSync(lockDir);
    writeFileSync(`${lockDir}/pid`, "999999999");

    // Should recover and acquire
    await acquireLock(lockFile);
    expect(existsSync(lockDir)).toBe(true);

    releaseLock(lockFile);
  });

  it("recovers stale lock with missing pid file", async () => {
    tmpDir = makeTmpDir();
    const lockFile = join(tmpDir, "no-pid");
    const lockDir = `${lockFile}.lock`;

    // Simulate stale lock without pid file
    mkdirSync(lockDir);

    await acquireLock(lockFile);
    expect(existsSync(lockDir)).toBe(true);

    releaseLock(lockFile);
  });

  it("does not consider lock stale when EPERM (process exists, no permission)", () => {
    tmpDir = makeTmpDir();
    const lockDir = join(tmpDir, "eperm.lock");
    mkdirSync(lockDir);
    // PID 1 (init/launchd) always exists but kill(1,0) throws EPERM for non-root
    writeFileSync(`${lockDir}/pid`, "1");

    // Should NOT be stale — process exists, we just can't signal it
    expect(isStaleLock(lockDir)).toBe(false);
  });
});
