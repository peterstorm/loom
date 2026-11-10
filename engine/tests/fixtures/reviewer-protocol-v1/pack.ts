import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import inventory from "./inventory.json";
import storage from "./storage.json";

type GoldenName = keyof typeof storage.goldens;
type PackFailure = "compressed-size" | "compressed-hash" | "gzip" | "decompressed-size" |
  "storage-format" | "json" | "path-roster" | "logical-bytes" | "noncanonical";
type PackResult = Readonly<{ ok: true; value: ReadonlyMap<string, Uint8Array> }> |
  Readonly<{ ok: false; error: PackFailure }>;
const storedEntries = z.array(z.strictObject({ path: z.string(), base64bytes: z.string() }));
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The inventory's file list for one golden. */
function goldenFiles(name: GoldenName) {
  const golden = inventory.goldens.find((entry) => entry.name === name);
  if (golden === undefined) throw new Error(`no golden named ${name} in the inventory`);
  return golden.files;
}

/** The bound comes from original logical byte counts, never a gzip header or decoded input. */
function expectedStorageLength(name: GoldenName): number {
  const files = goldenFiles(name);
  return 2 + files.length - 1 + files.reduce((sum, entry) => sum +
    Buffer.byteLength(JSON.stringify({ path: entry.path, base64bytes: "" })) + 4 * Math.ceil(entry.byteLength / 3), 0);
}

/** Test-fixture storage parser only: no path is ever used for filesystem access. */
export function parseReviewerV1Pack(name: GoldenName, bytes: Uint8Array): PackResult {
  if (bytes.byteLength > expectedStorageLength(name)) return { ok: false, error: "decompressed-size" };
  let json: unknown;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "json" };
  }
  const parsed = storedEntries.safeParse(json);
  if (!parsed.success) return { ok: false, error: "storage-format" };
  const expected = goldenFiles(name);
  if (parsed.data.length !== expected.length) return { ok: false, error: "path-roster" };
  // Canonical STORAGE JSON rejects duplicate/escaped keys, reordered fields and whitespace.
  // Logical artifact bytes are base64-decoded only: never parsed or reserialized here.
  const canonical = JSON.stringify(parsed.data.map(({ path, base64bytes }) => ({ path, base64bytes })));
  if (text !== canonical) return { ok: false, error: "noncanonical" };
  const files = new Map<string, Uint8Array>();
  for (const [index, entry] of parsed.data.entries()) {
    const original = expected[index];
    if (entry.path !== original.path) return { ok: false, error: "path-roster" };
    if (entry.base64bytes.length !== 4 * Math.ceil(original.byteLength / 3)) return { ok: false, error: "logical-bytes" };
    const decoded = Buffer.from(entry.base64bytes, "base64");
    if (decoded.toString("base64") !== entry.base64bytes || decoded.length !== original.byteLength ||
        sha256(decoded) !== original.sha256) return { ok: false, error: "logical-bytes" };
    files.set(entry.path, Uint8Array.from(decoded));
  }
  return { ok: true, value: files };
}

export function decodeReviewerV1Pack(name: GoldenName, compressed: Uint8Array): PackResult {
  const metadata = storage.goldens[name];
  const maxOutputLength = expectedStorageLength(name);
  if (storage.format !== "gzip-json-path-base64bytes-v1" || metadata.decompressedByteLength !== maxOutputLength) {
    return { ok: false, error: "storage-format" };
  }
  if (compressed.byteLength > metadata.compressedByteLength) return { ok: false, error: "compressed-size" };
  let bytes: Uint8Array;
  try {
    bytes = gunzipSync(compressed, { maxOutputLength });
  } catch {
    return { ok: false, error: "gzip" };
  }
  if (sha256(compressed) !== metadata.sha256) return { ok: false, error: "compressed-hash" };
  if (bytes.byteLength !== maxOutputLength) return { ok: false, error: "decompressed-size" };
  return parseReviewerV1Pack(name, bytes);
}
