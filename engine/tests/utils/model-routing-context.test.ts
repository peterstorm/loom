import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeAgentDir,
  buildPiRoutingContext,
  homeAgentDir,
  loadModelRoutingConfig,
  parentModelRefFromEnv,
} from "../../src/utils/model-routing-context";

const VALID_CONFIG = {
  schemaVersion: 1,
  defaultClass: "cloud",
  modelClasses: { local: ["desktop-vllm/*", "desktop-muse/*"] },
  rules: [
    { id: "local-workloads-use-parent", when: { parentClass: "local" }, use: { kind: "parent" } },
  ],
};

describe("model routing context shell", () => {
  let home: string;
  let active: string;
  const saved: { HOME: string | undefined; PI_CODING_AGENT_DIR: string | undefined } = {
    HOME: undefined,
    PI_CODING_AGENT_DIR: undefined,
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "routing-home-"));
    active = mkdtempSync(join(tmpdir(), "routing-agent-"));
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    saved.HOME = process.env.HOME;
    saved.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = active;
  });

  afterEach(() => {
    process.env.HOME = saved.HOME;
    process.env.PI_CODING_AGENT_DIR = saved.PI_CODING_AGENT_DIR;
    rmSync(home, { recursive: true, force: true });
    rmSync(active, { recursive: true, force: true });
  });

  it("resolves the active agent dir from the environment, falling back to HOME", () => {
    expect(activeAgentDir()).toBe(active);
    // `delete` (not `= undefined`): Bun's process.env stringifies an undefined
    // assignment instead of removing the key, which would mask the fallback.
    delete process.env.PI_CODING_AGENT_DIR;
    expect(homeAgentDir()).toBe(join(home, ".pi", "agent"));
    expect(activeAgentDir()).toBe(join(home, ".pi", "agent"));
  });

  describe("parentModelRefFromEnv", () => {
    it("parses PI_PROVIDER/PI_MODEL into a ref", () => {
      expect(parentModelRefFromEnv({ PI_PROVIDER: "desktop-vllm", PI_MODEL: "qwen3.8-27b" }))
        .toEqual({ provider: "desktop-vllm", model: "qwen3.8-27b" });
    });

    it("is null when either variable is missing or malformed", () => {
      expect(parentModelRefFromEnv({})).toBeNull();
      expect(parentModelRefFromEnv({ PI_PROVIDER: "desktop-vllm" })).toBeNull();
      expect(parentModelRefFromEnv({ PI_MODEL: "qwen3.8-27b" })).toBeNull();
      expect(parentModelRefFromEnv({ PI_PROVIDER: "a/b", PI_MODEL: "m" })).toBeNull();
      expect(parentModelRefFromEnv({ PI_PROVIDER: " a", PI_MODEL: "m" })).toBeNull();
    });
  });

  describe("loadModelRoutingConfig", () => {
    it("is absent (ok, null) when no config exists anywhere", () => {
      expect(loadModelRoutingConfig()).toEqual({ ok: true, config: null });
    });

    it("loads and parses the active-dir config", () => {
      writeFileSync(join(active, "model-routing.json"), JSON.stringify(VALID_CONFIG));
      const loaded = loadModelRoutingConfig();
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.config?.defaultClass).toBe("cloud");
        expect(loaded.config?.rules.map((rule) => rule.id)).toEqual(["local-workloads-use-parent"]);
      }
    });

    it("falls back to the home agent dir when the active dir has none", () => {
      writeFileSync(join(home, ".pi", "agent", "model-routing.json"), JSON.stringify(VALID_CONFIG));
      const loaded = loadModelRoutingConfig();
      expect(loaded.ok).toBe(true);
      if (loaded.ok) expect(loaded.config?.schemaVersion).toBe(1);
    });

    it("prefers the active-dir config over the home one", () => {
      writeFileSync(join(active, "model-routing.json"), JSON.stringify({
        ...VALID_CONFIG,
        defaultClass: "homelab",
      }));
      writeFileSync(join(home, ".pi", "agent", "model-routing.json"), JSON.stringify(VALID_CONFIG));
      const loaded = loadModelRoutingConfig();
      expect(loaded.ok).toBe(true);
      if (loaded.ok) expect(loaded.config?.defaultClass).toBe("homelab");
    });

    it("fails closed on malformed JSON", () => {
      writeFileSync(join(active, "model-routing.json"), "{not json");
      const loaded = loadModelRoutingConfig();
      expect(loaded).toMatchObject({ ok: false, error: expect.stringContaining("cannot parse routing config") });
    });

    it("fails closed on an invalid schema and does not fall back to home", () => {
      writeFileSync(join(active, "model-routing.json"), JSON.stringify({ schemaVersion: 2 }));
      writeFileSync(join(home, ".pi", "agent", "model-routing.json"), JSON.stringify(VALID_CONFIG));
      const loaded = loadModelRoutingConfig();
      expect(loaded).toMatchObject({ ok: false, error: expect.stringContaining("invalid routing config") });
    });
  });

  describe("buildPiRoutingContext", () => {
    it("uses the env parent model and the active config", () => {
      writeFileSync(join(active, "model-routing.json"), JSON.stringify(VALID_CONFIG));
      const built = buildPiRoutingContext({ PI_PROVIDER: "desktop-vllm", PI_MODEL: "deepseek-v4-flash" });
      expect(built.configError).toBeNull();
      expect(built.context.parentRef).toEqual({ provider: "desktop-vllm", model: "deepseek-v4-flash" });
      expect(built.context.config?.rules).toHaveLength(1);
    });

    it("honours an explicit parent override over the env", () => {
      const override = { provider: "desktop-muse", model: "muse-70b" };
      const built = buildPiRoutingContext(
        { PI_PROVIDER: "desktop-vllm", PI_MODEL: "qwen3.8-27b" },
        active,
        override,
      );
      expect(built.context.parentRef).toEqual(override);
    });

    it("degrades a malformed config to no routing and reports the error", () => {
      writeFileSync(join(active, "model-routing.json"), "{not json");
      const built = buildPiRoutingContext({ PI_PROVIDER: "desktop-vllm", PI_MODEL: "qwen3.8-27b" });
      expect(built.context.config).toBeNull();
      expect(built.configError).toContain("cannot parse routing config");
    });
  });
});
