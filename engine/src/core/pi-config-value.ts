/**
 * Pi's config-value grammar, the one Pi resolves a provider's `apiKey` in
 * `models.json` with (core/resolve-config-value.js in the Pi package), as a
 * pure parse plus a pure template resolution. Loom reads the same key Pi
 * would, so the two must agree on what a value means:
 *
 * - a value starting with `!` is a shell command; its trimmed stdout is the
 *   value (empty output means no value);
 * - otherwise it is a template: `$NAME` and `${NAME}` interpolate an
 *   environment variable (an unset or empty one leaves the whole value
 *   unresolved), `$$` is a literal `$`, `$!` a literal `!`, and anything else
 *   is literal text.
 *
 * Running the command is I/O and belongs to the shell
 * (`utils/served-model-probe.ts`); this module only says which it is.
 */

/** One piece of a template value. */
export type TemplatePart =
  | Readonly<{ kind: "literal"; text: string }>
  | Readonly<{ kind: "env"; name: string }>;

/** What a config value asks for. */
export type ConfigValueReference =
  | Readonly<{ kind: "command"; command: string }>
  | Readonly<{ kind: "template"; parts: readonly TemplatePart[] }>;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_NAME_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/;

/** Append literal text, merging it into a preceding literal. */
function withLiteral(parts: readonly TemplatePart[], text: string): readonly TemplatePart[] {
  if (text === "") return parts;
  const last = parts[parts.length - 1];
  return last?.kind === "literal"
    ? [...parts.slice(0, -1), Object.freeze({ kind: "literal" as const, text: last.text + text })]
    : [...parts, Object.freeze({ kind: "literal" as const, text })];
}

/** Parse a non-command value into literal and environment parts, exactly as Pi does. */
function parseTemplate(value: string): readonly TemplatePart[] {
  let parts: readonly TemplatePart[] = [];
  let index = 0;
  while (index < value.length) {
    const dollar = value.indexOf("$", index);
    if (dollar < 0) return withLiteral(parts, value.slice(index));
    parts = withLiteral(parts, value.slice(index, dollar));
    const next = value[dollar + 1];
    if (next === "$" || next === "!") {
      parts = withLiteral(parts, next);
      index = dollar + 2;
      continue;
    }
    if (next === "{") {
      const end = value.indexOf("}", dollar + 2);
      if (end < 0) {
        parts = withLiteral(parts, "$");
        index = dollar + 1;
        continue;
      }
      const name = value.slice(dollar + 2, end);
      parts = ENV_NAME.test(name)
        ? [...parts, Object.freeze({ kind: "env" as const, name })]
        : withLiteral(parts, value.slice(dollar, end + 1));
      index = end + 1;
      continue;
    }
    const named = value.slice(dollar + 1).match(ENV_NAME_PREFIX);
    if (named !== null) {
      parts = [...parts, Object.freeze({ kind: "env" as const, name: named[0] })];
      index = dollar + 1 + named[0].length;
      continue;
    }
    parts = withLiteral(parts, "$");
    index = dollar + 1;
  }
  return parts;
}

/** What a raw config value asks for: a command to run, or a template to interpolate. */
export function parseConfigValueReference(value: string): ConfigValueReference {
  return value.startsWith("!")
    ? Object.freeze({ kind: "command", command: value.slice(1) })
    : Object.freeze({ kind: "template", parts: Object.freeze(parseTemplate(value)) });
}

/** The environment variables a template names, in first-seen order. */
export function templateVariables(parts: readonly TemplatePart[]): readonly string[] {
  return Object.freeze([...new Set(parts.flatMap((part) => (part.kind === "env" ? [part.name] : [])))]);
}

/**
 * A template's value under `env`, or null when a variable it names is unset
 * or empty — Pi treats an empty variable as missing, so the key is absent
 * rather than an empty string.
 */
export function resolveTemplate(
  parts: readonly TemplatePart[],
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  let resolved = "";
  for (const part of parts) {
    if (part.kind === "literal") {
      resolved += part.text;
      continue;
    }
    const value = env[part.name];
    if (value === undefined || value === "") return null;
    resolved += value;
  }
  return resolved;
}
