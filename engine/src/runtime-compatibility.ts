import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * Runtime identity published by the in-memory Pi extension and required by
 * fresh Loom CLI mutators. The revision is content-addressed so changing any
 * loaded extension/engine source invalidates the handshake automatically.
 */
export type LoomRuntimeIdentity = Readonly<{
  packageRoot: string;
  revision: string;
}>;

export const PI_EXTENSION_RUNTIME_ROOT_ENV = "LOOM_PI_EXTENSION_RUNTIME_ROOT";
export const PI_EXTENSION_RUNTIME_REVISION_ENV = "LOOM_PI_EXTENSION_RUNTIME_REVISION";

const RUNTIME_SOURCE_ROOTS = ["engine/src", "pi"] as const;
const RUNTIME_IDENTITY_FILES = ["package.json", "engine/package.json", "engine/bun.lock"] as const;
const REVISION_DOMAIN = "loom-runtime-revision-v1";

export type RuntimeRevisionEntry = Readonly<{
  path: string;
  bytes: Uint8Array;
}>;

/** Pure content-addressing core. Paths and bytes are both bound into the hash. */
export function runtimeRevisionFromEntries(entries: readonly RuntimeRevisionEntry[]): string {
  const ordered = [...entries].sort((left, right) => left.path.localeCompare(right.path));
  const duplicate = ordered.find((entry, index) => index > 0 && ordered[index - 1]?.path === entry.path);
  if (duplicate !== undefined) throw new Error(`duplicate Loom runtime revision path ${duplicate.path}`);

  const hash = createHash("sha256");
  hash.update(`${REVISION_DOMAIN}\0`);
  for (const entry of ordered) {
    const bytes = Buffer.from(entry.bytes);
    hash.update(`${Buffer.byteLength(entry.path, "utf8")}\0${entry.path}\0${bytes.byteLength}\0`);
    hash.update(bytes);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function revisionFiles(packageRoot: string): readonly string[] {
  const files: string[] = [];
  const visit = (absolute: string): void => {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      throw new Error(`Loom runtime source must not be a symbolic link: ${absolute}`);
    }
    if (stat.isDirectory()) {
      for (const child of readdirSync(absolute).sort()) visit(join(absolute, child));
      return;
    }
    if (!stat.isFile()) throw new Error(`Loom runtime source must be a regular file: ${absolute}`);
    files.push(absolute);
  };

  for (const sourceRoot of RUNTIME_SOURCE_ROOTS) visit(join(packageRoot, sourceRoot));
  for (const identityFile of RUNTIME_IDENTITY_FILES) visit(join(packageRoot, identityFile));
  return files;
}

/** Capture the mutable checkout bytes that one process is about to load/use. */
export function captureLoomRuntimeIdentity(rawPackageRoot: string): LoomRuntimeIdentity {
  const packageRoot = realpathSync(resolve(rawPackageRoot));
  const entries = revisionFiles(packageRoot).map((absolute): RuntimeRevisionEntry => Object.freeze({
    path: relative(packageRoot, absolute).split(sep).join("/"),
    bytes: readFileSync(absolute),
  }));
  return Object.freeze({ packageRoot, revision: runtimeRevisionFromEntries(entries) });
}

export type RuntimeCompatibility =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      kind: "handshake-missing" | "package-root-mismatch" | "revision-mismatch";
      message: string;
    }>;

const restartDiagnostic = (detail: string): string => [
  "Loom runtime version skew detected; no CLI mutation was performed.",
  detail,
  "The running Pi process has a different in-memory Loom runtime than the CLI checkout on disk.",
  "Run /reload in Pi (or fully exit and restart Pi), then retry the exact command.",
  "Do not edit the protected TaskGraph or Run Directory to work around this diagnostic.",
].join(" ");

/** Compare an already-captured extension identity with the checkout now on disk. */
export function loadedRuntimeCompatibility(
  loaded: LoomRuntimeIdentity,
  current: LoomRuntimeIdentity,
): RuntimeCompatibility {
  if (loaded.packageRoot !== current.packageRoot) {
    return Object.freeze({
      ok: false,
      kind: "package-root-mismatch",
      message: restartDiagnostic(
        `Pi loaded Loom from ${loaded.packageRoot}, but this command resolves to ${current.packageRoot}.`,
      ),
    });
  }
  if (loaded.revision !== current.revision) {
    return Object.freeze({
      ok: false,
      kind: "revision-mismatch",
      message: restartDiagnostic(
        `Pi loaded runtime revision ${loaded.revision}, but the checkout is ${current.revision}.`,
      ),
    });
  }
  return Object.freeze({ ok: true });
}

/** Parse the Pi-published handshake and compare it with a fresh CLI identity. */
export function piCliMutationCompatibility(
  env: Readonly<Record<string, string | undefined>>,
  current: LoomRuntimeIdentity,
): RuntimeCompatibility {
  if (env.PI_CODING_AGENT !== "true") return Object.freeze({ ok: true });

  const packageRoot = env[PI_EXTENSION_RUNTIME_ROOT_ENV];
  const revision = env[PI_EXTENSION_RUNTIME_REVISION_ENV];
  if (packageRoot === undefined || revision === undefined) {
    return Object.freeze({
      ok: false,
      kind: "handshake-missing",
      message: restartDiagnostic(
        "The running Pi extension did not publish a Loom runtime revision (the session may predate the handshake).",
      ),
    });
  }
  return loadedRuntimeCompatibility(Object.freeze({ packageRoot, revision }), current);
}

/** Throwing shell boundary used immediately before protected-state writes. */
export function assertPiCliMutationCompatible(
  env: Readonly<Record<string, string | undefined>>,
  current: LoomRuntimeIdentity,
): void {
  const compatibility = piCliMutationCompatibility(env, current);
  if (!compatibility.ok) throw new Error(compatibility.message);
}
