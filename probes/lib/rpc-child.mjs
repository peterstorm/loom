/**
 * The one RPC-child lifecycle the emission probes share: spawn `pi --mode rpc`
 * headless, frame its stdout as strict JSONL into an event bus, send commands
 * and await their responses under an explicit bound, and kill only this child.
 *
 * Both probe drivers (`emission-readiness/probe.mjs`,
 * `emission-qualification/probe.mjs`) cross this seam, so framing, timeout and
 * waiter bookkeeping are fixed in one place. What varies between them is data,
 * not code: the qualification driver passes a `retain` function that slims the
 * events it keeps (streaming `message_update` deltas re-embed the growing
 * partial message, which is quadratic in memory over a long thinking stream).
 * Waiters and `onEvent` listeners always see the full parsed event; `retain`
 * only shapes `events`, the retained history `waitFor` scans first.
 *
 * Ordering between waits is a bus-owned cursor, never object identity: a
 * cursor is a position in the event sequence (`events` indexes, non-JSON
 * markers included). `next` and `exchange` resolve the cursor just past the
 * event they matched, and a later wait given that cursor as `since` sees only
 * what arrived after it — however `retain` reshaped the retained copy.
 *
 * Tests: `rpc-child.test.mjs` drives the bus over a plain stream and the whole
 * lifecycle against a fake `pi` executable (the `executable` option), so no
 * real Pi or model is needed.
 */

import { spawn } from "node:child_process";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * RPC framing: strict JSONL, split on \n only. A line that is not JSON is
 * retained as a `__non_json__` marker (first 120 characters), never dropped.
 *
 * @param {NodeJS.ReadableStream} stdout
 * @param {{ retain?: (event: any) => any }} [options]
 */
export function makeBus(stdout, { retain = (event) => event } = {}) {
  const events = [];
  const waiters = [];
  const listeners = new Set();
  let buffer = "";
  stdout.on("data", (data) => {
    buffer += data.toString();
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        events.push({ type: "__non_json__", line: line.slice(0, 120) });
        continue;
      }
      events.push(retain(event));
      const cursor = events.length;
      for (const listener of listeners) listener(event);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i];
        if (waiter.predicate(event)) {
          waiters.splice(i, 1);
          clearTimeout(waiter.timer);
          waiter.resolve({ event, cursor });
        }
      }
    }
  });
  /**
   * Resolve `{ event, cursor }` for the first retained event at or after the
   * cursor `since` — or the first future event — matching `predicate`;
   * reject after `ms` naming `label`. `cursor` is the position just past the
   * matched event.
   */
  const next = (predicate, ms, label, since = 0) => {
    const at = events.findIndex((event, index) => index >= since && predicate(event));
    if (at !== -1) return Promise.resolve({ event: events[at], cursor: at + 1 });
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error(`${label}: no matching event within ${ms}ms`));
        }, ms),
      };
      waiters.push(waiter);
    });
  };
  return {
    events,
    next,
    /** The cursor at the end of the sequence so far: a wait given it as
     *  `since` sees only events that arrive from now on. */
    cursor: () => events.length,
    /**
     * `next`, resolving only the event. `since` is a cursor, so an earlier
     * phase's event never satisfies a later wait.
     */
    waitFor(predicate, ms, label, since = 0) {
      return next(predicate, ms, label, since).then(({ event }) => event);
    },
    /** Call `listener` with every parsed event from now on; returns the unsubscribe. */
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Response predicates: Pi answers a command either by its echoed `id` or by its `command` name. */
export const responseTo = Object.freeze({
  id: (id) => (event) => event.type === "response" && event.id === id,
  command: (name) => (event) => event.type === "response" && event.command === name,
});

/**
 * Spawn one headless RPC child: `<executable> --mode rpc ...args`, stdio piped.
 *
 * @param {readonly string[]} args the arguments after `--mode rpc`
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, retain?: (event: any) => any, executable?: string }} options
 */
export function spawnRpcChild(args, { cwd, env, retain, executable = "pi" }) {
  const child = spawn(executable, ["--mode", "rpc", ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const bus = makeBus(child.stdout, { retain });
  const stderrChunks = [];
  child.stderr.on("data", (data) => stderrChunks.push(data.toString()));
  const send = (command) => child.stdin.write(`${JSON.stringify(command)}\n`);
  /** Write one command and await `{ response, cursor }`: the response
   *  `matches` selects, within `ms`, and the cursor just past it. */
  const exchange = (command, matches, ms, label) => {
    send(command);
    return bus.next(matches, ms, label).then(({ event, cursor }) => ({ response: event, cursor }));
  };
  return {
    child,
    bus,
    /** Write one command line; no response is awaited. */
    send,
    exchange,
    /** Write one command and await the response `matches` selects, within `ms`. */
    request(command, matches, ms, label) {
      return exchange(command, matches, ms, label).then(({ response }) => response);
    },
    /** Everything the child wrote to stderr so far, trimmed. */
    stderr: () => stderrChunks.join("").trim(),
    /** SIGKILL only this child, then wait `graceMs` for its streams to settle. */
    async kill(graceMs) {
      child.kill("SIGKILL");
      await sleep(graceMs);
    },
  };
}
