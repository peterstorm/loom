import { readFile } from "node:fs/promises";
import { join } from "node:path";

// CALIBRATION: CAL-TRAVERSAL-01
// The caller-supplied `name` is joined onto a root, so `../` escapes it.
export async function readAttachment(root: string, name: string): Promise<string> {
  return readFile(join(root, name), "utf-8");
}
