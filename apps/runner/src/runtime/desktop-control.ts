import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { z } from "zod";

export const DesktopRunnerReadySchema = z.strictObject({
  port: z.number().int().min(1).max(65535),
  token: z.uuid(),
  earlierBootsContained: z.boolean(),
});
export type DesktopRunnerReady = z.infer<typeof DesktopRunnerReadySchema>;

export async function startDesktopRunnerControl(idle: () => boolean, earlierBootsContained = true) {
  const token = randomUUID();
  const holdMs = 15_000;
  let until = 0;
  const held = () => performance.now() < until;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}` || request.method !== "POST") {
      response.writeHead(403).end();
      return;
    }
    if (request.url === "/release") {
      until = 0;
      response.writeHead(204).end();
      return;
    }
    if (request.url !== "/hold" || held() || !idle()) {
      response.writeHead(409).end();
      return;
    }
    until = performance.now() + holdMs;
    response.writeHead(204).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing Runner control address");
  server.unref();
  return {
    ready: { port: address.port, token, earlierBootsContained },
    held,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

export async function holdDesktopRunnerIdle(
  ready: DesktopRunnerReady,
): Promise<(() => Promise<void>) | null> {
  const ask = (path: string) =>
    fetch(`http://127.0.0.1:${ready.port}/${path}`, {
      headers: { authorization: `Bearer ${ready.token}` },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(1_000),
    });
  const response = await ask("hold").catch(() => null);
  if (response?.status !== 204) return null;
  return async () => {
    await ask("release").catch(() => undefined);
  };
}
