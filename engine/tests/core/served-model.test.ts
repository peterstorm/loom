/**
 * The served-model decision (`core/served-model.ts`): a `served` routing
 * target resolves to the one model its provider lists, and to an actionable
 * reason — never a fallback model — for every way the listing can fail.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decideServedModel, type ServedProviderObservation } from "../../src/core/served-model";
import type { RouteProbe } from "../../src/core/route-reachability";

const URL = "http://127.0.0.1:8000/v1/models";
const CATALOG = ["glm-5", "warmind"] as const;
const probed = (probe: RouteProbe, catalog: readonly string[] = CATALOG): ServedProviderObservation =>
  ({ kind: "probed", url: URL, catalog, probe });
const listing = (servedModels: readonly string[] | null, status = 200): RouteProbe =>
  ({ kind: "answered", status, servedModels });
const reasonOf = (observation: ServedProviderObservation): string => {
  const decided = decideServedModel("desktop-vllm", observation);
  if (decided.kind !== "unknown") throw new Error(`expected no served model, got ${JSON.stringify(decided)}`);
  return decided.reason;
};

describe("served-model decision", () => {
  it("resolves the one listed model, declared in the catalog, to an exact ref", () => {
    expect(decideServedModel("desktop-vllm", probed(listing(["warmind"])))).toEqual({
      kind: "served",
      ref: { provider: "desktop-vllm", model: "warmind" },
    });
  });

  it("refuses a listing of zero or several models, naming them", () => {
    expect(reasonOf(probed(listing([])))).toMatch(/lists 0 models \(none\); a served target needs exactly one/);
    expect(reasonOf(probed(listing(["glm-5", "warmind"])))).toMatch(/lists 2 models \(glm-5, warmind\)/);
  });

  it("refuses a served model Pi's catalog does not declare", () => {
    expect(reasonOf(probed(listing(["mystery"])))).toMatch(/serves 'mystery', which Pi's models.json does not declare/);
  });

  it("refuses a served id that is not a recordable provider/model ref", () => {
    expect(reasonOf(probed(listing(["org/model"]), ["org/model"]))).toMatch(/not a recordable provider\/model ref/);
  });

  it("refuses a key the server rejects, as a key to fix", () => {
    expect(reasonOf(probed(listing(null, 401)))).toMatch(/refused the apiKey .* \(HTTP 401\); fix the key/);
    expect(reasonOf(probed(listing(null, 403)))).toMatch(/HTTP 403/);
  });

  it("refuses an unreachable server, any other status, and an unreadable body", () => {
    expect(reasonOf(probed({ kind: "refused", reason: "ECONNREFUSED" }))).toMatch(/cannot reach provider 'desktop-vllm' at .*: ECONNREFUSED/);
    expect(reasonOf(probed(listing(null, 503)))).toMatch(/answered HTTP 503/);
    expect(reasonOf(probed(listing(null, 200)))).toMatch(/without an OpenAI-style model list/);
  });

  it("refuses a provider with no endpoint, no key, or an unreadable models.json", () => {
    expect(reasonOf({ kind: "unconfigured" })).toMatch(/declares no baseUrl for provider 'desktop-vllm'/);
    expect(reasonOf({ kind: "keyless", missing: { kind: "absent" } })).toMatch(/declares no apiKey/);
    expect(reasonOf({ kind: "keyless", missing: { kind: "unset-variables", names: ["VLLM_KEY"] } }))
      .toMatch(/names unset environment variable VLLM_KEY; set it/);
    expect(reasonOf({ kind: "keyless", missing: { kind: "unset-variables", names: ["A", "B"] } }))
      .toMatch(/variables A, B; set them/);
    expect(reasonOf({ kind: "keyless", missing: { kind: "command-failed" } })).toMatch(/apiKey command .* failed or printed nothing/);
    expect(reasonOf({ kind: "unreadable", reason: "cannot parse models.json" })).toBe("cannot parse models.json");
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
