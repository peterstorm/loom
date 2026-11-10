/**
 * The one sandbox receipt fixture: the JSON body `scripts/security-sandbox.sh`
 * prints after its marker, describing a bounded run. Tests override exactly
 * the facts they are about, so every receipt they parse is otherwise the
 * script's own shape — including the exact `allowlistedEnv` the script passes.
 */

import { DEFAULT_SANDBOX_LIMITS, SANDBOX_ENV_ALLOWLIST, sandboxReceiptPrefix } from "../../src/core/security-sandbox";

/** The nonce every fixture run and receipt is bound to: a receipt the caller
 *  cannot bind is not evidence, so fixtures are built the way the script builds
 *  them — the caller's nonce in the marker. */
export const NONCE = "0123456789abcdef";

/** A receipt body (no marker) of a run that stayed inside every limit. */
export const aSandboxReceipt = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schemaVersion: 1,
    exit: 0,
    limits: { ...DEFAULT_SANDBOX_LIMITS },
    allowlistedEnv: [...SANDBOX_ENV_ALLOWLIST],
    scratchBytes: 12,
    networkNamespace: true,
    loopbackUp: true,
    targetReadOnly: true,
    readOnlyRoot: false,
    homeReadOnly: true,
    unremountedMounts: 0,
    enforced: { cpu: true, memory: true, processes: true, fileSize: true },
    ...overrides,
  });

/** A receipt as the script prints it — marker bound to `nonce`, then the body
 *  of `aSandboxReceipt(overrides)`. */
export const boundReceipt = (overrides: Record<string, unknown> = {}, nonce: string = NONCE): string =>
  `${sandboxReceiptPrefix(nonce)}${aSandboxReceipt(overrides)}`;
