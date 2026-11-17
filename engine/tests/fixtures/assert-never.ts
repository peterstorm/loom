/**
 * The totality proof every fixture `switch` over a union ends with. No engine
 * module exports one, so the fixtures share this single declaration: a new
 * variant fails to compile at each `default: return assertNever(x)` arm, and a
 * value smuggled past the type throws naming itself.
 */
export function assertNever(value: never): never {
  throw new Error(`unreachable variant: ${JSON.stringify(value)}`);
}
