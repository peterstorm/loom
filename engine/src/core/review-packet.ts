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

export const REVIEW_PACKET_SCHEMA_VERSION = 1 as const;
export const REVIEW_ARTIFACT_KINDS = ["diff", "postimage"] as const;
export type ReviewArtifactKind = (typeof REVIEW_ARTIFACT_KINDS)[number];

export interface ReviewPacketArtifactInput {
  readonly path: string;
  readonly diff: string;
  /** Null means the path was deleted at the packet's head revision. */
  readonly postimage: string | null;
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

export interface ReviewPacketArtifact {
  readonly path: string;
  readonly diff: HashedReviewArtifactContent;
  readonly postimage: HashedReviewArtifactContent | null;
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

const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

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

function packetBodyJson(body: PacketBody): JsonObject {
  const artifacts: readonly JsonValue[] = body.artifacts.map((artifact): JsonObject => ({
    path: artifact.path,
    diff: hashedContentJson(artifact.diff),
    postimage: artifact.postimage === null ? null : hashedContentJson(artifact.postimage),
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

/** Deterministic SHA-256 over UTF-8 text. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function freezeJson<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeJson(child);
  }
  return value;
}

type ParsedArtifacts = { readonly artifacts: ReviewPacketArtifact[]; readonly paths: Set<string>; readonly errors: string[] };

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
    if (artifact.postimage !== null && typeof artifact.postimage !== "string") {
      errors.push(`artifacts[${index}].postimage must be a string or null`);
    }
    if (typeof artifact.diff === "string" && (artifact.postimage === null || typeof artifact.postimage === "string")) {
      artifacts.push({
        path: path.value,
        diff: { content: artifact.diff, sha256: sha256Hex(artifact.diff) },
        postimage: artifact.postimage === null
          ? null
          : { content: artifact.postimage, sha256: sha256Hex(artifact.postimage) },
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
  if (postimage !== null) {
    if (typeof postimage.content !== "string" || typeof postimage.sha256 !== "string" || !SHA256_HEX.test(postimage.sha256)) {
      errors.push(`artifacts[${index}].postimage must contain content and a lowercase SHA-256 digest`);
    } else if (postimage.sha256 !== sha256Hex(postimage.content)) errors.push(`artifacts[${index}].postimage.sha256 does not match its content`);
  }
  if (errors.length > 0) return fail(errors);
  return ok({ path: entry.path, diff: entry.diff.content, postimage: postimage === null ? null : postimage.content as string });
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

export const verifyReviewPacket = parseReviewPacket;
export const buildReviewPacket = createReviewPacket;
export const canonicalizeReviewPacket = createReviewPacket;
export const parseAndVerifyReviewPacket = parseReviewPacket;
