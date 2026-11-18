import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { buildSnapshot } from "../scripts/catalog-snapshot/core.ts";
import { verifyServed } from "../scripts/catalog-snapshot/served.ts";

async function snapshot(description = "Send mail") {
  const apps = [
    { id: "mail", auth: [{ method: "oauth", kind: "oauth2" }], icons: [{ src: "icons/m.svg" }] },
    { id: "chat", auth: [{ method: "key", kind: "secrets" }], icons: [] },
  ].map((app) => ({
    ...app,
    package: `@acme.sh/${app.id}`,
    name: app.id,
    description,
    source: `apps/${app.id}.json`,
  }));
  const { files, failures } = await buildSnapshot({
    feed: JSON.stringify({ version: 1, apps }),
    readSource: async (id) =>
      JSON.stringify({
        package: `@acme.sh/${id}`,
        files: [
          { path: "index.ts", content: "export default {};" },
          { path: "package.json", content: JSON.stringify({ name: `@acme.sh/${id}` }) },
        ],
      }),
    readIcon: async () => new TextEncoder().encode("<svg/>"),
  });
  expect(failures).toEqual([]);
  return files;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});
/** Serve files on loopback; a path in `redirects` answers 302 to elsewhere instead. */
async function serve(files: ReadonlyMap<string, Uint8Array>, redirects: string[] = []) {
  const requested: string[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url!, "http://x").pathname.slice(1);
    requested.push(path);
    if (redirects.includes(path)) {
      response.writeHead(302, { location: `http://127.0.0.1:9/${path}` }).end();
      return;
    }
    const bytes = files.get(path);
    if (bytes === undefined) response.writeHead(404).end();
    else response.writeHead(200, { "content-type": "application/json" }).end(bytes);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { feedUrl: `http://127.0.0.1:${port}/index.json`, requested };
}

describe("checking a served catalog", () => {
  test("checks every document and icon the manifest lists, and the client's listing", async () => {
    const files = await snapshot();
    const { feedUrl, requested } = await serve(files);
    const report = await verifyServed({ feedUrl, manifest: files.get("manifest.json")! });
    expect(report.problems).toEqual([]);
    expect(report.checked).toEqual({ files: files.size, documents: 4, icons: 1 });
    expect(report.listed).toBe(2);
    expect(report.prepared.map((entry) => [entry.id, entry.matchesDocument])).toEqual([
      ["mail", true],
      ["chat", true],
    ]);
    expect(Object.keys(report.hosts)).toEqual([new URL(feedUrl).host]);
    for (const path of files.keys()) expect(requested).toContain(path);
  });

  test("fails a redirect on any verification request", async () => {
    const files = await snapshot();
    const icon = [...files.keys()].find((path) => path.startsWith("icons/"))!;
    const { feedUrl } = await serve(files, [icon]);
    const report = await verifyServed({ feedUrl, manifest: files.get("manifest.json")! });
    expect(report.problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`${icon} redirects \\(HTTP 302\\)`, "u")),
      ]),
    );
  });

  test("fails a served index with the same entry count that is not the manifest's", async () => {
    const expected = await snapshot();
    const other = await snapshot("Send other mail");
    const { feedUrl } = await serve(other);
    const report = await verifyServed({ feedUrl, manifest: expected.get("manifest.json")! });
    expect(report.problems).toEqual([
      "the served index.json is not the manifest's (hash or size differs)",
    ]);
  });
});
