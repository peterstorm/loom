import { spawn } from "node:child_process";
import { describe, it } from "vitest";

/**
 * TEMPORARY diagnostic — darwin containment facts, removed after diagnosis.
 *
 * The completion-check runner proves process-group containment with
 * `process.kill(-pgid, 0)` probes around SIGTERM/SIGKILL. Three macOS CI
 * tests failed with containment unproven while their Linux twins pass, so
 * this probe logs the raw observation timeline on the CI runner: when the
 * group becomes ESRCH after a default-death TERM, and after a KILL of a
 * child that trapped TERM. Every line is prefixed for grep.
 */

const note = (message: string): void => {
  process.stdout.write(`CONTAINMENT-PROBE ${message}\n`);
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const errnoOf = (cause: unknown): string => {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "unknown-error";
};

const probe = (pgid: number): string => {
  try {
    process.kill(-pgid, 0);
    return "present";
  } catch (cause) {
    return errnoOf(cause);
  }
};

const signal = (pgid: number, name: "SIGTERM" | "SIGKILL"): string => {
  try {
    process.kill(-pgid, name);
    return `sent:${name}`;
  } catch (cause) {
    return `send-failed:${name}:${errnoOf(cause)}`;
  }
};

type Observed = { readonly kind: string; readonly atMs: number; readonly detail: string };

function watchChild(child: import("node:child_process").ChildProcess, startAt: number): Promise<Observed[]> {
  const observed: Observed[] = [];
  child.once("exit", (code, sig) => observed.push({ kind: "exit", atMs: Date.now() - startAt, detail: `code=${code} signal=${sig}` }));
  child.once("close", (code, sig) => observed.push({ kind: "close", atMs: Date.now() - startAt, detail: `code=${code} signal=${sig}` }));
  child.once("error", (cause) => observed.push({ kind: "error", atMs: Date.now() - startAt, detail: String(cause) }));
  return Promise.resolve(observed);
}

describe("containment probe (temporary diagnostic)", () => {
  it("logs group liveness around TERM and KILL for handler and plain children", async () => {
    // Variant A: child TRAPS SIGTERM (stays alive until KILL) — the shape of
    // the three failing runner tests.
    const startA = Date.now();
    const childA = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => { process.stdout.write('TERM-HANDLER-RAN\\n'); }); setInterval(() => undefined, 1000);"],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const pgidA = childA.pid!;
    const observedA = watchChild(childA, startA);
    childA.stdout!.on("data", (chunk: Buffer) => note(`A child-stdout ${chunk.toString().trim()} at ${Date.now() - startA}ms`));
    childA.stderr!.on("data", (chunk: Buffer) => note(`A child-stderr ${chunk.toString().trim()} at ${Date.now() - startA}ms`));
    note(`A start platform=${process.platform} pid=${pgidA} node=${process.version}`);
    await delay(300);
    note(`A t+${Date.now() - startA} before-TERM probe=${probe(pgidA)}`);
    note(`A t+${Date.now() - startA} ${signal(pgidA, "SIGTERM")}`);
    for (let step = 1; step <= 6; step += 1) {
      await delay(100);
      note(`A t+${Date.now() - startA} after-TERM probe=${probe(pgidA)}`);
    }
    note(`A t+${Date.now() - startA} ${signal(pgidA, "SIGKILL")}`);
    for (let step = 1; step <= 12; step += 1) {
      await delay(100);
      note(`A t+${Date.now() - startA} after-KILL probe=${probe(pgidA)}`);
    }
    for (const observed of await observedA) note(`A child-${observed.kind} at ${observed.atMs}ms ${observed.detail}`);

    // Variant B: child with NO handler — default-death TERM; the shape the
    // passing macOS tests (timeout-with-descendant) exercise.
    const startB = Date.now();
    const childB = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000);"], {
      detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const pgidB = childB.pid!;
    const observedB = watchChild(childB, startB);
    note(`B start platform=${process.platform} pid=${pgidB}`);
    await delay(300);
    note(`B t+${Date.now() - startB} before-TERM probe=${probe(pgidB)}`);
    note(`B t+${Date.now() - startB} ${signal(pgidB, "SIGTERM")}`);
    for (let step = 1; step <= 12; step += 1) {
      await delay(100);
      const liveness = probe(pgidB);
      note(`B t+${Date.now() - startB} after-TERM probe=${liveness}`);
      if (liveness !== "present") break;
    }
    for (const observed of await observedB) note(`B child-${observed.kind} at ${observed.atMs}ms ${observed.detail}`);

    try { childA.kill("SIGKILL"); } catch { /* already gone */ }
    try { childB.kill("SIGKILL"); } catch { /* already gone */ }
  }, 20_000);
});
