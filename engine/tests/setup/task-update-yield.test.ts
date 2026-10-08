/**
 * Pins the suite-wide event-loop turn (`task-update-yield.ts`): the runner
 * itself chains tests through microtasks only, so a check-phase callback
 * queued by a synchronous test runs before the next test starts only because
 * the setup file's `afterEach` turns the loop. Without that turn the worker
 * cannot read its `onTaskUpdate` RPC replies between synchronous tests.
 */
import { describe, expect, it } from "vitest";

describe("suite-wide event-loop turn between tests", () => {
  let turned = false;

  it("queues a check-phase callback from a synchronous test", () => {
    setImmediate(() => { turned = true; });
    expect(turned).toBe(false);
  });

  it("starts the next test only after the event loop turned", () => {
    expect(turned).toBe(true);
  });
});
