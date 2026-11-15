/**
 * The served-model decision (`core/served-model.ts`): a `served` routing
 * target resolves to the one model its provider lists, and to a typed cause —
 * never a fallback model — for every way the listing can fail. The cause's
 * prose is `describeServedModelUnknown`'s (`core/served-model-cause.ts`).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decideServedModel, type ServedProviderObservation } from "../../src/core/served-model";
import { describeServedModelUnknown, type ServedModelUnknownCause } from "../../src/core/served-model-cause";
import type { RouteProbe } from "../../src/core/route-reachability";

const URL = "http://127.0.0.1:8000/v1/models";
const CATALOG = ["glm-5", "warmind"] as const;
const probed = (probe: RouteProbe, catalog: readonly string[] = CATALOG): ServedProviderObservation =>
  ({ kind: "probed", url: URL, catalog, probe });
const listing = (servedModels: readonly string[] | null, status = 200): RouteProbe =>
  ({ kind: "answered", status, servedModels });
const causeOf = (observation: ServedProviderObservation): ServedModelUnknownCause => {
  const decided = decideServedModel("desktop-vllm", observation);
  if (decided.kind !== "unknown") throw new Error(`expected no served model, got ${JSON.stringify(decided)}`);
  return decided.cause;
};
const reasonOf = (observation: ServedProviderObservation): string => describeServedModelUnknown("desktop-vllm", causeOf(observation));

describe("served-model decision", () => {
  it("resolves the one listed model, declared in the catalog, to an exact ref", () => {
    expect(decideServedModel("desktop-vllm", probed(listing(["warmind"])))).toEqual({
      kind: "served",
      ref: { provider: "desktop-vllm", model: "warmind" },
    });
  });

  it("refuses a listing of zero or several models, naming them", () => {
    expect(causeOf(probed(listing([])))).toEqual({ kind: "not-one-model", url: URL, served: [] });
    expect(reasonOf(probed(listing([])))).toMatch(/lists 0 models \(none\); a served target needs exactly one/);
    expect(reasonOf(probed(listing(["glm-5", "warmind"])))).toMatch(/lists 2 models \(glm-5, warmind\)/);
  });

  it("refuses a served model Pi's catalog does not declare", () => {
    expect(causeOf(probed(listing(["mystery"])))).toEqual({ kind: "undeclared-model", model: "mystery" });
    expect(reasonOf(probed(listing(["mystery"])))).toMatch(/serves 'mystery', which Pi's models.json does not declare/);
  });

  it("refuses a served id that is not a recordable provider/model ref", () => {
    expect(causeOf(probed(listing(["org/model"]), ["org/model"]))).toMatchObject({ kind: "unrecordable-model", model: "org/model" });
    expect(reasonOf(probed(listing(["org/model"]), ["org/model"]))).toMatch(/not a recordable provider\/model ref/);
  });

  it("refuses a key the server rejects, as a key to fix", () => {
    expect(causeOf(probed(listing(null, 401)))).toEqual({ kind: "key-refused", url: URL, status: 401 });
    expect(reasonOf(probed(listing(null, 401)))).toMatch(/refused the key Loom resolved for provider 'desktop-vllm' \(HTTP 401\); fix the key/);
    expect(causeOf(probed(listing(null, 403)))).toEqual({ kind: "key-refused", url: URL, status: 403 });
  });

  it("refuses an unreachable server, any other status, and an unreadable body", () => {
    expect(causeOf(probed({ kind: "refused", reason: "ECONNREFUSED" }))).toEqual({ kind: "unreachable", url: URL, detail: "ECONNREFUSED" });
    expect(reasonOf(probed({ kind: "refused", reason: "ECONNREFUSED" }))).toMatch(/cannot reach provider 'desktop-vllm' at .*: ECONNREFUSED/);
    expect(causeOf(probed(listing(null, 503)))).toEqual({ kind: "error-status", url: URL, status: 503 });
    expect(causeOf(probed(listing(null, 200)))).toEqual({ kind: "not-a-model-list", url: URL, status: 200 });
    expect(reasonOf(probed(listing(null, 200)))).toMatch(/without an OpenAI-style model list/);
  });

  it("carries a provider with no endpoint, no usable key, or an unreadable config as its typed cause", () => {
    expect(causeOf({ kind: "unconfigured" })).toEqual({ kind: "no-base-url" });
    expect(causeOf({ kind: "keyless", key: { kind: "absent" } })).toEqual({ kind: "no-usable-key", key: { kind: "absent" } });
    expect(causeOf({ kind: "keyless", key: { kind: "command-failed", source: "auth-json" } }))
      .toEqual({ kind: "no-usable-key", key: { kind: "command-failed", source: "auth-json" } });
    expect(causeOf({ kind: "unreadable", detail: "cannot parse models.json: it is not JSON" }))
      .toEqual({ kind: "unreadable-config", detail: "cannot parse models.json: it is not JSON" });
  });

  it("never resolves unless the listing names exactly one catalog model", () => {
    const id = fc.constantFrom("glm-5", "warmind", "other");
    fc.assert(fc.property(fc.array(id, { maxLength: 4 }), fc.integer({ min: 100, max: 599 }), (served, status) => {
      const decided = decideServedModel("desktop-vllm", probed(listing(served, status)));
      const resolvable = status >= 200 && status <= 299 && served.length === 1 && CATALOG.some((model) => model === served[0]);
      expect(decided.kind).toBe(resolvable ? "served" : "unknown");
      if (decided.kind === "served") expect(decided.ref).toEqual({ provider: "desktop-vllm", model: served[0] });
    }));
  });
});

describe("rendering a served-model cause", () => {
  const render = (cause: ServedModelUnknownCause): string => describeServedModelUnknown("desktop-vllm", cause);

  it("names the file a missing or unusable key comes from, with its remedy", () => {
    expect(render({ kind: "no-base-url" })).toMatch(/declares no baseUrl for provider 'desktop-vllm'/);
    expect(render({ kind: "no-usable-key", key: { kind: "absent" } }))
      .toMatch(/neither Pi's auth.json nor its models.json holds a key for provider 'desktop-vllm'/);
    expect(render({ kind: "no-usable-key", key: { kind: "unset-variables", source: "models-json", names: ["VLLM_KEY"] } }))
      .toMatch(/the apiKey Pi's models.json declares for provider 'desktop-vllm' names unset environment variable VLLM_KEY; set it/);
    expect(render({ kind: "no-usable-key", key: { kind: "unset-variables", source: "auth-json", names: ["A", "B"] } }))
      .toMatch(/the credential Pi's auth.json stores .* variables A, B; set them/);
    expect(render({ kind: "no-usable-key", key: { kind: "command-failed", source: "models-json" } }))
      .toMatch(/the key command in the apiKey Pi's models.json declares .* failed or printed nothing/);
    expect(render({ kind: "no-usable-key", key: { kind: "stored-credential-keyless", credential: "oauth" } }))
      .toMatch(/auth.json stores an oauth credential .* that holds no key, and Pi sends no other/);
    expect(render({ kind: "no-usable-key", key: { kind: "stored-credential-keyless", credential: "api_key" } }))
      .toMatch(/stores an api_key credential .* remove the entry so the models.json apiKey applies/);
    expect(render({ kind: "no-usable-key", key: { kind: "not-a-header-value", source: "auth-json" } }))
      .toMatch(/the credential Pi's auth.json stores .* resolves to a value an HTTP header cannot carry/);
  });

  it("renders the routing context's own causes", () => {
    expect(render({ kind: "not-probed" })).toBe("the routing context did not probe it");
    expect(render({ kind: "foreign-model", provider: "other", model: "m" })).toMatch(/answered other\/m, a model of another provider/);
    expect(render({ kind: "unreadable-config", detail: "cannot parse auth.json: it is not JSON" })).toBe("cannot parse auth.json: it is not JSON");
  });
});
