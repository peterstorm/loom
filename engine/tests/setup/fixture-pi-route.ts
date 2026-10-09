/**
 * Vitest global setup (registered in `vitest.config.ts`): one fake local Pi
 * route for the whole run.
 *
 * A Pi parent's spawn batch is refused unless every route it names answers
 * `GET {baseUrl}/models` (core/route-reachability.ts). Fixture Pi sessions
 * must therefore point at a route that answers, never at the operator's real
 * `~/.pi/agent/models.json`. This starts a loopback HTTP server listing the
 * catalog's local model and a fixture agent directory whose `models.json`
 * names it, published to the workers under `FIXTURE_PI_AGENT_DIR_ENV`
 * (`tests/fixtures/fixture-pi-agent-directory.ts`, which owns the read);
 * `tests/fixtures/pi-session.ts` sets `PI_CODING_AGENT_DIR` to that directory
 * for every fixture Pi session.
 *
 * The server lives in Vitest's main process on purpose: test workers run CLI
 * children through `spawnSync`, which blocks the worker's own event loop, so a
 * server inside a worker could not answer its own children.
 */
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_VLLM_ROUTE } from "../../src/core/model-profiles";
import { FIXTURE_PI_AGENT_DIR_ENV } from "../fixtures/fixture-pi-agent-directory";

export default async function setup(): Promise<() => Promise<void>> {
  const server = createServer((request, response) => {
    const listed = request.url === "/v1/models";
    response.writeHead(listed ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(listed ? { object: "list", data: [{ id: DESKTOP_VLLM_ROUTE.model, object: "model" }] } : {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture Pi route has no TCP address");
  const agentDir = mkdtempSync(join(tmpdir(), "loom-fixture-pi-agent-"));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      [DESKTOP_VLLM_ROUTE.provider]: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: "openai-completions",
        models: [{ id: DESKTOP_VLLM_ROUTE.model }],
      },
    },
  }, null, 2));
  // Workers are started after global setup and inherit this environment.
  process.env[FIXTURE_PI_AGENT_DIR_ENV] = agentDir;
  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(agentDir, { recursive: true, force: true });
  };
}
