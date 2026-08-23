/**
 * Imperative shell for the model-routing policy: loads the `model-routing.json`
 * config and observes the parent session's model, then hands a typed
 * {@link PiRoutingContext} to the pure policy in `core/model-routing.ts`.
 *
 * Fail-closed: a config that is absent simply means "no routing" (the declared
 * binding is used); a config that is present but malformed is an error the
 * caller surfaces, and it degrades to "no routing" — a broken policy never
 * silently authorizes inheriting a parent model.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseModelRef,
  parseModelRoutingConfig,
  type ModelRef,
  type ModelRoutingConfig,
} from "../core/model-routing";
import type { PiRoutingContext } from "./render-pi-agent";

export function homeAgentDir(): string {
  return join(process.env.HOME ?? "", ".pi", "agent");
}

/** The active Pi agent directory (honours PI_CODING_AGENT_DIR). */
export function activeAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? homeAgentDir();
}

export type RoutingConfigLoad =
  | Readonly<{ ok: true; config: ModelRoutingConfig | null }>
  | Readonly<{ ok: false; error: string }>;

/**
 * Load and parse the routing config from the active agent dir, falling back to
 * the home agent dir. Absent → `{ ok: true, config: null }` (no routing).
 * Present but malformed → `{ ok: false, error }`.
 */
export function loadModelRoutingConfig(dir: string = activeAgentDir()): RoutingConfigLoad {
  const candidates = [join(dir, "model-routing.json")];
  if (dir !== homeAgentDir()) candidates.push(join(homeAgentDir(), "model-routing.json"));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf-8"));
    } catch (error) {
      return { ok: false, error: `cannot parse routing config ${path}: ${error instanceof Error ? error.message : String(error)}` };
    }
    const parsed = parseModelRoutingConfig(raw);
    if (!parsed.ok) return { ok: false, error: `invalid routing config ${path}: ${parsed.error.message}` };
    return { ok: true, config: parsed.value };
  }
  return { ok: true, config: null };
}

/** The parent session's model ref from `PI_PROVIDER`/`PI_MODEL`, or null. */
export function parentModelRefFromEnv(env: NodeJS.ProcessEnv = process.env): ModelRef | null {
  const provider = env.PI_PROVIDER;
  const model = env.PI_MODEL;
  if (typeof provider !== "string" || typeof model !== "string") return null;
  const parsed = parseModelRef(`${provider}/${model}`);
  return parsed.ok ? parsed.value : null;
}

export type BuiltRoutingContext = Readonly<{
  context: PiRoutingContext;
  /** Non-null when a present config was malformed; the context degrades to no routing. */
  configError: string | null;
}>;

/**
 * Build the routing context a render/spawn decision uses. `parentOverride`
 * wins over the env (used by the renderer when the caller knows the parent
 * model explicitly). A malformed config degrades to no routing and reports
 * its error.
 */
export function buildPiRoutingContext(
  env: NodeJS.ProcessEnv = process.env,
  dir: string = activeAgentDir(),
  parentOverride: ModelRef | null = null,
): BuiltRoutingContext {
  const loaded = loadModelRoutingConfig(dir);
  const context: PiRoutingContext = Object.freeze({
    config: loaded.ok ? loaded.config : null,
    parentRef: parentOverride ?? parentModelRefFromEnv(env),
  });
  return Object.freeze({ context, configError: loaded.ok ? null : loaded.error });
}
