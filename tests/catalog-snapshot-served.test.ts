import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildSnapshot,
  cacheControlFor,
  publishedManifest,
} from "../scripts/catalog-snapshot/core.ts";
import { verifyServed } from "../scripts/catalog-snapshot/served.ts";

async function snapshot(description = "Send mail", note = "") {
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
          { path: "index.ts", content: `export default {}; ${note}` },
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
/**
 * Serve a release on loopback as the publisher deploys it: the manifest as published, each path
 * with its `Cache-Control`. `answer` may change what one request gets.
 */
async function serve(
  files: ReadonlyMap<string, Uint8Array>,
  answer: (
    path: string,
    count: number,
  ) => { status?: number; headers?: Record<string, string>; body?: Uint8Array } | undefined = () =>
    undefined,
) {
  const requested: string[] = [];
  const release = new Map(files);
  release.set("manifest.json", publishedManifest(files.get("manifest.json")!, published));
  const server = createServer((request, response) => {
    const path = new URL(request.url!, "http://x").pathname.slice(1);
    requested.push(path);
    const changed = answer(path, requested.filter((item) => item === path).length);
    const bytes = changed?.body ?? release.get(path);
    if (changed?.status !== undefined) response.writeHead(changed.status, changed.headers).end();
    else if (bytes === undefined) response.writeHead(404).end();
    else
      response
        .writeHead(200, {
          "content-type": "application/json",
          "cache-control": cacheControlFor(path) ?? "no-store",
          ...changed?.headers,
        })
        .end(bytes);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { feedUrl: `http://127.0.0.1:${port}/index.json`, requested };
}
const published = "2026-11-18T00:00:00.000Z";

describe("checking a served catalog", () => {
  test("checks every document and icon the manifest lists, and the client's listing", async () => {
    const files = await snapshot();
    const { feedUrl, requested } = await serve(files);
    const report = await verifyServed({ feedUrl, manifest: files.get("manifest.json")! });
    expect(report.problems).toEqual([]);
    expect(report.checked).toEqual({ files: files.size, documents: 4, icons: 1, retained: 0 });
    expect(report.listed).toBe(2);
    // Ours, and the catalog client's listing.
    expect(report.indexReads).toBe(2);
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
    const { feedUrl } = await serve(files, (path) =>
      path === icon
        ? { status: 302, headers: { location: `http://127.0.0.1:9/${path}` } }
        : undefined,
    );
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
      "an index response (read 1) is not the manifest's index.json (hash or size differs)",
    ]);
  });

  test("fails when the catalog client is given another index than the one checked", async () => {
    const files = await snapshot();
    const other = (await snapshot("Send other mail")).get("index.json")!;
    // Right for the first read, another release's same-count index for the client's.
    const { feedUrl } = await serve(files, (path, count) =>
      path === "index.json" && count === 2 ? { body: other } : undefined,
    );
    const report = await verifyServed({ feedUrl, manifest: files.get("manifest.json")! });
    expect(report.listed).toBe(2);
    expect(report.problems).toEqual([
      "an index response (read 2) is not the manifest's index.json (hash or size differs)",
    ]);
  });

  test("fails a path served with another class's Cache-Control", async () => {
    const files = await snapshot();
    const { feedUrl } = await serve(files, (path) =>
      path === "apps/mail.json"
        ? { headers: { "cache-control": "public, max-age=31536000, immutable" } }
        : undefined,
    );
    const report = await verifyServed({ feedUrl, manifest: files.get("manifest.json")! });
    expect(report.problems).toEqual([
      'apps/mail.json: Cache-Control is "public, max-age=31536000, immutable", not "public, max-age=300, must-revalidate" (the legacy paths)',
    ]);
  });

  test("requests no path the layout does not allow, and fetches the previous release's files", async () => {
    const files = await snapshot();
    const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json")));
    const tampered = new TextEncoder().encode(
      JSON.stringify({ ...manifest, files: { ...manifest.files, "../secret": manifest.feed } }),
    );
    const first = await serve(files);
    const refused = await verifyServed({ feedUrl: first.feedUrl, manifest: tampered });
    expect(refused.problems).toEqual([
      'the manifest lists "../secret", which has no place in a snapshot',
    ]);
    expect(first.requested).toEqual([]);

    // The previous release's documents are kept beside the new ones, and each is fetched.
    const previous = await snapshot("Old mail", "old");
    const second = await serve(new Map([...previous, ...files]));
    const report = await verifyServed({
      feedUrl: second.feedUrl,
      manifest: files.get("manifest.json")!,
      previous: previous.get("manifest.json")!,
    });
    expect(report.problems).toEqual([]);
    // Both documents differ; the icon is the same bytes and was checked already.
    expect(report.checked.retained).toBe(2);
    const missing = await serve(files);
    const gone = await verifyServed({
      feedUrl: missing.feedUrl,
      manifest: files.get("manifest.json")!,
      previous: previous.get("manifest.json")!,
    });
    expect(gone.checked.retained).toBe(0);
    expect(gone.problems).toEqual(
      expect.arrayContaining([expect.stringMatching(/apps\/mail\/[0-9a-f]{64}\.json: HTTP 404/u)]),
    );
  });
});
