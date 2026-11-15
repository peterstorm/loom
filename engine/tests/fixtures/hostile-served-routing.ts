/**
 * A Pi agent directory whose `model-routing.json` sends every child of a
 * cloud parent to a `served` target on a provider nothing listens for, keyed
 * by a command that leaves a marker when it runs. Resolving a child's route
 * under it refuses (`served-model-unknown`, cause `unreachable`) after running
 * the key command, so a test can prove either that a route was resolved or
 * that none was.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deadLoopbackPort } from "./dead-loopback-port";

export type HostileServedRouting = Readonly<{
  /** The agent directory, for `PI_CODING_AGENT_DIR`. */
  dir: string;
  /** The cloud parent model the routing applies to, for `PI_PROVIDER`/`PI_MODEL`. */
  parentEnv: Readonly<{ PI_PROVIDER: string; PI_MODEL: string }>;
  /** Whether the served provider's key command has run. */
  keyCommandRan: () => boolean;
  remove: () => void;
}>;

export async function hostileServedRouting(): Promise<HostileServedRouting> {
  const dir = mkdtempSync(join(tmpdir(), "loom-hostile-routing-"));
  const marker = join(dir, "key-command-ran");
  const port = await deadLoopbackPort();
  writeFileSync(join(dir, "models.json"), JSON.stringify({
    providers: {
      "down-vllm": {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        apiKey: `!touch ${marker} && printf sk-hostile`,
        models: [{ id: "other-model" }],
      },
    },
  }));
  writeFileSync(join(dir, "model-routing.json"), JSON.stringify({
    schemaVersion: 1,
    defaultClass: "cloud",
    modelClasses: {},
    targets: { down: { served: "down-vllm", thinkingLevel: "high" } },
    rules: [{ id: "everything-to-the-down-server", when: { parentClass: "cloud" }, use: { kind: "named", target: "down" } }],
  }));
  return Object.freeze({
    dir,
    parentEnv: Object.freeze({ PI_PROVIDER: "openai-codex", PI_MODEL: "gpt-5.6-sol" }),
    keyCommandRan: () => existsSync(marker),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  });
}
