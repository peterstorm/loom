import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireLock,
  acquireLockSync,
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

  it("retires a genuinely stale lock through its exclusive generation claim", () => {
    tmpDir = makeTmpDir();
    const lockDir = join(tmpDir, "stale.lock");
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "pid"), "999999999"); // dead pid

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(stealStaleLock(lockDir)).toBe(true);
      expect(existsSync(lockDir)).toBe(false);
      expect(readdirSync(tmpDir).some((entry) => entry.includes(".retiring-"))).toBe(false);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("a lock that vanished before observation is a normal retry", () => {
    tmpDir = makeTmpDir();
    expect(stealStaleLock(join(tmpDir, "never-existed.lock"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "recovers after a claimant process dies immediately after publishing its generation claim",
    async () => {
      tmpDir = makeTmpDir();
      const lockFile = join(tmpDir, "orphaned-claim");
      const lockDir = `${lockFile}.lock`;
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "pid"), "999999999:stale-generation");
      const lockModule = new URL("../../src/utils/lock.ts", import.meta.url).href;

      const crashed = spawnSync("bun", ["--eval", [
        `const { observeStaleLock } = await import(${JSON.stringify(lockModule)});`,
        `if (observeStaleLock(${JSON.stringify(lockDir)}) === null) process.exit(2);`,
        `process.kill(process.pid, "SIGKILL");`,
      ].join("\n")], { encoding: "utf-8" });

      expect(crashed.signal).toBe("SIGKILL");
      expect(existsSync(join(lockDir, "generation-claim"))).toBe(true);
      await acquireLock(lockFile);
      expect(readFileSync(join(lockDir, "pid"), "utf-8")).toContain(`${process.pid}:`);
      releaseLock(lockFile);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rechecks an initially-live generation claim and acquires after its claimant exits",
    async () => {
      tmpDir = makeTmpDir();
      const lockFile = join(tmpDir, "claimant-exits-during-wait");
      const lockDir = `${lockFile}.lock`;
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "pid"), "999999999:stale-generation");
      const lockModule = new URL("../../src/utils/lock.ts", import.meta.url).href;
      const claimant = spawn("bun", ["--eval", [
        `const { observeStaleLock } = await import(${JSON.stringify(lockModule)});`,
        `if (observeStaleLock(${JSON.stringify(lockDir)}) === null) process.exit(2);`,
        `console.log("claimed");`,
        `setTimeout(() => process.exit(0), 250);`,
      ].join("\n")], { stdio: ["ignore", "pipe", "pipe"] });
      const exited = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((resolveExit) => {
        claimant.once("exit", (code, signal) => resolveExit({ code, signal }));
      });
      await new Promise<void>((resolveClaim, rejectClaim) => {
        let announced = false;
        claimant.once("error", rejectClaim);
        claimant.stdout.on("data", (chunk) => {
          if (!String(chunk).includes("claimed") || announced) return;
          announced = true;
          resolveClaim();
        });
        claimant.once("exit", (code, signal) => {
          if (!announced) rejectClaim(new Error(`claimant exited before announcing its claim: code=${code}, signal=${signal}`));
        });
      });

      await acquireLock(lockFile);

      expect(await exited).toEqual({ code: 0, signal: null });
      expect(readFileSync(join(lockDir, "pid"), "utf-8")).toContain(`${process.pid}:`);
      releaseLock(lockFile);
    },
  );

  it("keeps an unexpired generation claim contended while its claimant is alive", () => {
    tmpDir = makeTmpDir();
    const lockDir = join(tmpDir, "live-claim.lock");
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "pid"), "999999999:stale-generation");
    const claim = observeStaleLock(lockDir);
    expect(claim).not.toBeNull();
    if (claim === null) throw new Error("expected this process to own the generation claim");
    const claimBytes = readFileSync(join(lockDir, "generation-claim"), "utf-8");

    expect(stealStaleLock(lockDir)).toBe(false);
    expect(readFileSync(join(lockDir, "generation-claim"), "utf-8")).toBe(claimBytes);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(retireObservedStaleLock(claim)).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("a generation claim rejects replacement between owner read and PID probing", async () => {
    tmpDir = makeTmpDir();
    const lockFile = join(tmpDir, "release-race");
    const lockDir = `${lockFile}.lock`;
    await acquireLock(lockFile);
    const releasedOwner = readFileSync(join(lockDir, "pid"), "utf-8");
    const releasedGeneration = releasedOwner.split(":")[1];
    expect(releasedGeneration).toBeDefined();

    // Simulate even an uncoordinated actor replacing G with H after the owner
    // snapshot and generation claim but before the PID probe returns ESRCH.
    // Normal release is stricter: it must acquire the same exclusive claim.
    const probe = vi.spyOn(process, "kill").mockImplementationOnce(() => {
      rmSync(lockDir, { recursive: true, force: true });
      acquireLockSync(lockFile);
      throw Object.assign(new Error("observed owner exited"), { code: "ESRCH" });
    });
    try {
      const delayedObservation = observeStaleLock(lockDir);
      expect(delayedObservation?.generation).toBe(releasedGeneration);
      if (delayedObservation === null) return;
      const freshOwner = readFileSync(join(lockDir, "pid"), "utf-8");
      expect(freshOwner).not.toBe(releasedOwner);

      expect(retireObservedStaleLock(delayedObservation)).toBe(false);
      expect(readFileSync(join(lockDir, "pid"), "utf-8")).toBe(freshOwner);
      expect(readdirSync(tmpDir).some((entry) => entry.includes(".retiring-"))).toBe(false);
    } finally {
      probe.mockRestore();
      releaseLock(lockFile);
    }
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
      // Contender A claims and retires the stale generation, then contender B
      // acquires fresh before A's already-consumed proof is replayed.
      const delayedObservation = observeStaleLock(lockDir);
      expect(delayedObservation).not.toBeNull();
      if (delayedObservation === null) return;
      expect(retireObservedStaleLock(delayedObservation)).toBe(true);
      await acquireLock(lockFile);
      const freshOwner = readFileSync(join(lockDir, "pid"), "utf-8");
      expect(freshOwner).not.toContain(staleGeneration);

      // A's claim moved away with its generation, so replaying the proof
      // cannot acquire authority over B's fresh owner record.
      expect(retireObservedStaleLock(delayedObservation)).toBe(false);
      expect(readFileSync(join(lockDir, "pid"), "utf-8")).toBe(freshOwner);
      releaseLock(lockFile);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
