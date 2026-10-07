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
      for (const listener of listeners) listener(event);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i];
        if (waiter.predicate(event)) {
          waiters.splice(i, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(event);
        }
      }
    }
  });
  return {
    events,
    /**
     * Resolve with the first retained or future event matching `predicate`;
     * reject after `ms` naming `label`. `since` skips the retained events
     * before that index, so an earlier phase's event never satisfies a later wait.
     */
    waitFor(predicate, ms, label, since = 0) {
      const existing = events.slice(since).find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            const at = waiters.indexOf(waiter);
            if (at !== -1) waiters.splice(at, 1);
            reject(new Error(`${label}: no matching event within ${ms}ms`));
          }, ms),
        };
        waiters.push(waiter);
      });
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
  return {
    child,
    bus,
    /** Write one command line; no response is awaited. */
    send,
    /** Write one command and await the response `matches` selects, within `ms`. */
    request(command, matches, ms, label) {
      send(command);
      return bus.waitFor(matches, ms, label);
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
