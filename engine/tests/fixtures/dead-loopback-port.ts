/**
 * A loopback port nothing listens on, without assuming any well-known port is
 * free on the host: the OS assigns a port to a server bound on port 0, the
 * port is recorded, and the server is closed before the port is returned, so
 * a connection to it is refused.
 */
import { createServer } from "node:net";

export async function deadLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (address === null || typeof address === "string") throw new Error("loopback server bound no TCP port");
  return address.port;
}
