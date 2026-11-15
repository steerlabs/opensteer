import { createServer, type Server } from "node:net";

/** Distinct loopback ports the OS just released; its ephemeral range is the app port range. */
export async function freePorts(count: number): Promise<number[]> {
  const listeners: Server[] = [];
  try {
    for (let index = 0; index < count; index++) {
      const listener = createServer();
      listeners.push(listener);
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", resolve);
      });
    }
    return listeners.map((listener) => {
      const address = listener.address();
      if (!address || typeof address === "string" || address.port < 49_152)
        throw new Error("No free port in the app port range");
      return address.port;
    });
  } finally {
    await Promise.all(
      listeners.map((listener) => new Promise<void>((resolve) => listener.close(() => resolve()))),
    );
  }
}

export async function freePort(): Promise<number> {
  const [port] = await freePorts(1);
  return port!;
}
