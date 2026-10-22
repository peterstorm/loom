/**
 * Wire-graph edits to one Task's frozen `red-then-green` obligation, for tests
 * holding a stored Proof to (or against) an I6 era. Pure: each returns a new
 * graph and leaves its input untouched.
 */

type WireProof = Readonly<{
  obligations: readonly Readonly<{ kind: string }>[];
  results: readonly Readonly<{ obligation: Readonly<{ kind: string }> }>[];
}>;

type WireGraph = Readonly<Record<string, unknown>>;

const withProof = (raw: WireGraph, id: string, edit: (proof: WireProof) => WireProof): Record<string, unknown> => ({
  ...raw,
  tasks: (raw.tasks as readonly Record<string, unknown>[]).map((task) =>
    task.id === id ? { ...task, proof: edit(task.proof as WireProof) } : task),
});

const RED_THEN_GREEN = "red-then-green";

/** `raw` with `id`'s red-then-green obligation and result removed (a no-op when it carries none). */
export const withoutRedThenGreen = (raw: WireGraph, id: string): Record<string, unknown> =>
  withProof(raw, id, (proof) => ({
    ...proof,
    obligations: proof.obligations.filter(({ kind }) => kind !== RED_THEN_GREEN),
    results: proof.results.filter(({ obligation }) => obligation.kind !== RED_THEN_GREEN),
  }));

/** `raw` with `id` owing I6: one pending red-then-green right after new-tests, where population derives it. */
export const withRedThenGreen = (raw: WireGraph, id: string): Record<string, unknown> =>
  withProof(withoutRedThenGreen(raw, id), id, (proof) => {
    const at = proof.obligations.findIndex(({ kind }) => kind === "new-tests") + 1;
    const obligation = { kind: RED_THEN_GREEN };
    return {
      ...proof,
      obligations: [...proof.obligations.slice(0, at), obligation, ...proof.obligations.slice(at)],
      results: [...proof.results.slice(0, at), { state: "pending", obligation }, ...proof.results.slice(at)],
    };
  });
