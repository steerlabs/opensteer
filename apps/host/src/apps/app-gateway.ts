import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type IncomingHttpHeaders } from "node:http";
import { type Duplex } from "node:stream";
import type { FastifyInstance } from "fastify";
import {
  AppIdSchema,
  AuthSessionIdSchema,
  UserIdSchema,
  type AuthenticatedSession,
} from "@opensteer/core";
import type { IdentityService } from "@opensteer/identity";
import {
  appIdFromHostname,
  appOriginHeader,
  appOriginKey,
  appOriginTicketParameter,
  isAppOriginUrl,
  prepareAppHtml,
  type AppTheme,
} from "@opensteer/shared/appFrame";
import { z } from "zod";
import {
  appGatewayCookieName,
  appOriginHeaders,
  appOriginRequestHeaders,
  appOriginResponseHeaders,
  type AppOriginMode,
} from "./app-proxy.js";
import type { AppService } from "./app-service.js";

const cookieLifetime = 30 * 24 * 60 * 60 * 1_000;
const loopbackNames = ["localhost", "127.0.0.1", "[::1]"];
const identitySchema = z.strictObject({
  appId: AppIdSchema,
  origin: z.string(),
  userId: UserIdSchema,
  sessionId: AuthSessionIdSchema,
  theme: z.enum(["light", "dark"]),
  expiry: z.number().int(),
});
type AppIdentity = z.infer<typeof identitySchema>;
type UpgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

export function hasAppAuthority(headers: IncomingHttpHeaders): boolean {
  return (
    headers[appOriginHeader] !== undefined ||
    /^[a-z2-7]{26}\.localhost(?::\d+)?$/iu.test(headers.host ?? "")
  );
}

interface AppGatewayOptions {
  apps: Pick<AppService, "get" | "response" | "connect">;
  identity: Pick<IdentityService, "isSessionCurrent">;
  signingKey: Uint8Array;
  canonicalOrigin: string;
  /** A real origin holds one person's logins and storage, so shared Deployments have none. */
  realOrigins: boolean;
}

export class AppGateway {
  readonly #tickets = new Map<string, { identity: AppIdentity; expiry: number }>();
  readonly #sockets = new Map<Duplex, number>();
  readonly #options: AppGatewayOptions;
  constructor(options: AppGatewayOptions) {
    this.#options = options;
  }

  entryUrl(
    appId: string,
    session: AuthenticatedSession,
    theme: AppTheme,
    headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  ): string | undefined {
    if (!this.#options.realOrigins) return undefined;
    const canonical = new URL(this.#options.canonicalOrigin);
    const host = typeof headers.host === "string" ? headers.host : "";
    const connect =
      /^connect-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([a-z0-9.-]+)$/u.exec(
        host,
      );
    let origin: string;
    if (connect)
      origin = `https://${appOriginKey(appId)}-${connect[1]!.replaceAll("-", "")}.${connect[2]}`;
    else if (
      canonical.protocol === "http:" &&
      loopbackNames.includes(canonical.hostname) &&
      loopbackNames.some((name) => host === name + (canonical.port && `:${canonical.port}`))
    ) {
      const agent = typeof headers["user-agent"] === "string" ? headers["user-agent"] : "";
      if (/Safari/iu.test(agent) && !/Chrome|Chromium|CriOS|Edg|OPR/iu.test(agent))
        return undefined;
      origin = `http://${appOriginKey(appId)}.localhost${canonical.port ? `:${canonical.port}` : ""}`;
    } else return undefined;
    const now = Date.now();
    for (const [ticket, value] of this.#tickets)
      if (value.expiry <= now) this.#tickets.delete(ticket);
    if (this.#tickets.size >= 4_096) this.#tickets.delete(this.#tickets.keys().next().value!);
    const ticket = randomBytes(32).toString("base64url");
    this.#tickets.set(ticket, {
      identity: {
        appId,
        origin,
        userId: session.user.id,
        sessionId: session.id,
        theme,
        expiry: now + cookieLifetime,
      },
      expiry: now + 60_000,
    });
    return `${origin}/?${appOriginTicketParameter}=${ticket}`;
  }

  installHttp(app: FastifyInstance): void {
    app.addHook("onRequest", async (request, reply) => {
      if (!hasAppAuthority(request.headers)) return;
      // Fastify still runs post-response hooks after a hijacked response finishes.
      reply.hijack();
      const controller = new AbortController();
      const cleanup = this.#track(request.raw.socket, controller);
      reply.raw.once("close", () => {
        cleanup();
        controller.abort();
      });
      try {
        const mode = this.#authority(request.headers);
        if (!this.#isolated(request.raw, mode.origin, false))
          throw new Error("App request refused");
        const { identity, cookie, path, entry } = await this.#admit(request.raw, mode);
        this.#recheck(identity, controller, request.raw.socket);
        const result = await this.#options.apps.response({
          appId: identity.appId,
          userId: identity.userId,
          originMode: mode,
          theme: identity.theme,
          prefix: "",
          path,
          method: request.method,
          headers: request.headers,
          body: request.raw,
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          result.body.destroy();
          return;
        }
        const headers = { ...result.headers, ...appOriginHeaders(mode) };
        if (cookie) {
          headers["set-cookie"] = [cookie, ...[result.headers["set-cookie"] ?? []].flat()];
        }
        if (entry) headers["cache-control"] = "private, no-store";
        reply.raw.writeHead(result.status, headers);
        result.body.on("error", () => reply.raw.destroy());
        result.body.pipe(reply.raw);
      } catch (error) {
        if (controller.signal.aborted) return;
        const mode = this.#safeAuthority(request.headers);
        const html = prepareAppHtml(
          "<title>Opensteer app</title><body><p>Open this app from Opensteer.</p></body>",
          "light",
          true,
        );
        reply.raw.writeHead(
          error && typeof error === "object" && "statusCode" in error && error.statusCode === 413
            ? 413
            : 403,
          {
            ...appOriginHeaders(mode),
            "cache-control": "private, no-store",
            "content-type": "text/html; charset=utf-8",
            "content-length": Buffer.byteLength(html),
            connection: "close",
          },
        );
        request.raw.resume();
        reply.raw.end(request.method === "HEAD" ? undefined : html);
      }
    });
    app.addHook("preClose", async () => {
      for (const socket of this.#sockets.keys()) socket.destroy();
    });
  }

  installUpgrades(app: FastifyInstance): void {
    const server = app.server;
    const inherited = server.listeners("upgrade") as UpgradeListener[];
    server.removeAllListeners("upgrade");
    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!hasAppAuthority(request.headers)) {
        for (const listener of inherited) listener.call(server, request, socket, head);
        return;
      }
      socket.on("error", () => undefined);
      const controller = new AbortController();
      this.#track(socket, controller);
      socket.pause();
      void this.#upgrade(request, socket, head, controller);
    });
  }

  async #upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    controller: AbortController,
  ): Promise<void> {
    try {
      const mode = this.#authority(request.headers);
      if (!this.#isolated(request, mode.origin, true)) throw new Error("App upgrade refused");
      const { identity, cookie, path, entry } = await this.#admit(request, mode);
      this.#recheck(identity, controller, socket);
      const { stream, port } = await this.#options.apps.connect(
        identity.appId,
        identity.userId,
        controller.signal,
      );
      if (controller.signal.aborted) {
        stream.destroy();
        return;
      }
      const headers = appOriginRequestHeaders(request.headers);
      headers.host = `127.0.0.1:${port}`;
      headers.connection = "Upgrade";
      headers.upgrade = request.headers.upgrade ?? "websocket";
      const upstream = httpRequest({
        host: "127.0.0.1",
        port,
        path,
        method: request.method,
        headers,
        createConnection: () => stream,
        signal: controller.signal,
      });
      upstream.on("error", () => socket.destroy());
      stream.on("error", () => socket.destroy());
      controller.signal.addEventListener(
        "abort",
        () => {
          upstream.destroy();
          stream.destroy();
        },
        { once: true },
      );
      const writeHeaders = (response: IncomingMessage, upgrade: boolean) => {
        const outgoing = appOriginResponseHeaders(response.headers, mode);
        outgoing.connection = upgrade ? "Upgrade" : "close";
        if (upgrade) outgoing.upgrade = response.headers.upgrade ?? "websocket";
        if (cookie) {
          outgoing["set-cookie"] = [cookie, ...[outgoing["set-cookie"] ?? []].flat()];
        }
        if (entry) outgoing["cache-control"] = "private, no-store";
        const lines = Object.entries(outgoing).flatMap(([name, value]) =>
          (Array.isArray(value) ? value : [value]).map((item) => `${name}: ${item}`),
        );
        socket.write(
          `HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? ""}\r\n${lines.join("\r\n")}\r\n\r\n`,
        );
      };
      upstream.once("response", (response) => {
        writeHeaders(response, false);
        response.on("error", () => socket.destroy());
        response.pipe(socket);
      });
      upstream.once("upgrade", (response, tunnel, upstreamHead) => {
        writeHeaders(response, true);
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) tunnel.write(head);
        tunnel.on("error", () => socket.destroy());
        tunnel.once("close", () => socket.destroy());
        socket.once("close", () => tunnel.destroy());
        socket.pipe(tunnel).pipe(socket);
        socket.resume();
      });
      upstream.end();
    } catch {
      if (!socket.destroyed)
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  }

  #authority(headers: IncomingHttpHeaders): AppOriginMode & { appId: string } {
    const forwarded = headers[appOriginHeader];
    const origin =
      forwarded === undefined
        ? `http://${(headers.host ?? "").toLowerCase()}`
        : typeof forwarded === "string"
          ? forwarded
          : "";
    if (!isAppOriginUrl(origin) || new URL(origin).origin !== origin)
      throw new Error("Invalid app authority");
    const url = new URL(origin);
    const appId = appIdFromHostname(url.hostname)!;
    const parents = ["app://opensteer"];
    const connect = /^[a-z2-7]{26}-([0-9a-f]{32})\.(.+)$/u.exec(url.hostname);
    if (url.protocol === "https:" && connect) {
      const hex = connect[1]!;
      parents.push(
        `https://connect-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}.${connect[2]}`,
      );
    } else if (url.protocol === "http:" && /^[a-z2-7]{26}\.localhost$/u.test(url.hostname)) {
      for (const host of loopbackNames)
        parents.push(`http://${host}${url.port ? `:${url.port}` : ""}`);
    } else throw new Error("Invalid app authority");
    return { appId, origin, parents };
  }
  #safeAuthority(headers: IncomingHttpHeaders): AppOriginMode {
    try {
      return this.#authority(headers);
    } catch {
      return { origin: "", parents: ["app://opensteer"] };
    }
  }
  #isolated(request: IncomingMessage, origin: string, upgrade: boolean): boolean {
    if (upgrade) return request.headers.origin === origin;
    const site = request.headers["sec-fetch-site"];
    if (site === undefined)
      return request.headers.origin === undefined || request.headers.origin === origin;
    return (
      site === "same-origin" ||
      site === "none" ||
      (["GET", "HEAD"].includes(request.method ?? "") &&
        request.headers["sec-fetch-mode"] === "navigate")
    );
  }
  async #admit(request: IncomingMessage, mode: AppOriginMode & { appId: string }) {
    const url = new URL(request.url ?? "/", mode.origin);
    const ticket = url.searchParams.get(appOriginTicketParameter);
    const entry = ticket ? this.#tickets.get(ticket) : undefined;
    if (ticket) this.#tickets.delete(ticket);
    let identity =
      entry &&
      entry.expiry > Date.now() &&
      entry.identity.appId === mode.appId &&
      entry.identity.origin === mode.origin
        ? entry.identity
        : undefined;
    const fromTicket = identity !== undefined;
    if (!identity) {
      const cookie = (request.headers.cookie ?? "")
        .split(/; ?/u)
        .find((pair) => pair.startsWith(`${appGatewayCookieName}=`));
      identity = this.#verify(cookie?.slice(appGatewayCookieName.length + 1));
    }
    if (!identity || identity.appId !== mode.appId || identity.origin !== mode.origin)
      throw new Error("App identity required");
    await this.#authorize(identity);
    // Preserve the app's path and query bytes except for the private entry parameter.
    const raw = request.url ?? "/";
    const query = raw.indexOf("?");
    const path =
      query < 0
        ? raw
        : raw.slice(0, query) +
          (() => {
            const fields = raw
              .slice(query + 1)
              .split("&")
              .filter((part) => {
                try {
                  return (
                    decodeURIComponent(part.split("=")[0]!.replaceAll("+", " ")) !==
                    appOriginTicketParameter
                  );
                } catch {
                  return true;
                }
              });
            return fields.length ? `?${fields.join("&")}` : "";
          })();
    return {
      identity,
      path,
      entry: ticket !== null,
      cookie: fromTicket
        ? `${appGatewayCookieName}=${this.#sign(identity)}; HttpOnly; Secure; SameSite=None; Partitioned; Path=/; Max-Age=${cookieLifetime / 1_000}`
        : undefined,
    };
  }
  #sign(identity: AppIdentity): string {
    const payload = Buffer.from(JSON.stringify(identity)).toString("base64url");
    return `${payload}.${createHmac("sha256", this.#options.signingKey).update(payload).digest("base64url")}`;
  }
  #verify(cookie: string | undefined): AppIdentity | undefined {
    if (!cookie || cookie.length > 4_096) return undefined;
    const [payload, signature, extra] = cookie.split(".");
    if (!payload || !signature || extra !== undefined) return undefined;
    const expected = createHmac("sha256", this.#options.signingKey).update(payload).digest();
    const provided = Buffer.from(signature, "base64url");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
      return undefined;
    try {
      const parsed = identitySchema.safeParse(
        JSON.parse(Buffer.from(payload, "base64url").toString()),
      );
      return parsed.success && parsed.data.expiry > Date.now() ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
  async #authorize(identity: AppIdentity): Promise<void> {
    if (
      identity.expiry <= Date.now() ||
      !(await this.#options.identity.isSessionCurrent(identity.sessionId, identity.userId))
    )
      throw new Error("App session ended");
    await this.#options.apps.get(identity.appId, identity.userId);
  }
  #track(socket: Duplex, controller: AbortController): () => void {
    this.#sockets.set(socket, (this.#sockets.get(socket) ?? 0) + 1);
    let active = true;
    const cleanup = () => {
      if (!active) return;
      active = false;
      const count = this.#sockets.get(socket) ?? 1;
      if (count <= 1) this.#sockets.delete(socket);
      else this.#sockets.set(socket, count - 1);
      socket.off("close", close);
    };
    const close = () => {
      cleanup();
      controller.abort();
    };
    socket.once("close", close);
    return cleanup;
  }
  #recheck(identity: AppIdentity, controller: AbortController, socket: Duplex): void {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      if (controller.signal.aborted) return;
      timer = setTimeout(() => {
        void this.#authorize(identity).then(schedule, () => {
          controller.abort();
          socket.destroy();
        });
      }, 30_000);
      timer.unref();
    };
    controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    schedule();
  }
}
