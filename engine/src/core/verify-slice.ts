/**
 * The Verify Slice: which part of `npm run verify` one invocation runs.
 *
 * `npm run verify` is the one verification command for local runs, CI and
 * Loom's own Verification Manifest. Unset, it runs every tier in order:
 * typecheck, lint, the whole Vitest suite, then the smoke scripts. CI sets
 * `LOOM_VERIFY_SLICE` per matrix job so the tiers, and Vitest's file-level
 * shards, run in parallel jobs: `static` (typecheck and lint), `unit:<i>/<n>`
 * (Vitest shard i of n) and `smoke`. The CI matrix lists every slice, so the
 * union of its jobs is the whole command.
 *
 * Pure: the shell reads the environment and spawns the planned npm scripts.
 */

import type { DomainResult } from "./orchestration-contract";

export type VerifySlice =
  | Readonly<{ kind: "all" }>
  | Readonly<{ kind: "static" }>
  | Readonly<{ kind: "unit"; index: number; total: number }>
  | Readonly<{ kind: "smoke" }>;

/** One npm script and the arguments appended after `--`. */
export type VerifyStep = Readonly<{ script: string; args: readonly string[] }>;

export const VERIFY_SLICE_VARIABLE = "LOOM_VERIFY_SLICE";

const UNIT_SHARD = /^unit:([1-9][0-9]*)\/([1-9][0-9]*)$/;

const ok = <T>(value: T): DomainResult<T, never> => Object.freeze({ ok: true as const, value });
const fail = (error: string): DomainResult<never, string> => Object.freeze({ ok: false as const, error });

/** The slice `raw` names; an absent or empty value is the whole command. */
export function parseVerifySlice(raw: string | undefined): DomainResult<VerifySlice, string> {
  if (raw === undefined || raw === "") return ok(Object.freeze({ kind: "all" as const }));
  if (raw === "static" || raw === "smoke") return ok(Object.freeze({ kind: raw }));
  const shard = UNIT_SHARD.exec(raw);
  const index = Number(shard?.[1]);
  const total = Number(shard?.[2]);
  if (shard === null || !Number.isSafeInteger(total) || index > total) {
    return fail(`${VERIFY_SLICE_VARIABLE} must be static, smoke or unit:<i>/<n> with 1 <= i <= n, got ${JSON.stringify(raw)}`);
  }
  return ok(Object.freeze({ kind: "unit" as const, index, total }));
}

const step = (script: string, ...args: string[]): VerifyStep => Object.freeze({ script, args: Object.freeze(args) });

/** The npm scripts a slice runs, in order; the run stops at the first failure. */
export function verifySteps(slice: VerifySlice): readonly VerifyStep[] {
  switch (slice.kind) {
    case "all":
      return [step("typecheck"), step("lint"), step("test:unit"), step("test:smoke")];
    case "static":
      return [step("typecheck"), step("lint")];
    case "unit":
      return [step("test:unit", `--shard=${slice.index}/${slice.total}`)];
    case "smoke":
      return [step("test:smoke")];
    default:
      return assertNever(slice);
  }
}

function assertNever(value: never): never {
  throw new Error(`unreachable verify slice: ${JSON.stringify(value)}`);
}
