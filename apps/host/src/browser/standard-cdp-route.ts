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
import { OpensteerError, type TabId } from "@opensteer/core";
import type { AgentWorkingInRegistry } from "../agent-sessions/agent-working-in.js";
import {
  cdpCommandRefusal,
  connectionAutoAttachParameters,
  connectionNestedAutoAttachRefusal,
  nestsAutoAttach,
} from "@opensteer/browser-runtime-core";
import { BrowserCdpConnectionEnded, type BrowserService } from "./browser-service.js";
import type { ChromeSharedTabs } from "./chrome-shared-tabs.js";
import {
  standardCdpConnectPrefix,
  type StandardCdpTicketClaims,
  type StandardCdpUpgrade,
  type StandardCdpPoolReservation,
} from "./standard-cdp-tickets.js";
import {
  RawCdpRequestSchema,
  standardCdpAdmissionMs,
  standardCdpMaxLivePerBinding,
} from "./standard-cdp-transport.js";

export const standardCdpRecheckMs = 2_000;
const authorityCheckMs = standardCdpRecheckMs / 2;
const ticketParams = z.object({ ticket: z.string() });
const replyId = z.object({
  id: z.number().int().nonnegative().optional(),
  sessionId: z.string().optional(),
  result: z.object({ sessionId: z.string().optional() }).loose().optional(),
});
const commandKey = (id: number, sessionId?: string) => JSON.stringify([id, sessionId]);

type StandardCdpBrowser = Pick<BrowserService, "standardCdpTickets" | "attachStandardCdpForAgent">;

export function registerStandardCdpRoute(
  app: FastifyInstance,
  browser: StandardCdpBrowser,
  chromeTabs?: ChromeSharedTabs,
  workingIn?: Pick<AgentWorkingInRegistry, "note">,
): void {
  const upgrades = new WeakMap<object, { upgrade: StandardCdpUpgrade; transferred?: () => void }>();
  const liveByBinding = new Map<string, number>();
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
        const upgrade = params.success
          ? (browser.standardCdpTickets?.consumeForUpgrade(params.data.ticket) ??
            chromeTabs?.standardCdpTickets.consumeForUpgrade(params.data.ticket))
          : undefined;
        if (!upgrade) {
          void reply
            .code(401)
            .send({ error: "This browser connection link is invalid or expired." });
          return;
        }
        const entry: { upgrade: StandardCdpUpgrade; transferred?: () => void } = { upgrade };
        if (upgrade.pool) {
          const { pool } = upgrade;
          const end = () => {
            upgrades.delete(request);
            entry.transferred?.();
            pool.release();
          };
          const socket = request.raw.socket;
          socket.once("close", end);
          reply.raw.once("finish", end);
          entry.transferred = () => {
            socket.off("close", end);
            reply.raw.off("finish", end);
          };
        }
        upgrades.set(request, entry);
        done();
      },
    },
    (socket, request) => {
      const entry = upgrades.get(request);
      upgrades.delete(request);
      if (!entry) {
        closeStandardSocket(socket, 1008, "Browser attachment refused");
        return;
      }
      entry.transferred?.();
      const { claims, pool } = entry.upgrade;
      const binding = claims.authority.agentBindingId;
      const live = liveByBinding.get(binding) ?? 0;
      if (live >= standardCdpMaxLivePerBinding) {
        pool?.release();
        closeStandardSocket(socket, 1013, "Too many live browser connections for this task.");
        return;
      }
      liveByBinding.set(binding, live + 1);
      socket.once("close", () => {
        const remaining = (liveByBinding.get(binding) ?? 1) - 1;
        if (remaining) liveByBinding.set(binding, remaining);
        else liveByBinding.delete(binding);
      });
      relayStandardCdp(
        socket,
        claims,
        claims.sharedChromeTab && chromeTabs ? chromeTabs : browser,
        pool,
        workingIn,
      );
    },
  );
}

function relayStandardCdp(
  socket: WebSocket,
  claims: StandardCdpTicketClaims,
  browser: StandardCdpBrowser,
  pool?: StandardCdpPoolReservation,
  workingIn?: Pick<AgentWorkingInRegistry, "note">,
): void {
  const stopping = new AbortController();
  // The one tab this ticket was issued for: the shared Chrome tab, or the page it attached to.
  const tabId = claims.sharedChromeTab?.tabId ?? claims.facts.seed?.surfaceId;
  // Settled when the ticket was issued, from the one authority rule's resolution of its binding.
  const connectionWork = claims.facts.agentConnectionId !== null;
  const pending = new Map<string, number>();
  // Sessions the router opened as aliases of the browser root: their auto-attach is the root's.
  const rootAliases = new Set<string>();
  const aliasRequests = new Set<string>();
  let inBytes = 0;
  let outBytes = 0;
  let outCount = 0;
  let sending = Promise.resolve();
  let checking: Promise<void> | undefined;
  let recheck: NodeJS.Timeout | undefined;
  let refusalTimer: NodeJS.Timeout | undefined;
  let expiryTimer: NodeJS.Timeout | undefined;

  const end = (code: number, reason: string) => {
    if (stopping.signal.aborted) return;
    stopping.abort();
    clearInterval(recheck);
    clearTimeout(refusalTimer);
    clearTimeout(expiryTimer);
    pending.clear();
    closeStandardSocket(socket, code, reason);
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
  const authorize = (verify: (signal?: AbortSignal) => Promise<void>) => {
    const check = AbortSignal.timeout(authorityCheckMs);
    checking ??= withTimeout(verify(AbortSignal.any([check, stopping.signal])), authorityCheckMs, {
      signal: stopping.signal,
      timeoutError: () => new Error("Browser authority could not be rechecked."),
    }).finally(() => {
      checking = undefined;
    });
    return checking;
  };
  const initial = new AbortController();
  const opening = pool
    ? browser.attachStandardCdpForAgent(claims, stopping.signal, initial.signal, pool)
    : browser.attachStandardCdpForAgent(claims, stopping.signal, initial.signal);
  void opening.then(
    (attached) => {
      if (initial.signal.aborted || stopping.signal.aborted) attached.close();
    },
    () => undefined,
  );
  const ready = withTimeout(opening, standardCdpAdmissionMs, {
    signal: stopping.signal,
    timeoutError: () => {
      const error = new BrowserCdpConnectionEnded("Browser attachment admission timed out.");
      initial.abort(error);
      return error;
    },
  }).then(
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
            const { id, sessionId, result } = replyId.parse(JSON.parse(frame.toString("utf8")));
            const key = id === undefined ? undefined : commandKey(id, sessionId);
            if (key !== undefined && aliasRequests.delete(key) && result?.sessionId)
              rootAliases.add(result.sessionId);
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
      recheck = setInterval(() => {
        if (!stopping.signal.aborted)
          void authorize(attached.reauthorize).catch(() => end(1008, "Browser authority ended"));
      }, authorityCheckMs);
      recheck.unref();
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
    if (request.method === "Target.attachToBrowserTarget" && !request.sessionId)
      aliasRequests.add(key);
    if (request.method === "Target.detachFromTarget") {
      const detached = request.params?.sessionId;
      if (typeof detached === "string") rootAliases.delete(detached);
    }
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
        // Refused here for every runtime, before anything reaches the browser.
        // The method list itself is the runtime router's, whose standard client also admits the
        // whole-context branch; a connection's page auto-attach is limited here as well, so a
        // runtime of any version receives it limited.
        const refusal =
          cdpCommandRefusal(request.method, request.params, connectionWork) ??
          (connectionWork && nestsAutoAttach(request.method, request.params)
            ? connectionNestedAutoAttachRefusal
            : undefined);
        if (refusal) {
          await send(
            Buffer.from(
              JSON.stringify({
                id: request.id,
                sessionId: request.sessionId,
                error: { code: -32000, message: refusal },
              }),
            ),
          );
          if (pending.has(key)) {
            inBytes -= pending.get(key)!;
            pending.delete(key);
          }
          return;
        }
        await authorize(attached.reauthorize);
        // Rechecked: the connection's work is in its tab now (in memory; a Run's is ignored).
        if (tabId !== undefined) workingIn?.note(claims.authority.agentBindingId, tabId as TabId);
        const sent =
          connectionWork &&
          request.method === "Target.setAutoAttach" &&
          request.sessionId &&
          !rootAliases.has(request.sessionId)
            ? Buffer.from(
                JSON.stringify({
                  ...request,
                  params: connectionAutoAttachParameters(request.params),
                }),
                "utf8",
              )
            : frame;
        if (!stopping.signal.aborted) await attached.send(sent);
      })
      .catch(() => end(1008, "Browser authority or runtime ended"));
  });
}

function closeStandardSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
  if (socket.readyState !== WebSocket.CLOSED) {
    const hardClose = setTimeout(() => socket.terminate(), 1_000);
    hardClose.unref();
    socket.once("close", () => clearTimeout(hardClose));
  }
}
