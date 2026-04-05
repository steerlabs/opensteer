import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, test } from "vitest";

import {
  FLOW_RECORDER_DRAIN_SCRIPT,
  FLOW_RECORDER_INSTALL_SCRIPT,
} from "../../packages/runtime-core/src/index.js";
import { Opensteer } from "../../packages/opensteer/src/index.js";

const temporaryRoots: string[] = [];

describe.sequential("recorder browser script", () => {
  afterAll(async () => {
    await Promise.all(
      temporaryRoots.map((rootPath) =>
        rm(rootPath, { recursive: true, force: true }).catch(() => undefined),
      ),
    );
  });

  test("captures trusted DOM actions and prefers stable selectors", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "opensteer-recorder-browser-script-"));
    temporaryRoots.push(rootDir);

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/") {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html>
<html lang="en">
  <body>
    <button data-testid="submit-button" type="button"><span id="submit-label">Submit</span></button>
    <input name="email" type="email" />
    <div id="scroll-target" style="width: 320px; height: 140px; overflow: auto; border: 1px solid #111;">
      <div style="height: 1200px;">Scrollable content</div>
    </div>
  </body>
</html>`);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start recorder browser script fixture server");
    }

    const opensteer = new Opensteer({
      name: "recorder-browser-script",
      rootDir,
      browser: "temporary",
      launch: {
        headless: true,
      },
    });

    try {
      await opensteer.open(`http://127.0.0.1:${String(address.port)}/`);
      await opensteer.addInitScript(FLOW_RECORDER_INSTALL_SCRIPT);
      await opensteer.evaluate(FLOW_RECORDER_INSTALL_SCRIPT);

      await opensteer.click({
        selector: "#submit-label",
      });
      await opensteer.input({
        selector: 'input[name="email"]',
        text: "user@example.com",
      });
      await opensteer.scroll({
        selector: "#scroll-target",
        direction: "down",
        amount: 180,
      });

      const drained = (await opensteer.evaluate(FLOW_RECORDER_DRAIN_SCRIPT)) as {
        readonly events: readonly {
          readonly kind: string;
          readonly selector?: string;
        }[];
      };
      const clickEvent = drained.events.find((event) => event.kind === "click");
      const typeEvent = drained.events.find((event) => event.kind === "type");
      const scrollEvent = drained.events.find((event) => event.kind === "scroll");

      expect(clickEvent?.selector).toContain(`data-testid="submit-button"`);
      expect(typeEvent?.selector).toContain(`name="email"`);
      expect(scrollEvent).toBeDefined();
    } finally {
      await opensteer.close().catch(() => undefined);
      server.close();
      await once(server, "close").catch(() => undefined);
    }
  }, 60_000);
});
