import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";

const base = process.env.OPENSTEER_NATIVE_JOURNEY_EVIDENCE_DIR ?? tmpdir();
mkdirSync(base, { recursive: true });
const directory = mkdtempSync(path.join(base, "native-viewer-"));
const events: unknown[] = [];
const Event = z.object({
  type: z.string(),
  details: z.unknown(),
  platform: z.enum(["ios", "android"]),
  at: z.number(),
  fixtureTarget: z.literal(true),
});
const Manifest = z.looseObject({ launchAsset: z.looseObject({ url: z.url() }) });
const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
writeFileSync(
  path.join(directory, "metadata.json"),
  JSON.stringify(
    {
      source,
      target: "local protocol fixture; not full Host/browser/phone acceptance",
      nativeClient: "actual custom Expo client",
      port: 18766,
      metroPort: 18767,
    },
    null,
    2,
  ),
);
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1:18766");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/event") {
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 1_048_576) throw new Error("Fixture event is too large");
      }
      const event = Event.parse(JSON.parse(body));
      events.push(event);
      appendFileSync(path.join(directory, "events.jsonl"), JSON.stringify(event) + "\n");
      response.end("{}");
    } else if (url.pathname === "/events") {
      response.end(JSON.stringify({ directory, source, events }));
    } else {
      const platform =
        request.headers["expo-platform"] === "android" ||
        url.searchParams.get("platform") === "android"
          ? "android"
          : "ios";
      const upstream = await fetch(`http://127.0.0.1:18767/?platform=${platform}`, {
        headers: {
          accept: "application/expo+json",
          "expo-platform": platform,
          "expo-protocol-version": "1",
        },
      });
      if (!upstream.ok) throw new Error(`Metro manifest ${upstream.status}`);
      const manifest = Manifest.parse(await upstream.json());
      const bundle = new URL(manifest.launchAsset.url);
      bundle.pathname = "/apps/mobile/modules/remote-text-input/tests/native/journey.tsx.bundle";
      bundle.hostname = platform === "android" ? "10.0.2.2" : "127.0.0.1";
      manifest.launchAsset.url = bundle.toString();
      response.setHeader("content-type", "application/expo+json");
      response.setHeader("expo-protocol-version", "1");
      response.end(JSON.stringify(manifest));
    }
  })().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    appendFileSync(
      path.join(directory, "errors.jsonl"),
      JSON.stringify({ at: Date.now(), message }) + "\n",
    );
    response.statusCode = 500;
    response.end(JSON.stringify({ error: message }));
  });
});
server.listen(18766, "127.0.0.1", () =>
  process.stdout.write(`Native viewer fixture: ${directory}\n`),
);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.once(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
