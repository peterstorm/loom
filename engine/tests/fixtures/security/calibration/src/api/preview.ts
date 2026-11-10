// CALIBRATION: CAL-SSRF-01
// The preview fetches whatever URL the caller names, including link-local and
// internal hosts.
export async function preview(url: string): Promise<string> {
  return (await fetch(url)).text();
}
