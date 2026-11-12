import { KeyedStreamReceiver } from "../../packages/protocol/src/keyed-stream.js";
import type {
  BrowserTabRecord,
  BrowserTabStreamMeta,
} from "../../packages/protocol/src/browser-tabs.js";
import { createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserRuntime,
  BrowserRuntimeServer,
  Ed25519AttachTicketVerifier,
  defaultAttachTicketReplayLedgerPath,
  type LaunchedBrowser,
} from "../../packages/browser-runtime-core/src/index.js";
import {
  TestChromiumLauncher,
  findChromium,
} from "../../apps/browser-runtime/src/browser/browser-test-lifecycle.js";

/** Producer seam: a future video runtime supplies the same fixture evaluation and real relay URL. */
export interface BrowserStreamProducer {
  readonly encoding: string;
  readonly runtimeUrl: string;
  readonly browserBridge: {
    readonly bridgeToken: string;
    readonly runtimeId: string;
    readonly url: URL;
  };
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
  const keys = new Map<string, KeyObject>();
  const bridgeToken = randomUUID();
  const runtimeId = "browser-runtime-integration";
  const runtime = new BrowserRuntime({
    runtimeId: "browser-runtime-integration",
    initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
    launcher: {
      launch: async (request) => {
        engine = await launcher.launch(request);
        return engine;
      },
    },
    ticketVerifier: await Ed25519AttachTicketVerifier.create({
      replayLedgerPath: defaultAttachTicketReplayLedgerPath(directory),
      resolvePublicKey: (keyId) => keys.get(keyId) ?? null,
    }),
    sessionFilesRoot: join(directory, "files"),
  });
  const tabs = new KeyedStreamReceiver<BrowserTabRecord, BrowserTabStreamMeta>();
  const attach = runtime.attach.bind(runtime);
  runtime.attach = async (ticket, sink) =>
    attach(ticket, {
      sendFrame: (frame) => sink.sendFrame(frame),
      sendServer: (message) => {
        if (message.type === "browser.tabs" && tabs.apply(message.stream) === "applied")
          surface = tabs.rows.keys().next().value;
        return sink.sendServer(message);
      },
    });
  const server = new BrowserRuntimeServer({
    runtime,
    port: 0,
    relayBridge: {
      token: bridgeToken,
      updateAttachKeys: (entries) => {
        keys.clear();
        for (const entry of entries) keys.set(entry.keyId, createPublicKey(entry.publicKeyPem));
      },
    },
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
      browserBridge: { bridgeToken, runtimeId, url: new URL(`http://127.0.0.1:${address.port}/`) },
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
