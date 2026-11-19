import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { withTimeout } from "@opensteer/shared/withTimeout";
import framework from "../../packages/plugin-engine/apps/package.json" with { type: "json" };
export const pluginFixtureFiles = (revision: number, sites?: string[]) => [
  {
    path: "skills/demo/SKILL.md",
    content: "---\nname: demo\ndescription: Fixture skill\n---\nFixture instructions.\n",
  },
  {
    path: "package.json",
    content: JSON.stringify({
      name: "fixture-plugin",
      type: "module",
      dependencies: { apps: framework.version },
    }),
  },
  {
    path: "index.ts",
    content: `
import { defineApp, defineProvider, secrets, object, string, query, mutation, router, number } from "apps";
import { always } from "apps/operations/approval";
${sites ? `const service = defineProvider({ name: "Fixture", hosts: ${JSON.stringify(sites)}, auth: { key: secrets({ label: "API key", fields: object({ token: string() }) }) } });` : ""}
export default defineApp(${sites ? "{ user: { accounts: { service } } }" : "{}"}, { tools: router({
  read: query({ input: object({ amount: number() }) }, async (_ctx, { amount }) => amount + ${revision}),
  reviewed: mutation({ input: object({ amount: number() }), approval: always() }, async (_ctx, { amount }) => amount + ${revision}),
  wait: query({ input: object({}) }, async (ctx) => (await ctx.fetch("https://api.fixture.invalid/wait")).text()),
}) });`,
  },
];
export function pluginFixtureProcesses(parent: number) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, ppid, rss, ...command] = line.trim().split(/\s+/u);
      return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss), command: command.join(" ") };
    });
  const owned = new Set([parent]);
  for (let count = -1; count !== owned.size;) {
    count = owned.size;
    for (const row of rows) if (owned.has(row.ppid)) owned.add(row.pid);
  }
  return rows.filter((row) => owned.has(row.pid));
}
const deadline = <T>(promise: Promise<T>, message: string) =>
  withTimeout(promise, 15_000, { timeoutError: () => new Error(message) });
/**
 * The test network: an npm registry with no packages, a catalog and a slow endpoint. It serves no
 * framework, since builds link the Host's own; `requests` records every host and path asked for.
 */
export async function pluginFixtureRegistry(
  waiting?: () => void,
  catalogFiles?: ReturnType<typeof pluginFixtureFiles>,
  handle?: (request: IncomingMessage, response: ServerResponse) => boolean,
) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.headers.host ?? ""}${request.url ?? ""}`);
    if (handle?.(request, response)) return;
    if (request.url === "/wait") {
      waiting?.();
    } else if (request.url === "/catalog")
      response.end(
        JSON.stringify({
          version: 1,
          apps: catalogFiles
            ? [
                {
                  id: "fixture",
                  package: "fixture-plugin",
                  name: "Catalog fixture",
                  description: "Hermetic catalog plugin",
                  auth: [],
                  icons: [],
                  source: "apps/fixture.json",
                },
              ]
            : [],
        }),
      );
    else if (request.url === "/apps/fixture.json" && catalogFiles)
      response.end(JSON.stringify({ package: "fixture-plugin", files: catalogFiles }));
    else {
      response.statusCode = 404;
      response.end();
    }
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await deadline(listening, "Registry did not listen");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Registry has no port");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    requests,
    address: `127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await deadline(
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
        "Registry did not stop",
      );
    },
  };
}
