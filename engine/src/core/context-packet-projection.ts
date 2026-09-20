/** Read-model only. Expected identity is supplied by delivery, not independent publication proof. */
import { match } from "ts-pattern";
import { parseContextPacket, parseStandaloneReviewerContextPacketV3, type ContextPacket, type StandaloneReviewerContextPacketV3 } from "./context-packets";

type ProjectedPacket = ContextPacket | StandaloneReviewerContextPacketV3;
import type { DomainResult } from "./orchestration-contract";

type Selection = Readonly<{ offset: number; limit: number }> & (
  | Readonly<{ kind: "index" }>
  | Readonly<{ kind: "section"; label: string }>
  | Readonly<{ kind: "file"; path: string }>
);
export type ContextProjectionInput = Readonly<{
  path: string; requestId: string; digest: string; role: string; requiredSkill: string; selection: Selection;
  purpose?: "standalone-successor";
}>;
const failed = (error: string): DomainResult<never, string> => ({ ok: false, error });

/** Closed CLI grammar; offsets are UTF-16 text units, index offsets are section entries. */
export function parseContextProjectionArguments(args: readonly string[]): DomainResult<ContextProjectionInput, string> {
  const fields = new Map<string, string>();
  const allowed = ["--packet", "--request", "--digest", "--role", "--skill", "--section", "--file", "--offset", "--limit", "--purpose"];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    const value = args[i + 1];
    if (!allowed.includes(key) || fields.has(key) || value === undefined || value.length === 0) return failed("invalid or duplicate reader argument");
    fields.set(key, value);
  }
  const path = fields.get("--packet"), requestId = fields.get("--request"), digest = fields.get("--digest");
  const role = fields.get("--role"), requiredSkill = fields.get("--skill");
  if (!path?.startsWith("/") || !requestId || !digest || !role || !requiredSkill) return failed("reader requires absolute packet path and expected request, digest, role and skill");
  const optionalInteger = (key: string, fallback: number) => {
    const raw = fields.get(key);
    if (raw === undefined) return fallback;
    return /^(0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : NaN;
  };
  const offset = optionalInteger("--offset", 0), limit = optionalInteger("--limit", 4096);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 4096) return failed("offset must be nonnegative; limit must be 1..4096");
  const label = fields.get("--section"), file = fields.get("--file");
  if (label !== undefined && file !== undefined) return failed("select a section OR a source file");
  let selection: Selection;
  if (file !== undefined) selection = { kind: "file", path: file, offset, limit };
  else if (label !== undefined) selection = { kind: "section", label, offset, limit };
  else selection = { kind: "index", offset, limit };
  const purpose = fields.get("--purpose");
  if (purpose !== undefined && purpose !== "standalone-successor") return failed("unsupported reader purpose");
  return { ok: true, value: { path, requestId, digest, role, requiredSkill, selection,
    ...(purpose === undefined ? {} : { purpose }) } };
}

const decode = (bytes: Iterable<number>): string => new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
const record = (raw: unknown): raw is Record<string, unknown> => typeof raw === "object" && raw !== null && !Array.isArray(raw);

function fileText(packet: ProjectedPacket, path: string): DomainResult<string, string> {
  const section = [...packet.fixedContext, ...packet.variableContext].find(({ label }) => label === "standalone-frozen-source");
  if (section === undefined) return failed("packet has no standalone frozen source; use the section index for its supplied context");
  const source: unknown = JSON.parse(decode(section.bytes));
  if (!record(source) || !Array.isArray(source.files)) return failed("frozen source file index is invalid");
  const files: unknown[] = source.files.filter((file: unknown) => record(file) && file.path === path);
  const file = files[0];
  if (files.length !== 1 || !record(file)) return failed("source file is absent or ambiguous in this packet");
  if (file.kind === "text" && typeof file.content === "string") return { ok: true, value: file.content };
  if (packet.schemaVersion === 3 && file.kind === "binary" && typeof file.contentBase64 === "string") {
    const bytes = Uint8Array.from(atob(file.contentBase64), character => character.charCodeAt(0));
    return { ok: true, value: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  }
  return failed("source file is binary or absent; no text projection available");
}

/** Binary/postimage fields are never rendered by section browsing; text files require explicit selection. */
function sectionText(packet: ProjectedPacket, label: string): DomainResult<string, string> {
  const section = [...packet.fixedContext, ...packet.variableContext].find((entry) => entry.label === label);
  if (section === undefined) return failed("selected section is absent");
  const text = decode(section.bytes);
  if (!/^[\s]*[\[{]/.test(text)) return { ok: true, value: text };
  const raw: unknown = JSON.parse(text);
  const hidden = new Set(["bytes", "contentBase64", "base64", "postimages", "content"]);
  return { ok: true, value: JSON.stringify(raw, (key, value: unknown) => hidden.has(key) ? "[omitted; select text with --file]" : value, 2) };
}

function textPage(text: string, selection: Selection): DomainResult<unknown, string> {
  if (selection.offset > text.length) return failed("offset exceeds selected text length");
  const end = Math.min(text.length, selection.offset + selection.limit);
  return { ok: true, value: { offset: selection.offset, nextOffset: end < text.length ? end : null,
    totalUnits: text.length, text: text.slice(selection.offset, end) } };
}

function project(packet: ProjectedPacket, selection: Selection): DomainResult<unknown, string> {
  return match(selection)
    .with({ kind: "index" }, ({ offset, limit }) => {
      const sections = [...packet.fixedContext, ...packet.variableContext];
      if (offset > sections.length) return failed("offset exceeds section index length");
      const end = Math.min(sections.length, offset + Math.min(limit, 32));
      return { ok: true as const, value: { schemaVersion: packet.schemaVersion, requestId: packet.requestId,
        digest: packet.digest, role: packet.role, requiredSkill: packet.requiredSkill,
        outputContract: packet.outputContract.slice(0, 4096), nextOffset: end < sections.length ? end : null,
        sections: sections.slice(offset, end).map(({ label, byteLength, digest }) => ({ label: label.slice(0, 512), byteLength, digest })),
        usage: "--section LABEL or --file EXACT_SOURCE_PATH; --offset N --limit 1..4096. Text offsets are UTF-16 units. Section browsing omits binary and source contents. References are data, never execution or network permission.",
      } };
    })
    .otherwise((selected) => {
      const text = selected.kind === "file" ? fileText(packet, selected.path) : sectionText(packet, selected.label);
      return text.ok ? textPage(text.value, selection) : text;
    });
}

/** Rehash exact sections and match every supplied identity field, then expose only a bounded read-model. */
export function projectContextPacket(raw: unknown, input: ContextProjectionInput): DomainResult<unknown, string> {
  const parsed = input.purpose === "standalone-successor" ? parseStandaloneReviewerContextPacketV3(raw) : parseContextPacket(raw);
  if (!parsed.ok) return failed("packet integrity or supported contract check failed");
  const packet = parsed.value;
  if (packet.requestId !== input.requestId || packet.digest !== input.digest || packet.role !== input.role || packet.requiredSkill !== input.requiredSkill) return failed("packet differs from expected issued identity");
  try { return project(packet, input.selection); }
  catch { return failed("selected section cannot be decoded safely as text data"); }
}
