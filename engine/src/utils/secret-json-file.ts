/**
 * Imperative shell: reads one of Pi's JSON config files that hold provider
 * keys (`models.json`, `auth.json`). Its errors name the file and what went
 * wrong, never the text: V8's `JSON.parse` error quotes the text around the
 * fault, which in these files can be a key.
 */

import { readFileSync } from "node:fs";
import { observePathPresence } from "./path-presence";

export type SecretJsonFile =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "parsed"; value: unknown }>
  | Readonly<{ kind: "error"; error: string }>;

/** The JSON value at `path` (a leading BOM stripped, as Pi strips it), absent, or an error that quotes nothing of the file. */
export function readSecretJsonFile(path: string): SecretJsonFile {
  const presence = observePathPresence(path);
  if (presence.kind === "absent") return { kind: "absent" };
  if (presence.kind === "unknown") return { kind: "error", error: `cannot read ${path}: ${presence.cause}` };
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "read failed";
    return { kind: "error", error: `cannot read ${path}: ${code}` };
  }
  try {
    return { kind: "parsed", value: JSON.parse(text.replace(/^﻿/, "")) };
  } catch {
    return { kind: "error", error: `cannot parse ${path}: it is not JSON` };
  }
}
