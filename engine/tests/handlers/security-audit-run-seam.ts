/**
 * The security-audit CLI seam as the handler tests cross it: one invocation is
 * `<op> --out <dir> …` with a stdin payload, exactly the way `cli.ts` invokes
 * the handler, and its outcome is accepted or refused WITH the refusal.
 *
 * A leaf: both harnesses (`security-audit-harness.ts`, the run lifecycle, and
 * `security-verification-harness.ts`, the ballot-obtaining program) read the
 * `Run` shape from here, so neither imports the other back.
 */

import { createSecurityAuditHandler } from "../../src/handlers/helpers/security-audit";

/** One invocation's outcome: accepted, or refused WITH the refusal — never
 *  one without the other. */
export type Invocation =
  | Readonly<{ ok: true; error: null }>
  | Readonly<{ ok: false; error: string }>;

export type Run = Readonly<{
  out: string;
  /** What the LAST invocation printed. */
  stdout: () => string;
  invoke: (args: readonly string[], stdin?: string) => Promise<Invocation>;
}>;

/** One invocation against the run directory `out`, and what it printed. The
 *  one place the `[op, --out, out, ...rest]` argv convention is spelled. */
export async function invokeAt(
  out: string,
  args: readonly string[],
  stdin = "",
): Promise<Readonly<{ invocation: Invocation; printed: string }>> {
  let printed = "";
  const result = await createSecurityAuditHandler((text) => { printed += `${text}\n`; })(stdin, [args[0] ?? "", "--out", out, ...args.slice(1)]);
  const invocation: Invocation = result?.kind === "error" ? { ok: false, error: String(result.message ?? "") } : { ok: true, error: null };
  return { invocation, printed };
}
