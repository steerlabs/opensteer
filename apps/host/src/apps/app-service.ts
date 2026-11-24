import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { Readable } from "node:stream";
import {
  AppIdSchema,
  AppPublishInputSchema,
  OpensteerError,
  appFolderSegments,
  appMaxBytes,
  type App,
  type AppId,
  type AppListItem,
  type AppPublishInput,
  type AppServerSpec,
  type ComputerFolder,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import {
  admitCommand,
  OpensteerStore,
  TriggerStore,
  resolveResourceAccess,
  lineageAllowsPersonalContext,
  type AppAuthorization,
  type AppRecord,
  type AppStore,
  type PublishedApp,
} from "@opensteer/database";
import type { AppRuntimeSpec, RunnerAppState, RunnerConnectionId } from "@opensteer/protocol";
import type { Command } from "@opensteer/protocol/command-table";
import { createPrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import { readBoundedResponse } from "@opensteer/shared/boundedJson";
import { appFrameHeaders, prepareAppHtml, type AppTheme } from "@opensteer/shared/appFrame";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { KeyedMutationQueue } from "@opensteer/shared/mutationQueue";
import type { RunToolScope, RunToolTokenService } from "../agents/run-tool-tokens.js";
import type { ConnectionCaller, ProgramCaller } from "../mcp/agent-caller.js";
import type { AppTabPort } from "../tabs/ports.js";
import type { AgentHomeFiles } from "../threads/agent-home-files.js";
import {
  appCorsHeaders,
  appOriginHeaders,
  requestAppHttp,
  type AppHttpResponse,
  type AppOriginMode,
} from "./app-proxy.js";
import { AppTunnelError, type AppRunnerConnection, type AppTunnelHub } from "./app-tunnel-hub.js";

/** Who asks: the person from a client, an agent from its Run, or an automation script. */
export type AppActor =
  | { readonly kind: "person"; readonly ownerId: UserId }
  | { readonly kind: "run"; readonly claims: RunToolScope }
  | { readonly kind: "program"; readonly caller: ProgramCaller };

type AppReader = AppActor | { kind: "connection"; caller: ConnectionCaller };
type AppPublishActor =
  | { readonly kind: "run"; readonly claims: RunToolScope }
  | { readonly kind: "program"; readonly caller: ProgramCaller };

export interface AppCallLifetime {
  readonly signal?: AbortSignal;
  readonly checkLive?: () => Promise<void>;
}

interface AppServiceOptions {
  readonly dataDirectory: string;
  readonly apps: AppStore;
  readonly files: Pick<AgentHomeFiles, "list" | "download">;
  /** The hosting computer's Agent home, which every server folder lives in. */
  readonly agentHome: () => Promise<ComputerFolder>;
  readonly tokens: Pick<RunToolTokenService, "reauthorize">;
  readonly tunnels: Pick<
    AppTunnelHub,
    "connection" | "start" | "stop" | "sync" | "close" | "connect" | "accept"
  >;
  readonly tabs: Pick<AppTabPort, "removeTabs">;
  /** The owner's Apps page and app tabs reread these apps. */
  readonly changed: (ownerId: UserId, appIds: AppId[]) => void;
}

interface Actual {
  readonly connectionId: RunnerConnectionId;
  readonly generation: number;
  readonly state: "running" | "stopped" | "failed";
}
interface Computer {
  readonly connection: AppRunnerConnection;
  /** Settles once the complete-set sync answered; false means connects stay unavailable. */
  readonly synced: Promise<boolean>;
}

const unavailable = () =>
  new OpensteerError({ code: "not_found", message: "App content is unavailable" });
const missing = () => new OpensteerError({ code: "not_found", message: "App not found" });
const startTimeoutMs = 30_000;

function joinComputerPath(root: string, segments: readonly string[]): string {
  if (segments.length === 0) return root;
  const isWindows = /^[A-Za-z]:[\\/]/u.test(root) || root.startsWith("\\\\");
  return isWindows ? win32.join(root, ...segments) : posix.join(root, ...segments);
}

export class AppService {
  readonly #views = new Map<string, { appId: AppId; userId: UserId }>();
  readonly #tokensByPair = new Map<string, string>();
  readonly #locks = new KeyedMutationQueue();
  readonly #computers = new Map<RunnerId, Computer>();
  readonly #actual = new Map<AppId, Actual>();
  readonly #revocations = new Set<(appId: AppId) => void>();
  readonly #directory: string;
  readonly #options: AppServiceOptions;
  constructor(options: AppServiceOptions) {
    this.#options = options;
    this.#directory = join(options.dataDirectory, "apps");
  }

  /** Publishes HTML, or starts and verifies a server on its fixed port before committing. */
  async publish(
    scopeOrActor: RunToolScope | { readonly kind: "program"; readonly caller: ProgramCaller },
    operationKey: string,
    input: AppPublishInput,
    lifetime: AppCallLifetime = {},
  ): Promise<{ appId: AppId; version: number }> {
    input = AppPublishInputSchema.parse(input);
    const actor: AppPublishActor =
      "kind" in scopeOrActor ? scopeOrActor : { kind: "run", claims: scopeOrActor };
    const scope = actor.kind === "run" ? runScope(actor.claims) : programScope(actor.caller);
    const publishKey = actor.kind === "run" ? operationKey : `${actor.caller.key}:${operationKey}`;
    const lockKey =
      input.appId ??
      `${actor.kind === "run" ? actor.claims.runId : actor.caller.key}:${operationKey}`;
    return this.#locks.run(lockKey, async () => {
      await this.#admit(actor, lifetime, input.start !== undefined);
      const replay = await this.#options.apps.publication(scope.runId, publishKey);
      if (replay) return { appId: AppIdSchema.parse(replay.appId), version: replay.version };
      const { agentHome } = await this.#options.apps.authorizeRun(scope, input.start !== undefined);
      const previous = input.appId
        ? await this.#options.apps.get(scope.userId, input.appId)
        : undefined;
      const result =
        input.start === undefined
          ? await this.#publishHtml(actor, scope, publishKey, input, previous, lifetime)
          : await this.#publishServer(
              actor,
              scope,
              publishKey,
              input,
              input.start,
              agentHome,
              previous,
              lifetime,
            );
      this.#options.changed(scope.userId, [result.appId]);
      return { appId: result.appId, version: result.version };
    });
  }

  async #publishServer(
    actor: AppPublishActor,
    run: ReturnType<typeof runScope> | ReturnType<typeof programScope>,
    publishKey: string,
    input: AppPublishInput,
    start: string,
    agentHome: ComputerFolder,
    previous: PublishedApp | undefined,
    lifetime: AppCallLifetime,
  ) {
    let segments: string[];
    try {
      segments = appFolderSegments(input.path);
    } catch {
      throw new OpensteerError({
        code: "bad_request",
        message: "Use an app folder inside Agent home, without traversal",
      });
    }
    const server: AppServerSpec = {
      folder: {
        computerId: agentHome.computerId,
        path: joinComputerPath(agentHome.path, segments),
      },
      command: start,
    };
    await this.#ready(agentHome.computerId, lifetime.signal);
    await this.#admit(actor, lifetime, true);
    const reservation = previous
      ? await this.#options.apps.prepareServer(
          {
            scope: run,
            appId: previous.id,
            computerId: agentHome.computerId,
          },
          this.#authorize(actor, lifetime),
        )
      : await this.#options.apps.reserve(
          {
            scope: run,
            creationKey: `${run.runId ?? run.callerKey ?? "program"}:${publishKey}`,
            name: input.name,
            computerId: agentHome.computerId,
          },
          this.#authorize(actor, lifetime),
        );
    if (previous) this.#options.changed(run.userId, [previous.id]);
    const spec: AppRuntimeSpec = {
      appId: reservation.appId,
      version: (previous?.version.version ?? 0) + 1,
      generation: reservation.generation,
      port: reservation.port,
      folder: server.folder,
      agentHome,
      command: server.command,
    };
    const abandon = async () => {
      if (reservation.published) {
        await this.#options.apps.cancelStart(spec.appId, spec.generation);
        await this.#halt(spec.folder.computerId, spec.appId, spec.generation).catch(
          () => undefined,
        );
        this.#options.changed(run.userId, [spec.appId]);
      } else {
        const record = await this.#options.apps.markDeleting(
          run.userId,
          spec.appId,
          this.#options.tabs.removeTabs,
        );
        try {
          await this.#halt(record.computerId, record.id, record.server!.generation);
          await this.#remove(record);
        } catch {
          this.#options.changed(run.userId, [spec.appId]);
        }
      }
    };
    try {
      await this.#launch(run.userId, spec, actor, lifetime);
    } catch (error) {
      await abandon();
      lifetime.signal?.throwIfAborted();
      throw startFailure(error);
    }
    try {
      await this.#admit(actor, lifetime, true);
      return await this.#options.apps.commit(
        {
          scope: run,
          appId: spec.appId,
          name: input.name,
          publishKey,
          expectedVersion: spec.version,
          server,
          serverGeneration: spec.generation,
        },
        this.#authorize(actor, lifetime),
      );
    } catch (error) {
      await abandon();
      throw error;
    }
  }

  async #publishHtml(
    actor: AppPublishActor,
    scope: ReturnType<typeof runScope> | ReturnType<typeof programScope>,
    publishKey: string,
    input: AppPublishInput,
    previous: PublishedApp | undefined,
    lifetime: AppCallLifetime,
  ) {
    if (!/\.html?$/iu.test(input.path))
      throw new OpensteerError({
        code: "bad_request",
        message: "Publish an HTML file (.html or .htm), or give start to publish a server folder",
      });
    // The file service resolves these opaque path segments inside Agent home.
    const segments = input.path.replace(/^\.\//u, "").split("/");
    if (
      segments.some(
        (part) =>
          !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0"),
      )
    )
      throw new OpensteerError({
        code: "bad_request",
        message: "Use an HTML file path inside Agent home",
      });
    const signal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(lifetime.signal ? [lifetime.signal] : []),
    ]);
    let key = "";
    let revision: string | undefined;
    let rootScope: string | undefined;
    for (const [index, name] of segments.entries()) {
      let cursor: string | undefined;
      let found = false;
      do {
        const page = await this.#options.files.list(
          {
            parentKey: key,
            limit: 500,
            ...(cursor ? { cursor } : {}),
            ...(rootScope ? { expectedRootScope: rootScope } : {}),
          },
          signal,
        );
        rootScope ??= page.rootScope;
        const entry = page.entries.find((candidate) => candidate.name === name);
        if (entry) {
          if (entry.kind !== (index === segments.length - 1 ? "file" : "directory"))
            throw unavailable();
          key = entry.key;
          revision = entry.revision;
          found = true;
          break;
        }
        cursor = page.cursor ?? undefined;
      } while (cursor);
      if (!found) throw unavailable();
    }
    if (!revision)
      throw new OpensteerError({
        code: "conflict",
        reason: "unsupported-runner",
        message: "Update the hosting computer to publish apps from Agent home.",
      });
    const response = await this.#options.files
      .download(key, signal, "app-html", revision)
      .catch((error) => {
        if (error instanceof OpensteerError && error.reason === "file-too-large")
          throw new OpensteerError({
            code: "bad_request",
            message: "App HTML exceeds the 5 MiB limit",
          });
        throw error;
      });
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
    await this.#admit(actor, lifetime, false);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    // A digest names complete immutable bytes; interrupted writes cannot replace another version.
    await createPrivateFileAtomically(
      join(this.#directory, sha256),
      Buffer.from(bytes).toString("utf8"),
    );
    await this.#admit(actor, lifetime, false);
    const result = await this.#options.apps.commit(
      {
        scope,
        ...(previous ? { appId: previous.id } : {}),
        name: input.name,
        publishKey,
        html: { sha256, sizeBytes: bytes.byteLength },
      },
      this.#authorize(actor, lifetime),
    );
    // Publishing HTML over a server stops it; its port stays reserved for the app.
    if (previous && result.retiredServer)
      await this.#halt(previous.computerId, previous.id, result.retiredServer.generation).catch(
        () => undefined,
      );
    return result;
  }

  /** Retires abandoned reservations, then deletes HTML bytes no version references. */
  async collectGarbage(): Promise<void> {
    for (const reservation of await this.#options.apps.abandonedReservations()) {
      if (reservation.deleting) continue;
      await this.#options.apps.markDeleting(
        reservation.ownerId,
        reservation.id,
        this.#options.tabs.removeTabs,
      );
    }
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const referenced = new Set(await this.#options.apps.referencedDigests());
    for (const name of await readdir(this.#directory)) {
      if (/^[0-9a-f]{64}$/u.test(name) && !referenced.has(name))
        await rm(join(this.#directory, name), { force: true });
    }
  }

  async get(ownerId: UserId, appId: string): Promise<App> {
    return this.#view(await this.#options.apps.get(ownerId, appId));
  }

  async list(actor: AppReader, query?: string, lifetime: AppCallLifetime = {}): Promise<App[]> {
    await this.#admit(actor, lifetime, false, "read");
    return (
      await this.#options.apps.list(ownerOf(actor), query, this.#authorize(actor, lifetime, "read"))
    ).map((app) => this.#view(app));
  }

  async rename(ownerId: UserId, appId: string, name: string): Promise<App> {
    const id = parseAppId(appId);
    await this.#options.apps.rename(ownerId, id, name);
    this.#options.changed(ownerId, [id]);
    return this.get(ownerId, id);
  }

  /**
   * Persists running intent, then starts on the saved computer and fixed port. Offline,
   * the intent waits for reconnect. A failure stays failed until an explicit retry.
   */
  async start(actor: AppActor, appId: string, lifetime: AppCallLifetime = {}): Promise<App> {
    const id = parseAppId(appId);
    const ownerId = ownerOf(actor);
    const command = { type: "app.start", appId: id, idempotencyKey: "app.start" } as Command;
    return this.#locks.run(id, async () => {
      await this.#admit(actor, lifetime, true, "read-write", command);
      const app = await this.#options.apps.get(ownerId, id);
      if (this.#computers.has(app.computerId)) await this.#ready(app.computerId, lifetime.signal);
      else if (actor.kind !== "person") throw startFailure(new ComputerOfflineError());
      await this.#admit(actor, lifetime, true, "read-write", command);
      const record = await this.#options.apps.setDesiredState(
        ownerId,
        id,
        "running",
        this.#authorize(actor, lifetime, "read-write", true, command),
      );
      this.#options.changed(ownerId, [id]);
      if (actor.kind === "person" && !this.#computers.has(record.computerId))
        return this.get(ownerId, id);
      let dispatched = false;
      try {
        const spec = await this.#spec(record);
        await this.#launch(ownerId, spec, actor, lifetime, () => {
          dispatched = true;
        });
      } catch (error) {
        if (!dispatched || lifetime.signal?.aborted) {
          await this.#options.apps.cancelStart(id, record.server.generation);
          await this.#halt(record.computerId, id, record.server.generation).catch(() => undefined);
          this.#options.changed(ownerId, [id]);
          lifetime.signal?.throwIfAborted();
          throw startFailure(error);
        }
        const current = await this.#options.apps.get(ownerId, id);
        // A Stop or Delete that overtook this start owns the outcome.
        if (
          actor.kind !== "person" &&
          current.server?.generation === record.server.generation &&
          !(error instanceof ComputerOfflineError)
        )
          throw startFailure(error);
        return this.#view(current);
      }
      return this.get(ownerId, id);
    });
  }

  /** Persists stopped intent before any I/O, so it beats a pending start and survives reconnect. */
  async stop(actor: AppActor, appId: string, lifetime: AppCallLifetime = {}): Promise<App> {
    const id = parseAppId(appId);
    const ownerId = ownerOf(actor);
    const record = await this.#options.apps.setDesiredState(
      ownerId,
      id,
      "stopped",
      this.#authorize(actor, lifetime),
    );
    this.#options.changed(ownerId, [id]);
    if (!this.#computers.has(record.computerId)) return this.get(ownerId, id);
    try {
      await this.#halt(record.computerId, id, record.server.generation);
    } catch {
      throw outcomeUnknown(
        "Opensteer could not confirm this app's server stopped. It stays stopped and its computer stops it on reconnect.",
      );
    }
    return this.get(ownerId, id);
  }

  /**
   * Withdraws viewing first, stops the exact process tree, then removes the records and
   * the app's tabs together. The folder stays on disk.
   */
  async delete(actor: AppActor, appId: string, lifetime: AppCallLifetime = {}): Promise<void> {
    const id = parseAppId(appId);
    const ownerId = ownerOf(actor);
    const record = await this.#options.apps.markDeleting(
      ownerId,
      id,
      this.#options.tabs.removeTabs,
      this.#authorize(actor, lifetime),
    );
    this.#revoke(id);
    this.#options.changed(ownerId, [id]);
    if (record.server)
      try {
        await this.#halt(record.computerId, id, record.server.generation);
      } catch {
        this.#options.changed(ownerId, [id]);
        throw outcomeUnknown(
          "Opensteer could not confirm this app's server stopped. The app is hidden and its deletion finishes when its computer reconnects.",
        );
      }
    await this.#locks.run(id, () => this.#remove(record));
  }

  /** Lets a viewer channel close its connections the moment an app's viewing ends. */
  onRevoked(listener: (appId: AppId) => void): () => void {
    this.#revocations.add(listener);
    return () => this.#revocations.delete(listener);
  }

  /**
   * Reconciles the computer's complete desired set before app connects are allowed.
   * A fresh Runner holds no trusted state, so running intent restarts here.
   */
  async onRunnerConnected(computerId: RunnerId): Promise<void> {
    const connection = this.#options.tunnels.connection(computerId);
    if (!connection) return;
    const computer: Computer = { connection, synced: this.#reconcile(computerId, connection) };
    this.#computers.set(computerId, computer);
    await computer.synced;
  }

  /** Servers on a lost connection are offline; the Runner's own cleanup stops them. */
  async onRunnerDisconnected(
    computerId: RunnerId,
    connectionId: RunnerConnectionId,
  ): Promise<void> {
    const computer = this.#computers.get(computerId);
    if (computer?.connection.connectionId !== connectionId) return;
    this.#computers.delete(computerId);
    for (const [appId, actual] of this.#actual)
      if (actual.connectionId === connectionId) this.#actual.delete(appId);
    await this.#announceComputer(computerId);
  }

  /** Actual state from the current connection, including exits nobody asked for. */
  async onAppState(
    computerId: RunnerId,
    connectionId: RunnerConnectionId,
    report: Pick<RunnerAppState, "appId" | "generation" | "state" | "error">,
  ): Promise<void> {
    const appId = parseAppId(report.appId);
    if (!this.#observe(computerId, connectionId, appId, report.generation, report.state)) return;
    await this.#options.apps.setLastError(
      appId,
      report.generation,
      report.state === "failed" ? (report.error ?? "App server failed") : null,
    );
    const record = await this.#options.apps.record(appId);
    if (record) this.#options.changed(record.ownerId, [appId]);
  }

  async view(ownerId: UserId, appId: string, theme: AppTheme) {
    const app = await this.get(ownerId, appId);
    const pair = `${app.appId}:${ownerId}`;
    const token = this.#tokensByPair.get(pair) ?? randomBytes(32).toString("base64url");
    this.#tokensByPair.set(pair, token);
    this.#views.set(token, { appId: app.appId, userId: ownerId });
    return { app, path: `/v1/apps/${app.appId}/${theme}/${token}/` };
  }

  async authorizeView(appId: string, token: string): Promise<PublishedApp> {
    const view = this.#views.get(token);
    if (!view || view.appId !== appId) throw unavailable();
    return this.#options.apps.get(view.userId, appId);
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
    const userId = input.originMode ? input.userId : this.#views.get(input.token ?? "")?.userId;
    if (!userId) throw unavailable();
    const app = input.originMode
      ? await this.#options.apps.get(userId, input.appId)
      : await this.authorizeView(input.appId, input.token ?? "");
    const wantsHtml = input.headers.accept?.includes("text/html") ?? input.path === "/";
    if (!app.version.server) {
      if (
        (input.originMode ? input.path.split("?")[0] : input.path) !== "/" ||
        !["GET", "HEAD"].includes(input.method)
      )
        throw unavailable();
      const html = await this.#content(app.version, input.theme, !!input.originMode);
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
    // Viewing never starts a server.
    const state = this.#view(app).state;
    if (state !== "running")
      return this.#errorResponse(
        503,
        stateMessage[state],
        input.theme,
        wantsHtml,
        input.originMode,
      );
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
      if (error instanceof OpensteerError && error.code === "not_found")
        return this.#errorResponse(
          404,
          "This app is no longer available.",
          input.theme,
          wantsHtml,
          input.originMode,
        );
      return this.#errorResponse(
        503,
        "This app's server did not answer. Try again, or restart it from Apps.",
        input.theme,
        wantsHtml,
        input.originMode,
      );
    }
  }

  /** A tunnel to the exact running generation, never a start. */
  async connect(appId: string, userId: UserId, signal: AbortSignal) {
    const app = await this.#options.apps.get(userId, appId);
    if (!app.version.server || !app.server)
      throw new AppTunnelError("This app no longer runs a server");
    if (app.server.desiredState !== "running") throw new AppTunnelError(stateMessage.stopped);
    const computer = this.#computers.get(app.computerId);
    if (!computer) throw new AppTunnelError(stateMessage.offline);
    if (!(await computer.synced))
      throw new AppTunnelError("This app's computer could not reconcile its app servers");
    return this.#options.tunnels.connect(await this.#spec(app), signal);
  }

  acceptTunnel(ticket: string, socket: import("ws").WebSocket): void {
    this.#options.tunnels.accept(ticket, socket);
  }

  async content(appId: string, token: string, theme: AppTheme): Promise<string> {
    const { version } = await this.authorizeView(appId, token);
    return this.#content(version, theme, false);
  }

  /** The App read model: actual state from the current connection, intent otherwise. */
  #view(app: PublishedApp): App {
    const server = app.version.server && app.server ? app.server : null;
    const state = !server
      ? "running"
      : !this.#computers.has(app.computerId)
        ? "offline"
        : this.#actualState(app.id, server.generation, server.desiredState, server.lastError);
    return {
      appId: app.id,
      name: app.name,
      kind: server ? "server" : "html",
      state,
      ...(server && app.version.server
        ? {
            localUrl: `http://127.0.0.1:${server.port}`,
            folder: app.version.server.folder.path,
            start: app.version.server.command,
          }
        : {}),
      computerId: app.computerId,
      taskId: app.threadId,
      version: app.version.version,
      server: server
        ? {
            desiredState: server.desiredState,
            state,
            port: server.port,
            generation: server.generation,
            lastError: server.lastError,
          }
        : null,
      createdAt: app.createdAt.toISOString(),
      updatedAt: app.updatedAt.toISOString(),
    };
  }

  #actualState(
    appId: AppId,
    generation: number,
    desiredState: "running" | "stopped",
    lastError: string | null,
  ): App["state"] {
    const actual = this.#actual.get(appId);
    if (actual?.generation === generation) return actual.state;
    if (desiredState === "stopped") return "stopped";
    return lastError ? "failed" : "stopped";
  }

  async #spec(app: PublishedApp): Promise<AppRuntimeSpec> {
    if (!app.version.server || !app.server)
      throw new OpensteerError({
        code: "bad_request",
        message: "This app is HTML and has no server to start or stop.",
      });
    return {
      appId: app.id,
      version: app.version.version,
      generation: app.server.generation,
      port: app.server.port,
      folder: app.version.server.folder,
      agentHome: await this.#options.agentHome(),
      command: app.version.server.command,
    };
  }

  #authorize(
    actor: AppReader,
    lifetime: AppCallLifetime,
    required: "read" | "read-write" = "read-write",
    fullAccess = false,
    /** The door's command this is, where the door's own answer decides it (B8). */
    command?: Command,
  ): AppAuthorization {
    return async (database) => {
      lifetime.signal?.throwIfAborted();
      await lifetime.checkLive?.();
      if (actor.kind === "run") await new OpensteerStore(database).assertActiveGrant(actor.claims);
      if (actor.kind === "program") {
        const triggers = new TriggerStore(database);
        if (actor.caller.program.kind === "trigger")
          await triggers.assertActiveExecutionBinding(actor.caller.program);
        else await triggers.assertActiveWatchBinding(actor.caller.program);
      }
      const { access, execution } = await resolveResourceAccess(database, {
        ownerUserId: ownerOf(actor),
        explicitAccess: "read-write",
        // Mini-apps have no selected resource kind; only unlimited lineage reaches them.
        grantTarget: { kind: "device" },
        ...(actor.kind === "run"
          ? { agentBindingId: `run:${actor.claims.runId}` }
          : actor.kind === "connection"
            ? { agentConnectionId: actor.caller.connectionId }
            : actor.kind === "program"
              ? { agentBindingId: actor.caller.key }
              : { kind: "person" }),
      });
      // Work from a bridge anyone may speak to has no apps of the person's: as if none existed.
      // Read from the connection row the admission just read; the person's own Run reads nothing.
      if (
        (actor.kind === "run" || actor.kind === "program") &&
        !lineageAllowsPersonalContext(execution.agentConnection)
      )
        throw missing();
      // A server started under a connection outlives that connection's Disconnect: the door's
      // own rule asks the person (app.start's lineage face), and so does this tool (B8).
      if (
        command &&
        execution.agentConnection &&
        (actor.kind === "run" || actor.kind === "program")
      ) {
        const admission = await admitCommand(database, {
          ownerUserId: ownerOf(actor),
          subject: {
            kind: "binding",
            bindingId: actor.kind === "run" ? `run:${actor.claims.runId}` : actor.caller.key,
          },
          command,
        });
        if (admission.answer !== "now")
          throw new OpensteerError({
            code: "conflict",
            reason: "asks-person",
            message: "This needs the person in Opensteer. Ask them with opensteer_command.",
          });
      }
      if (actor.kind === "run")
        await this.#options.apps.authorizeRun(runScope(actor.claims), fullAccess, database);
      if (actor.kind === "program")
        await this.#options.apps.authorizeRun(programScope(actor.caller), fullAccess, database);
      if (!access || (required === "read-write" && access !== "read-write"))
        throw new OpensteerError({
          code: "forbidden",
          message: "Changing apps requires read-write access.",
        });
      lifetime.signal?.throwIfAborted();
    };
  }

  async #admit(
    actor: AppReader,
    lifetime: AppCallLifetime,
    fullAccess: boolean,
    required: "read" | "read-write" = "read-write",
    command?: Command,
  ): Promise<void> {
    lifetime.signal?.throwIfAborted();
    await lifetime.checkLive?.();
    if (actor.kind === "run") {
      await this.#options.tokens.reauthorize(actor.claims);
    }
    await this.#authorize(
      actor,
      lifetime,
      required,
      fullAccess,
      command,
    )(this.#options.apps.database);
    lifetime.signal?.throwIfAborted();
  }

  async #ready(computerId: RunnerId, signal?: AbortSignal): Promise<Computer> {
    const computer = this.#computers.get(computerId);
    if (!computer) throw startFailure(new ComputerOfflineError());
    const synced = await withTimeout(computer.synced, startTimeoutMs, {
      ...(signal ? { signal } : {}),
      timeoutError: () =>
        outcomeUnknown(
          "The app's computer did not finish reconciling its servers. Reconnect it before starting an app.",
        ),
    });
    if (computer.connection.signal.aborted || this.#computers.get(computerId) !== computer)
      throw startFailure(new ComputerOfflineError());
    if (!synced)
      throw outcomeUnknown(
        "Opensteer could not reconcile the computer's app servers. Confirm pending servers stopped and reconnect the computer before starting an app.",
      );
    return computer;
  }

  async #launch(
    ownerId: UserId,
    spec: AppRuntimeSpec,
    actor: AppActor,
    lifetime: AppCallLifetime,
    onDispatch?: () => void,
  ): Promise<void> {
    const computer = await this.#ready(spec.folder.computerId, lifetime.signal);
    const record = await this.#options.apps.record(spec.appId);
    if (!record || record.deleting || record.server?.generation !== spec.generation)
      throw new OpensteerError({
        code: "conflict",
        message: "The app changed before its server could start. Check app_list before retrying.",
      });
    await this.#admit(actor, lifetime, true);
    const { connection } = computer;
    try {
      onDispatch?.();
      await this.#options.tunnels.start(
        connection,
        spec,
        AbortSignal.any([
          AbortSignal.timeout(startTimeoutMs),
          ...(lifetime.signal ? [lifetime.signal] : []),
        ]),
      );
      lifetime.signal?.throwIfAborted();
      this.#observe(
        spec.folder.computerId,
        connection.connectionId,
        spec.appId,
        spec.generation,
        "running",
      );
      if (await this.#options.apps.setLastError(spec.appId, spec.generation, null))
        this.#options.changed(ownerId, [spec.appId]);
    } catch (error) {
      if (connection.signal.aborted) throw new ComputerOfflineError();
      this.#observe(
        spec.folder.computerId,
        connection.connectionId,
        spec.appId,
        spec.generation,
        "failed",
      );
      await this.#options.apps.setLastError(
        spec.appId,
        spec.generation,
        error instanceof Error ? error.message : "App server failed to start",
      );
      this.#options.changed(ownerId, [spec.appId]);
      throw error;
    }
  }

  /** Only an acknowledged Stop proves the exact generation's process tree is gone. */
  async #halt(computerId: RunnerId, appId: AppId, generation: number): Promise<void> {
    this.#options.tunnels.close(appId);
    const computer = this.#computers.get(computerId);
    if (!computer || computer.connection.signal.aborted) throw new ComputerOfflineError();
    await this.#options.tunnels.stop(computerId, computer.connection, appId, generation);
    this.#observe(computerId, computer.connection.connectionId, appId, generation, "stopped");
  }

  async #reconcile(computerId: RunnerId, connection: AppRunnerConnection): Promise<boolean> {
    try {
      const deleting = await this.#options.apps.deleting(computerId);
      const apps = await this.#options.apps.runtimeSet(computerId);
      const specs = await Promise.all(apps.map((app) => this.#spec(app)));
      const result = await this.#options.tunnels.sync(
        computerId,
        connection,
        apps.map((app, index) => ({ spec: specs[index]!, desiredState: app.server.desiredState })),
      );
      if (!result.ok) return false;
      // The complete set omitted them, so the Runner has stopped whatever they left.
      for (const app of deleting) await this.#locks.run(app.id, () => this.#remove(app));
      return true;
    } catch {
      return false;
    } finally {
      await this.#announceComputer(computerId).catch(() => undefined);
    }
  }

  async #announceComputer(computerId: RunnerId): Promise<void> {
    const apps = await this.#options.apps.runtimeSet(computerId);
    const byOwner = new Map<UserId, AppId[]>();
    for (const app of apps) byOwner.set(app.ownerId, [...(byOwner.get(app.ownerId) ?? []), app.id]);
    for (const [ownerId, appIds] of byOwner) this.#options.changed(ownerId, appIds);
  }

  #observe(
    computerId: RunnerId,
    connectionId: RunnerConnectionId,
    appId: AppId,
    generation: number,
    state: Actual["state"],
  ): boolean {
    if (this.#computers.get(computerId)?.connection.connectionId !== connectionId) return false;
    const previous = this.#actual.get(appId);
    if (previous?.connectionId === connectionId && previous.generation > generation) return false;
    this.#actual.set(appId, { connectionId, generation, state });
    return true;
  }

  async #remove(record: AppRecord): Promise<void> {
    await this.#options.apps.remove(record.id, this.#options.tabs.removeTabs);
    this.#actual.delete(record.id);
    this.#options.changed(record.ownerId, [record.id]);
  }

  #revoke(appId: AppId): void {
    for (const [token, view] of this.#views)
      if (view.appId === appId) {
        this.#views.delete(token);
        this.#tokensByPair.delete(`${appId}:${view.userId}`);
      }
    this.#options.tunnels.close(appId);
    for (const listener of this.#revocations) listener(appId);
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

/** The agent-sized list entry: no server detail beyond what calling it needs. */
export function appListItem(app: App): AppListItem {
  const { server: _server, createdAt: _createdAt, ...item } = app;
  return item;
}

const stateMessage = {
  stopped: "This app's server is stopped. Start it from Apps.",
  failed: "This app's server failed. Start it again from Apps.",
  offline: "This app's computer is offline. The app comes back when that computer reconnects.",
} as const;

class ComputerOfflineError extends Error {
  constructor() {
    super("The app's computer is not connected");
  }
}

function startFailure(error: unknown): OpensteerError {
  if (error instanceof OpensteerError) return error;
  if (error instanceof ComputerOfflineError)
    return new OpensteerError({
      code: "runner_offline",
      message: "The app's computer is not connected, so its server cannot start now.",
      next: "Publish again once that computer is online.",
    });
  if (error instanceof AppTunnelError && error.portInUse)
    return new OpensteerError({
      code: "conflict",
      reason: "port_in_use",
      message: error.message,
      next: "Stop the program using that port, then call app_start. The app keeps its port.",
    });
  const message = (error instanceof Error ? error.message : "App server failed to start").slice(
    0,
    1_000,
  );
  const tail = error instanceof AppTunnelError ? error.logTail.trim() : "";
  // Keep the newest output: the end of a log explains the failure.
  const room = 1_970 - message.length;
  return new OpensteerError({
    code: "conflict",
    reason: "app_start_failed",
    message: tail
      ? `${message}\nServer output:\n${tail.length > room ? `…${tail.slice(-room)}` : tail}`
      : message,
    next: "Fix the server so it listens on 127.0.0.1 at PORT, then publish again or call app_start.",
  });
}

function outcomeUnknown(message: string): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    reason: "outcome_unknown",
    message,
    next: "Check app_list before acting again.",
  });
}

function parseAppId(appId: string): AppId {
  const parsed = AppIdSchema.safeParse(appId);
  if (!parsed.success) throw missing();
  return parsed.data;
}

function ownerOf(actor: AppReader): UserId {
  return actor.kind === "person"
    ? actor.ownerId
    : actor.kind === "run"
      ? actor.claims.requestedBy
      : actor.caller.userId;
}

function runScope(scope: RunToolScope) {
  return {
    threadId: scope.threadId,
    runId: scope.runId,
    userId: scope.requestedBy,
    environmentId: scope.environmentId,
  };
}
function programScope(caller: ProgramCaller) {
  return {
    threadId: caller.anchor.id,
    runId: null,
    userId: caller.userId,
    environmentId: caller.anchor.environmentId,
    accessMode: caller.accessMode,
    callerKey: caller.key,
  };
}
