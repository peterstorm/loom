// CALIBRATION: CAL-EXHAUST-01
// Every queued id is fetched concurrently, so a large batch opens unbounded
// sockets and memory.
export async function drain(ids: readonly string[]): Promise<unknown[]> {
  return Promise.all(ids.map((id) => fetch(`https://upstream.example/items/${id}`).then((response) => response.json())));
}
