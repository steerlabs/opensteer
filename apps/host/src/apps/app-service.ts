import type { RunToolScope } from "../agents/run-tool-tokens.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  AppPublishInputSchema,
  AppFetchInputSchema,
  appFolderSegments,
  utf8Prefix,
  type TaskFolder,
  type AppServerSpec,
  OpensteerError,
  appMaxBytes,
  type AgentEvent,
  type UserId,
} from "@opensteer/core";
import type { AppStore } from "@opensteer/database";
import { createPrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import { readBoundedResponse } from "@opensteer/shared/boundedJson";
import { prepareAppHtml, type AppTheme } from "@opensteer/shared/appFrame";
import { Readable } from "node:stream";
import { KeyedMutationQueue } from "@opensteer/shared/mutationQueue";
import type { AppRuntimeSpec } from "@opensteer/protocol";
import { AppTunnelError, type AppTunnelHub } from "./app-tunnel-hub.js";
import {
  requestAppHttp,
  appCorsHeaders,
  appRequestPath,
  type AppHttpResponse,
  type AppOriginMode,
  appOriginHeaders,
} from "./app-proxy.js";
import { appFrameHeaders } from "@opensteer/shared/appFrame";
import type { RunToolTokenService } from "../agents/run-tool-tokens.js";
import type { FolderDirectoryPage } from "@opensteer/protocol";
import type { z } from "zod";

const unavailable = () =>
  new OpensteerError({ code: "not_found", message: "App content is unavailable" });
interface AppServiceOptions {
  readonly tunnels?: Pick<AppTunnelHub, "start" | "stop" | "connect" | "accept">;
  readonly dataDirectory: string;
  readonly apps: AppStore;
  readonly files: {
    list(
      folder: TaskFolder,
      input: { parentKey: string; limit: number; cursor?: string },
      signal: AbortSignal,
    ): Promise<FolderDirectoryPage>;
    download(folder: TaskFolder, key: string, signal: AbortSignal): Promise<Response>;
  };
  readonly tokens: Pick<RunToolTokenService, "authenticate" | "reauthorize">;
  readonly tabsChanged?: () => Promise<void>;
  readonly publishEvent: (event: AgentEvent) => void;
}

export class AppService {
  readonly #views = new Map<string, { appId: string; userId: UserId }>();
  readonly #tokensByPair = new Map<string, string>();
  readonly #locks = new KeyedMutationQueue();
  readonly #directory: string;
  readonly #options: AppServiceOptions;
  constructor(options: AppServiceOptions) {
    this.#options = options;
    this.#directory = join(options.dataDirectory, "apps");
  }

  listTabs(userId: UserId) {
    return this.#options.apps.listTabs(userId);
  }
  async setTabOpen(appId: string, userId: UserId, open: boolean) {
    const result = await this.#options.apps.setTabOpen(appId, userId, open);
    await this.#notifyTabs();
    return { appTabs: result.appTabs };
  }
  async #publishedTabsChanged(appId: string) {
    if (await this.#options.apps.tabIsOpen(appId)) await this.#notifyTabs();
  }
  async #notifyTabs() {
    try {
      await this.#options.tabsChanged?.();
    } catch {
      return;
    }
  }

  async publish(
    scope: RunToolScope,
    publishKey: string,
    input: z.infer<typeof AppPublishInputSchema>,
  ) {
    input = AppPublishInputSchema.parse(input);
    return this.#locks.run(input.appId ?? `${scope.runId}:${publishKey}`, async () => {
      const { app: previous, publisher } = await this.#options.apps.authorize({
        ...scope,
        userId: scope.requestedBy,
        ...(input.appId ? { appId: input.appId } : {}),
        fullAccess: input.start !== undefined,
      });
      const folder: TaskFolder = {
        computerId: publisher.folderComputerId,
        path: publisher.folderPath,
      };
      const replay = await this.#options.apps.publication(scope.runId, publishKey);
      if (replay) return publicationResult(replay);
      if (input.start !== undefined) {
        try {
          appFolderSegments(input.path);
        } catch {
          throw new OpensteerError({
            code: "bad_request",
            message: "Use an app folder relative to this task's folder without traversal",
          });
        }
        const server: AppServerSpec = {
          folder: {
            computerId: folder.computerId,
            path: join(folder.path, ...appFolderSegments(input.path)),
          },
          command: input.start,
        };
        const appId = input.appId ?? `app_${randomUUID()}`;
        const version = (previous?.latestVersion ?? 0) + 1;
        const spec = this.#runtimeSpec(appId, version, server);
        try {
          await this.#tunnels().start(spec, AbortSignal.timeout(30_000));
        } catch (error) {
          await this.#tunnels()
            .stop(spec)
            .catch(() => undefined);
          throw new OpensteerError({
            code: "bad_request",
            message:
              error instanceof AppTunnelError
                ? `${error.message}\n${error.logTail}`
                : "App server failed to start",
          });
        }
        try {
          await this.#options.tokens.reauthorize(scope);
          const result = await this.#options.apps.publish({
            ...scope,
            userId: scope.requestedBy,
            ...(input.appId ? { appId: input.appId } : { id: appId }),
            title: input.title,
            publishKey,
            server,
            expectedVersion: version,
          });
          if (result.event) {
            this.#options.publishEvent(result.event);
            await this.#publishedTabsChanged(result.appId);
          }
          return publicationResult(result);
        } catch (error) {
          await this.#tunnels()
            .stop(spec)
            .catch(() => undefined);
          throw error;
        }
      }
      if (!/\.html?$/iu.test(input.path))
        throw new OpensteerError({
          code: "bad_request",
          message: "Publish an HTML file (.html or .htm)",
        });
      // Files drivers resolve these opaque path segments against the admitted task folder.
      const segments = input.path.replace(/^\.\//u, "").split("/");
      if (
        segments.some(
          (part) =>
            !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0"),
        )
      )
        throw new OpensteerError({
          code: "bad_request",
          message: "Use an HTML file path relative to this task's folder",
        });
      const signal = AbortSignal.timeout(30_000);
      let key = "";
      for (const [index, name] of segments.entries()) {
        let cursor: string | undefined;
        let found = false;
        do {
          const page = await this.#options.files.list(
            folder,
            { parentKey: key, limit: 500, ...(cursor ? { cursor } : {}) },
            signal,
          );
          const entry = page.entries.find((entry) => entry.name === name);
          if (entry) {
            if (entry.kind !== (index === segments.length - 1 ? "file" : "directory"))
              throw unavailable();
            key = entry.key;
            found = true;
            break;
          }
          cursor = page.cursor ?? undefined;
        } while (cursor);
        if (!found) throw unavailable();
      }
      const response = await this.#options.files.download(folder, key, signal);
      if (!response.ok) {
        await response.body?.cancel();
        throw unavailable();
      }
      const bytes = await readBoundedResponse(response, {
        maximumBytes: appMaxBytes,
        signal,
        sizeError: () =>
          new OpensteerError({ code: "bad_request", message: "App HTML exceeds the 5 MiB limit" }),
      });
      if (!bytes.byteLength)
        throw new OpensteerError({ code: "bad_request", message: "App HTML is empty" });
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new OpensteerError({ code: "bad_request", message: "App HTML must be UTF-8" });
      }
      await this.#options.tokens.reauthorize(scope);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      // A digest names complete immutable bytes; interrupted writes cannot replace another version.
      const file = join(this.#directory, sha256);
      await createPrivateFileAtomically(file, Buffer.from(bytes).toString("utf8"));
      const previousVersion = previous
        ? await this.#options.apps.latest(previous.id, scope.requestedBy)
        : null;
      const result = await this.#options.apps.publish({
        ...(input.appId ? { appId: input.appId } : {}),
        title: input.title,
        sha256,
        sizeBytes: bytes.byteLength,
        publishKey,
        threadId: scope.threadId,
        runId: scope.runId,
        environmentId: scope.environmentId,
        userId: scope.requestedBy,
      });
      if (previous) {
        const old = previousVersion!;
        // The old server's generation is the one replaced by this publication.
        if (old.version.server)
          await this.#stop(this.#runtimeSpec(previous.id, result.version - 1, old.version.server));
      }
      if (result.event) {
        this.#options.publishEvent(result.event);
        await this.#publishedTabsChanged(result.appId);
      }
      return publicationResult(result);
    });
  }

  async collectGarbage(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const referenced = new Set(await this.#options.apps.referencedDigests());
    for (const name of await readdir(this.#directory)) {
      if (/^[0-9a-f]{64}$/u.test(name) && !referenced.has(name))
        await rm(join(this.#directory, name), { force: true });
    }
  }

  get(appId: string, userId: UserId) {
    return this.#options.apps.get(appId, userId);
  }

  async view(appId: string, userId: UserId, theme: AppTheme) {
    const app = await this.get(appId, userId);
    const pair = `${appId}:${userId}`;
    const token = this.#tokensByPair.get(pair) ?? randomBytes(32).toString("base64url");
    this.#tokensByPair.set(pair, token);
    this.#views.set(token, { appId, userId });
    return { app, path: `/v1/apps/${appId}/${theme}/${token}/` };
  }

  async authorizeView(appId: string, token: string) {
    const view = this.#views.get(token);
    if (!view || view.appId !== appId) throw unavailable();
    return this.#options.apps.latest(appId, view.userId);
  }

  async response(input: {
    appId: string;
    token?: string;
    userId?: UserId;
    originMode?: AppOriginMode;
    theme: AppTheme;
    path: string;
    prefix: string;
    method: string;
    headers: import("node:http").IncomingHttpHeaders;
    body?: Readable;
    signal: AbortSignal;
  }): Promise<AppHttpResponse> {
    // The lock covers only the connection decision, never the streaming lifetime.
    const userId = input.originMode ? input.userId : this.#views.get(input.token ?? "")?.userId;
    if (!userId) throw unavailable();
    const latest = input.originMode
      ? await this.#options.apps.latest(input.appId, userId)
      : await this.authorizeView(input.appId, input.token ?? "");
    if (!latest.version.server) {
      if (
        (input.originMode ? input.path.split("?")[0] : input.path) !== "/" ||
        !["GET", "HEAD"].includes(input.method)
      )
        throw unavailable();
      const html = await this.#content(latest.version, input.theme, !!input.originMode);
      return {
        status: 200,
        headers: {
          ...(input.originMode
            ? {
                ...appOriginHeaders(input.originMode),
                "content-type": "text/html; charset=utf-8",
                "cache-control": "private, no-store",
              }
            : { ...appFrameHeaders(), ...appCorsHeaders }),
          "content-length": String(Buffer.byteLength(html)),
        },
        body: Readable.from(input.method === "HEAD" ? [] : [html]),
      };
    }
    try {
      return await requestAppHttp({
        ...input,
        connect: (signal) => this.connect(input.appId, userId, signal),
      });
    } catch (error) {
      if (input.signal.aborted) throw error;
      if (error && typeof error === "object" && "statusCode" in error && error.statusCode === 413)
        return this.#errorResponse(
          413,
          "App request exceeds the 32 MiB limit",
          input.theme,
          false,
          input.originMode,
        );
      // Personal admission is checked again before opening a tunnel.
      if (error instanceof OpensteerError && error.code === "not_found")
        return this.#errorResponse(
          404,
          "This app is no longer available.",
          input.theme,
          input.headers.accept?.includes("text/html") ?? input.path === "/",
          input.originMode,
        );
      return this.#errorResponse(
        503,
        "This app's server is unavailable. Try again after its computer reconnects or the app is republished.",
        input.theme,
        input.headers.accept?.includes("text/html") ?? input.path === "/",
        input.originMode,
      );
    }
  }

  connect(appId: string, userId: UserId, signal: AbortSignal) {
    return this.#locks.run(appId, async () => {
      const current = await this.#options.apps.latest(appId, userId);
      if (!current.version.server) throw new AppTunnelError("This app no longer runs a server");
      return this.#tunnels().connect(
        this.#runtimeSpec(appId, current.version.version, current.version.server),
        signal,
      );
    });
  }

  async list(scope: RunToolScope) {
    return { apps: await this.#options.apps.list({ ...scope, userId: scope.requestedBy }) };
  }

  async listForCaller(scope: { readonly requestedBy: UserId }) {
    return {
      apps: await this.#options.apps.listOwned(scope.requestedBy),
    };
  }

  async fetch(scope: RunToolScope, input: z.infer<typeof AppFetchInputSchema>) {
    input = AppFetchInputSchema.parse(input);
    await this.#options.apps.authorize({
      ...scope,
      userId: scope.requestedBy,
      appId: input.appId,
      fullAccess: true,
    });
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    try {
      const view = await this.view(input.appId, scope.requestedBy, "light");
      const response = await requestAppHttp({
        method: input.method,
        path: appRequestPath(input.path),
        headers: input.headers ?? {},
        ...(input.body === undefined ? {} : { body: Readable.from([input.body]) }),
        prefix: view.path.slice(0, -1),
        signal,
        connect: (signal) =>
          this.#locks.run(input.appId, async () => {
            const { app, version } = await this.#options.apps.latest(
              input.appId,
              scope.requestedBy,
            );
            if (!version.server)
              throw new OpensteerError({
                code: "bad_request",
                message: "app_fetch requires a server app",
              });
            const spec = this.#runtimeSpec(app.id, version.version, version.server);
            return this.#tunnels().connect(spec, signal);
          }),
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk);
        const remaining = 256 * 1_024 - size;
        chunks.push(bytes.subarray(0, remaining));
        size += Math.min(bytes.length, remaining);
        if (bytes.length >= remaining) {
          truncated = true;
          controller.abort();
          break;
        }
      }
      const text = Buffer.concat(chunks).toString("utf8");
      truncated ||= Buffer.byteLength(text) > 256 * 1_024;
      const note = "\n[Response truncated at 256 KiB]";
      return {
        status: response.status,
        contentType: response.headers["content-type"],
        body: truncated ? utf8Prefix(text, 256 * 1_024 - Buffer.byteLength(note)) + note : text,
        truncated,
      };
    } catch (error) {
      if (error instanceof OpensteerError) throw error;
      return {
        status: 503,
        contentType: "text/plain",
        body:
          error instanceof AppTunnelError
            ? `${error.message}\n${error.logTail}`
            : "App request failed or exceeded 30 seconds",
        truncated: false,
      };
    } finally {
      controller.abort();
    }
  }

  acceptTunnel(ticket: string, socket: import("ws").WebSocket): void {
    this.#tunnels().accept(ticket, socket);
  }

  async #stop(spec: AppRuntimeSpec): Promise<void> {
    try {
      await this.#tunnels().stop(spec);
    } catch {
      /* The runtime also retires a replaced app generation. */
    }
  }

  #runtimeSpec(appId: string, version: number, server: AppServerSpec): AppRuntimeSpec {
    return { appId, version, folder: server.folder, command: server.command };
  }
  #tunnels() {
    if (!this.#options.tunnels) throw new AppTunnelError("App servers are unavailable");
    return this.#options.tunnels;
  }
  #errorResponse(
    status: number,
    message: string,
    theme: AppTheme,
    html: boolean,
    originMode?: AppOriginMode,
  ): AppHttpResponse {
    const body = html
      ? prepareAppHtml(
          `<title>App unavailable</title><body><p>${message}</p></body>`,
          theme,
          !!originMode,
        )
      : message;
    return {
      status,
      headers: {
        ...(originMode
          ? { ...appOriginHeaders(originMode), "cache-control": "private, no-store" }
          : { ...appFrameHeaders(), ...appCorsHeaders }),
        "content-type": html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
        "content-length": String(Buffer.byteLength(body)),
      },
      body: Readable.from([body]),
    };
  }

  async content(appId: string, token: string, theme: AppTheme): Promise<string> {
    const { version } = await this.authorizeView(appId, token);
    return this.#content(version, theme, false);
  }
  async #content(
    version: { sha256: string | null; sizeBytes: number | null },
    theme: AppTheme,
    realOrigin: boolean,
  ): Promise<string> {
    if (!version.sha256 || !version.sizeBytes) throw unavailable();
    const file = join(this.#directory, version.sha256);
    if ((await stat(file)).size !== version.sizeBytes) throw unavailable();
    const bytes = await readFile(file);
    if (createHash("sha256").update(bytes).digest("hex") !== version.sha256) throw unavailable();
    return prepareAppHtml(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      theme,
      realOrigin,
    );
  }
}

function publicationResult(result: { readonly appId: string; readonly version: number }) {
  return {
    appId: result.appId,
    version: result.version,
    message:
      "The app is shown inline in this Thread. Do not restate its contents; refer to it by title or appId.",
  };
}
