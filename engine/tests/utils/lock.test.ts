import { describe, it, expect, afterEach, vi } from "vitest";
import { chmodSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireLock,
  isStaleLock,
  observeStaleLock,
  releaseLock,
  retireObservedStaleLock,
  stealStaleLock,
  withLockSync,
} from "../../src/utils/lock";

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

  it("holds and releases the same protocol synchronously", () => {
    tmpDir = makeTmpDir();
    const lockFile = join(tmpDir, "sync");

    const observed = withLockSync(lockFile, () => existsSync(`${lockFile}.lock`));

    expect(observed).toBe(true);
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

  it("a non-EEXIST mkdir failure surfaces immediately instead of spinning through retries", async () => {
    tmpDir = makeTmpDir();
    // Parent dir of the lock does not exist → mkdirSync throws ENOENT,
    // which no amount of retrying can fix. Before the fix this spun for
    // MAX_ATTEMPTS * RETRY_MS (~5s) and reported a misleading
    // "could not acquire lock".
    const started = Date.now();
    await expect(acquireLock(join(tmpDir, "missing-parent", "test"))).rejects.toThrow(/ENOENT/);
    expect(Date.now() - started).toBeLessThan(2_000);
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

  it("treats an inaccessible pid path as live instead of reaping its lock", () => {
    tmpDir = makeTmpDir();
    const lockDir = join(tmpDir, "pid-eloop.lock");
    mkdirSync(lockDir);
    symlinkSync("pid", join(lockDir, "pid"));

    expect(isStaleLock(lockDir)).toBe(false);
  });

  it("preserves a foreign-owned lock on release", () => {
    tmpDir = makeTmpDir();
    const lockFile = join(tmpDir, "foreign");
    const lockDir = `${lockFile}.lock`;
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "pid"), `999999999:foreign-generation`);

    releaseLock(lockFile);

    expect(existsSync(lockDir)).toBe(true);
  });

  it("surfaces ownership-inspection errors without removing the lock", () => {
    tmpDir = makeTmpDir();
    const lockFile = join(tmpDir, "owner-loop");
    const lockDir = `${lockFile}.lock`;
    mkdirSync(lockDir);
    symlinkSync("pid", join(lockDir, "pid"));

    expect(() => releaseLock(lockFile)).toThrow(/Cannot inspect lock ownership/);
    expect(existsSync(lockDir)).toBe(true);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "surfaces removal failure after proving this process owns the lock",
    () => {
      tmpDir = makeTmpDir();
      const lockFile = join(tmpDir, "owned");
      const lockDir = `${lockFile}.lock`;
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "pid"), `${process.pid}`);
      chmodSync(tmpDir, 0o500);
      try {
        expect(() => releaseLock(lockFile)).toThrow(/Failed to release owned lock/);
        expect(existsSync(lockDir)).toBe(true);
      } finally {
        chmodSync(tmpDir, 0o700);
      }
    },
  );
});

describe("generation-addressed stale-lock retirement", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not move a live lock", () => {
    tmpDir = makeTmpDir();
    const lockDir = join(tmpDir, "live.lock");
    // A live lock: pid file names THIS (running) process.
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "pid"), `${process.pid}`);

    expect(stealStaleLock(lockDir)).toBe(false);
    expect(existsSync(lockDir)).toBe(true);
    expect(existsSync(join(lockDir, "pid"))).toBe(true);
    expect(readdirSync(tmpDir).filter((entry) => entry.includes(".retired-"))).toEqual([]);
  });

  it("retires a genuinely stale lock behind its persistent generation fence", () => {
    tmpDir = makeTmpDir();
    const lockDir = join(tmpDir, "stale.lock");
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "pid"), "999999999"); // dead pid

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(stealStaleLock(lockDir)).toBe(true);
      expect(existsSync(lockDir)).toBe(false);
      expect(readdirSync(tmpDir).some((entry) => entry.includes(".retired-legacy-"))).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("a lock that vanished before observation is a normal retry", () => {
    tmpDir = makeTmpDir();
    expect(stealStaleLock(join(tmpDir, "never-existed.lock"))).toBe(false);
  });

  it("a delayed third contender cannot displace the fresh holder", async () => {
    tmpDir = makeTmpDir();
    const lockFile = join(tmpDir, "three-contenders");
    const lockDir = `${lockFile}.lock`;
    const staleGeneration = "stale-generation";
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "pid"), `999999999:${staleGeneration}`);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // Contenders A and C observe the same stale generation. A retires it,
      // then contender B acquires fresh before delayed contender C acts.
      const delayedObservation = observeStaleLock(lockDir);
      expect(delayedObservation).not.toBeNull();
      if (delayedObservation === null) return;
      expect(retireObservedStaleLock(delayedObservation)).toBe(true);
      await acquireLock(lockFile);
      const freshOwner = readFileSync(join(lockDir, "pid"), "utf-8");
      expect(freshOwner).not.toContain(staleGeneration);

      // Contender C carries A's delayed stale observation. The persistent
      // generation fence makes its rename collide instead of moving B.
      expect(retireObservedStaleLock(delayedObservation)).toBe(false);
      expect(readFileSync(join(lockDir, "pid"), "utf-8")).toBe(freshOwner);
      releaseLock(lockFile);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
