import {
  standardCdpBufferedMaxBytes,
  standardCdpMaxPending,
  standardCdpMessageMaxBytes,
} from "@opensteer/protocol/standard-cdp";
import { rawDataBuffer } from "@opensteer/shared/webSocketFrame";
import { withTimeout } from "@opensteer/shared/withTimeout";
import type { FastifyInstance } from "fastify";
import { WebSocket, type RawData } from "ws";
import { z } from "zod";
import { unversionedRoute } from "../server/unversioned-route.js";
import { OpensteerError } from "@opensteer/core";
import { BrowserCdpConnectionEnded, type BrowserService } from "./browser-service.js";
import type { ChromeSharedTabs } from "./chrome-shared-tabs.js";
import { standardCdpConnectPrefix, type StandardCdpTicketClaims } from "./standard-cdp-tickets.js";
import { RawCdpRequestSchema } from "./standard-cdp-transport.js";

export const standardCdpRecheckMs = 2_000;
const authorityCheckMs = standardCdpRecheckMs / 2;
const ticketParams = z.object({ ticket: z.string() });
const replyId = z.object({
  id: z.number().int().nonnegative().optional(),
  sessionId: z.string().optional(),
});
const commandKey = (id: number, sessionId?: string) => JSON.stringify([id, sessionId]);

type StandardCdpBrowser = Pick<BrowserService, "standardCdpTickets" | "attachStandardCdpForAgent">;

export function registerStandardCdpRoute(
  app: FastifyInstance,
  browser: StandardCdpBrowser,
  chromeTabs?: ChromeSharedTabs,
): void {
  const upgrades = new WeakMap<object, StandardCdpTicketClaims>();
  app.get(
    `${standardCdpConnectPrefix}:ticket`,
    {
      config: unversionedRoute,
      websocket: true,
      preValidation: (request, reply, done) => {
        if (!request.ws) {
          void reply.code(426).send({ error: "WebSocket required" });
          return;
        }
        const params = ticketParams.safeParse(request.params);
        const claims = params.success
          ? (browser.standardCdpTickets?.consume(params.data.ticket) ??
            chromeTabs?.standardCdpTickets.consume(params.data.ticket))
          : undefined;
        if (!claims) {
          void reply.code(401).send({ error: "Browser attachment ticket is invalid or expired" });
          return;
        }
        upgrades.set(request, claims);
        done();
      },
    },
    (socket, request) => {
      const claims = upgrades.get(request);
      upgrades.delete(request);
      if (!claims) socket.close(1008, "Browser attachment refused");
      else
        relayStandardCdp(
          socket,
          claims,
          claims.sharedChromeTab && chromeTabs ? chromeTabs : browser,
        );
    },
  );
}

function relayStandardCdp(
  socket: WebSocket,
  claims: StandardCdpTicketClaims,
  browser: StandardCdpBrowser,
): void {
  const stopping = new AbortController();
  const pending = new Map<string, number>();
  let inBytes = 0;
  let outBytes = 0;
  let outCount = 0;
  let sending = Promise.resolve();
  let checking: Promise<void> | undefined;
  let refusalTimer: NodeJS.Timeout | undefined;
  let expiryTimer: NodeJS.Timeout | undefined;

  const end = (code: number, reason: string) => {
    if (stopping.signal.aborted) return;
    stopping.abort();
    clearInterval(recheck);
    clearTimeout(refusalTimer);
    clearTimeout(expiryTimer);
    pending.clear();
    if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
  };
  const overload = () => end(1013, "CDP relay overloaded");
  const send = (data: Buffer): Promise<void> =>
    new Promise((resolve, reject) => {
      if (stopping.signal.aborted || socket.readyState !== WebSocket.OPEN) {
        resolve();
        return;
      }
      socket.send(data, { binary: false }, (error) => (error ? reject(error) : resolve()));
    });
  const authorize = (verify: () => Promise<void>) => {
    checking ??= withTimeout(verify(), authorityCheckMs, {
      signal: stopping.signal,
      timeoutError: () => new Error("Browser authority could not be rechecked."),
    }).finally(() => {
      checking = undefined;
    });
    return checking;
  };
  const ready = browser.attachStandardCdpForAgent(claims, stopping.signal).then(
    (attached) => {
      if (stopping.signal.aborted) {
        attached.close();
        return undefined;
      }
      const ended = () => {
        if (attached.signal.reason === 1013) overload();
        else end(1000, "Browser attachment ended");
      };
      attached.signal.addEventListener("abort", ended, { once: true });
      if (attached.signal.aborted) {
        ended();
        return undefined;
      }
      attached.onFrame((frame) => {
        if (stopping.signal.aborted) return;
        if (
          frame.length > standardCdpMessageMaxBytes ||
          inBytes + outBytes + frame.length > standardCdpBufferedMaxBytes ||
          outCount >= standardCdpMaxPending
        ) {
          overload();
          return;
        }
        outBytes += frame.length;
        outCount++;
        void authorize(attached.reauthorize)
          .then(async () => {
            if (stopping.signal.aborted) return;
            const { id, sessionId } = replyId.parse(JSON.parse(frame.toString("utf8")));
            const key = id === undefined ? undefined : commandKey(id, sessionId);
            await send(frame);
            if (key !== undefined && pending.has(key)) {
              inBytes -= pending.get(key)!;
              pending.delete(key);
            }
          })
          .catch(() => end(1008, "Browser authority ended"))
          .finally(() => {
            outBytes -= frame.length;
            outCount--;
          });
      });
      return attached;
    },
    (error: unknown) => {
      if (stopping.signal.aborted) return undefined;
      refusalTimer = setTimeout(() => end(1008, "Browser attachment refused"), 10_000);
      refusalTimer.unref();
      return error instanceof BrowserCdpConnectionEnded ||
        (claims.sharedChromeTab && error instanceof OpensteerError)
        ? error.message
        : "Browser attachment refused.";
    },
  );

  const recheck = setInterval(() => {
    void ready
      .then((attached) => {
        if (attached && typeof attached !== "string" && !stopping.signal.aborted)
          return authorize(attached.reauthorize);
        return undefined;
      })
      .catch(() => end(1008, "Browser authority ended"));
  }, authorityCheckMs);
  recheck.unref();
  if (claims.authority.expiresAt !== undefined) {
    expiryTimer = setTimeout(
      () => end(1008, "Browser authority expired"),
      Math.min(2_147_483_647, Math.max(0, claims.authority.expiresAt - Date.now())),
    );
    expiryTimer.unref();
  }
  socket.once("close", () => end(1000, "CDP disconnected"));
  socket.on("error", () => end(1011, "CDP transport failed"));
  socket.on("message", (raw: RawData, binary: boolean) => {
    if (stopping.signal.aborted) return;
    const frame = rawDataBuffer(raw);
    if (binary) {
      end(1003, "CDP requires JSON text");
      return;
    }
    if (frame.length > standardCdpMessageMaxBytes) {
      end(1009, "CDP message too large");
      return;
    }
    if (
      inBytes + outBytes + frame.length > standardCdpBufferedMaxBytes ||
      pending.size >= standardCdpMaxPending
    ) {
      overload();
      return;
    }
    let request: z.infer<typeof RawCdpRequestSchema>;
    try {
      request = RawCdpRequestSchema.parse(JSON.parse(frame.toString("utf8")));
    } catch {
      end(1007, "Invalid CDP command");
      return;
    }
    const key = commandKey(request.id, request.sessionId);
    if (pending.has(key)) {
      end(1007, "Duplicate pending CDP command");
      return;
    }
    pending.set(key, frame.length);
    inBytes += frame.length;
    sending = sending
      .then(async () => {
        const attached = await ready;
        if (!attached || stopping.signal.aborted) return;
        if (typeof attached === "string") {
          const data = Buffer.from(
            JSON.stringify({
              id: request.id,
              sessionId: request.sessionId,
              error: { code: -32000, message: attached },
            }),
          );
          await send(data);
          end(1008, "Browser attachment refused");
          return;
        }
        await authorize(attached.reauthorize);
        if (!stopping.signal.aborted) await attached.send(frame);
      })
      .catch(() => end(1008, "Browser authority or runtime ended"));
  });
}
