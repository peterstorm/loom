/**
 * Vitest setup file (registered in `vitest.config.ts`): after every test, give
 * the worker's event loop one full turn before the next test starts.
 *
 * A worker reports progress with a `onTaskUpdate` RPC and arms a fixed 60s
 * timer for the main thread's reply. The runner chains tests through promise
 * microtasks only, so a file whose tests are synchronous work — `spawnSync`
 * CLI children, TypeScript closure scans, gzip and replay fixtures — never
 * returns to the event loop between tests. The reply arrives promptly but
 * waits unread in the IPC channel; when the file finally yields, libuv runs
 * expired timers before it polls I/O, so the 60s timer fires first and the
 * run fails with an unhandled "[vitest-worker]: Timeout calling
 * \"onTaskUpdate\"" while every test passes. CPU oversubscription only
 * stretches those synchronous spans; it is not the mechanism.
 *
 * `setImmediate` resolves in the check phase, and the loop polls I/O before
 * every check phase, so a reply pending at one test boundary is read by the
 * next. The longest span a reply can wait unread is then two consecutive
 * tests, each bounded by its own timeout — instead of a whole file (one
 * 26-test integration file measured 24.8s without a single turn locally).
 * A timer-based yield would not do: an expired timer runs before the poll.
 */
import { afterEach } from "vitest";

afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
