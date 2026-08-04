/**
 * Deterministic Review Packet construction and verification.
 *
 * This module is a functional core: callers supply already-read task context,
 * git identities, and artifact bytes. It performs no filesystem or git I/O.
 */

import { createHash } from "node:crypto";
import { fail, isRecord, ok, type ParseResult } from "./panel-kernel";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = Readonly<{ [key: string]: JsonValue }>;

export const REVIEW_PACKET_SCHEMA_VERSION = 2 as const;
export const REVIEW_ARTIFACT_KINDS = ["diff", "postimage"] as const;
export type ReviewArtifactKind = (typeof REVIEW_ARTIFACT_KINDS)[number];
export const REVIEW_POSTIMAGE_ENCODINGS = ["utf8", "base64"] as const;
export type ReviewPostimageEncoding = (typeof REVIEW_POSTIMAGE_ENCODINGS)[number];

export interface ReviewPacketArtifactInput {
  readonly path: string;
  readonly diff: string;
  /** Original file bytes. Null means deletion at the packet's head revision. */
  readonly postimage: Uint8Array | null;
}

export interface ReviewPacketInput {
  readonly task: JsonObject;
  readonly baseSha: string;
  readonly headSha: string;
  readonly declaredPaths: readonly string[];
  readonly modifiedPaths: readonly string[];
  readonly artifacts: readonly ReviewPacketArtifactInput[];
  readonly planContext: JsonValue;
  readonly proofObligations: readonly JsonValue[];
}

export interface HashedReviewArtifactContent {
  readonly sha256: string;
  readonly content: string;
}

export interface HashedReviewPostimage {
  readonly sha256: string;
  readonly encoding: ReviewPostimageEncoding;
  readonly content: string;
}

export interface ReviewPacketArtifact {
  readonly path: string;
  readonly diff: HashedReviewArtifactContent;
  readonly postimage: HashedReviewPostimage | null;
}

export interface ReviewPacket {
  readonly schemaVersion: typeof REVIEW_PACKET_SCHEMA_VERSION;
  readonly packetId: string;
  readonly task: JsonObject;
  readonly baseSha: string;
  readonly headSha: string;
  readonly declaredPaths: readonly string[];
  readonly modifiedPaths: readonly string[];
  readonly artifacts: readonly ReviewPacketArtifact[];
  readonly planContext: JsonValue;
  readonly proofObligations: readonly JsonValue[];
}

type PacketBody = Omit<ReviewPacket, "packetId">;

/** Minimal, byte-hash-aware packet projection accepted by the explicit
 * historical write-evidence recovery boundary. Schema v1 remains readable
 * only here: its UTF-8 postimage hashes can recover text paths, while lossy
 * binary postimages naturally fail the current-byte hash comparison. */
export interface VerifiedReviewPacketRecovery {
  readonly schemaVersion: 1 | typeof REVIEW_PACKET_SCHEMA_VERSION;
  readonly packetId: string;
  readonly taskId: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly declaredPaths: readonly string[];
  readonly modifiedPaths: readonly string[];
  readonly artifacts: readonly Readonly<{
    path: string;
    postimageSha256: string | null;
  }>[];
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseJsonValue(raw: unknown, label: string): ParseResult<JsonValue> {
  const visiting = new WeakSet<object>();

  const visit = (value: unknown, path: string): ParseResult<JsonValue> => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return ok(value);
    if (typeof value === "number") {
      return Number.isFinite(value) ? ok(value) : fail([`${path} must be a finite JSON number`]);
    }
    if (typeof value !== "object") return fail([`${path} must be JSON data`]);
    if (visiting.has(value)) return fail([`${path} must not contain a cycle`]);
    visiting.add(value);

    if (Array.isArray(value)) {
      const values: JsonValue[] = [];
      const errors: string[] = [];
      value.forEach((entry, index) => {
        const parsed = visit(entry, `${path}[${index}]`);
        if (parsed.ok) values.push(parsed.value);
        else errors.push(...parsed.errors);
      });
      visiting.delete(value);
      return errors.length === 0 ? ok(values) : fail(errors);
    }

    const record = value as Record<string, unknown>;
    const result: Record<string, JsonValue> = {};
    const errors: string[] = [];
    for (const key of Object.keys(record).sort(compareStrings)) {
      const parsed = visit(record[key], `${path}.${key}`);
      if (parsed.ok) result[key] = parsed.value;
      else errors.push(...parsed.errors);
    }
    visiting.delete(value);
    return errors.length === 0 ? ok(result) : fail(errors);
  };

  return visit(raw, label);
}

function parseJsonObject(raw: unknown, label: string): ParseResult<JsonObject> {
  if (!isRecord(raw)) return fail([`${label} must be a JSON object`]);
  const parsed = parseJsonValue(raw, label);
  return parsed.ok && isRecord(parsed.value)
    ? ok(parsed.value as JsonObject)
    : parsed.ok
      ? fail([`${label} must be a JSON object`])
      : parsed;
}

/**
 * A packet path is already canonical repo-relative POSIX syntax. We reject
 * aliases instead of normalizing them: otherwise two spellings could name the
 * same file while producing different packet identities.
 */
export function parseReviewPath(raw: unknown, label = "path"): ParseResult<string> {
  if (typeof raw !== "string" || raw.length === 0) return fail([`${label} must be non-empty`]);
  if (raw.trim() !== raw) return fail([`${label} must not have surrounding whitespace`]);
  if (raw.includes("\0")) return fail([`${label} must not contain NUL`]);
  if (raw.startsWith("/") || WINDOWS_ABSOLUTE.test(raw)) {
    return fail([`${label} must be repository-relative, not absolute`]);
  }
  if (raw.includes("\\")) return fail([`${label} must use POSIX '/' separators`]);
  const segments = raw.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return fail([`${label} must be canonical and must not contain traversal segments`]);
  }
  return ok(raw);
}

function parsePathSet(raw: unknown, label: string): ParseResult<readonly string[]> {
  if (!Array.isArray(raw)) return fail([`${label} must be an array`]);
  const paths: string[] = [];
  const errors: string[] = [];
  raw.forEach((entry, index) => {
    const parsed = parseReviewPath(entry, `${label}[${index}]`);
    if (parsed.ok) paths.push(parsed.value);
    else errors.push(...parsed.errors);
  });
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) errors.push(`${label} repeats path '${path}'`);
    seen.add(path);
  }
  return errors.length === 0 ? ok([...paths].sort(compareStrings)) : fail(errors);
}

function parseGitSha(raw: unknown, label: string): ParseResult<string> {
  if (typeof raw !== "string" || !GIT_SHA.test(raw)) {
    return fail([`${label} must be a lowercase 40- or 64-character hexadecimal git SHA`]);
  }
  return ok(raw);
}

function hashedContentJson(content: HashedReviewArtifactContent): JsonObject {
  return { sha256: content.sha256, content: content.content };
}

function hashedPostimageJson(postimage: HashedReviewPostimage): JsonObject {
  return { sha256: postimage.sha256, encoding: postimage.encoding, content: postimage.content };
}

function packetBodyJson(body: PacketBody): JsonObject {
  const artifacts: readonly JsonValue[] = body.artifacts.map((artifact): JsonObject => ({
    path: artifact.path,
    diff: hashedContentJson(artifact.diff),
    postimage: artifact.postimage === null ? null : hashedPostimageJson(artifact.postimage),
  }));
  return {
    schemaVersion: body.schemaVersion,
    task: body.task,
    baseSha: body.baseSha,
    headSha: body.headSha,
    declaredPaths: body.declaredPaths,
    modifiedPaths: body.modifiedPaths,
    artifacts,
    planContext: body.planContext,
    proofObligations: body.proofObligations,
  };
}

function packetJson(packet: ReviewPacket): JsonObject {
  return { ...packetBodyJson(packet), packetId: packet.packetId };
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/** Stable JSON for hashing and other deterministic boundaries. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (isJsonArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort(compareStrings)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

/** Deterministic SHA-256 over bytes, without an intervening text decode. */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Deterministic SHA-256 over UTF-8 text. */
export function sha256Hex(text: string): string {
  return sha256Bytes(Buffer.from(text, "utf-8"));
}

function freezeJson<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeJson(child);
  }
  return value;
}

type ParsedArtifacts = { readonly artifacts: ReviewPacketArtifact[]; readonly paths: Set<string>; readonly errors: string[] };

/** Encode bytes as readable UTF-8 exactly when that representation is lossless. */
function encodePostimage(bytes: Uint8Array): HashedReviewPostimage {
  const original = Buffer.from(bytes);
  const utf8 = original.toString("utf-8");
  const losslessUtf8 = Buffer.from(utf8, "utf-8").equals(original);
  return {
    sha256: sha256Bytes(original),
    encoding: losslessUtf8 ? "utf8" : "base64",
    content: losslessUtf8 ? utf8 : original.toString("base64"),
  };
}

function decodePostimage(
  encoding: unknown,
  content: unknown,
  label: string,
): ParseResult<Uint8Array> {
  if (!(REVIEW_POSTIMAGE_ENCODINGS as readonly unknown[]).includes(encoding)) {
    return fail([`${label}.encoding must be 'utf8' or 'base64'`]);
  }
  if (typeof content !== "string") return fail([`${label}.content must be a string`]);

  if (encoding === "base64" && (!CANONICAL_BASE64.test(content) || Buffer.from(content, "base64").toString("base64") !== content)) {
    return fail([`${label}.content must be canonical base64`]);
  }

  const bytes = Buffer.from(content, encoding === "utf8" ? "utf-8" : "base64");
  if (encoding === "utf8" && bytes.toString("utf-8") !== content) {
    return fail([`${label}.content must be canonical UTF-8 text`]);
  }
  if (encodePostimage(bytes).encoding !== encoding) {
    return fail([`${label}.encoding must be utf8 whenever the original bytes are valid UTF-8`]);
  }
  return ok(bytes);
}

function parseArtifactInputs(raw: unknown): ParsedArtifacts {
  const artifacts: ReviewPacketArtifact[] = [];
  const paths = new Set<string>();
  const errors: string[] = [];
  if (!Array.isArray(raw)) return { artifacts, paths, errors: ["artifacts must be an array"] };
  raw.forEach((artifact, index) => {
    if (!isRecord(artifact)) {
      errors.push(`artifacts[${index}] must be an object`);
      return;
    }
    const path = parseReviewPath(artifact.path, `artifacts[${index}].path`);
    if (!path.ok) { errors.push(...path.errors); return; }
    if (paths.has(path.value)) errors.push(`artifacts repeats path '${path.value}'`);
    paths.add(path.value);
    if (typeof artifact.diff !== "string") errors.push(`artifacts[${index}].diff must be a string`);
    if (artifact.postimage !== null && !(artifact.postimage instanceof Uint8Array)) {
      errors.push(`artifacts[${index}].postimage must be a Uint8Array or null`);
    }
    if (typeof artifact.diff === "string" && (artifact.postimage === null || artifact.postimage instanceof Uint8Array)) {
      artifacts.push({
        path: path.value,
        diff: { content: artifact.diff, sha256: sha256Hex(artifact.diff) },
        postimage: artifact.postimage === null ? null : encodePostimage(artifact.postimage),
      });
    }
  });
  return { artifacts, paths, errors };
}

function scopeErrors(declared: readonly string[], modified: readonly string[], artifactPaths: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  const scope = new Set([...declared, ...modified]);
  if (scope.size === 0) errors.push("review packet scope must be non-empty");
  for (const path of artifactPaths) {
    if (!scope.has(path)) errors.push(`artifact '${path}' is outside the declared/modified scope`);
  }
  for (const path of scope) {
    if (!artifactPaths.has(path)) errors.push(`scoped path '${path}' has no artifact`);
  }
  return errors;
}

/** Construct a canonical packet from already-read data. */
export function createReviewPacket(input: ReviewPacketInput): ParseResult<ReviewPacket> {
  const task = parseJsonObject(input.task, "task");
  const planContext = parseJsonValue(input.planContext, "planContext");
  const proofObligations = parseJsonValue(input.proofObligations, "proofObligations");
  const baseSha = parseGitSha(input.baseSha, "baseSha");
  const headSha = parseGitSha(input.headSha, "headSha");
  const declaredPaths = parsePathSet(input.declaredPaths, "declaredPaths");
  const modifiedPaths = parsePathSet(input.modifiedPaths, "modifiedPaths");
  const parsed = [task, planContext, proofObligations, baseSha, headSha, declaredPaths, modifiedPaths];
  const errors = parsed.flatMap((result) => result.ok ? [] : result.errors);
  if (task.ok && (typeof task.value.id !== "string" || task.value.id.trim() === "")) errors.push("task.id must be a non-empty string");
  if (proofObligations.ok && !Array.isArray(proofObligations.value)) errors.push("proofObligations must be an array");
  const artifactResult = parseArtifactInputs(input.artifacts);
  errors.push(...artifactResult.errors);
  if (declaredPaths.ok && modifiedPaths.ok) errors.push(...scopeErrors(declaredPaths.value, modifiedPaths.value, artifactResult.paths));
  if (errors.length > 0 || !task.ok || !planContext.ok || !proofObligations.ok || !baseSha.ok || !headSha.ok ||
      !declaredPaths.ok || !modifiedPaths.ok || !Array.isArray(proofObligations.value)) return fail(errors);
  const body: PacketBody = {
    schemaVersion: REVIEW_PACKET_SCHEMA_VERSION, task: task.value, baseSha: baseSha.value, headSha: headSha.value,
    declaredPaths: declaredPaths.value, modifiedPaths: modifiedPaths.value,
    artifacts: [...artifactResult.artifacts].sort((left, right) => compareStrings(left.path, right.path)),
    planContext: planContext.value, proofObligations: proofObligations.value,
  };
  return ok(freezeJson({ ...body, packetId: sha256Hex(canonicalJson(packetBodyJson(body))) }));
}

/** Serialize only the validated canonical domain shape. */
export function serializeReviewPacket(packet: ReviewPacket): string {
  return `${JSON.stringify(packetJson(packet), null, 2)}\n`;
}

function rawPacketObject(raw: unknown): ParseResult<Record<string, unknown>> {
  if (typeof raw !== "string") return isRecord(raw) ? ok(raw) : fail(["review packet must be a JSON object"]);
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? ok(parsed) : fail(["review packet JSON must contain an object"]);
  } catch (error) {
    return fail([`review packet is not valid JSON: ${error instanceof Error ? error.message : "parse failed"}`]);
  }
}

function parseHashedArtifact(entry: unknown, index: number): ParseResult<ReviewPacketArtifactInput> {
  if (!isRecord(entry) || !isRecord(entry.diff)) return fail([`artifacts[${index}] must contain a hashed diff object`]);
  const postimage = entry.postimage;
  if (postimage !== null && !isRecord(postimage)) return fail([`artifacts[${index}].postimage must be a hashed object or null`]);
  if (typeof entry.path !== "string" || typeof entry.diff.content !== "string") return fail([`artifacts[${index}] has invalid path or diff content`]);
  const errors: string[] = [];
  if (typeof entry.diff.sha256 !== "string" || !SHA256_HEX.test(entry.diff.sha256)) {
    errors.push(`artifacts[${index}].diff.sha256 must be a lowercase SHA-256 digest`);
  } else if (entry.diff.sha256 !== sha256Hex(entry.diff.content)) errors.push(`artifacts[${index}].diff.sha256 does not match its content`);

  let postimageBytes: Uint8Array | null = null;
  if (postimage !== null) {
    if (typeof postimage.sha256 !== "string" || !SHA256_HEX.test(postimage.sha256)) {
      errors.push(`artifacts[${index}].postimage.sha256 must be a lowercase SHA-256 digest`);
    }
    const decoded = decodePostimage(postimage.encoding, postimage.content, `artifacts[${index}].postimage`);
    if (!decoded.ok) errors.push(...decoded.errors);
    else {
      postimageBytes = decoded.value;
      if (typeof postimage.sha256 === "string" && SHA256_HEX.test(postimage.sha256) &&
          postimage.sha256 !== sha256Bytes(decoded.value)) {
        errors.push(`artifacts[${index}].postimage.sha256 does not match its decoded bytes`);
      }
    }
  }
  if (errors.length > 0) return fail(errors);
  return ok({ path: entry.path, diff: entry.diff.content, postimage: postimageBytes });
}

function parseHashedArtifacts(raw: unknown): ParseResult<ReviewPacketArtifactInput[]> {
  if (!Array.isArray(raw)) return fail(["artifacts must be an array"]);
  const values: ReviewPacketArtifactInput[] = [];
  const errors: string[] = [];
  raw.forEach((entry, index) => {
    const parsed = parseHashedArtifact(entry, index);
    if (parsed.ok) values.push(parsed.value); else errors.push(...parsed.errors);
  });
  return errors.length > 0 ? fail(errors) : ok(values);
}

/** Parse untrusted JSON, re-canonicalize it, and verify every content hash and packet id. */
export function parseReviewPacket(raw: unknown): ParseResult<ReviewPacket> {
  const object = rawPacketObject(raw);
  if (!object.ok) return object;
  const value = object.value;
  if (value.schemaVersion !== REVIEW_PACKET_SCHEMA_VERSION) return fail([`schemaVersion must equal ${REVIEW_PACKET_SCHEMA_VERSION}`]);
  const artifacts = parseHashedArtifacts(value.artifacts);
  if (!artifacts.ok) return artifacts;
  const rebuilt = createReviewPacket({
    task: value.task as JsonObject, baseSha: value.baseSha as string, headSha: value.headSha as string,
    declaredPaths: value.declaredPaths as readonly string[], modifiedPaths: value.modifiedPaths as readonly string[],
    artifacts: artifacts.value, planContext: value.planContext as JsonValue,
    proofObligations: value.proofObligations as readonly JsonValue[],
  });
  if (!rebuilt.ok) return rebuilt;
  if (typeof value.packetId !== "string" || !SHA256_HEX.test(value.packetId)) return fail(["packetId must be a lowercase SHA-256 digest"]);
  return value.packetId === rebuilt.value.packetId ? rebuilt : fail(["packetId does not match canonical packet content"]);
}

function recoveryProjection(packet: ReviewPacket): VerifiedReviewPacketRecovery {
  return freezeJson({
    schemaVersion: packet.schemaVersion,
    packetId: packet.packetId,
    taskId: packet.task.id as string,
    baseSha: packet.baseSha,
    headSha: packet.headSha,
    declaredPaths: packet.declaredPaths,
    modifiedPaths: packet.modifiedPaths,
    artifacts: packet.artifacts.map((artifact) => ({
      path: artifact.path,
      postimageSha256: artifact.postimage?.sha256 ?? null,
    })),
  });
}

function parseLegacyRecoveryPacket(value: Record<string, unknown>): ParseResult<VerifiedReviewPacketRecovery> {
  const task = parseJsonObject(value.task, "task");
  const planContext = parseJsonValue(value.planContext, "planContext");
  const proofObligations = parseJsonValue(value.proofObligations, "proofObligations");
  const baseSha = parseGitSha(value.baseSha, "baseSha");
  const headSha = parseGitSha(value.headSha, "headSha");
  const declaredPaths = parsePathSet(value.declaredPaths, "declaredPaths");
  const modifiedPaths = parsePathSet(value.modifiedPaths, "modifiedPaths");
  const errors = [task, planContext, proofObligations, baseSha, headSha, declaredPaths, modifiedPaths]
    .flatMap((result) => result.ok ? [] : result.errors);
  if (task.ok && (typeof task.value.id !== "string" || task.value.id.trim() === "")) {
    errors.push("task.id must be a non-empty string");
  }
  if (proofObligations.ok && !Array.isArray(proofObligations.value)) {
    errors.push("proofObligations must be an array");
  }

  const artifacts: Array<{
    path: string;
    diff: HashedReviewArtifactContent;
    postimage: HashedReviewArtifactContent | null;
  }> = [];
  const artifactPaths = new Set<string>();
  if (!Array.isArray(value.artifacts)) errors.push("artifacts must be an array");
  else value.artifacts.forEach((raw, index) => {
    if (!isRecord(raw) || !isRecord(raw.diff)) {
      errors.push(`artifacts[${index}] must contain a hashed diff object`);
      return;
    }
    const path = parseReviewPath(raw.path, `artifacts[${index}].path`);
    if (!path.ok) { errors.push(...path.errors); return; }
    if (artifactPaths.has(path.value)) errors.push(`artifacts repeats path '${path.value}'`);
    artifactPaths.add(path.value);
    if (typeof raw.diff.content !== "string" || typeof raw.diff.sha256 !== "string" ||
        !SHA256_HEX.test(raw.diff.sha256) || raw.diff.sha256 !== sha256Hex(raw.diff.content)) {
      errors.push(`artifacts[${index}].diff must contain UTF-8 content and its lowercase SHA-256 digest`);
      return;
    }
    let postimage: HashedReviewArtifactContent | null = null;
    if (raw.postimage !== null) {
      if (!isRecord(raw.postimage) || typeof raw.postimage.content !== "string" ||
          typeof raw.postimage.sha256 !== "string" || !SHA256_HEX.test(raw.postimage.sha256) ||
          raw.postimage.sha256 !== sha256Hex(raw.postimage.content)) {
        errors.push(`artifacts[${index}].postimage must contain UTF-8 content and its lowercase SHA-256 digest`);
        return;
      }
      postimage = { content: raw.postimage.content, sha256: raw.postimage.sha256 };
    }
    artifacts.push({
      path: path.value,
      diff: { content: raw.diff.content, sha256: raw.diff.sha256 },
      postimage,
    });
  });

  if (declaredPaths.ok && modifiedPaths.ok) {
    errors.push(...scopeErrors(declaredPaths.value, modifiedPaths.value, artifactPaths));
  }
  if (errors.length > 0 || !task.ok || !planContext.ok || !proofObligations.ok ||
      !baseSha.ok || !headSha.ok || !declaredPaths.ok || !modifiedPaths.ok ||
      !Array.isArray(proofObligations.value)) return fail(errors);

  const sortedArtifacts = [...artifacts].sort((left, right) => compareStrings(left.path, right.path));
  const body: JsonObject = {
    schemaVersion: 1,
    task: task.value,
    baseSha: baseSha.value,
    headSha: headSha.value,
    declaredPaths: declaredPaths.value,
    modifiedPaths: modifiedPaths.value,
    artifacts: sortedArtifacts.map((artifact): JsonObject => ({
      path: artifact.path,
      diff: hashedContentJson(artifact.diff),
      postimage: artifact.postimage === null ? null : hashedContentJson(artifact.postimage),
    })),
    planContext: planContext.value,
    proofObligations: proofObligations.value,
  };
  if (typeof value.packetId !== "string" || !SHA256_HEX.test(value.packetId)) {
    return fail(["packetId must be a lowercase SHA-256 digest"]);
  }
  if (value.packetId !== sha256Hex(canonicalJson(body))) {
    return fail(["packetId does not match canonical packet content"]);
  }
  return ok(freezeJson({
    schemaVersion: 1 as const,
    packetId: value.packetId,
    taskId: task.value.id as string,
    baseSha: baseSha.value,
    headSha: headSha.value,
    declaredPaths: declaredPaths.value,
    modifiedPaths: modifiedPaths.value,
    artifacts: sortedArtifacts.map((artifact) => ({
      path: artifact.path,
      postimageSha256: artifact.postimage?.sha256 ?? null,
    })),
  }));
}

/** Verify current packets and legacy v1 text metadata for explicit recovery. */
export function parseReviewPacketRecovery(raw: unknown): ParseResult<VerifiedReviewPacketRecovery> {
  const object = rawPacketObject(raw);
  if (!object.ok) return object;
  if (object.value.schemaVersion === REVIEW_PACKET_SCHEMA_VERSION) {
    const packet = parseReviewPacket(object.value);
    return packet.ok ? ok(recoveryProjection(packet.value)) : packet;
  }
  if (object.value.schemaVersion === 1) return parseLegacyRecoveryPacket(object.value);
  return fail([`schemaVersion must equal 1 or ${REVIEW_PACKET_SCHEMA_VERSION}`]);
}

export const verifyReviewPacket = parseReviewPacket;
export const buildReviewPacket = createReviewPacket;
export const canonicalizeReviewPacket = createReviewPacket;
export const parseAndVerifyReviewPacket = parseReviewPacket;
