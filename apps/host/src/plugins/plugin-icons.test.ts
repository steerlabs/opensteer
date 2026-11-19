import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { crc32 } from "node:zlib";
import { Effect } from "effect";
import sharp from "sharp";
import { safeHttpClient } from "@opensteer/plugin-engine-utils/safe-fetch";
import { defaultUrlPolicy, httpsOnlyUrlPolicy } from "@opensteer/plugin-engine-utils/url-policy";
import { pluginIconMaxBytes } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import {
  pluginIconReader,
  pluginIconRef,
  pluginIconRefOf,
  pluginIconSource,
  pluginIconSources,
  readPluginIcons,
  type PluginIconSource,
} from "./plugin-icons.js";

const svg =
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#e33"/></svg>';
const png = await sharp({
  create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 90, b: 200, alpha: 1 } },
})
  .png()
  .toBuffer();
const dataUri = (type: string, bytes: Buffer | string) =>
  `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
/** A PNG whose header claims far more pixels than any icon, with no pixels behind it. */
function claimedHugePng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(100_000, 0);
  header.writeUInt32BE(100_000, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const type = Buffer.from("IHDR");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, header])));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([png.subarray(0, 8), length, type, header, crc]);
}

describe("plugin icon choice", () => {
  it("draws the light variant, else one for either theme, never a dark one alone", () => {
    const light = "https://example.com/light.svg";
    const either = dataUri("image/png", png);
    const dark = "https://example.com/dark.svg";
    expect(
      pluginIconSource([
        { src: dark, theme: "dark" },
        { src: either },
        { src: light, theme: "light" },
      ]),
    ).toBe(light);
    expect(pluginIconSource([{ src: dark, theme: "dark" }, { src: either }])).toBe(either);
    expect(pluginIconSource([{ src: dark, theme: "dark" }])).toBeNull();
    expect(pluginIconSource([{ src: "ftp://example.com/a.png" }, { src: "icons/a.svg" }])).toBe(
      null,
    );
    expect(pluginIconSource("not a list")).toBeNull();
  });

  it("names a source by one ref per declarer, so each keeps the policy it is read under", () => {
    const icons = [{ src: dataUri("image/png", png) }];
    const ref = pluginIconRefOf(icons, "plugin")!;
    expect(ref).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(pluginIconRefOf(icons, "catalog")).not.toBe(ref);
    const unlisted = pluginIconRef({ src: "https://example.com/a.svg", origin: "plugin" });
    expect(pluginIconSources([ref, unlisted], [[], icons], "plugin")).toEqual(
      new Map([[ref, { src: icons[0]!.src, origin: "plugin" }]]),
    );
    expect(pluginIconSources([ref], [icons], "catalog")).toEqual(new Map());
  });
});

describe("plugin icon reads", () => {
  it("draws a JPEG the way its EXIF orientation shows it", async () => {
    // Stored landscape, tagged to show turned a quarter: it displays portrait.
    const stored = await sharp({
      create: { width: 32, height: 16, channels: 3, background: { r: 200, g: 0, b: 0 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const src = dataUri("image/jpeg", stored);
    const [icon] = await Effect.runPromise(
      Effect.gen(function* () {
        const egress = {
          policy: httpsOnlyUrlPolicy,
          client: yield* safeHttpClient(httpsOnlyUrlPolicy),
        };
        const read = yield* pluginIconReader({ catalog: egress, plugin: egress });
        const source = { src, origin: "plugin" } as const;
        return yield* readPluginIcons(read, new Map([[pluginIconRef(source), source]]));
      }).pipe(Effect.scoped),
    );
    const { data, info } = await sharp(Buffer.from(icon!.image.split(",")[1]!, "base64"))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alpha = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
    // Portrait in a square tile: the top middle is drawn, the left middle is padding.
    expect([alpha(64, 2), alpha(2, 64)]).toEqual([255, 0]);
  });

  it("serves every icon as a small WebP, read once and only from where its declarer may point", async (context) => {
    const hits = new Map<string, number>();
    const routes: Record<string, (response: ServerResponse) => void> = {
      "/logo.svg": (response) => response.end(svg),
      "/page.png": (response) => response.end("<html>not an image</html>"),
      "/big.svg": (response) => {
        response.setHeader("content-length", String(pluginIconMaxBytes + 1));
        response.end("x".repeat(pluginIconMaxBytes + 1));
      },
      // No declared length, so the bound is the bytes read.
      "/streamed.svg": (response) => {
        response.write(`<svg>${" ".repeat(pluginIconMaxBytes)}`);
        response.end("</svg>");
      },
      "/moved.svg": (response) => {
        response.statusCode = 302;
        response.setHeader("location", "/logo.svg");
        response.end();
      },
    };
    const server = createServer((request, response) => {
      const path = request.url ?? "";
      hits.set(path, (hits.get(path) ?? 0) + 1);
      const route = routes[path];
      if (route) route(response);
      else {
        response.statusCode = 404;
        response.end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    context.onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as { port: number };
    const at = (path: string) => `http://127.0.0.1:${port}${path}`;
    const catalog = (src: string): PluginIconSource => ({ src, origin: "catalog" });
    const plugin = (src: string): PluginIconSource => ({ src, origin: "plugin" });
    // A reference cycle, which a client's SVG renderer may recurse on without end.
    const cyclic =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 8 8"><g id="a"><use xlink:href="#a"/></g><rect width="4" height="4"/></svg>';

    const sources = [
      catalog(at("/logo.svg")),
      catalog(at("/page.png")),
      catalog(at("/big.svg")),
      catalog(at("/streamed.svg")),
      catalog(at("/moved.svg")),
      catalog(at("/missing.svg")),
      catalog("https://10.255.255.1/icon.png"),
      // A plugin's own icon is read only from a public HTTPS address.
      plugin(at("/logo.svg?plugin")),
      plugin("https://127.0.0.1/icon.png"),
      // An inline icon is typed by its bytes, not by what it claims.
      plugin(dataUri("image/webp", png)),
      plugin(dataUri("image/svg+xml", cyclic)),
      plugin(dataUri("image/svg+xml", "<html></html>")),
      plugin(dataUri("image/png", claimedHugePng())),
    ];
    const byRef = new Map(sources.map((source) => [pluginIconRef(source), source]));
    const [first, again] = await Effect.runPromise(
      Effect.gen(function* () {
        const read = yield* pluginIconReader({
          catalog: { policy: defaultUrlPolicy, client: yield* safeHttpClient(defaultUrlPolicy) },
          plugin: {
            policy: httpsOnlyUrlPolicy,
            client: yield* safeHttpClient(httpsOnlyUrlPolicy),
          },
        });
        return [yield* readPluginIcons(read, byRef), yield* readPluginIcons(read, byRef)] as const;
      }).pipe(Effect.scoped),
    );

    const served = new Map(first.map(({ ref, image }) => [ref, image]));
    expect([...served.keys()].map((ref) => byRef.get(ref)!.src)).toEqual([
      at("/logo.svg"),
      dataUri("image/webp", png),
      dataUri("image/svg+xml", cyclic),
    ]);
    for (const image of served.values()) {
      expect(image).toMatch(/^data:image\/webp;base64,/u);
      const metadata = await sharp(Buffer.from(image.split(",")[1]!, "base64")).metadata();
      expect([metadata.format, metadata.width, metadata.height]).toEqual(["webp", 128, 128]);
    }
    expect(hits.get("/logo.svg")).toBe(1);
    expect(hits.get("/moved.svg")).toBe(1);
    expect(hits.has("/logo.svg?plugin")).toBe(false);
    expect(again).toEqual(first);
  });
});
