/**
 * The panel publication fixture's store isolation: each
 * `createPanelPublications()` store owns its registrations and effect-id
 * sequence, so issued identities never depend on what another suite (or an
 * earlier test) issued, and one store's resolver never resolves another's
 * publications.
 */
import { describe, expect, it } from "vitest";
import type { BatchPublicationIdentity, SpawnRequest } from "../../src/core/orchestration-contract";
import { createPanelPublications } from "./panel-authority";

const identityOf = ({ issuance }: SpawnRequest): BatchPublicationIdentity => ({
  schemaVersion: 1,
  kind: "batch-publication-identity",
  runId: issuance.runId,
  effectId: issuance.effectId,
  publicationDigest: issuance.publicationDigest,
});

describe("createPanelPublications", () => {
  it("mints the same effect ids in every fresh store, whatever another store issued first", () => {
    const earlier = createPanelPublications();
    earlier.refutationPanelFixture("run.store-isolation.earlier", ["reproduction"]);
    earlier.architecturePanelFixture("run.store-isolation.earlier-arch");
    const first = createPanelPublications().refutationPanelFixture("run.store-isolation", ["reproduction"]);
    const second = createPanelPublications().refutationPanelFixture("run.store-isolation", ["reproduction"]);
    expect(first.requests[0]!.issuance.effectId).toBe("effect:panel-fixture:1");
    expect(second.requests.map(({ issuance }) => issuance)).toEqual(first.requests.map(({ issuance }) => issuance));
  });

  it("resolves only the publications its own store registered", () => {
    const owner = createPanelPublications();
    const stranger = createPanelPublications();
    const request = owner.refutationPanelFixture("run.store-isolation.owner", ["reproduction"]).requests[0]!;
    expect(owner.resolver(identityOf(request)).ok).toBe(true);
    expect(stranger.resolver(identityOf(request)).ok).toBe(false);
  });

  it("restores a rewritten registration after the body, even when the body throws", () => {
    const store = createPanelPublications();
    const request = store.refutationPanelFixture("run.store-isolation.rewrite", ["reproduction"]).requests[0]!;
    const failure = new Error("body failed");
    expect(() => store.withRewrittenPanelRegistration(request, (receipt) => ({ ...receipt, requestIds: [] }), () => {
      expect(store.resolver(identityOf(request)).ok).toBe(false);
      throw failure;
    })).toThrow(failure);
    expect(store.resolver(identityOf(request)).ok).toBe(true);
  });
});
