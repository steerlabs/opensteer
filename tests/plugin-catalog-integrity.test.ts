import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { Effect, Exit } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { expect, test } from "vitest";
import { catalogSource } from "../packages/plugin-engine/catalog/src/implementation/source.ts";

const document = (pkg: string, manifest = pkg) =>
  JSON.stringify({
    package: pkg,
    files: [
      { path: "index.ts", content: 'export { default } from "apps";' },
      { path: "package.json", content: JSON.stringify({ name: manifest }) },
    ],
  });
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const served: Record<string, string> = {
  "/feed/apps/listed.json": document("@demo/listed"),
  "/feed/documents/elsewhere.json": document("@demo/elsewhere"),
  "/feed/apps/changed.json": document("@demo/changed"),
  "/feed/apps/unhashed.json": document("@demo/unhashed"),
  "/feed/apps/bad-hash.json": document("@demo/bad-hash"),
  "/feed/apps/twice.json": document("@demo/twice"),
  // The document and its package.json agree with each other but not with the index.
  "/feed/apps/replaced.json": document("@other/replaced"),
  "/secret.json": document("@demo/escape"),
};
const entry = (id: string, source: string, hash?: string, pkg = `@demo/${id}`) => ({
  id,
  package: pkg,
  name: id,
  description: "",
  auth: [],
  icons: [],
  source,
  ...(hash === undefined ? {} : { sha256: hash }),
});
const hashOf = (path: string) => sha256(served[path]!);
served["/feed/index.json"] = JSON.stringify({
  version: 1,
  apps: [
    entry("listed", "apps/listed.json", hashOf("/feed/apps/listed.json")),
    // The entry names its own document; it is not always apps/<id>.json.
    entry("elsewhere", "documents/elsewhere.json", hashOf("/feed/documents/elsewhere.json")),
    // The index records an earlier version of this document.
    entry("changed", "apps/changed.json", sha256(document("@demo/changed") + " ")),
    entry("unhashed", "apps/unhashed.json"),
    entry("bad-hash", "apps/bad-hash.json", "abc"),
    entry("twice", "apps/twice.json", hashOf("/feed/apps/twice.json")),
    entry("twice", "apps/twice.json", hashOf("/feed/apps/twice.json")),
    entry("replaced", "apps/replaced.json", hashOf("/feed/apps/replaced.json"), "@demo/replaced"),
    entry("up", "../secret.json", hashOf("/secret.json"), "@demo/escape"),
    entry("absolute", "/secret.json", hashOf("/secret.json"), "@demo/escape"),
    entry("away", "https://example.invalid/secret.json", hashOf("/secret.json"), "@demo/escape"),
    entry("encoded", "apps/%2e%2e/%2e%2e/secret.json", hashOf("/secret.json"), "@demo/escape"),
  ],
});

test("an install refuses a source the index does not uniquely list, hash and name", async (context) => {
  const requested: string[] = [];
  const server = createServer((request, response) => {
    requested.push(request.url ?? "");
    const body = served[request.url ?? ""];
    response.statusCode = body === undefined ? 404 : 200;
    response.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No port");
  const feed = `http://127.0.0.1:${address.port}/feed/index.json`;
  const prepare = (verified: boolean, id: string) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* catalogSource(client, feed, { verified }).prepare(id);
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );
  const tag = (exit: Exit.Exit<unknown, unknown>) =>
    Exit.isFailure(exit) ? JSON.stringify(exit.cause).match(/"_tag":"(Catalog\w+)"/u)?.[1] : "ok";

  for (const verified of [true, false]) {
    const listed = await prepare(verified, "listed");
    expect(Exit.isSuccess(listed) && listed.value.origin).toEqual({
      reference: `http://127.0.0.1:${address.port}/feed/apps/listed.json`,
      name: "@demo/listed",
      commit: null,
      sha256: hashOf("/feed/apps/listed.json"),
    });
    expect(tag(await prepare(verified, "elsewhere"))).toBe("ok");
    for (const refused of ["changed", "bad-hash", "twice", "replaced"])
      expect(tag(await prepare(verified, refused)), refused).toBe("CatalogSourceUnverified");
    for (const escaping of ["up", "absolute", "away", "encoded"])
      expect(tag(await prepare(verified, escaping)), escaping).toBe("CatalogSourceUnverified");
    expect(tag(await prepare(verified, "absent"))).toBe("CatalogImportFailed");
  }
  // Opensteer's own feed proves every install; a development feed may list no hash, and the
  // install still records the document's.
  expect(tag(await prepare(true, "unhashed"))).toBe("CatalogSourceUnverified");
  const unhashed = await prepare(false, "unhashed");
  expect(Exit.isSuccess(unhashed) && unhashed.value.origin?.sha256).toBe(
    hashOf("/feed/apps/unhashed.json"),
  );
  // No refused source was ever fetched from outside the feed.
  expect(requested).not.toContain("/secret.json");
});
