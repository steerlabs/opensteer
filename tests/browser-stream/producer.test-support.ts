import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserRuntime,
  BrowserRuntimeServer,
  type LaunchedBrowser,
} from "../../packages/browser-runtime-core/src/index.js";
import { BrowserAttachTicketClaimsSchema } from "../../packages/protocol/src/index.js";
import {
  TestChromiumLauncher,
  findChromium,
} from "../../apps/browser-runtime/src/browser/browser-test-lifecycle.js";

/** Producer seam: a future video runtime supplies the same fixture evaluation and real relay URL. */
export interface BrowserStreamProducer {
  readonly encoding: string;
  readonly runtimeUrl: string;
  surfaceId(): string;
  evaluate<T>(expression: string): Promise<T>;
  close(): Promise<void>;
}

export async function startJpegProducer(): Promise<BrowserStreamProducer> {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-browser-bench-"));
  const launcher = new TestChromiumLauncher({
    executablePath: findChromium(),
    headless: true,
    chromiumSandbox: false,
  });
  let engine: LaunchedBrowser | undefined;
  let surface: string | undefined;
  const runtime = new BrowserRuntime({
    runtimeId: "browser-runtime-integration",
    initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
    launcher: {
      launch: async (request) => {
        engine = await launcher.launch(request);
        return engine;
      },
    },
    // The enrolled relay fixture verifies the real Host signature before forwarding this ticket.
    ticketVerifier: {
      verify: async (ticket) =>
        BrowserAttachTicketClaimsSchema.parse(
          JSON.parse(Buffer.from(ticket.split(".")[1]!, "base64url").toString()),
        ),
    },
    sessionFilesRoot: join(directory, "files"),
  });
  const attach = runtime.attach.bind(runtime);
  runtime.attach = async (ticket, sink) =>
    attach(ticket, {
      sendFrame: (frame) => sink.sendFrame(frame),
      sendServer: (message) => {
        if (message.type === "browser.snapshot") surface = message.surfaces[0]?.id;
        return sink.sendServer(message);
      },
    });
  const server = new BrowserRuntimeServer({
    runtime,
    port: 0,
    relayBridge: { token: randomUUID(), updateAttachKeys: () => undefined },
  });
  const close = async () => {
    try {
      await server.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    const address = await server.start();
    return {
      encoding: "jpeg",
      runtimeUrl: `ws://127.0.0.1:${address.port}/v1/browser`,
      surfaceId: () => {
        if (!surface) throw new Error("Producer has no root surface");
        return surface;
      },
      evaluate: async <T>(expression: string): Promise<T> => {
        const page = engine?.context.pages()[0];
        if (!page) throw new Error("Producer has no root page");
        const result = await (
          await page.cdp()
        ).send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (result.exceptionDetails)
          throw new Error(`Fixture evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
        return result.result.value;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
