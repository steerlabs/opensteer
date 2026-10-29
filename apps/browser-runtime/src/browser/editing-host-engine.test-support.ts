import { z } from "zod";
import {
  BrowserRuntime,
  BrowserRuntimeServer,
  type LaunchedBrowser,
} from "@opensteer/browser-runtime-core";
import { BrowserAttachTicketClaimsSchema } from "@opensteer/protocol";
import {
  FakeProfileStateClient,
  testSessionFilesRoot,
} from "@opensteer/browser-runtime-core/test-support";
import { chromium } from "playwright-core";
import { PlaywrightChromiumLauncher } from "./playwright-launcher.js";

let engine: LaunchedBrowser | undefined;
const trace: Record<string, unknown>[] = [];
const record = (step: string, facts: Record<string, unknown> = {}) => {
  if (trace.length === 1024) trace.shift();
  trace.push({ at: Date.now(), step, ...facts });
};
const launcher = new PlaywrightChromiumLauncher({
  headless: true,
  chromiumSandbox: false,
  executablePath: chromium.executablePath(),
});
const runtime = new BrowserRuntime({
  runtimeId: "browser-runtime-integration",
  launcher: {
    launch: async (request) => {
      engine = await launcher.launch(request);
      const clipboard = engine.clipboard;
      if (clipboard) {
        const open = clipboard.open.bind(clipboard);
        clipboard.open = async (page, input) => {
          record("clipboard.open.start", {
            items: input?.map((item) => ({ type: item.type, bytes: item.bytes.length })),
          });
          const scope = await open(page, input);
          record("clipboard.open.end");
          return {
            close: async () => {
              record("clipboard.close.start");
              const result = await scope.close();
              record("clipboard.close.end");
              return result;
            },
          };
        };
      }
      return engine;
    },
  },
  ticketVerifier: {
    verify: async (ticket) =>
      BrowserAttachTicketClaimsSchema.parse(
        JSON.parse(Buffer.from(ticket.split(".")[1]!, "base64url").toString()),
      ),
  },
  profileStateClient: new FakeProfileStateClient(),
  sessionFilesRoot: testSessionFilesRoot(),
});
const attach = runtime.attach.bind(runtime);
runtime.attach = async (ticket, sink) => {
  const attached = await attach(ticket, {
    sendFrame: (frame) => sink.sendFrame(frame),
    sendServer: (message) => {
      if (message.type.startsWith("clipboard."))
        record("output", {
          type: message.type,
          ...("operationId" in message ? { operationId: message.operationId } : {}),
          ...(message.type === "clipboard.result" ? { outcome: message.outcome } : {}),
        });
      return sink.sendServer(message);
    },
  });
  const handle = attached.handle.bind(attached);
  attached.handle = (frame) => {
    const metadata = z
      .object({
        type: z.string(),
        operationId: z.string().optional(),
        part: z.object({ operationId: z.string(), index: z.number(), data: z.string() }).optional(),
      })
      .parse(JSON.parse(frame.toString()));
    const facts = {
      type: metadata.type,
      operationId: metadata.operationId ?? metadata.part?.operationId,
      ...(metadata.part
        ? { index: metadata.part.index, bytes: Buffer.from(metadata.part.data, "base64").length }
        : {}),
    };
    record("input", facts);
    return handle(frame).finally(() => record("input.done", facts));
  };
  return attached;
};
const server = new BrowserRuntimeServer({ runtime, port: 0 });
let stopping: Promise<void> | undefined;
const stop = () => {
  stopping ??= server.close().finally(() => process.exit());
  return stopping;
};
process.on("disconnect", () => void stop());
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
const request = z.object({
  requestId: z.uuid(),
  method: z.string(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});
process.on("message", (value) => {
  if (value === "stop") {
    void stop();
    return;
  }
  const parsed = request.safeParse(value);
  if (!parsed.success) return;
  void (async () => {
    try {
      if (parsed.data.method === "Opensteer.testDiagnostics") {
        process.send?.({ requestId: parsed.data.requestId, result: trace });
        return;
      }
      const cdp = await engine!.context.pages()[0]!.cdp();
      const result = await cdp.send(parsed.data.method, parsed.data.parameters);
      process.send?.({ requestId: parsed.data.requestId, result });
    } catch (error) {
      process.send?.({ requestId: parsed.data.requestId, error: String(error) });
    }
  })();
});
const address = await server.start();
process.send?.({ type: "ready", url: `ws://127.0.0.1:${address.port}/v1/browser` });
