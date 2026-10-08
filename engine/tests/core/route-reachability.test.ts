import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decideRouteReachability,
  distinctRoutes,
  modelsUrl,
  reachabilityRefusal,
  type RouteProbe,
} from "../../src/core/route-reachability";
import type { PiBinding } from "../../src/core/model-profiles";

const LOCAL: PiBinding = { harness: "pi", provider: "desktop-vllm", model: "glm-5.3-flash-spark-tp2-v14", thinking: "high" };
const ENDPOINT = { provider: "desktop-vllm", baseUrl: "http://192.168.0.80:8000/v1/" };
const URL = "http://192.168.0.80:8000/v1/models";

const answered = (status: number, servedModels: readonly string[] | null = null): RouteProbe =>
  ({ kind: "answered", status, servedModels });

describe("decideRouteReachability", () => {
  it("is reachable when the server lists the model", () => {
    expect(decideRouteReachability(LOCAL, ENDPOINT, answered(200, ["other", LOCAL.model])))
      .toEqual({ kind: "reachable", route: "desktop-vllm/glm-5.3-flash-spark-tp2-v14", url: URL, served: "listed" });
  });

  it("is unreachable when the server answers but does not serve the model", () => {
    expect(decideRouteReachability(LOCAL, ENDPOINT, answered(200, ["qwen3.8-27b"]))).toMatchObject({
      kind: "unreachable", url: URL, reason: expect.stringContaining("does not serve 'glm-5.3-flash-spark-tp2-v14'"),
    });
  });

  it.each([401, 403])("treats an authentication refusal (HTTP %i) as a live server whose list is unobservable", (status) => {
    expect(decideRouteReachability(LOCAL, ENDPOINT, answered(status))).toMatchObject({ kind: "reachable", served: "unlisted" });
  });

  it("is reachable but unlisted when a 2xx body lists nothing readable", () => {
    expect(decideRouteReachability(LOCAL, ENDPOINT, answered(200))).toMatchObject({ kind: "reachable", served: "unlisted" });
  });

  it("is unreachable when the connection is refused", () => {
    expect(decideRouteReachability(LOCAL, ENDPOINT, { kind: "refused", reason: "fetch failed (connect ECONNREFUSED)" }))
      .toEqual({ kind: "unreachable", route: "desktop-vllm/glm-5.3-flash-spark-tp2-v14", url: URL, reason: "fetch failed (connect ECONNREFUSED)" });
  });

  it("is unconfigured when Pi declares no endpoint for the provider", () => {
    expect(decideRouteReachability(LOCAL, null, null)).toMatchObject({
      kind: "unconfigured", reason: expect.stringContaining("'desktop-vllm'"),
    });
  });

  it("decides every non-auth, non-2xx status unreachable (property)", () => {
    fc.assert(fc.property(
      fc.integer({ min: 100, max: 599 }).filter((status) => (status < 200 || status > 299) && status !== 401 && status !== 403),
      (status) => {
        expect(decideRouteReachability(LOCAL, ENDPOINT, answered(status, [LOCAL.model]))).toMatchObject({
          kind: "unreachable", reason: `GET /models answered HTTP ${status}`,
        });
      },
    ));
  });
});

describe("reachabilityRefusal", () => {
  it("is null when every route is reachable", () => {
    expect(reachabilityRefusal([decideRouteReachability(LOCAL, ENDPOINT, answered(200, [LOCAL.model]))])).toBeNull();
  });

  it("names every refused route, its URL and the reason, and says nothing was spawned", () => {
    const refusal = reachabilityRefusal([
      decideRouteReachability(LOCAL, ENDPOINT, { kind: "refused", reason: "timed out" }),
      decideRouteReachability({ provider: "llama.cpp", model: "m" }, null, null),
    ]);
    expect(refusal).toContain(`route desktop-vllm/glm-5.3-flash-spark-tp2-v14 is unreachable at ${URL}: timed out`);
    expect(refusal).toContain("route llama.cpp/m is unconfigured");
    expect(refusal).toContain("nothing was spawned");
  });
});

describe("route helpers", () => {
  it("joins the models path onto a base URL with or without a trailing slash", () => {
    expect(modelsUrl({ provider: "p", baseUrl: "http://h/v1" })).toBe("http://h/v1/models");
    expect(modelsUrl({ provider: "p", baseUrl: "http://h/v1//" })).toBe("http://h/v1/models");
  });

  it("probes each route once, in first-seen order, whatever the thinking level", () => {
    expect(distinctRoutes([LOCAL, { ...LOCAL, thinking: "high" }, LOCAL]).map(({ model }) => model)).toEqual([LOCAL.model]);
  });
});
