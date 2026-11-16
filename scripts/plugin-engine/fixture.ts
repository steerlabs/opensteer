import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { cp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withTimeout } from "@opensteer/shared/withTimeout";
import framework from "../../vendor/plugin-engine/apps/package.json" with { type: "json" };
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
export async function pluginFixtureRegistry(directory: string, waiting?: () => void) {
  await cp(resolve("vendor/plugin-engine/apps/dist"), join(directory, "package"), {
    recursive: true,
  });
  const archive = join(directory, "framework.tgz");
  execFileSync("tar", ["--format=ustar", "-czf", archive, "-C", directory, "package"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const tarball = await readFile(archive);
  let origin = "";
  const server = createServer((request, response) => {
    if (request.url === "/apps") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          name: "apps",
          "dist-tags": { latest: framework.version },
          versions: {
            [framework.version]: {
              name: "apps",
              version: framework.version,
              dist: { tarball: origin + "/framework.tgz" },
            },
          },
        }),
      );
    } else if (request.url === "/framework.tgz") response.end(tarball);
    else if (request.url === "/wait") {
      waiting?.();
    } else if (request.url === "/catalog") response.end(JSON.stringify({ version: 1, apps: [] }));
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
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
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
