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

  test("captures trusted DOM actions, prefers stable selectors, and exposes browser stop state", async () => {
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
      expect((drained as { readonly stopRequested?: boolean }).stopRequested).toBe(false);

      const stopped = (await opensteer.evaluate(`() => {
        const host = document.querySelector("[data-opensteer-recorder-ui]");
        if (!(host instanceof HTMLElement) || !(host.shadowRoot instanceof ShadowRoot)) {
          throw new Error("Recorder UI was not mounted.");
        }
        const button = host.shadowRoot.querySelector("button");
        if (!(button instanceof HTMLButtonElement)) {
          throw new Error("Recorder stop button was not mounted.");
        }
        button.click();
        const recorder = globalThis.__opensteerFlowRecorder;
        const stopped = recorder && typeof recorder.drain === "function" ? recorder.drain() : null;
        return {
          hostPresent: document.querySelector("[data-opensteer-recorder-ui]") instanceof HTMLElement,
          stopped,
        };
      }`)) as {
        readonly hostPresent: boolean;
        readonly stopped: {
          readonly stopRequested: boolean;
          readonly events: readonly {
            readonly kind: string;
          }[];
        } | null;
      };

      expect(stopped.hostPresent).toBe(false);
      expect(stopped.stopped?.stopRequested).toBe(true);
      expect(stopped.stopped?.events.some((event) => event.kind === "click")).toBe(false);
    } finally {
      await opensteer.close().catch(() => undefined);
      server.close();
      await once(server, "close").catch(() => undefined);
    }
  }, 60_000);

  test("mounts the stop button after full navigations and on new pages", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "opensteer-recorder-browser-stop-ui-"));
    temporaryRoots.push(rootDir);

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      response.setHeader("content-type", "text/html; charset=utf-8");
      if (url.pathname === "/" || url.pathname === "/next" || url.pathname === "/popup") {
        response.end(
          `<!doctype html><html lang="en"><body><main>${url.pathname}</main></body></html>`,
        );
        return;
      }
      response.statusCode = 404;
      response.end("not found");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start recorder stop button fixture server");
    }

    const baseUrl = `http://127.0.0.1:${String(address.port)}`;
    const opensteer = new Opensteer({
      name: "recorder-browser-stop-ui",
      rootDir,
      browser: "temporary",
      launch: {
        headless: true,
      },
    });

    const expectStopButton = async (pageRef?: string) => {
      const mounted = (await opensteer.evaluate({
        ...(pageRef === undefined ? {} : { pageRef }),
        script: `() => {
          const host = document.querySelector("[data-opensteer-recorder-ui]");
          if (!(host instanceof HTMLElement) || !(host.shadowRoot instanceof ShadowRoot)) {
            return false;
          }
          const button = host.shadowRoot.querySelector("button");
          return button instanceof HTMLButtonElement && button.textContent === "Stop recording";
        }`,
      })) as boolean;
      expect(mounted).toBe(true);
    };

    try {
      await opensteer.open(`${baseUrl}/`);
      await opensteer.addInitScript(FLOW_RECORDER_INSTALL_SCRIPT);
      await opensteer.evaluate(FLOW_RECORDER_INSTALL_SCRIPT);

      await expectStopButton();

      await opensteer.goto(`${baseUrl}/next`);
      await expectStopButton();

      const popup = await opensteer.newPage({
        url: `${baseUrl}/popup`,
      });
      await expectStopButton(popup.pageRef);
    } finally {
      await opensteer.close().catch(() => undefined);
      server.close();
      await once(server, "close").catch(() => undefined);
    }
  }, 60_000);

  test("classifies multi-step history traversal without depending on storage writes", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "opensteer-recorder-history-state-"));
    temporaryRoots.push(rootDir);

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      response.setHeader("content-type", "text/html; charset=utf-8");
      if (url.pathname === "/" || url.pathname === "/step1" || url.pathname === "/step2") {
        response.end(
          `<!doctype html><html lang="en"><body><main>${url.pathname}</main></body></html>`,
        );
        return;
      }
      response.statusCode = 404;
      response.end("not found");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start recorder history-state fixture server");
    }

    const baseUrl = `http://127.0.0.1:${String(address.port)}`;
    const opensteer = new Opensteer({
      name: "recorder-history-state",
      rootDir,
      browser: "temporary",
      launch: {
        headless: true,
      },
    });

    try {
      await opensteer.open(`${baseUrl}/`);
      await opensteer.addInitScript(FLOW_RECORDER_INSTALL_SCRIPT);
      await opensteer.evaluate(FLOW_RECORDER_INSTALL_SCRIPT);

      await opensteer.evaluate(`() => {
        history.pushState({ step: 1 }, "", "/step1");
        history.pushState({ step: 2 }, "", "/step2");
      }`);
      await opensteer.evaluate(FLOW_RECORDER_DRAIN_SCRIPT);

      await opensteer.evaluate(`() => {
        Object.defineProperty(Storage.prototype, "setItem", {
          configurable: true,
          writable: true,
          value() {
            throw new Error("blocked");
          },
        });
      }`);

      const drained = (await opensteer.evaluate(`() => {
        return new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            reject(new Error("timed out waiting for popstate"));
          }, 2_000);
          addEventListener(
            "popstate",
            () => {
              clearTimeout(timeoutId);
              setTimeout(() => {
                const recorder = globalThis.__opensteerFlowRecorder;
                resolve(recorder && typeof recorder.drain === "function" ? recorder.drain() : null);
              }, 0);
            },
            { once: true },
          );
          history.go(-2);
        });
      }`)) as {
        readonly url: string;
        readonly events: readonly {
          readonly kind: string;
          readonly url?: string;
        }[];
      } | null;

      expect(drained?.url).toBe(`${baseUrl}/`);
      expect(
        drained?.events.some((event) => event.kind === "go-back" && event.url === `${baseUrl}/`),
      ).toBe(true);
    } finally {
      await opensteer.close().catch(() => undefined);
      server.close();
      await once(server, "close").catch(() => undefined);
    }
  }, 60_000);
});
