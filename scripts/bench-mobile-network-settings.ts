import { createServer } from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
import { MockHostClient } from "../packages/client/src/mock/mock-host-client.js";
import { unwrapRpcResult } from "../packages/client/src/host/index.js";
import { PluginsOverviewViewSchema } from "../packages/protocol/src/index.js";
import { createSettingsRead } from "../packages/client/src/settings/index.js";
import { startShapingProxy, linkProfiles } from "../tests/mobile-network/proxy.test-support.js";
const client = new MockHostClient({ latencyMs: 0 });
const report = [];
try {
  const seed = unwrapRpcResult(await client.rpc["plugins.overview.get"]({})).rows.find(
    (row) => row.title === "Gmail",
  )!;
  for (const count of [50, 200, 500]) {
    const body = JSON.stringify({
      ok: true,
      data: PluginsOverviewViewSchema.parse({
        rows: Array.from({ length: count }, (_, i) => ({
          ...seed,
          title: `Mail account ${i}`,
          target: { kind: "service", definitionId: `mail-${i}` },
        })),
      }),
    });
    for (const compressed of [false, true]) {
      const payload = compressed ? gzipSync(body) : Buffer.from(body);
      let requests = 0;
      const server = createServer((_request, response) => {
        requests++;
        response.writeHead(200, {
          "Content-Type": "application/json",
          ...(compressed ? { "Content-Encoding": "gzip" } : {}),
          Connection: "close",
        });
        response.end(payload);
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No address");
      const proxy = await startShapingProxy(
        new URL(`http://127.0.0.1:${address.port}`),
        linkProfiles["weak-cell"],
      );
      try {
        const start = performance.now();
        const page = createSettingsRead(
          async () => {
            const response = await fetch(`${proxy.origin}/rpc/plugins.overview.get`);
            return await response.json();
          },
          () => {},
          (reason) => {
            throw reason;
          },
        );
        await page.refresh();
        const firstPaintMs = Math.round(performance.now() - start);
        const burst = page.refresh();
        for (let i = 0; i < 100; i++) void page.refresh();
        await burst;
        page.dispose();
        report.push({
          rows: count,
          compressed,
          rawBytes: Buffer.byteLength(body),
          payloadBytes: payload.length,
          firstPaintMs,
          initialRpcCount: 1,
          eventBurstRpcCount: requests - 1,
          workspaceDeviceFanout: 0,
        });
      } finally {
        await proxy.close();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  }
  const destination = process.argv[2];
  if (destination) await writeFile(destination, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  client.dispose();
}
